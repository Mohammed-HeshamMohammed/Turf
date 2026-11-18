package main

// Build step 26, part B: captions during a call and what they tell the agent (migrations/0007_captions_signals.sql).
//
//   - When a call is answered and the agency requires captions, or the AI's suggestions are on for the caller (the CRM says which, D148),
//     the carrier transcribes the lead's side (Telnyx transcription_start, English, D285). Finished lines are kept; captions pause with
//     the recording (D277).
//   - Each line is read for practical signals with a clear action (D362): a callback asked for, with the time filled in inside calling
//     hours (D359); agreeing to meet, which opens booking (D360, with step 28); an opt-out, for this agency or for anyone, which the agent
//     confirms and which never blocks on its own (D352, D351); asked about price, wants to sell soon, mentioned another buyer. Nobody is
//     scored on mood.
//   - The call's outcome is pre-selected from them for the wrap-up (D361); the agent confirms it or picks another.
//   - The reading here is word rules, the same for every agency: it learns nothing from anyone's calls, so nothing crosses between
//     agencies or clients (D146). The AI's own reading comes with the in-app assistant (part C).
//   - Captions and recordings past the agency's keeping time are removed (D147).

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	digitsAndLetters = regexp.MustCompile(`[^a-z0-9 ]+`)
	callbackAsk      = regexp.MustCompile(`\b(call|try|ring|reach) (me|us) (back )?(again )?(tomorrow|today|tonight|later|next week|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (an|a|one|two|\d+) (hour|hours|minute|minutes)|after \d|at \d)`)
	callbackLater    = regexp.MustCompile(`\b(call back|callback|call again) (tomorrow|today|tonight|later|next week|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at \d)`)
	atHour           = regexp.MustCompile(`\b(at|after|around) (\d{1,2})(?: (\d{2}))? ?(am|pm|a m|p m|in the morning|in the evening|in the afternoon)?\b`)
	inSpan           = regexp.MustCompile(`\bin (an|a|one|two|\d+) (hour|hours|minute|minutes)\b`)
	weekday          = regexp.MustCompile(`\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b`)
)

var signalWords = map[string][]string{
	"opt_out_anyone": {"all these companies", "all you companies", "all these calls", "calls from anyone", "anyone calling me", "everyone calling me",
		"nobody call me", "no one call me", "put me on the do not call list", "on the do not call list"},
	"opt_out": {"stop calling", "dont call me", "do not call me", "dont call this number", "never call", "take me off", "remove me", "remove my number",
		"leave me alone", "not interested stop", "lose my number"},
	"meeting": {"lets meet", "we can meet", "i can meet", "come by", "come over", "stop by", "set up a meeting", "set up an appointment", "make an appointment",
		"book a time", "see the house", "see the property", "walk through", "look at the house"},
	"asked_price": {"how much", "what price", "your offer", "what would you pay", "whats the offer", "what is the offer", "cash offer", "what can you offer",
		"what are you offering", "make me an offer"},
	"sell_soon": {"sell soon", "sell quickly", "need to sell", "have to sell", "sell fast", "asap", "as soon as possible", "moving soon", "this month",
		"before the end of the month", "behind on payments", "foreclosure"},
	"other_buyer": {"another buyer", "other buyer", "another offer", "other offers", "another investor", "other investors", "a realtor", "my realtor",
		"an agent", "listed with", "listing it", "already have an offer"},
}

// spoken is a caption line in lower-case letters and digits ("5:30" is "5 30", "don't" is "dont").
func spoken(text string) string {
	t := strings.ToLower(strings.NewReplacer("'", "", "’", "").Replace(text))
	t = digitsAndLetters.ReplaceAllString(t, " ")
	return " " + strings.TrimSpace(spaces.ReplaceAllString(t, " ")) + " "
}

type signalHit struct {
	kind string
	at   *time.Time // a callback's time
}

// readSignals reads one finished caption line of the lead. now and zone place a callback's time; from and until are calling hours.
func readSignals(text string, now time.Time, zone *time.Location, from, until int) []signalHit {
	w := spoken(text)
	var hits []signalHit
	for _, kind := range []string{"opt_out_anyone", "opt_out", "meeting", "asked_price", "sell_soon", "other_buyer"} {
		for _, p := range signalWords[kind] {
			if strings.Contains(w, " "+p+" ") {
				hits = append(hits, signalHit{kind: kind})
				break
			}
		}
	}
	// "No calls from anyone" includes "this agency".
	if len(hits) > 0 && hits[0].kind == "opt_out_anyone" && (len(hits) < 2 || hits[1].kind != "opt_out") {
		hits = append(hits, signalHit{kind: "opt_out"})
	}
	if callbackAsk.MatchString(w) || callbackLater.MatchString(w) {
		at := callbackTime(w, now, zone, from, until)
		hits = append(hits, signalHit{kind: "callback", at: &at})
	}
	return hits
}

