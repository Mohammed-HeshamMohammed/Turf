package crm

// A lead's request about their data (D310, D367, D370). The owner or an admin
// enters it with the person's number and email; every record of the agency about them is found; it is exported, or deleted by the
// owner with their second step. A deletion leaves only the number and email on the agency's block lists ("deleted on request"),
// so the person is never contacted again; the dialer removes its calls and texts with that number; the request and its dates stay.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) dataRequestRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/data-requests", s.member(s.listDataRequests))
	mux.Handle("POST /api/v1/data-requests", s.member(s.newDataRequest))
	mux.Handle("GET /api/v1/data-requests/{id}", s.member(s.getDataRequest))
	mux.Handle("GET /api/v1/data-requests/{id}/export", s.member(s.exportDataRequest))
	mux.Handle("POST /api/v1/data-requests/{id}/delete", s.member(s.deleteDataRequest))
	mux.Handle("POST /api/v1/data-requests/{id}/close", s.member(s.closeDataRequest))
	mux.HandleFunc("GET /internal/v1/dialer/erasures", s.dialerErasures)
	mux.HandleFunc("POST /internal/v1/dialer/erasures/{id}/done", s.dialerErasureDone)
}

type dataRequest struct {
	ID, Kind, Name, PhoneKey, Email, Status string
}

func loadDataRequest(ctx context.Context, tx pgx.Tx, id string) (*dataRequest, error) {
	var d dataRequest
	err := tx.QueryRow(ctx, `SELECT id::text, kind, name, phone_key, email, status FROM data_requests WHERE id = $1`, nullID(id)).
		Scan(&d.ID, &d.Kind, &d.Name, &d.PhoneKey, &d.Email, &d.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("No such data request.")
	}
	return &d, err
}

