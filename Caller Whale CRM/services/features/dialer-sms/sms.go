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
	ID         string    `db:"id" json:"id"`
	OrgID      string    `db:"org_id" json:"org_id"`
	UserID     *string   `db:"user_id" json:"user_id"`
	LeadID     *string   `db:"lead_id" json:"lead_id"`
	Direction  string    `db:"direction" json:"direction"`
	FromNumber string    `db:"from_number" json:"from"`
	ToNumber   string    `db:"to_number" json:"to"`
	Body       string    `db:"body" json:"body"`
	CarrierID  *string   `db:"carrier_id" json:"carrier_id"`
	Route      string    `db:"route" json:"route"`
	Status     string    `db:"status" json:"status"`
	Error      string    `db:"error" json:"error"`
	CreatedAt  time.Time `db:"created_at" json:"created_at"`
	UpdatedAt  time.Time `db:"updated_at" json:"updated_at"`
}

var (
	stopWords  = []string{"stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out", "opt-out"}
	startWords = []string{"start", "unstop", "yes", "subscribe"}
)

type textAsk struct {
	LeadID   string `json:"lead_id"`
	Text     string `json:"text"`
	From     string `json:"from"`
	Scenario string `json:"scenario"` // simulate mode only: sms_delivered or sms_failed
}

func (s *server) sendText(ctx context.Context, sc scope, ask textAsk) (*smsRow, error) {
	if !sc.can("message") {
		return nil, forbidden("Your role does not allow texting.")
	}
	text := strings.TrimSpace(ask.Text)
	if text == "" || len([]rune(text)) > 1600 {
		return nil, bad("Write a text of up to 1,600 characters.")
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
	if lead.DoNotCall {
		return nil, conflictErr("This lead is do-not-call; they cannot be texted.")
	}
	to := e164(lead.Phone)
	if to == "" {
		return nil, conflictErr("The lead's phone number cannot receive texts.")
	}
	var why string
	err = s.st.db.QueryRow(ctx, `SELECT CASE
			WHEN EXISTS (SELECT 1 FROM sms_opt_outs WHERE org_id = $1 AND phone_number = $2) THEN 'stop'
			WHEN EXISTS (SELECT 1 FROM sms_messages WHERE org_id = $1 AND from_number = $2 AND direction = 'incoming') THEN ''
			WHEN EXISTS (SELECT 1 FROM sms_consents WHERE org_id = $1 AND phone_number = $2) THEN ''
			ELSE 'no_conversation' END`, sc.orgID, to).Scan(&why)
	if err != nil {
		return nil, err
	}
	switch why {
	case "stop":
		return nil, conflictErr("This number replied STOP. It cannot be texted until it sends START.")
	case "no_conversation":
		return nil, conflictErr("Texting is for conversations: the lead must text first, or have agreed to texts on a form or a call.")
	}
	from, err := s.callerID(ctx, sc, ask.From, "texts")
	if err != nil {
		return nil, err
	}
	id := newUUID()
	if _, err = s.st.db.Exec(ctx, `INSERT INTO sms_messages (id, org_id, user_id, lead_id, direction, from_number, to_number, body, route)
		VALUES ($1, $2, $3, $4, 'outgoing', $5, $6, $7, $8)`, id, sc.orgID, sc.userID, ask.LeadID, from, to, text, s.route()); err != nil {
		return nil, err
	}
	scenario := ""
	if s.cfg.simulate {
		scenario = ask.Scenario
	}
	carrierID, err := s.carrier.sendText(withScenario(ctx, scenario), from, to, text)
	if err != nil {
		log.Printf("WARN text %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE sms_messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, id, err.Error())
		return nil, &apiError{502, "carrier", "The carrier did not take the text. Try again in a moment."}
	}
	if _, err = s.st.db.Exec(ctx, `UPDATE sms_messages SET carrier_id = $2, updated_at = now() WHERE id = $1`, id, carrierID); err != nil {
		return nil, err
	}
	// A delivery report can come before the carrier's answer: apply any that are waiting for this text.
	if err = s.replayTextEvents(ctx, carrierID); err != nil {
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
	word := strings.ToLower(strings.Trim(strings.TrimSpace(text), ".!"))
	switch {
	case slices.Contains(stopWords, word):
		_, err = tx.Exec(ctx, `INSERT INTO sms_opt_outs (org_id, phone_number, keyword) VALUES ($1, $2, $3) ON CONFLICT (org_id, phone_number) DO UPDATE SET keyword = EXCLUDED.keyword, at = now()`, org, from, word)
	case slices.Contains(startWords, word):
		_, err = tx.Exec(ctx, `DELETE FROM sms_opt_outs WHERE org_id = $1 AND phone_number = $2`, org, from)
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	// Which lead wrote: the thread is theirs. Done after the text is safe, so a CRM outage loses nothing.
	if lead, err := s.crm.findLead(ctx, org, user, from); err == nil && lead.Found {
		_, _ = s.st.db.Exec(ctx, `UPDATE sms_messages SET lead_id = $2, updated_at = now() WHERE id = $1`, id, lead.LeadID)
		_, _ = s.st.db.Exec(ctx, `UPDATE sms_messages SET lead_id = $3 WHERE org_id = $1 AND to_number = $2 AND lead_id IS NULL`, org, from, lead.LeadID)
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

func (s *server) textConsent(ctx context.Context, sc scope, lead, source string) error {
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
	_, err = s.st.db.Exec(ctx, `INSERT INTO sms_consents (org_id, phone_number, source, user_id) VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id, phone_number) DO UPDATE SET source = EXCLUDED.source, user_id = EXCLUDED.user_id, at = now()`, sc.orgID, phone, source, sc.userID)
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
