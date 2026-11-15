package main

// Calls: dialling a lead, folding the carrier's webhooks into one record per call, acting on them (recording, voicemail drop,
// hanging up on a machine, answering an inbound call), and reporting each finished call to the CRM once.
//
// A call goes live -> (hangup) due -> [wrapup, when a person answered and the caller has not said how it went] -> reported.
// Webhooks may come twice or in any order: each is stored once by its event id, each fact keeps its first or strongest value,
// and the outcome is decided from all the facts only when the call is settled, a few seconds after its hangup.

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type callRow struct {
	ID                 string     `db:"id" json:"id"`
	OrgID              string     `db:"org_id" json:"org_id"`
	UserID             string     `db:"user_id" json:"user_id"`
	LeadID             *string    `db:"lead_id" json:"lead_id"`
	Direction          string     `db:"direction" json:"direction"`
	FromNumber         string     `db:"from_number" json:"from"`
	ToNumber           string     `db:"to_number" json:"to"`
	Route              string     `db:"route" json:"route"`
	Scenario           string     `db:"scenario" json:"scenario,omitempty"`
	CallControlID      *string    `db:"call_control_id" json:"call_control_id"`
	CallSessionID      string     `db:"call_session_id" json:"call_session_id"`
	AMDMode            string     `db:"amd_mode" json:"amd_mode"`
	Record             bool       `db:"record" json:"record"`
	VoicemailDropURL   string     `db:"voicemail_drop_url" json:"voicemail_drop_url"`
	TransferTo         string     `db:"transfer_to" json:"transfer_to"`
	InitiatedAt        *time.Time `db:"initiated_at" json:"initiated_at"`
	AnsweredAt         *time.Time `db:"answered_at" json:"answered_at"`
	EndedAt            *time.Time `db:"ended_at" json:"ended_at"`
	AMDResult          string     `db:"amd_result" json:"amd_result"`
	Greeting           string     `db:"greeting" json:"greeting"`
	HangupCause        string     `db:"hangup_cause" json:"hangup_cause"`
	HangupSource       string     `db:"hangup_source" json:"hangup_source"`
	SIPCode            string     `db:"sip_code" json:"sip_code"`
	TransferAnsweredAt *time.Time `db:"transfer_answered_at" json:"transfer_answered_at"`
	PlaybackEndedAt    *time.Time `db:"playback_ended_at" json:"playback_ended_at"`
	VoicemailDropped   bool       `db:"voicemail_dropped" json:"voicemail_dropped"`
	RecordingURL       string     `db:"recording_url" json:"recording_url"`
	RecordingStartedAt *time.Time `db:"recording_started_at" json:"recording_started_at"`
	RecordingEndedAt   *time.Time `db:"recording_ended_at" json:"recording_ended_at"`
	Disposition        string     `db:"disposition" json:"disposition"`
	CallbackAt         *time.Time `db:"callback_at" json:"callback_at"`
	Notes              string     `db:"notes" json:"notes"`
	ReportState        string     `db:"report_state" json:"report_state"`
	SettleAfter        *time.Time `db:"settle_after" json:"settle_after"`
	Attempts           int        `db:"attempts" json:"attempts"`
	Outcome            string     `db:"outcome" json:"outcome"`
	CRMStatus          string     `db:"crm_status" json:"crm_status"`
	CRMMessage         string     `db:"crm_message" json:"crm_message"`
	RecordingReported  bool       `db:"recording_reported" json:"recording_reported"`
	CreatedAt          time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt          time.Time  `db:"updated_at" json:"updated_at"`
}

func (c callRow) facts(now time.Time) facts {
	return facts{
		Direction: c.Direction, Answered: c.AnsweredAt != nil, Ended: c.EndedAt != nil, AMD: c.AMDResult,
		HangupCause: c.HangupCause, HangupSource: c.HangupSource, SIPCode: c.SIPCode, Transferred: c.TransferAnsweredAt != nil,
		Disposition: c.Disposition, VoicemailDropped: c.VoicemailDropped,
		WrapupTimedOut: c.ReportState == "wrapup" && c.SettleAfter != nil && !now.Before(*c.SettleAfter),
	}
}