// matchingLeads are the agency's leads with the person's number or email, on the lead or among its other contacts.
func matchingLeads(ctx context.Context, tx pgx.Tx, phoneKey, email string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT l.id::text FROM leads l WHERE
		($1 <> '' AND crm.phone_key(l.phone) = $1) OR ($2 <> '' AND lower(l.email) = $2)
		OR (jsonb_typeof(l.contacts) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.contacts) c
			WHERE ($1 <> '' AND crm.phone_key(c->>'phone') = $1) OR ($2 <> '' AND lower(c->>'email') = $2)))`, phoneKey, email)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// leadTables are the agency tables holding rows of one lead (a lead_id column), the sync log aside.
func leadTables(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT c.table_name FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name
		JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'crm'
		WHERE c.table_schema = 'crm' AND c.column_name = 'lead_id' AND k.relrowsecurity AND c.table_name NOT IN ('change_log') ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// gather is every record about the person: their leads and everything kept on them, their blocks, unsubscribes and form sends.
func gather(ctx context.Context, tx pgx.Tx, d *dataRequest, leads []string) (map[string][]json.RawMessage, error) {
	out := map[string][]json.RawMessage{}
	add := func(name, sql string, args ...any) error {
		rows, err := queryJSON(ctx, tx, sql, args...)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if len(rows) > 0 {
			out[name] = rows
		}
		return nil
	}
	if err := add("leads", `SELECT to_jsonb(l) FROM leads l WHERE l.id = ANY($1::uuid[])`, leads); err != nil {
		return nil, err
	}
	if err := add("properties", `SELECT to_jsonb(p) FROM properties p WHERE p.id IN (SELECT property_id FROM leads WHERE id = ANY($1::uuid[]))`, leads); err != nil {
		return nil, err
	}
	tables, err := leadTables(ctx, tx)
	if err != nil {
		return nil, err
	}
	for _, t := range tables {
		name := pgx.Identifier{t}.Sanitize()
		sql := `SELECT to_jsonb(x) FROM crm.` + name + ` x WHERE x.lead_id = ANY($1::uuid[])`
		if t == "lead_files" {
			sql = `SELECT to_jsonb(x) - 'body' FROM crm.lead_files x WHERE x.lead_id = ANY($1::uuid[])` // the files themselves download from the lead
		}
		if err := add(t, sql, leads); err != nil {
			return nil, err
		}
	}
	if err := add("form_submissions_by_number", `SELECT to_jsonb(f) FROM form_submissions f WHERE $1 <> '' AND f.phone_key = $1 AND (f.lead_id IS NULL OR NOT f.lead_id = ANY($2::uuid[]))`, d.PhoneKey, leads); err != nil {
		return nil, err
	}
	if err := add("number_blocks", `SELECT to_jsonb(b) FROM number_blocks b WHERE $1 <> '' AND b.phone_key = $1`, d.PhoneKey); err != nil {
		return nil, err
	}
	if err := add("email_unsubscribes", `SELECT to_jsonb(u) FROM email_unsubscribes u WHERE $1 <> '' AND u.address = $1`, d.Email); err != nil {
		return nil, err
	}
	return out, nil
}

func counts(found map[string][]json.RawMessage) map[string]int {
	c := map[string]int{}
	for k, v := range found {
		c[k] = len(v)
	}
	return c
}

// newDataRequest is POST /api/v1/data-requests {kind, name, phone, email, received_on, block_calls, block_texts, note}.
func (s *server) newDataRequest(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins handle data requests.")
	}
	var body struct {
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		Phone      string `json:"phone"`
		Email      string `json:"email"`
		ReceivedOn string `json:"received_on"`
		BlockCalls bool   `json:"block_calls"`
		BlockTexts bool   `json:"block_texts"`
		Note       string `json:"note"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	key, email := phoneKey(body.Phone), strings.ToLower(strings.TrimSpace(body.Email))
	day, err := time.Parse("2006-01-02", body.ReceivedOn)
	switch {
	case body.Kind != "access" && body.Kind != "delete":
		return bad("kind is access (a copy of their data) or delete.")
	case key == "" && email == "":
		return bad("Give the person's phone number or email, as they gave it to you.")
	case email != "" && !strings.Contains(email, "@"):
		return bad("That email is not an address.")
	case err != nil || day.After(s.now()):
		return bad("received_on is the day the person asked, like 2026-11-18.")
	case len(body.Name) > 200 || len(body.Note) > 1000:
		return bad("Keep the name under 200 characters and the note under 1,000.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	d := &dataRequest{Kind: body.Kind, Name: strings.TrimSpace(body.Name), PhoneKey: key, Email: email}
	leads, err := matchingLeads(ctx, tx, key, email)
	if err != nil {
		return err
	}
	found, err := gather(ctx, tx, d, leads)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(counts(found))
	if err := tx.QueryRow(ctx, `INSERT INTO data_requests (org_id, kind, name, phone_key, email, received_on, note, block_calls, block_texts, found, entered_by)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text`,
		d.Kind, d.Name, key, email, day, strings.TrimSpace(body.Note), body.BlockCalls || body.Kind == "delete", body.BlockTexts || body.Kind == "delete", raw, q.sc.userID).Scan(&d.ID); err != nil {
		return err
	}
	// Blocking does not wait for the rest: the person asked not to be contacted.
	if body.BlockCalls || body.BlockTexts {
		if err := s.blockForRequest(ctx, tx, q.sc, key, body.BlockCalls, body.BlockTexts, "asked_agency"); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusCreated, map[string]any{"id": d.ID, "leads": leads, "found": counts(found)})
	return nil
}

func (s *server) blockForRequest(ctx context.Context, tx pgx.Tx, sc scope, key string, calls, texts bool, reason string) error {
	if key == "" {
		return nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO number_blocks (org_id, phone_key, calls, texts, reason, source, note, marked_by)
		VALUES (cw_org(), $1, $2, $3, $4, '', 'Data request', $5)
		ON CONFLICT (org_id, phone_key) WHERE lifted_at IS NULL DO UPDATE SET calls = number_blocks.calls OR EXCLUDED.calls,
			texts = number_blocks.texts OR EXCLUDED.texts, reason = CASE WHEN EXCLUDED.reason = 'deleted_on_request' THEN EXCLUDED.reason ELSE number_blocks.reason END`,
		key, calls, texts, reason, nullID(sc.userID)); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE leads SET do_not_call = true, version = version + 1, updated_at = now() WHERE crm.phone_key(phone) = $1 AND $2 AND NOT do_not_call`, key, calls)
	return err
}

func (s *server) listDataRequests(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins handle data requests.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	list, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', id, 'kind', kind, 'name', name, 'phone_key', phone_key, 'email', email, 'received_on', received_on,
			'status', status, 'found', found, 'entered_at', entered_at, 'exported_at', exported_at, 'deleted_at', deleted_at, 'dialer_erased_at', dialer_erased_at)
		FROM data_requests ORDER BY entered_at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"requests": list})
	return nil
}

