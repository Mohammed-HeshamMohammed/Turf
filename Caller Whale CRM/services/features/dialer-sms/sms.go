package main

// Texts with leads. Texting is conversations only (decided 2026-11-14): a lead may be texted when they texted first, gave
// consent on a form, or agreed on a call. A number that sent STOP is never texted by that workspace again until it sends
// START. The carrier's delivery reports move a text forward (queued, sent, delivered or failed) and never back.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type smsRow struct {
	ID         string     `db:"id" json:"id"`
	OrgID      string     `db:"org_id" json:"org_id"`
	UserID     *string    `db:"user_id" json:"user_id"`
	LeadID     *string    `db:"lead_id" json:"lead_id"`
	Direction  string     `db:"direction" json:"direction"`
	FromNumber string     `db:"from_number" json:"from"`
	ToNumber   string     `db:"to_number" json:"to"`
	Body       string     `db:"body" json:"body"`
	CarrierID  *string    `db:"carrier_id" json:"carrier_id"`
	Route      string     `db:"route" json:"route"`
	Status     string     `db:"status" json:"status"`
	Error      string     `db:"error" json:"error"`
	CreatedAt  time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt  time.Time  `db:"updated_at" json:"updated_at"`
	SendAt     *time.Time `db:"send_at" json:"send_at"`   // a scheduled text's time (step 10)
	BatchID    *string    `db:"batch_id" json:"batch_id"` // one message to many leads
	// A reply read as an opt-out, or waiting for the agent's choice (step 25, D207, D208).
	OptOutQuestion string     `db:"opt_out_question" json:"opt_out_question"`
	OptOutBy       *string    `db:"opt_out_by" json:"opt_out_by"`
	OptOutAt       *time.Time `db:"opt_out_at" json:"opt_out_at"`
	Complaint      bool       `db:"complaint" json:"complaint"` // a reply that complains (step 39)
}

var (
	startWords = []string{"start", "unstop", "yes", "subscribe"}
)

type textAsk struct {
	LeadID   string `json:"lead_id"`
	Text     string `json:"text"`
	From     string `json:"from"`
	Scenario string `json:"scenario"` // simulate mode only: sms_delivered or sms_failed
	// Later instead of now (step 10, D211): sent then, inside the lead's texting hours, unless the number was blocked meanwhile.
	SendAt *time.Time `json:"send_at"`
}

func (s *server) sendText(ctx context.Context, sc scope, ask textAsk) (*smsRow, error) {
	// A time given: the text waits for it (step 10, D211).
	if ask.SendAt != nil {
		return s.scheduleText(ctx, sc, ask, *ask.SendAt, "", false)
	}
	to, lead, err := s.mayText(ctx, sc, ask, false)
	if err != nil {
		return nil, err
	}
	// Only inside the hours leads may be texted (step 21, D151); later ones can be scheduled.
	if err := s.mayContactNow(ctx, sc.orgID); err != nil {
		return nil, err
	}
	if err := s.mayUse(ctx, sc.orgID, sc.userID, lead, "texts"); err != nil {
		return nil, err
	}
	from, err := s.numberFor(ctx, sc, lead, ask.From, "texts")
	if err != nil {
		return nil, err
	}
	id := newUUID()
	if _, err = s.st.db.Exec(ctx, `INSERT INTO sms_messages (id, org_id, user_id, lead_id, direction, from_number, to_number, body, route)
		VALUES ($1, $2, $3, $4, 'outgoing', $5, $6, $7, $8)`, id, sc.orgID, sc.userID, ask.LeadID, from, to, strings.TrimSpace(ask.Text), s.route()); err != nil {
		return nil, err
	}
	m, err := s.deliver(ctx, sc.orgID, ask.LeadID, id, from, to, strings.TrimSpace(ask.Text), ask.Scenario)
	if err == nil {
		s.charge(ctx, sc.orgID, sc.userID, lead, "texts", 1, id) // to the lead's team and the sender (step 22)
	}
	return m, err
}