func (c callRow) ccid() string {
	if c.CallControlID == nil {
		return ""
	}
	return *c.CallControlID
}

func (s *server) loadCall(ctx context.Context, q pgx.Tx, where string, args ...any) (*callRow, error) {
	var rows pgx.Rows
	var err error
	sql := `SELECT * FROM calls WHERE ` + where
	if q != nil {
		rows, err = q.Query(ctx, sql, args...)
	} else {
		rows, err = s.st.db.Query(ctx, sql, args...)
	}
	if err != nil {
		return nil, err
	}
	c, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[callRow])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// ------------------------------------------------------------------------------------------------------------- dialling

type dialAsk struct {
	LeadID           string `json:"lead_id"`
	From             string `json:"from"`
	DetectMachine    *bool  `json:"detect_machine"` // default true: the dialer skips machines
	Record           bool   `json:"record"`
	VoicemailDropURL string `json:"voicemail_drop_url"`
	Scenario         string `json:"scenario"` // simulate mode only
}

func (s *server) placeCall(ctx context.Context, sc scope, ask dialAsk) (*callRow, error) {
	if !sc.can("call") {
		return nil, forbidden("Your role does not allow calls.")
	}
	if !validID(ask.LeadID) {
		return nil, bad("Choose a lead (lead_id).")
	}
	lead, err := s.crm.lead(ctx, sc.orgID, sc.userID, ask.LeadID)
	var refused errCRMRefused
	if errors.As(err, &refused) {
		return nil, notFound(refused.message)
	}
	if err != nil {
		return nil, err
	}
	if !lead.MayCall {
		return nil, conflictErr(lead.Reason)
	}
	to := e164(lead.Phone)
	if to == "" {
		return nil, conflictErr("The lead's phone number is not a number that can be dialled.")
	}
	from, err := s.callerID(ctx, sc, ask.From, "calls")
	if err != nil {
		return nil, err
	}
	if ask.VoicemailDropURL != "" && !strings.HasPrefix(ask.VoicemailDropURL, "https://") {
		return nil, bad("voicemail_drop_url must be an https address of the recording to play.")
	}
	amd := ""
	if ask.DetectMachine == nil || *ask.DetectMachine {
		amd = s.cfg.amdMode
		if ask.VoicemailDropURL != "" && amd == "detect" {
			amd = "detect_beep" // the message must start after the beep
		}
	}
	scenario := ""
	if s.cfg.simulate {
		scenario = strings.TrimSpace(ask.Scenario)
	}
	id := newUUID()
	if _, err = s.st.db.Exec(ctx, `INSERT INTO calls (id, org_id, user_id, lead_id, direction, from_number, to_number, route, scenario, amd_mode, record, voicemail_drop_url)
		VALUES ($1, $2, $3, $4, 'outgoing', $5, $6, $7, $8, $9, $10, $11)`,
		id, sc.orgID, sc.userID, ask.LeadID, from, to, s.route(), scenario, amd, ask.Record || s.cfg.recordCalls, ask.VoicemailDropURL); err != nil {
		return nil, err
	}
	answer, err := s.carrier.dial(ctx, dialRequest{From: from, To: to, ClientState: id, AMD: amd, TimeoutSecs: s.cfg.ringSeconds, TimeLimitSecs: 4 * 3600, Scenario: scenario})
	if err != nil {
		log.Printf("WARN dial %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE calls SET report_state = 'skipped', crm_message = $2, updated_at = now() WHERE id = $1`, id, "The carrier refused the call: "+err.Error())
		return nil, &apiError{502, "carrier", "The carrier did not place the call. Try again in a moment."}
	}
	// A webhook may have come first and set these from the call's client state: keep whatever is there.
	if _, err = s.st.db.Exec(ctx, `UPDATE calls SET call_control_id = coalesce(call_control_id, $2),
			call_session_id = CASE WHEN call_session_id = '' THEN $3 ELSE call_session_id END, updated_at = now() WHERE id = $1`,
		id, answer.CallControlID, answer.CallSessionID); err != nil {
		return nil, err
	}
	return s.loadCall(ctx, nil, `id = $1`, id)
}

// callerID is the number a call or text goes out from: the one asked for if it is the workspace's, else the person's own,
// else the workspace's first, else TELNYX_FROM_NUMBER.
func (s *server) callerID(ctx context.Context, sc scope, asked, kind string) (string, error) {
	var from string
	err := s.st.db.QueryRow(ctx, `SELECT phone_number FROM numbers WHERE org_id = $1 AND `+kind+`
		ORDER BY (phone_number = $3) DESC, (user_id = $2) DESC, created_at LIMIT 1`, sc.orgID, sc.userID, e164(asked)).Scan(&from)
	if errors.Is(err, pgx.ErrNoRows) {
		if s.cfg.fromNumber == "" {
			return "", conflictErr("This workspace has no phone number yet.")
		}
		return s.cfg.fromNumber, nil
	}
	return from, err
}

func (s *server) route() string {
	if s.cfg.simulate {
		return "telnyx-sim"
	}
	return "telnyx"
}

// ------------------------------------------------------------------------------------------------------------- webhooks

// callEvent folds one call webhook into its call. It answers the call it belongs to (nil when none does) and whether this
// event was new; a repeat changes nothing.
func (s *server) callEvent(ctx context.Context, ev event) (*callRow, bool, error) {
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	ccid := ev.str("call_control_id")
	state := ev.clientState()
	ourID, leg, _ := strings.Cut(state, ":")
	if !validID(ourID) {
		ourID, leg = "", ""
	}
	var call *callRow
	if leg == "" && ccid != "" {
		if call, err = s.loadCall(ctx, tx, `call_control_id = $1 FOR UPDATE`, ccid); err != nil {
			return nil, false, err
		}
	}
	if call == nil && ourID != "" {
		if call, err = s.loadCall(ctx, tx, `id = $1 FOR UPDATE`, ourID); err != nil {
			return nil, false, err
		}
	}
	if call == nil && leg == "" && ev.str("direction") == "incoming" {
		if call, err = s.inboundCall(ctx, tx, ev); err != nil {
			return nil, false, err
		}
	}
	var callID *string
	if call != nil {
		callID = &call.ID
	}
	raw, _ := json.Marshal(ev)
	tag, err := tx.Exec(ctx, `INSERT INTO webhook_events (id, event_type, occurred_at, call_id, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
		ev.ID, ev.EventType, ev.OccurredAt, callID, raw)
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 0 || call == nil {
		return call, false, tx.Commit(ctx)
	}
	at := ev.OccurredAt
	if at.IsZero() {
		at = s.now()
	}
	upd := func(sql string, args ...any) {
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE calls SET `+sql+`, updated_at = now() WHERE id = $1`, append([]any{call.ID}, args...)...)
		}
	}
	if leg == "" && ccid != "" {
		upd(`call_control_id = coalesce(call_control_id, $2), call_session_id = CASE WHEN call_session_id = '' THEN $3 ELSE call_session_id END`, ccid, ev.str("call_session_id"))
	}
	switch ev.EventType {
	case "call.initiated":
		if leg == "" {
			upd(`initiated_at = least(coalesce(initiated_at, $2), $2)`, at)
		}
	case "call.answered":
		if leg == "transfer" {
			upd(`transfer_answered_at = least(coalesce(transfer_answered_at, $2), $2)`, at)
		} else if leg == "" {
			upd(`answered_at = least(coalesce(answered_at, $2), $2), initiated_at = least(coalesce(initiated_at, $2), $2)`, at)
		}
	case "call.machine.detection.ended", "call.machine.premium.detection.ended":
		result := amdResult(ev.str("result"))
		// A sure answer is never replaced by an unsure one.
		upd(`amd_result = CASE WHEN amd_result IN ('human', 'machine', 'fax', 'silence') AND $2 = 'not_sure' THEN amd_result ELSE $2 END`, result)
	case "call.machine.greeting.ended", "call.machine.premium.greeting.ended":
		upd(`greeting = CASE WHEN greeting = 'beep_detected' THEN greeting ELSE $2 END`, ev.str("result"))
	case "call.playback.ended":
		upd(`playback_ended_at = coalesce(playback_ended_at, $2), voicemail_dropped = voicemail_dropped OR voicemail_drop_url <> ''`, at)
	case "call.recording.saved":
		url := recordingURL(ev)
		upd(`recording_url = CASE WHEN recording_url = '' THEN $2 ELSE recording_url END, recording_started_at = coalesce(recording_started_at, $3),
			recording_ended_at = coalesce(recording_ended_at, $4)`, url, ev.time("recording_started_at"), ev.time("recording_ended_at"))
	case "call.hangup":
		if leg == "" {
			end := at
			if t := ev.time("end_time"); t != nil {
				end = *t
			}
			upd(`ended_at = coalesce(ended_at, $2), hangup_cause = CASE WHEN hangup_cause = '' THEN $3 ELSE hangup_cause END,
				hangup_source = CASE WHEN hangup_source = '' THEN $4 ELSE hangup_source END, sip_code = CASE WHEN sip_code = '' THEN $5 ELSE sip_code END,
				initiated_at = coalesce(initiated_at, $6),
				report_state = CASE WHEN report_state = 'live' THEN 'due' ELSE report_state END,
				settle_after = CASE WHEN report_state = 'live' THEN $7::timestamptz ELSE settle_after END`,
				end, ev.str("hangup_cause"), ev.str("hangup_source"), ev.str("sip_hangup_cause"), ev.time("start_time"), s.now().Add(s.cfg.settleDelay))
		}
	}
	if err != nil {
		return nil, false, err
	}
	if call, err = s.loadCall(ctx, tx, `id = $1`, call.ID); err != nil {
		return nil, false, err
	}
	return call, true, tx.Commit(ctx)
}