// callbackTime turns "tomorrow at 5", "in an hour", "on friday" into a time inside calling hours, in the agency's time zone (the lead's
// own once leads carry one).
func callbackTime(w string, now time.Time, zone *time.Location, from, until int) time.Time {
	if zone == nil {
		zone = time.UTC
	}
	local := now.In(zone)
	if m := inSpan.FindStringSubmatch(w); m != nil {
		n := map[string]int{"an": 1, "a": 1, "one": 1, "two": 2}[m[1]]
		if n == 0 {
			n, _ = strconv.Atoi(m[1])
		}
		unit := time.Minute
		if strings.HasPrefix(m[2], "hour") {
			unit = time.Hour
		}
		return textingWindowIn(local.Add(time.Duration(n)*unit), zone, from, until)
	}
	day, dayGiven := local, false
	switch {
	case strings.Contains(w, " tomorrow "):
		day, dayGiven = local.AddDate(0, 0, 1), true
	case strings.Contains(w, " next week "):
		day, dayGiven = local.AddDate(0, 0, 7), true
	case weekday.MatchString(w):
		want := map[string]time.Weekday{"sunday": 0, "monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6}[weekday.FindString(w)]
		ahead := (int(want) - int(local.Weekday()) + 7) % 7
		if ahead == 0 {
			ahead = 7
		}
		day, dayGiven = local.AddDate(0, 0, ahead), true
	}
	hour, minute := -1, 0
	if m := atHour.FindStringSubmatch(w); m != nil {
		hour, _ = strconv.Atoi(m[2])
		minute, _ = strconv.Atoi(m[3])
		pm := strings.HasPrefix(m[4], "p") || strings.Contains(m[4], "evening") || strings.Contains(m[4], "afternoon")
		am := strings.HasPrefix(m[4], "a") || strings.Contains(m[4], "morning")
		switch {
		case pm && hour < 12:
			hour += 12
		case !am && !pm && hour >= 1 && hour < 8: // "at 5" on a call means the afternoon
			hour += 12
		}
		if hour > 23 || minute > 59 {
			hour, minute = -1, 0
		}
	}
	switch {
	case hour >= 0:
	case strings.Contains(w, " tonight "):
		hour = 18
	case strings.Contains(w, " later ") && !dayGiven:
		return textingWindowIn(local.Add(2*time.Hour), zone, from, until)
	default:
		hour = 10
	}
	at := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, zone)
	if !dayGiven && !at.After(local) {
		at = at.AddDate(0, 0, 1)
	}
	return textingWindowIn(at, zone, from, until)
}

// suggestOutcome is the wrap-up's pre-selected outcome from the call's signals (D361): an opt-out first, then a callback, then a meeting.
func suggestOutcome(kinds []string) string {
	has := func(k string) bool {
		for _, x := range kinds {
			if x == k {
				return true
			}
		}
		return false
	}
	switch {
	case has("opt_out") || has("opt_out_anyone"):
		return "Do not call"
	case has("callback"):
		return "Callback"
	case has("meeting"):
		return "Transfer"
	}
	return ""
}

// startCaptions asks the carrier to transcribe the lead's side of an answered call.
func (s *server) startCaptions(ctx context.Context, c *callRow) {
	if c.CallControlID == nil {
		return
	}
	if err := s.carrier.action(ctx, *c.CallControlID, "transcription_start", map[string]any{"language": "en", "transcription_engine": "B",
		"transcription_tracks": "inbound", "client_state": base64.StdEncoding.EncodeToString([]byte(c.ID))}); err != nil {
		log.Printf("WARN call %s: transcription_start: %v", c.ID, err)
	}
}