// sendScheduled sends a text that waited for its time, checking again as its sender is now (a bulk text skips the one-sender rule).
func (s *server) sendScheduled(ctx context.Context, sc scope, id string, ask textAsk, bulk bool) (*smsRow, error) {
	to, lead, err := s.mayText(ctx, sc, ask, bulk)
	if err != nil {
		return nil, err
	}
	if err := s.mayUse(ctx, sc.orgID, sc.userID, lead, "texts"); err != nil {
		return nil, err
	}
	m, err := s.deliver(ctx, sc.orgID, ask.LeadID, id, ask.From, to, ask.Text, "")
	if err == nil {
		s.charge(ctx, sc.orgID, sc.userID, lead, "texts", 1, id)
	}
	return m, err
}

// mayText checks that the person may text the lead now: their role, the conversation's one sender (unless anySender: a bulk text,
// D212), do-not-call, a number that takes texts, STOP, and that texting is a conversation (the lead texted first or agreed).
func (s *server) mayText(ctx context.Context, sc scope, ask textAsk, anySender bool) (string, leadInfo, error) {
	if !sc.can("message") {
		return "", leadInfo{}, forbidden("Your role does not allow texting.")
	}
	// The carriers approved the agency's texting, and its opt-out and complaint rates allow it (step 39).
	if err := s.textingAllowed(ctx, sc.orgID, anySender); err != nil {
		return "", leadInfo{}, err
	}
	text := strings.TrimSpace(ask.Text)
	if text == "" || len([]rune(text)) > 1600 {
		return "", leadInfo{}, bad("Write a text of up to 1,600 characters.")
	}
	if !validID(ask.LeadID) {
		return "", leadInfo{}, bad("Choose a lead (lead_id).")
	}
	lead, thread, err := s.leadThread(ctx, sc, ask.LeadID)
	if err != nil {
		return "", lead, err
	}
	// One person sends in a lead's conversation (step 10, D17).
	if !anySender {
		if err := thread.mustBeSender(sc.userID); err != nil {
			return "", lead, err
		}
	}
	if lead.BlockedTexts {
		why := lead.BlockReason
		if why == "" {
			why = "This number is blocked for texts."
		}
		return "", lead, conflictErr(why)
	}
	if lead.WaitingApproval {
		return "", lead, conflictErr("This list is waiting for its client's approval.")
	}
	to := e164(lead.Phone)
	if to == "" {
		return "", lead, conflictErr("The lead's phone number cannot receive texts.")
	}
	// Consent belongs to the agency, the lead's client and the number (D353, D366): the lead's own reply, a form, the agent marking it
	// on a call, or the agency confirming it for the lead's list. Without contact for 6 months it is confirmed again on a call (D358).
	var why string
	err = s.st.db.QueryRow(ctx, `SELECT CASE
			WHEN EXISTS (SELECT 1 FROM sms_opt_outs WHERE org_id = $1 AND phone_number = $2) THEN 'stop'
			WHEN EXISTS (SELECT 1 FROM sms_messages WHERE org_id = $1 AND lead_id = $3 AND direction = 'incoming' AND opt_out_question = 'waiting') THEN 'choose'
			WHEN NOT ($5 OR EXISTS (SELECT 1 FROM sms_messages WHERE org_id = $1 AND from_number = $2 AND lead_id = $3 AND direction = 'incoming')
				OR EXISTS (SELECT 1 FROM sms_consents WHERE org_id = $1 AND client_key = $4 AND phone_number = $2)) THEN 'no_conversation'
			WHEN greatest(
				(SELECT max(created_at) FROM sms_messages WHERE org_id = $1 AND (from_number = $2 OR to_number = $2) AND status <> 'failed'),
				(SELECT max(at) FROM sms_consents WHERE org_id = $1 AND client_key = $4 AND phone_number = $2),
				(SELECT max(answered_at) FROM calls WHERE org_id = $1 AND (from_number = $2 OR to_number = $2))) < now() - interval '180 days' THEN 'stale'
			ELSE '' END`, sc.orgID, to, ask.LeadID, lead.ClientID, lead.ListConsent).Scan(&why)
	if err != nil {
		return "", lead, err
	}
	switch why {
	case "stop":
		return "", lead, conflictErr("This number opted out of texts. It cannot be texted until it sends START.")
	case "choose":
		return "", lead, conflictErr("The lead's last reply may be an opt-out: choose \"opt-out\" or \"not an opt-out\" first.")
	case "no_conversation":
		return "", lead, conflictErr("Texting needs consent: the lead texted first, agreed on a form or a call, or the agency confirmed it for this list.")
	case "stale":
		return "", lead, conflictErr("No contact with this number for 6 months: confirm on a call that they still agree to texts first.")
	}
	return to, lead, nil
}