// inboundCall makes the record for a call to one of a workspace's numbers. An unknown number is not ours: nil.
func (s *server) inboundCall(ctx context.Context, tx pgx.Tx, ev event) (*callRow, error) {
	to, from := e164(ev.phone("to")), e164(ev.phone("from"))
	var org, user string
	err := tx.QueryRow(ctx, `SELECT org_id::text, user_id::text FROM numbers WHERE phone_number = $1 AND calls`, to).Scan(&org, &user)
	if errors.Is(err, pgx.ErrNoRows) {
		log.Printf("WARN inbound call to %s, which no workspace has", maskNumber(to))
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	id := newUUID()
	if _, err = tx.Exec(ctx, `INSERT INTO calls (id, org_id, user_id, direction, from_number, to_number, route, call_control_id, call_session_id)
		VALUES ($1, $2, $3, 'incoming', $4, $5, $6, $7, $8) ON CONFLICT (call_control_id) DO NOTHING`,
		id, org, user, from, to, s.route(), ev.str("call_control_id"), ev.str("call_session_id")); err != nil {
		return nil, err
	}
	return s.loadCall(ctx, tx, `call_control_id = $1 FOR UPDATE`, ev.str("call_control_id"))
}

func amdResult(r string) string {
	switch r {
	case "human", "human_residence", "human_business":
		return "human"
	case "machine":
		return "machine"
	case "silence":
		return "silence"
	case "fax_detected", "fax":
		return "fax"
	}
	return "not_sure"
}

func recordingURL(ev event) string {
	for _, name := range []string{"recording_urls", "public_recording_urls"} {
		if m, ok := ev.Payload[name].(map[string]any); ok {
			for _, f := range []string{"mp3", "wav"} {
				if u, _ := m[f].(string); u != "" {
					return u
				}
			}
		}
	}
	return ""
}

// react does what a new event asks of the dialer. It runs after the event is saved; a failed command is logged, and the call
// still settles from what the carrier reports.
func (s *server) react(ctx context.Context, ev event, c *callRow) {
	leg := ""
	if _, l, ok := strings.Cut(ev.clientState(), ":"); ok {
		leg = l
	}
	do := func(action string, body map[string]any) {
		if err := s.carrier.action(ctx, ev.str("call_control_id"), action, body); err != nil {
			log.Printf("WARN call %s: %s: %v", c.ID, action, err)
		}
	}
	live := c.EndedAt == nil
	switch {
	case ev.EventType == "call.initiated" && c.Direction == "incoming" && leg == "" && live:
		do("answer", map[string]any{"client_state": base64.StdEncoding.EncodeToString([]byte(c.ID))})
	case ev.EventType == "call.answered" && leg == "" && live && c.Record:
		do("record_start", map[string]any{"format": "mp3", "channels": "single"})
	case ev.EventType == "call.answered" && leg == "" && live && c.Direction == "incoming":
		// Ring the number's owner in the browser, when they have a calling login.
		var username string
		if err := s.st.db.QueryRow(ctx, `SELECT sip_username FROM agent_credentials WHERE user_id = $1`, c.UserID).Scan(&username); err == nil && username != "" {
			do("transfer", map[string]any{"to": "sip:" + username + "@sip.telnyx.com", "client_state": base64.StdEncoding.EncodeToString([]byte(c.ID + ":agent"))})
		}
	case strings.HasSuffix(ev.EventType, "detection.ended") && live && c.AMDResult == "machine" && c.VoicemailDropURL == "":
		do("hangup", nil) // the auto dialer skips machines
	case strings.HasSuffix(ev.EventType, "greeting.ended") && live && c.AMDResult == "machine" && c.VoicemailDropURL != "" && c.PlaybackEndedAt == nil:
		do("playback_start", map[string]any{"audio_url": c.VoicemailDropURL})
	case ev.EventType == "call.playback.ended" && live:
		do("hangup", nil)
	case ev.EventType == "call.hangup" && leg == "":
		s.settleSoon(c.ID)
	case ev.EventType == "call.recording.saved" && c.ReportState == "reported" && !c.RecordingReported && c.RecordingURL != "":
		s.reportRecording(ctx, c)
	}
}

// ------------------------------------------------------------------------------------------------------------- the person's part

func (s *server) hangupCall(ctx context.Context, sc scope, id string) (*callRow, error) {
	c, err := s.ownCall(ctx, sc, id)
	if err != nil {
		return nil, err
	}
	if c.EndedAt == nil && c.ccid() != "" {
		if err = s.carrier.action(ctx, c.ccid(), "hangup", nil); err != nil {
			return nil, &apiError{502, "carrier", "The carrier did not end the call: " + err.Error()}
		}
	}
	return c, nil
}

func (s *server) transferCall(ctx context.Context, sc scope, id, to string) (*callRow, error) {
	c, err := s.ownCall(ctx, sc, id)
	if err != nil {
		return nil, err
	}
	target := e164(to)
	if strings.HasPrefix(to, "sip:") {
		target = to
	}
	if target == "" {
		return nil, bad("Transfer to a phone number or a sip: address.")
	}
	if c.EndedAt != nil || c.AnsweredAt == nil {
		return nil, conflictErr("Only a call in progress can be transferred.")
	}
	if _, err = s.st.db.Exec(ctx, `UPDATE calls SET transfer_to = $2, updated_at = now() WHERE id = $1`, c.ID, target); err != nil {
		return nil, err
	}
	if err = s.carrier.action(ctx, c.ccid(), "transfer", map[string]any{"to": target, "from": c.FromNumber,
		"client_state": base64.StdEncoding.EncodeToString([]byte(c.ID + ":transfer"))}); err != nil {
		return nil, &apiError{502, "carrier", "The carrier did not transfer the call: " + err.Error()}
	}
	return s.loadCall(ctx, nil, `id = $1`, c.ID)
}

type wrapAsk struct {
	Outcome    string `json:"outcome"`
	CallbackAt string `json:"callback_at"`
	Notes      string `json:"notes"`
}

// wrapUp is the person saying how a call went. "auto" means "use what the carrier said". It can come before the hangup.
func (s *server) wrapUp(ctx context.Context, sc scope, id string, ask wrapAsk) (*callRow, error) {
	c, err := s.ownCall(ctx, sc, id)
	if err != nil {
		return nil, err
	}
	label := validDisposition(ask.Outcome)
	if strings.EqualFold(ask.Outcome, "auto") {
		label = "auto"
	}
	if label == "" {
		return nil, bad(fmt.Sprintf("Choose one of: %s, or auto.", strings.Join(dispositions, ", ")))
	}
	var callback *time.Time
	if label == "Callback" {
		t, err := time.Parse(time.RFC3339, ask.CallbackAt)
		if err != nil {
			return nil, bad("A callback needs a time (callback_at, like 2026-11-16T15:00:00-05:00).")
		}
		callback = &t
	}
	if c.ReportState == "reported" || c.ReportState == "failed" || c.ReportState == "skipped" {
		return nil, conflictErr("This call is already logged.")
	}
	if _, err = s.st.db.Exec(ctx, `UPDATE calls SET disposition = $2, callback_at = $3, notes = $4,
			settle_after = CASE WHEN report_state IN ('due', 'wrapup') THEN $5::timestamptz ELSE settle_after END,
			report_state = CASE WHEN report_state = 'wrapup' THEN 'due' ELSE report_state END, updated_at = now() WHERE id = $1`,
		c.ID, label, callback, strings.TrimSpace(ask.Notes), s.now()); err != nil {
		return nil, err
	}
	if c.EndedAt != nil {
		s.settleCall(ctx, c.ID)
	}
	return s.loadCall(ctx, nil, `id = $1`, c.ID)
}

// ownCall is a call the person made or took; someone who sees the whole workspace may act on any of its calls.
func (s *server) ownCall(ctx context.Context, sc scope, id string) (*callRow, error) {
	if !validID(id) {
		return nil, notFound("No such call.")
	}
	c, err := s.loadCall(ctx, nil, `id = $1 AND org_id = $2`, id, sc.orgID)
	if err != nil {
		return nil, err
	}
	if c == nil || (c.UserID != sc.userID && !sc.wide()) {
		return nil, notFound("No such call.")
	}
	return c, nil
}

// ------------------------------------------------------------------------------------------------------------- settling

// settleSoon settles a call once its settle delay has passed; the periodic sweep catches any it misses.
func (s *server) settleSoon(id string) {
	if s.cfg.noTimers {
		return
	}
	if s.cfg.settleDelay <= 0 {
		s.settleCall(context.Background(), id)
		return
	}
	time.AfterFunc(s.cfg.settleDelay+50*time.Millisecond, func() { s.settleCall(context.Background(), id) })
}

func (s *server) settleDue(ctx context.Context) {
	rows, err := s.st.db.Query(ctx, `SELECT id::text FROM calls WHERE report_state IN ('due', 'wrapup') AND settle_after <= $1 ORDER BY settle_after LIMIT 100`, s.now())
	if err != nil {
		log.Printf("ERROR settle: %v", err)
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		log.Printf("ERROR settle: %v", err)
		return
	}
	for _, id := range ids {
		s.settleCall(ctx, id)
	}
}

func (s *server) settlePeriodically(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.settleDue(ctx)
		}
	}
}