// captionHeard keeps a finished caption line and reads it for signals.
func (s *server) captionHeard(ctx context.Context, ev event, c *callRow) error {
	data, _ := ev.Payload["transcription_data"].(map[string]any)
	text, _ := data["transcript"].(string)
	final, _ := data["is_final"].(bool)
	text = strings.TrimSpace(text)
	if !final || text == "" || !c.Captions || c.CaptionsPaused {
		return nil
	}
	if len(text) > 2000 {
		text = text[:2000]
	}
	at := ev.OccurredAt
	if at.IsZero() {
		at = s.now()
	}
	if _, err := s.st.db.Exec(ctx, `INSERT INTO call_captions (call_id, org_id, at, speaker, text) VALUES ($1, $2, $3, 'lead', $4)`, c.ID, c.OrgID, at, text); err != nil {
		return err
	}
	from, until, zone := s.contactWindow(ctx, c.OrgID)
	hits := readSignals(text, s.now(), zone, from, until)
	for _, h := range hits {
		if _, err := s.st.db.Exec(ctx, `INSERT INTO call_signals (call_id, org_id, lead_id, kind, said, suggested_at) VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (call_id, kind) DO UPDATE SET said = EXCLUDED.said, suggested_at = coalesce(EXCLUDED.suggested_at, call_signals.suggested_at)
			WHERE call_signals.decision = ''`, c.ID, c.OrgID, c.LeadID, h.kind, truncate(text, 300), h.at); err != nil {
			return err
		}
	}
	if len(hits) == 0 {
		return nil
	}
	return s.presetOutcome(ctx, c.ID)
}

// presetOutcome sets the call's pre-selected outcome from its signals that were not dismissed.
func (s *server) presetOutcome(ctx context.Context, call string) error {
	rows, err := s.st.db.Query(ctx, `SELECT kind FROM call_signals WHERE call_id = $1 AND decision <> 'dismissed'`, call)
	if err != nil {
		return err
	}
	kinds, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	_, err = s.st.db.Exec(ctx, `UPDATE calls SET suggested_outcome = $2, updated_at = now() WHERE id = $1`, call, suggestOutcome(kinds))
	return err
}

// mayReadCall is the call's agent, or someone who may join or review the lead's team's calls (the lead's rank).
func (s *server) mayReadCall(ctx context.Context, sc scope, id string) (*callRow, error) {
	if !validID(id) {
		return nil, notFound("No such call.")
	}
	c, err := s.loadCall(ctx, nil, `id = $1 AND org_id = $2`, id, sc.orgID)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, notFound("No such call.")
	}
	if c.UserID == sc.userID || sc.wide() {
		return c, nil
	}
	if c.LeadID != nil {
		if lead, err := s.crm.lead(ctx, sc.orgID, sc.userID, *c.LeadID); err == nil && (lead.Rank == "owner" || lead.Rank == "lead" || lead.Rank == "deputy") {
			return c, nil
		}
	}
	return nil, notFound("No such call.")
}

// callCaptions is GET /api/v1/calls/{id}/captions: the lines, the signals and the pre-selected outcome.
func (s *server) callCaptions(ctx context.Context, sc scope, id string) (map[string]any, error) {
	c, err := s.mayReadCall(ctx, sc, id)
	if err != nil {
		return nil, err
	}
	lines, err := s.st.db.Query(ctx, `SELECT jsonb_build_object('at', at, 'speaker', speaker, 'text', text) FROM call_captions WHERE call_id = $1 ORDER BY id`, c.ID)
	if err != nil {
		return nil, err
	}
	captions, err := pgx.CollectRows(lines, pgx.RowTo[map[string]any])
	if err != nil {
		return nil, err
	}
	signals, err := s.signalsWhere(ctx, `call_id = $1`, `ORDER BY created_at`, c.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"call_id": c.ID, "captions": captions, "signals": signals, "suggested_outcome": c.SuggestedOutcome,
		"suggestions": c.Suggestions, "captions_on": c.Captions, "captions_paused": c.CaptionsPaused}, nil
}

func (s *server) signalsWhere(ctx context.Context, where, tail string, args ...any) ([]map[string]any, error) {
	rows, err := s.st.db.Query(ctx, `SELECT jsonb_build_object('id', id, 'call_id', call_id, 'kind', kind, 'said', said, 'suggested_at', suggested_at,
		'created_at', created_at, 'decision', decision, 'decided_by', decided_by, 'decided_at', decided_at) FROM call_signals WHERE `+where+` `+tail, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[map[string]any])
}