// getDataRequest is GET /api/v1/data-requests/{id}: the request with what is found about the person now.
func (s *server) getDataRequest(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins handle data requests.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	d, err := loadDataRequest(ctx, tx, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	leads, err := matchingLeads(ctx, tx, d.PhoneKey, d.Email)
	if err != nil {
		return err
	}
	found, err := gather(ctx, tx, d, leads)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"id": d.ID, "kind": d.Kind, "status": d.Status, "leads": leads, "found_now": counts(found)})
	return nil
}

// exportDataRequest is GET /api/v1/data-requests/{id}/export: every record about the person, as one JSON file to give them.
func (s *server) exportDataRequest(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins handle data requests.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	d, err := loadDataRequest(ctx, tx, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	if d.Status == "deleted" {
		return conflictErr("This person's data was deleted; there is nothing left to export.")
	}
	leads, err := matchingLeads(ctx, tx, d.PhoneKey, d.Email)
	if err != nil {
		return err
	}
	found, err := gather(ctx, tx, d, leads)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE data_requests SET exported_at = now(), status = CASE WHEN status = 'open' THEN 'exported' ELSE status END WHERE id = $1`, d.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	q.w.Header().Set("Content-Disposition", `attachment; filename="data-request-`+d.ID[:8]+`.json"`)
	q.w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(q.w, http.StatusOK, map[string]any{"request": d.ID, "exported_at": s.now(), "records": found,
		"not_included": "Calls' recordings and texts are kept by the dialer; files download from each lead."})
	return nil
}

// deleteDataRequest is POST /api/v1/data-requests/{id}/delete {confirm: true}: the owner, with their second step, deletes every record
// about the person. The number and email stay blocked, marked "deleted on request".
func (s *server) deleteDataRequest(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("Only the owner deletes a person's data.")
	}
	if !q.sc.secondStep {
		return &apiError{http.StatusForbidden, "second_step_required", "Pass your second sign-in step first."}
	}
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if !body.Confirm {
		return bad("Deleting cannot be undone: send confirm: true.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	d, err := loadDataRequest(ctx, tx, q.r.PathValue("id"))
	if err != nil {
		return err
	}
	if d.Kind != "delete" || d.Status == "deleted" {
		return conflictErr("Only an open request to delete is carried out.")
	}
	leads, err := matchingLeads(ctx, tx, d.PhoneKey, d.Email)
	if err != nil {
		return err
	}
	found, err := gather(ctx, tx, d, leads)
	if err != nil {
		return err
	}
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx, op: op{ID: newUUIDString()}}
	tables, err := leadTables(ctx, tx)
	if err != nil {
		return err
	}
	// The rows that do not go with the lead by themselves, then the leads (the rest follows them), then their unused properties.
	for _, t := range tables {
		if _, err := tx.Exec(ctx, `DELETE FROM crm.`+pgx.Identifier{t}.Sanitize()+` WHERE lead_id = ANY($1::uuid[])`, leads); err != nil {
			return fmt.Errorf("deleting from %s: %w", t, err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM form_submissions WHERE $1 <> '' AND phone_key = $1`, d.PhoneKey); err != nil {
		return err
	}
	var properties []string
	if err := tx.QueryRow(ctx, `SELECT coalesce(array_agg(property_id::text), '{}') FROM leads WHERE id = ANY($1::uuid[]) AND property_id IS NOT NULL`, leads).Scan(&properties); err != nil {
		return err
	}
	for _, id := range leads {
		if _, err := tx.Exec(ctx, `DELETE FROM leads WHERE id = $1`, id); err != nil {
			return err
		}
		if err := r.record(change{entity: "lead", kind: "lead.deleted", id: id, leadID: id, deleted: true}); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM properties p WHERE p.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.property_id = p.id)
		AND NOT EXISTS (SELECT 1 FROM deals x WHERE x.property_id = p.id)`, properties); err != nil {
		return err
	}
	// A lead sent to or from another agency keeps the referral's dates, without the person.
	if _, err := tx.Exec(ctx, `UPDATE lead_referrals SET name = '', phone = '', email = '', address = '', note = ''
		WHERE (from_org = cw_org() AND from_lead_id = ANY($1::uuid[])) OR (to_org = cw_org() AND to_lead_id = ANY($1::uuid[]))`, leads); err != nil {
		return err
	}
	// Never contacted again: the number blocked for calls and texts, the email unsubscribed.
	if err := s.blockForRequest(ctx, tx, q.sc, d.PhoneKey, true, true, "deleted_on_request"); err != nil {
		return err
	}
	if d.Email != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO email_unsubscribes (org_id, address) VALUES (cw_org(), $1) ON CONFLICT DO NOTHING`, d.Email); err != nil {
			return err
		}
	}
	raw, _ := json.Marshal(counts(found))
	if _, err := tx.Exec(ctx, `UPDATE data_requests SET status = 'deleted', name = '', found = $2, deleted_by = $3, deleted_at = now() WHERE id = $1`, d.ID, raw, q.sc.userID); err != nil {
		return err
	}
	if d.PhoneKey != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO dialer_erasures (request_id, org_id, phone_key) VALUES ($1, cw_org(), $2) ON CONFLICT DO NOTHING`, d.ID, d.PhoneKey); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"id": d.ID, "status": "deleted", "deleted": counts(found)})
	return nil
}

func (s *server) closeDataRequest(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins handle data requests.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE data_requests SET status = 'closed' WHERE id = $1 AND status IN ('open', 'exported')`, nullID(q.r.PathValue("id")))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("No open data request with that id.")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"status": "closed"})
	return nil
}

