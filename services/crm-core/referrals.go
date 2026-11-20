package main

// Build step 37 (migrations/0043_referrals.sql): sending a lead to another agency (D248-D254, D373).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *server) referralRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/referrals/agencies", s.member(s.findAgencies))
	mux.Handle("POST /api/v1/leads/{id}/send", s.member(s.sendLead))
	mux.Handle("GET /api/v1/referrals", s.member(s.listReferrals))
	mux.Handle("POST /api/v1/referrals/{id}/accept", s.member(s.acceptReferral))
	mux.Handle("POST /api/v1/referrals/{id}/decline", s.member(s.endReferral("declined")))
	mux.Handle("POST /api/v1/referrals/{id}/cancel", s.member(s.endReferral("cancelled")))
	mux.Handle("POST /api/v1/referrals/{id}/fee", s.member(s.referralFee))
	mux.Handle("POST /api/v1/referrals/{id}/share-close", s.member(s.referralShareClose))
}

func referralManager(q *req) error {
	if !manages(q.sc) {
		return forbidden("Only the owner or an admin sends and accepts leads between agencies.")
	}
	return nil
}

// findAgencies is GET /api/v1/referrals/agencies?owner=Name#tag: the agencies that person owns, to send a lead to (D248).
func (s *server) findAgencies(q *req) error {
	if err := referralManager(q); err != nil {
		return err
	}
	name, tag, ok := strings.Cut(strings.TrimSpace(q.r.URL.Query().Get("owner")), "#")
	if !ok || strings.TrimSpace(name) == "" || strings.TrimSpace(tag) == "" {
		return bad("Find an agency by its owner's name and tag, like Sam Lee#4821.")
	}
	ctx := q.r.Context()
	var user string
	err := s.st.db.QueryRow(ctx, `SELECT user_id::text FROM people WHERE lower(name) = lower($1) AND tag = $2`, strings.TrimSpace(name), strings.TrimSpace(tag)).Scan(&user)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(q.w, 200, map[string]any{"agencies": []any{}})
		return nil
	}
	if err != nil {
		return err
	}
	p, err := s.rules.people(ctx, user)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, ws := range p.Workspaces {
		if ws.OrgID == q.sc.orgID || !(slices.Contains(ws.Roles, "owner") || slices.Contains(ws.Roles, "solo")) {
			continue
		}
		var agency string
		_ = s.st.db.QueryRow(ctx, `SELECT name FROM orgs WHERE id = $1`, ws.OrgID).Scan(&agency)
		out = append(out, map[string]any{"org_id": ws.OrgID, "name": agency})
	}
	writeJSON(q.w, 200, map[string]any{"agencies": out})
	return nil
}