// settleCall decides a finished call's outcome and logs it in the CRM. One copy works on a call at a time (the row lock);
// the CRM's operation id is the call id, so even a report sent twice is logged once.
func (s *server) settleCall(ctx context.Context, id string) {
	if err := s.settle(ctx, id); err != nil {
		log.Printf("ERROR settle call %s: %v", id, err)
	}
}

func (s *server) settle(ctx context.Context, id string) error {
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	c, err := s.loadCall(ctx, tx, `id = $1 AND report_state IN ('due', 'wrapup') AND settle_after <= $2 FOR UPDATE SKIP LOCKED`, id, s.now())
	if err != nil || c == nil {
		return err
	}
	set := func(sql string, args ...any) error {
		_, err := tx.Exec(ctx, `UPDATE calls SET `+sql+`, updated_at = now() WHERE id = $1`, append([]any{c.ID}, args...)...)
		return err
	}
	f := c.facts(s.now())
	label, wait := classify(f)
	if wait {
		if c.ReportState == "due" {
			if err = set(`report_state = 'wrapup', settle_after = $2`, s.now().Add(s.cfg.wrapup)); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	if label == "" {
		if err = set(`report_state = 'skipped', crm_message = $2`, reason(f)+": not logged on a lead"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	lead := ""
	if c.LeadID != nil {
		lead = *c.LeadID
	} else {
		found, err := s.crm.findLead(ctx, c.OrgID, c.UserID, c.FromNumber)
		if err != nil || !found.Found {
			msg := "No lead has this number"
			if err != nil {
				msg = "The CRM could not look up the number: " + err.Error()
			}
			if err = set(`report_state = 'skipped', outcome = $2, crm_message = $3`, label, msg); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		lead = found.LeadID
		if err = set(`lead_id = $2`, lead); err != nil {
			return err
		}
	}
	payload := s.callPayload(c, f, label, lead)
	answer, err := s.crm.recordCall(ctx, c.OrgID, c.UserID, c.ID, payload)
	var refused errCRMRefused
	switch {
	case errors.As(err, &refused):
		err = set(`report_state = 'failed', outcome = $2, crm_status = 'refused', crm_message = $3`, label, refused.message)
	case err != nil:
		// The CRM is away: try again later, less often each time, and give up after a day.
		wait := time.Duration(math.Min(float64(time.Hour), float64(time.Duration(1<<min(c.Attempts, 12))*time.Second*5)))
		state := "due"
		if c.Attempts >= 30 {
			state = "failed"
		}
		log.Printf("WARN call %s: the CRM did not take the report (attempt %d): %v", c.ID, c.Attempts+1, err)
		err = set(`report_state = $2, attempts = attempts + 1, settle_after = $3, outcome = $4, crm_message = $5`, state, s.now().Add(wait), label, err.Error())
	case answer.Status == "applied" || answer.Status == "duplicate":
		err = set(`report_state = 'reported', outcome = $2, crm_status = $3, crm_message = '', recording_reported = recording_url <> ''`, label, answer.Status)
	default:
		err = set(`report_state = 'failed', outcome = $2, crm_status = $3, crm_message = $4`, label, answer.Status, answer.Message)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// callPayload is the CRM's call.record operation for the call (services/crm-core/ops.go, callRecord).
func (s *server) callPayload(c *callRow, f facts, label, lead string) map[string]any {
	phone := c.ToNumber
	if c.Direction == "incoming" {
		phone = c.FromNumber
	}
	occurred := c.CreatedAt
	if c.InitiatedAt != nil {
		occurred = *c.InitiatedAt
	}
	seconds := func(a, b *time.Time) int {
		if a == nil || b == nil || b.Before(*a) {
			return 0
		}
		return int(b.Sub(*a).Round(time.Second) / time.Second)
	}
	talk := seconds(c.AnsweredAt, c.EndedAt)
	ring := seconds(c.InitiatedAt, c.AnsweredAt)
	if c.AnsweredAt == nil {
		ring = seconds(c.InitiatedAt, c.EndedAt)
	}
	details := map[string]any{
		"carrier": "telnyx", "route": c.Route, "simulated": c.Route == "telnyx-sim", "direction": c.Direction,
		"from": c.FromNumber, "to": c.ToNumber, "call_control_id": c.ccid(), "call_session_id": c.CallSessionID,
		"ring_seconds": ring, "talk_seconds": talk, "duration_seconds": seconds(c.InitiatedAt, c.EndedAt),
		"billed_minutes": int(math.Ceil(float64(talk) / 60)),
		"hangup_cause":   c.HangupCause, "hangup_source": c.HangupSource, "sip_code": c.SIPCode,
		"answered": f.Answered, "machine_detection": c.AMDResult, "greeting": c.Greeting,
		"voicemail_dropped": c.VoicemailDropped, "transferred_to": c.TransferTo, "reason": reason(f),
	}
	if c.Scenario != "" {
		details["scenario"] = c.Scenario
	}
	if c.RecordingURL != "" {
		details["recording_url"] = c.RecordingURL
	}
	payload := map[string]any{
		"lead_id": lead, "outcome": label, "phone": phone, "occurred_at": occurred.UTC().Format(time.RFC3339),
		"source": c.Route, "source_record_id": firstNonEmpty(c.CallSessionID, c.ccid()), "notes": c.Notes, "details": details,
	}
	if c.CallbackAt != nil {
		payload["callback_at"] = c.CallbackAt.Format(time.RFC3339)
	}
	if c.RecordingStartedAt != nil {
		payload["recording_started_at"] = c.RecordingStartedAt.UTC().Format(time.RFC3339)
	}
	if c.RecordingEndedAt != nil {
		payload["recording_ended_at"] = c.RecordingEndedAt.UTC().Format(time.RFC3339)
	}
	return payload
}

// reportRecording adds a recording that was saved after the call was logged.
func (s *server) reportRecording(ctx context.Context, c *callRow) {
	payload := map[string]any{"call_operation_id": c.ID, "recording_url": c.RecordingURL}
	if c.RecordingStartedAt != nil {
		payload["recording_started_at"] = c.RecordingStartedAt.UTC().Format(time.RFC3339)
	}
	if c.RecordingEndedAt != nil {
		payload["recording_ended_at"] = c.RecordingEndedAt.UTC().Format(time.RFC3339)
	}
	answer, err := s.crm.addRecording(ctx, c.OrgID, c.UserID, derivedID(c.ID, "recording"), payload)
	if err != nil || (answer.Status != "applied" && answer.Status != "duplicate") {
		log.Printf("WARN call %s: the recording was not added to the CRM: %v %s", c.ID, err, answer.Message)
		return
	}
	_, _ = s.st.db.Exec(ctx, `UPDATE calls SET recording_reported = true, updated_at = now() WHERE id = $1`, c.ID)
}

// ------------------------------------------------------------------------------------------------------------- helpers

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// derivedID is a fixed id made from another (a name-based UUID), so a retried request carries the same id.
func derivedID(id, name string) string {
	h := sha1.Sum([]byte(id + ":" + name))
	h[6] = h[6]&0x0f | 0x50
	h[8] = h[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

// e164 turns a US or international number into +<digits>; an empty answer means it is not a number.
func e164(phone string) string {
	phone = strings.TrimSpace(phone)
	digits := nonDigits.ReplaceAllString(phone, "")
	switch {
	case len(digits) == 10:
		return "+1" + digits
	case len(digits) == 11 && digits[0] == '1':
		return "+" + digits
	case strings.HasPrefix(phone, "+") && len(digits) >= 8 && len(digits) <= 15:
		return "+" + digits
	}
	return ""
}

// maskNumber keeps a number's last four digits for the log.
func maskNumber(n string) string {
	if len(n) <= 4 {
		return n
	}
	return strings.Repeat("*", len(n)-4) + n[len(n)-4:]
}