// ---- the dialer's part ----

func (s *server) fromDialer(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.dialerToken == "" || subtle.ConstantTimeCompare([]byte(bearer(r)), []byte(s.cfg.dialerToken)) != 1 {
		writeError(w, &apiError{http.StatusUnauthorized, "unauthorized", "Only the dialer service may call this."})
		return false
	}
	return true
}

// dialerErasures is GET /internal/v1/dialer/erasures: the numbers whose calls and texts the dialer must remove, per agency.
func (s *server) dialerErasures(w http.ResponseWriter, r *http.Request) {
	if !s.fromDialer(w, r) {
		return
	}
	rows, err := s.st.db.Query(r.Context(), `SELECT jsonb_build_object('id', request_id, 'org_id', org_id, 'phone_key', phone_key) FROM dialer_erasures ORDER BY asked_at LIMIT 200`)
	if err != nil {
		writeError(w, err)
		return
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"erasures": list})
}

// dialerErasureDone is POST /internal/v1/dialer/erasures/{id}/done: the dialer removed them; the request keeps the date.
func (s *server) dialerErasureDone(w http.ResponseWriter, r *http.Request) {
	if !s.fromDialer(w, r) {
		return
	}
	ctx := r.Context()
	var org string
	err := s.st.db.QueryRow(ctx, `DELETE FROM dialer_erasures WHERE request_id = $1 RETURNING org_id::text`, nullID(r.PathValue("id"))).Scan(&org)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if err := s.inScope(ctx, org, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE data_requests SET dialer_erased_at = now() WHERE id = $1`, r.PathValue("id"))
		return err
	}); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) inScope(ctx context.Context, org string, fn func(pgx.Tx) error) error {
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