// sendLead is POST /api/v1/leads/{id}/send {to_org, note, consent_confirmed}: the lead's contact details and the note go to the other
// agency; the blocks on its number go with it; the sender keeps a closed copy marked "Sent to" (D249-D251, D254).
func (s *server) sendLead(q *req) error {
	if err := referralManager(q); err != nil {
		return err
	}
	var body struct {
		ToOrg            string `json:"to_org"`
		Note             string `json:"note"`
		ConsentConfirmed bool   `json:"consent_confirmed"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if !body.ConsentConfirmed {
		return bad("Confirm the person agreed to be passed on to the other agency (consent_confirmed).")
	}
	if !validID(body.ToOrg) || body.ToOrg == q.sc.orgID || len(body.Note) > 2000 {
		return bad("Choose the other agency (to_org) and keep the note under 2,000 characters.")
	}
	ctx := q.r.Context()
	var target string
	if err := s.st.db.QueryRow(ctx, `SELECT name FROM orgs WHERE id = $1`, body.ToOrg).Scan(&target); err != nil {
		return notFound("No such agency.")
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx, op: op{ID: newUUIDString()}}
	lead, err := r.lead(q.r.PathValue("id"), true)
	if err != nil {
		return err
	}
	if lead == nil {
		return notFound("No such lead.")
	}
	var open bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM lead_referrals WHERE from_lead_id = $1 AND status = 'sent')`, lead["id"]).Scan(&open); err != nil {
		return err
	}
	if open {
		return conflictErr("This lead is already waiting at another agency.")
	}
	var address string
	_ = tx.QueryRow(ctx, `SELECT concat_ws(', ', nullif(p.address, ''), nullif(p.city, ''), nullif(p.region, ''), nullif(p.postal_code, '')) FROM properties p JOIN leads l ON l.property_id = p.id WHERE l.id = $1`, lead["id"]).Scan(&address)
	blocks, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('phone_key', phone_key, 'calls', calls, 'texts', texts) FROM number_blocks WHERE phone_key = crm.phone_key($1) AND lifted_at IS NULL`, lead["phone"])
	if err != nil {
		return err
	}
	if lead["do_not_call"] == true && len(blocks) == 0 && phoneKey(asString(lead["phone"])) != "" {
		raw, _ := json.Marshal(map[string]any{"phone_key": phoneKey(asString(lead["phone"])), "calls": true, "texts": true})
		blocks = append(blocks, raw)
	}
	blocksJSON, _ := json.Marshal(blocks)
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO lead_referrals (from_org, to_org, from_lead_id, name, phone, email, address, note, blocks, prev_stage, prev_verdict, consent_confirmed_at, consent_confirmed_by, sent_by)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $11) RETURNING id::text`,
		body.ToOrg, lead["id"], asString(lead["name"]), asString(lead["phone"]), asString(lead["email"]), address, strings.TrimSpace(body.Note), string(blocksJSON),
		asString(lead["stage"]), asString(lead["verdict"]), q.sc.userID).Scan(&id); err != nil {
		return err
	}
	if err := r.exec(`UPDATE leads SET stage = 'Closed', verdict = $2, next_action = '', next_action_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
		lead["id"], "Sent to "+target); err != nil {
		return err
	}
	if err := r.record(change{entity: "lead", kind: "lead.updated", id: asString(lead["id"]), leadID: asString(lead["id"])}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": id, "status": "sent", "to": target})
	return nil
}

// listReferrals is GET /api/v1/referrals: what this agency sent (status, fee, and the close only when both agreed) and received.
func (s *server) listReferrals(q *req) error {
	if err := referralManager(q); err != nil {
		return err
	}
	ctx := q.r.Context()
	sent, err := queryRaw(ctx, s, `SELECT jsonb_build_object('id', r.id, 'to_org', r.to_org, 'to', o.name, 'from_lead_id', r.from_lead_id, 'name', r.name, 'status', r.status,
			'sent_at', r.sent_at, 'decided_at', r.decided_at, 'decline_reason', r.decline_reason, 'fee_note', r.fee_note, 'fee_agreed', r.fee_agreed_at IS NOT NULL,
			'share_close', r.share_close_from AND r.share_close_to, 'deal_closed_at', CASE WHEN r.share_close_from AND r.share_close_to THEN r.deal_closed_at END)
		FROM lead_referrals r JOIN orgs o ON o.id = r.to_org WHERE r.from_org = $1 ORDER BY r.sent_at DESC LIMIT 500`, q.sc.orgID)
	if err != nil {
		return err
	}
	received, err := queryRaw(ctx, s, `SELECT jsonb_build_object('id', r.id, 'from_org', r.from_org, 'from', o.name, 'to_lead_id', r.to_lead_id, 'status', r.status, 'sent_at', r.sent_at,
			'name', r.name, 'phone', CASE WHEN r.status IN ('sent', 'accepted') THEN r.phone END, 'email', CASE WHEN r.status IN ('sent', 'accepted') THEN r.email END,
			'address', CASE WHEN r.status IN ('sent', 'accepted') THEN r.address END, 'note', r.note, 'fee_note', r.fee_note, 'fee_agreed', r.fee_agreed_at IS NOT NULL,
			'share_close', r.share_close_from AND r.share_close_to)
		FROM lead_referrals r JOIN orgs o ON o.id = r.from_org WHERE r.to_org = $1 ORDER BY r.sent_at DESC LIMIT 500`, q.sc.orgID)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"sent": sent, "received": received})
	return nil
}

func queryRaw(ctx context.Context, s *server, sql string, args ...any) ([]json.RawMessage, error) {
	rows, err := s.st.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
}

type referral struct {
	id, fromOrg, toOrg, fromLead, status string
	name, phone, email, address, note    string
	blocks                               []byte
	prevStage, prevVerdict               string
	toLead                               *string
	feeNote                              string
	feeBy                                *string
	shareFrom, shareTo                   bool
}

func (s *server) loadReferral(ctx context.Context, id string) (*referral, error) {
	var r referral
	err := s.st.db.QueryRow(ctx, `SELECT id::text, from_org::text, to_org::text, from_lead_id::text, status, name, phone, email, address, note, blocks::text, prev_stage, prev_verdict,
		to_lead_id::text, fee_note, fee_noted_by_org::text, share_close_from, share_close_to FROM lead_referrals WHERE id = $1`, nullID(id)).
		Scan(&r.id, &r.fromOrg, &r.toOrg, &r.fromLead, &r.status, &r.name, &r.phone, &r.email, &r.address, &r.note, &r.blocks, &r.prevStage, &r.prevVerdict,
			&r.toLead, &r.feeNote, &r.feeBy, &r.shareFrom, &r.shareTo)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("No such sent lead.")
	}
	return &r, err
}

// acceptReferral is POST /api/v1/referrals/{id}/accept {team_id, client_id}: the receiving owner or an admin takes it into a team and
// client of theirs; its blocks come locked, consent to text does not come at all (D248, D251, D373).
func (s *server) acceptReferral(q *req) error {
	if err := referralManager(q); err != nil {
		return err
	}
	var body struct {
		TeamID   string `json:"team_id"`
		ClientID string `json:"client_id"`
	}
	if q.r.ContentLength != 0 {
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
	}
	ctx := q.r.Context()
	ref, err := s.loadReferral(ctx, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	if ref.toOrg != q.sc.orgID {
		return notFound("No such sent lead.")
	}
	if ref.status != "sent" {
		return conflictErr("This lead was already " + ref.status + ".")
	}
	if (body.TeamID != "" && !validID(body.TeamID)) || (body.ClientID != "" && !validID(body.ClientID)) {
		return bad("team_id and client_id are ids of this agency.")
	}
	if body.TeamID != "" {
		if listed, err := s.rules.teams(ctx, q.sc.orgID); err == nil {
			_ = s.copyTeams(ctx, q.sc, listed)
		}
	}
	var fromName string
	_ = s.st.db.QueryRow(ctx, `SELECT name FROM orgs WHERE id = $1`, ref.fromOrg).Scan(&fromName)
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if body.ClientID != "" {
		var ok bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM clients WHERE id = $1)`, body.ClientID).Scan(&ok); err != nil || !ok {
			return bad("That client is not one of this agency's.")
		}
	}
	// The sender's blocks first, locked, so the new lead comes in do-not-call where they say so.
	var blocks []struct {
		PhoneKey string `json:"phone_key"`
		Calls    bool   `json:"calls"`
		Texts    bool   `json:"texts"`
	}
	_ = json.Unmarshal(ref.blocks, &blocks)
	for _, b := range blocks {
		if _, err := tx.Exec(ctx, `INSERT INTO number_blocks (org_id, phone_key, calls, texts, reason, source, note, marked_by, locked)
			VALUES (cw_org(), $1, $2, $3, 'asked_agency', 'referral', $4, NULL, true)
			ON CONFLICT (org_id, phone_key) WHERE lifted_at IS NULL DO UPDATE SET calls = number_blocks.calls OR EXCLUDED.calls, texts = number_blocks.texts OR EXCLUDED.texts, locked = true`,
			b.PhoneKey, b.Calls, b.Texts, "Came with a lead from "+fromName); err != nil {
			return err
		}
	}
	var lead string
	if err := tx.QueryRow(ctx, `INSERT INTO leads (org_id, team_id, client_id, name, phone, email, source, stage) VALUES (cw_org(), $1, $2, $3, $4, $5, $6, 'New') RETURNING id::text`,
		nullID(body.TeamID), nullID(body.ClientID), ref.name, ref.phone, ref.email, "From "+fromName).Scan(&lead); err != nil {
		return err
	}
	note := strings.TrimSpace(strings.Join(slices.DeleteFunc([]string{prefixed("Note from "+fromName+": ", ref.note), prefixed("Property: ", ref.address)}, func(x string) bool { return x == "" }), "\n"))
	if note != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO notes (org_id, lead_id, author_label, body) VALUES (cw_org(), $1, $2, $3)`, lead, fromName, note); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, lead); err != nil {
		return err
	}
	tag, err := s.st.db.Exec(ctx, `UPDATE lead_referrals SET status = 'accepted', to_lead_id = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'sent'`, ref.id, lead, q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflictErr("This lead was decided meanwhile.")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": ref.id, "status": "accepted", "lead_id": lead})
	return nil
}

// endReferral is POST /api/v1/referrals/{id}/decline {reason} (the receiver) or /cancel (the sender), while it waits: the sender's copy
// reopens as a normal lead (D252).
func (s *server) endReferral(status string) handler {
	return func(q *req) error {
		if err := referralManager(q); err != nil {
			return err
		}
		var body struct {
			Reason string `json:"reason"`
		}
		if q.r.ContentLength != 0 {
			if err := readJSON(q.w, q.r, &body); err != nil {
				return err
			}
		}
		ctx := q.r.Context()
		ref, err := s.loadReferral(ctx, q.r.PathValue("id"))
		if err != nil {
			return err
		}
		if (status == "declined" && ref.toOrg != q.sc.orgID) || (status == "cancelled" && ref.fromOrg != q.sc.orgID) {
			return notFound("No such sent lead.")
		}
		if len(body.Reason) > 500 {
			return bad("Keep the reason under 500 characters.")
		}
		tag, err := s.st.db.Exec(ctx, `UPDATE lead_referrals SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4 WHERE id = $1 AND status = 'sent'`,
			ref.id, status, q.sc.userID, strings.TrimSpace(body.Reason))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return conflictErr("This lead was already " + ref.status + ".")
		}
		// The sender's copy reopens, in the sender's own rows.
		tx, err := s.st.begin(ctx, scope{orgID: ref.fromOrg})
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		stage := ref.prevStage
		if stage == "" || stage == "Closed" {
			stage = "Contacted"
		}
		if _, err := tx.Exec(ctx, `UPDATE leads SET stage = $2, verdict = $3, version = version + 1, updated_at = now() WHERE id = $1`, ref.fromLead, stage, ref.prevVerdict); err != nil {
			return err
		}
		if status == "declined" {
			msg := "Declined by the other agency"
			if body.Reason != "" {
				msg += ": " + strings.TrimSpace(body.Reason)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO notes (org_id, lead_id, author_label, body) VALUES (cw_org(), $1, 'Caller Whale', $2)`, ref.fromLead, msg); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, ref.fromLead); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		writeJSON(q.w, 200, map[string]any{"id": ref.id, "status": status})
		return nil
	}
}