// decideSignal is POST /api/v1/calls/{id}/signals/{signal} {confirm}: the call's agent confirms or dismisses a signal. Confirming an
// opt-out marks the call "Do not call" (for anyone when the lead said so, D351) and confirming a callback fills in its time; both are
// logged when the call is (the wrap-up can still change them).
func (s *server) decideSignal(ctx context.Context, sc scope, id, signal string, confirm bool) (map[string]any, error) {
	c, err := s.ownCall(ctx, sc, id)
	if err != nil {
		return nil, err
	}
	if !validID(signal) {
		return nil, notFound("No such signal.")
	}
	if c.ReportState == "reported" || c.ReportState == "failed" || c.ReportState == "skipped" {
		return nil, conflictErr("This call is already logged.")
	}
	decision := map[bool]string{true: "confirmed", false: "dismissed"}[confirm]
	var kind string
	var at *time.Time
	err = s.st.db.QueryRow(ctx, `UPDATE call_signals SET decision = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND call_id = $2
		RETURNING kind, suggested_at`, signal, c.ID, decision, sc.userID).Scan(&kind, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("No such signal.")
	}
	if err != nil {
		return nil, err
	}
	if confirm {
		switch kind {
		case "opt_out", "opt_out_anyone":
			dnc := map[string]string{"opt_out": "agency", "opt_out_anyone": "anyone"}[kind]
			_, err = s.st.db.Exec(ctx, `UPDATE calls SET disposition = 'Do not call', dnc_kind = CASE WHEN dnc_kind = 'anyone' THEN dnc_kind ELSE $2 END, updated_at = now() WHERE id = $1`, c.ID, dnc)
		case "callback":
			_, err = s.st.db.Exec(ctx, `UPDATE calls SET disposition = CASE WHEN disposition = '' THEN 'Callback' ELSE disposition END,
				callback_at = coalesce(callback_at, $2), updated_at = now() WHERE id = $1`, c.ID, at)
		}
		if err != nil {
			return nil, err
		}
	}
	if err = s.presetOutcome(ctx, c.ID); err != nil {
		return nil, err
	}
	if c.EndedAt != nil {
		s.settleCall(ctx, c.ID)
	}
	return map[string]any{"id": signal, "kind": kind, "decision": decision}, nil
}

// leadSignals is GET /api/v1/leads/{id}/signals: what earlier calls with this lead brought up, for the next call (D142). Only this
// agency's calls with this lead, so nothing crosses between agencies or clients (D146).
func (s *server) leadSignals(ctx context.Context, sc scope, lead string) ([]map[string]any, error) {
	if !validID(lead) {
		return nil, notFound("No such lead.")
	}
	if _, err := s.crm.lead(ctx, sc.orgID, sc.userID, lead); err != nil {
		var refused errCRMRefused
		if errors.As(err, &refused) {
			return nil, notFound(refused.message)
		}
		return nil, err
	}
	return s.signalsWhere(ctx, `org_id = $1 AND lead_id = $2 AND decision <> 'dismissed'`, `ORDER BY created_at DESC LIMIT 50`, sc.orgID, lead)
}

// forgetOldCalls removes captions, and the address of recordings, past each agency's keeping time (D147).
func (s *server) forgetOldCalls(ctx context.Context) error {
	if _, err := s.st.db.Exec(ctx, `DELETE FROM call_captions cc USING sms_settings ss WHERE ss.org_id = cc.org_id AND ss.call_keep_days IS NOT NULL
		AND cc.at < now() - make_interval(days => ss.call_keep_days)`); err != nil {
		return err
	}
	_, err := s.st.db.Exec(ctx, `UPDATE calls c SET recording_url = '', updated_at = now() FROM sms_settings ss WHERE ss.org_id = c.org_id
		AND ss.call_keep_days IS NOT NULL AND c.recording_url <> '' AND c.created_at < now() - make_interval(days => ss.call_keep_days)`)
	return err
}

// putCallKeep is PUT /api/v1/calls/keep {days}: the owner or an admin sets how long recordings and captions are kept; null keeps them
// until Caller Whale's limit.
func (s *server) putCallKeep(ctx context.Context, sc scope, days *int) error {
	if !sc.can("admin") {
		return forbidden("The owner or an admin sets how long recordings and captions are kept.")
	}
	if days != nil && (*days < 7 || *days > 3650) {
		return bad("Keep recordings and captions from 7 days to 10 years.")
	}
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_settings (org_id, call_keep_days) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET call_keep_days = EXCLUDED.call_keep_days`, sc.orgID, days)
	return err
}