// deliver hands a saved text to the carrier and ends the lead's wait.
func (s *server) deliver(ctx context.Context, org, lead, id, from, to, text, scenario string) (*smsRow, error) {
	if !s.cfg.simulate {
		scenario = ""
	}
	carrierID, err := s.carrier.sendText(withScenario(ctx, scenario), from, to, text)
	if err != nil {
		log.Printf("WARN text %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE sms_messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, id, err.Error())
		return nil, &apiError{502, "carrier", "The carrier did not take the text. Try again in a moment."}
	}
	if _, err = s.st.db.Exec(ctx, `UPDATE sms_messages SET carrier_id = $2, status = 'queued', updated_at = now() WHERE id = $1`, id, carrierID); err != nil {
		return nil, err
	}
	// A delivery report can come before the carrier's answer: apply any that are waiting for this text.
	if err = s.replayTextEvents(ctx, carrierID); err != nil {
		return nil, err
	}
	// The lead is answered: their wait ends (step 10).
	if err = s.textAnswered(ctx, org, lead); err != nil {
		return nil, err
	}
	return s.loadText(ctx, `id = $1`, id)
}

func (s *server) loadText(ctx context.Context, where string, args ...any) (*smsRow, error) {
	rows, err := s.st.db.Query(ctx, `SELECT * FROM sms_messages WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	m, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[smsRow])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &m, err
}

var statusRank = map[string]int{"queued": 0, "sent": 1, "delivered": 2, "failed": 2}

// textEvent applies one messaging webhook.
func (s *server) textEvent(ctx context.Context, ev event) error {
	raw, _ := json.Marshal(ev)
	if ev.EventType == "message.received" {
		return s.textReceived(ctx, ev, raw)
	}
	carrierID := ev.str("id")
	msg, err := s.loadText(ctx, `carrier_id = $1`, carrierID)
	if err != nil {
		return err
	}
	var msgID *string
	if msg != nil {
		msgID = &msg.ID
	}
	tag, err := s.st.db.Exec(ctx, `INSERT INTO webhook_events (id, event_type, occurred_at, message_id, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
		ev.ID, ev.EventType, ev.OccurredAt, msgID, raw)
	if err != nil || tag.RowsAffected() == 0 || msg == nil {
		return err // a repeat, or a report for a text whose send has not returned yet (replayTextEvents applies it)
	}
	return s.applyTextStatus(ctx, msg.ID, ev)
}

func (s *server) applyTextStatus(ctx context.Context, id string, ev event) error {
	status, problem := "", ""
	to, _ := ev.Payload["to"].([]any)
	carrierStatus := ""
	if len(to) > 0 {
		if m, ok := to[0].(map[string]any); ok {
			carrierStatus, _ = m["status"].(string)
		}
	}
	switch {
	case ev.EventType == "message.sent":
		status = "sent"
	case ev.EventType == "message.finalized" && (carrierStatus == "delivered" || carrierStatus == "delivery_unconfirmed"):
		status = "delivered"
	case ev.EventType == "message.finalized":
		status = "failed"
		if errs, ok := ev.Payload["errors"].([]any); ok && len(errs) > 0 {
			if m, ok := errs[0].(map[string]any); ok {
				problem = strings.TrimSpace(firstNonEmpty(str(m, "detail"), str(m, "title")) + " " + str(m, "code"))
			}
		}
		if problem == "" {
			problem = carrierStatus
		}
	default:
		return nil
	}
	// Forward only: a late "sent" never undoes "delivered", and the first final answer stays.
	_, err := s.st.db.Exec(ctx, `UPDATE sms_messages SET status = $2, error = $3, updated_at = now()
		WHERE id = $1 AND (CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END) < $4`, id, status, problem, statusRank[status])
	return err
}

func (s *server) replayTextEvents(ctx context.Context, carrierID string) error {
	rows, err := s.st.db.Query(ctx, `SELECT payload FROM webhook_events WHERE message_id IS NULL AND event_type LIKE 'message.%' AND payload->'payload'->>'id' = $1 ORDER BY received_at`, carrierID)
	if err != nil {
		return err
	}
	evs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (event, error) {
		var ev event
		var raw []byte
		if err := r.Scan(&raw); err != nil {
			return ev, err
		}
		return ev, json.Unmarshal(raw, &ev)
	})
	if err != nil {
		return err
	}
	msg, err := s.loadText(ctx, `carrier_id = $1`, carrierID)
	if err != nil || msg == nil {
		return err
	}
	for _, ev := range evs {
		if _, err = s.st.db.Exec(ctx, `UPDATE webhook_events SET message_id = $2 WHERE id = $1`, ev.ID, msg.ID); err != nil {
			return err
		}
		if err = s.applyTextStatus(ctx, msg.ID, ev); err != nil {
			return err
		}
	}
	return nil
}

// textReceived stores a lead's text to a workspace number, links it to the lead, and handles STOP and START.
func (s *server) textReceived(ctx context.Context, ev event, raw []byte) error {
	to, from := e164(ev.phone("to")), e164(ev.phone("from"))
	var org, user string
	err := s.st.db.QueryRow(ctx, `SELECT org_id::text, user_id::text FROM numbers WHERE phone_number = $1 AND texts`, to).Scan(&org, &user)
	if errors.Is(err, pgx.ErrNoRows) {
		log.Printf("WARN text to %s, which no workspace has", maskNumber(to))
		_, err = s.st.db.Exec(ctx, `INSERT INTO webhook_events (id, event_type, occurred_at, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, ev.ID, ev.EventType, ev.OccurredAt, raw)
		return err
	}
	if err != nil {
		return err
	}
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id := newUUID()
	tag, err := tx.Exec(ctx, `INSERT INTO webhook_events (id, event_type, occurred_at, message_id, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
		ev.ID, ev.EventType, ev.OccurredAt, id, raw)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	text := ev.str("text")
	if tag, err = tx.Exec(ctx, `INSERT INTO sms_messages (id, org_id, user_id, direction, from_number, to_number, body, carrier_id, route, status)
		VALUES ($1, $2, $3, 'incoming', $4, $5, $6, $7, $8, 'received') ON CONFLICT (carrier_id) DO NOTHING`,
		id, org, user, from, to, text, ev.str("id"), s.route()); err != nil || tag.RowsAffected() == 0 {
		return err
	}
	// A complaining reply counts toward the agency's complaint rate (step 39, D269).
	if isComplaint(text) {
		if _, err = tx.Exec(ctx, `UPDATE sms_messages SET complaint = true WHERE id = $1`, id); err != nil {
			return err
		}
	}
	// An opt-out reply blocks at once; a reply that only mentions one waits for the agent's choice (step 25, D207, D208).
	word := plainWords(text)
	reading := readOptOut(text)
	started := slices.Contains(startWords, word)
	switch {
	case reading.clear:
		if reading.texts {
			_, err = tx.Exec(ctx, `INSERT INTO sms_opt_outs (org_id, phone_number, keyword) VALUES ($1, $2, $3) ON CONFLICT (org_id, phone_number) DO UPDATE SET keyword = EXCLUDED.keyword, at = now()`, org, from, word)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE sms_messages SET opt_out_question = 'opt_out', opt_out_at = now() WHERE id = $1`, id)
		}
	case reading.unclear:
		_, err = tx.Exec(ctx, `UPDATE sms_messages SET opt_out_question = 'waiting' WHERE id = $1`, id)
	case started:
		_, err = tx.Exec(ctx, `DELETE FROM sms_opt_outs WHERE org_id = $1 AND phone_number = $2`, org, from)
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	// Which lead wrote: the thread is theirs. Done after the text is safe, so a CRM outage loses nothing.
	lead, err := s.crm.findLead(ctx, org, user, from)
	// The agency's block list in the CRM: an opt-out blocks the number there (calls too when asked), START lifts what a reply made.
	switch {
	case reading.clear:
		leadID := ""
		if err == nil && lead.Found {
			leadID = lead.LeadID
		}
		if berr := s.crm.block(ctx, org, user, from, leadID, map[string]any{"calls": reading.calls, "texts": reading.texts, "note": "Replied: " + truncate(text, 200)}); berr != nil {
			log.Printf("WARN the CRM did not take an opt-out from %s: %v", maskNumber(from), berr)
		}
	case started:
		if berr := s.crm.block(ctx, org, user, from, "", map[string]any{"lift": true}); berr != nil {
			log.Printf("WARN the CRM did not take START from %s: %v", maskNumber(from), berr)
		}
	}
	if err == nil && lead.Found {
		_, _ = s.st.db.Exec(ctx, `UPDATE sms_messages SET lead_id = $2, updated_at = now() WHERE id = $1`, id, lead.LeadID)
		_, _ = s.st.db.Exec(ctx, `UPDATE sms_messages SET lead_id = $3 WHERE org_id = $1 AND to_number = $2 AND lead_id IS NULL`, org, from, lead.LeadID)
		// The text now waits for an answer: too long, and the team's leads are told (step 10, D21).
		if !reading.clear {
			// Who works the lead and leads its team, so the right people are told if it waits (asked as the number's owner).
			if _, _, err := s.leadThread(ctx, scope{userID: user, orgID: org}, lead.LeadID); err != nil {
				log.Printf("WARN the thread of lead %s: %v", lead.LeadID, err)
			}
			if err := s.textWaiting(ctx, org, lead.LeadID); err != nil {
				log.Printf("WARN the wait of a text from lead %s: %v", lead.LeadID, err)
			}
		}
	}
	return nil
}

func (s *server) textThread(ctx context.Context, sc scope, lead string) ([]smsRow, error) {
	if !validID(lead) {
		return nil, bad("Choose a lead (lead_id).")
	}
	// The lead must be one the person may see (the CRM decides).
	if _, err := s.crm.lead(ctx, sc.orgID, sc.userID, lead); err != nil {
		var refused errCRMRefused
		if errors.As(err, &refused) {
			return nil, notFound(refused.message)
		}
		return nil, err
	}
	rows, err := s.st.db.Query(ctx, `SELECT * FROM sms_messages WHERE org_id = $1 AND lead_id = $2 ORDER BY created_at, id`, sc.orgID, lead)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[smsRow])
}

func (s *server) textConsent(ctx context.Context, sc scope, lead, source, call string) error {
	if source != "form" && source != "call" {
		return bad("source is form or call.")
	}
	info, err := s.crm.lead(ctx, sc.orgID, sc.userID, lead)
	var refused errCRMRefused
	if errors.As(err, &refused) {
		return notFound(refused.message)
	}
	if err != nil {
		return err
	}
	phone := e164(info.Phone)
	if phone == "" {
		return conflictErr("The lead has no number that can receive texts.")
	}
	if info.BlockedTexts {
		return conflictErr("This number opted out of texts; consent cannot be marked over it.")
	}
	// The consent is for the lead's client only (D366), with the call it was given on when there is one (D354).
	var callID any
	if validID(call) {
		callID = call
	}
	_, err = s.st.db.Exec(ctx, `INSERT INTO sms_consents (org_id, client_key, phone_number, source, user_id, call_id) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (org_id, client_key, phone_number) DO UPDATE SET source = EXCLUDED.source, user_id = EXCLUDED.user_id, call_id = EXCLUDED.call_id, at = now()`,
		sc.orgID, info.ClientID, phone, source, sc.userID, callID)
	return err
}

func str(m map[string]any, name string) string {
	s, _ := m[name].(string)
	return s
}

type scenarioKey struct{}

func withScenario(ctx context.Context, scenario string) context.Context {
	if scenario == "" {
		return ctx
	}
	return context.WithValue(ctx, scenarioKey{}, scenario)
}

func scenarioFrom(ctx context.Context) string {
	s, _ := ctx.Value(scenarioKey{}).(string)
	return s
}