// referralFee is POST /api/v1/referrals/{id}/fee {note} (one side notes the fee) or {agree: true} (the other side agrees) (D253).
func (s *server) referralFee(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The two owners note a referral fee.")
	}
	var body struct {
		Note  *string `json:"note"`
		Agree bool    `json:"agree"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	ref, err := s.loadReferral(ctx, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	if ref.fromOrg != q.sc.orgID && ref.toOrg != q.sc.orgID {
		return notFound("No such sent lead.")
	}
	switch {
	case body.Note != nil:
		note := strings.TrimSpace(*body.Note)
		if note == "" || len(note) > 300 {
			return bad("Write the fee you agreed, up to 300 characters.")
		}
		_, err = s.st.db.Exec(ctx, `UPDATE lead_referrals SET fee_note = $2, fee_noted_by_org = $3, fee_agreed_at = NULL WHERE id = $1`, ref.id, note, q.sc.orgID)
	case body.Agree:
		if ref.feeNote == "" || ref.feeBy == nil || *ref.feeBy == q.sc.orgID {
			return conflictErr("The other agency notes the fee; you agree to it.")
		}
		_, err = s.st.db.Exec(ctx, `UPDATE lead_referrals SET fee_agreed_at = now() WHERE id = $1`, ref.id)
	default:
		return bad("Send the fee's note, or agree: true.")
	}
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// referralShareClose is POST /api/v1/referrals/{id}/share-close {agree}: each side says whether the sender is told when the deal closes;
// both must agree (D250).
func (s *server) referralShareClose(q *req) error {
	if err := referralManager(q); err != nil {
		return err
	}
	var body struct {
		Agree bool `json:"agree"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	ref, err := s.loadReferral(ctx, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	column := ""
	switch q.sc.orgID {
	case ref.fromOrg:
		column = "share_close_from"
	case ref.toOrg:
		column = "share_close_to"
	default:
		return notFound("No such sent lead.")
	}
	if _, err := s.st.db.Exec(ctx, `UPDATE lead_referrals SET `+column+` = $2 WHERE id = $1`, ref.id, body.Agree); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// referralFeeReminders reminds each agency's owner of an agreed fee once the received lead's deal closed (D253). It runs after the
// deal's transaction commits; fee_reminded_at keeps it to once.
func (s *server) referralFeeReminders(ctx context.Context, org, lead string) {
	if !validID(lead) {
		return
	}
	var fromOrg, feeNote, name string
	err := s.st.db.QueryRow(ctx, `UPDATE lead_referrals SET fee_reminded_at = now() WHERE to_org = $1 AND to_lead_id = $2 AND status = 'accepted'
		AND deal_closed_at IS NOT NULL AND fee_note <> '' AND fee_reminded_at IS NULL RETURNING from_org::text, fee_note, name`, org, lead).Scan(&fromOrg, &feeNote, &name)
	if err != nil {
		return
	}
	for _, o := range []string{org, fromOrg} {
		members, err := s.rules.members(ctx, o)
		if err != nil {
			continue
		}
		tx, err := s.st.begin(ctx, scope{orgID: o})
		if err != nil {
			continue
		}
		var leadRef any
		if o == org {
			leadRef = lead
		}
		for _, m := range members {
			if !slices.Contains(m.Roles, "owner") && !slices.Contains(m.Roles, "solo") {
				continue
			}
			var task string
			if tx.QueryRow(ctx, `INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, priority, due_at) VALUES (cw_org(), $1, $2, $3, 'Task', 'Normal', now()) RETURNING id::text`,
				leadRef, m.UserID, "Referral fee for "+name+": "+feeNote).Scan(&task) == nil {
				_, _ = tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'task', $1, $2, 'upsert')`, task, leadRef)
			}
		}
		_ = tx.Commit(ctx)
	}
}
