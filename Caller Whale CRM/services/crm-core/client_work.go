package main

// Build step 23, part B: sharing one call or deal with a client (D136, D281), lists sent to a client for approval (D138), and the quiet
// marker of the same number under another client (D133).

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// shareWithClient is the call.share_client and deal.share_client operations {id, shared}: a call's recording, or a deal's figures, are
// for the client only when shared one by one (D136, D281). Whoever may hand out the lead may share them.
func (r *run) shareWithClient(table, entity string, p map[string]any) (any, error) {
	if err := r.need("assign"); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	share := p["shared"] != false
	var lead string
	if err := r.tx.QueryRow(r.ctx, `SELECT lead_id::text FROM `+table+` WHERE id = $1 AND org_id = cw_org()`, id).Scan(&lead); err != nil {
		return nil, reject("No such %s", entity)
	}
	got, err := r.visibleLead(lead, true)
	if err != nil {
		return nil, err
	}
	if share && asString(got["client_id"]) == "" {
		return nil, reject("This lead is the agency's own business: there is no client to share with")
	}
	if err = r.exec(`UPDATE `+table+` SET shared_with_client = $2 WHERE id = $1`, id, share); err == nil {
		err = r.record(change{entity: entity, kind: entity + ".shared_with_client", id: id, leadID: lead, after: map[string]any{"shared_with_client": share}})
	}
	return map[string]any{"id": id, "shared_with_client": share}, err
}

// sendForApproval is POST /api/v1/projects/{id}/approval/send: the agency sends a list to its client to approve (D138).
func (s *server) sendForApproval(q *req) error {
	if !q.sc.can("import") || q.sc.external() {
		return forbidden("Your role does not send lists for approval.")
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such list.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `UPDATE projects SET approval_status = 'sent', approval_note = '', approval_at = now(), approval_by = NULL
		WHERE id = $1 AND org_id = cw_org() AND client_id IS NOT NULL RETURNING to_jsonb(projects.*)`, id)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return notFound("No such list for a client.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

// approveList is POST /api/v1/projects/{id}/approval {approved, note}: the client's person approves the list or asks for changes.
func (s *server) approveList(q *req) error {
	id := q.r.PathValue("id")
	var body struct {
		Approved bool   `json:"approved"`
		Note     string `json:"note"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if len(body.Note) > 2000 || !validID(id) {
		return bad("Keep the note under 2,000 characters.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	mine, err := myClient(ctx, tx, q.sc.userID)
	if err != nil {
		return err
	}
	if mine == "" {
		return forbidden("Only the client's own people approve its lists.")
	}
	status := "changes"
	if body.Approved {
		status = "approved"
	}
	rows, err := queryJSON(ctx, tx, `UPDATE projects SET approval_status = $3, approval_note = $4, approval_at = now(), approval_by = $5
		WHERE id = $1 AND org_id = cw_org() AND client_id = $2 AND approval_status IN ('sent', 'changes', 'approved')
		RETURNING jsonb_build_object('id', id, 'name', name, 'approval_status', approval_status, 'approval_note', approval_note)`, id, mine, status, strings.TrimSpace(body.Note), q.sc.userID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return notFound("No list of yours waits for approval.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

// clientApprovals is GET /api/v1/clients/{id}/approvals: the client's lists sent for approval, by name and size only (D127).
func (s *server) clientApprovals(q *req) error {
	id := q.r.PathValue("id")
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.sc.external() {
		mine, err := myClient(ctx, tx, q.sc.userID)
		if err != nil {
			return err
		}
		if mine != id {
			return notFound("No such client.")
		}
	} else if !slices.Contains(q.sc.scopes, "organization") {
		return forbidden("The owner and admins see a client's approvals.")
	}
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', p.id, 'name', p.name, 'approval_status', p.approval_status, 'approval_note', p.approval_note,
			'approval_at', p.approval_at, 'supplied_by', p.supplied_by, 'leads', (SELECT count(*) FROM leads l WHERE l.project_id = p.id AND l.deleted_at IS NULL))
		FROM projects p WHERE p.org_id = cw_org() AND p.client_id::text = $1 AND p.approval_status <> 'none' ORDER BY p.approval_at DESC NULLS LAST`, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"lists": rows})
	return nil
}

// waitingApproval says whether a lead's list waits for its client's approval, when that client requires it (D138).
func waitingApproval(ctx context.Context, tx pgx.Tx, lead string) (bool, error) {
	var waiting bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM leads l JOIN projects p ON p.id = l.project_id JOIN clients c ON c.id = p.client_id
		WHERE l.id = $1 AND c.approval_required AND p.approval_status <> 'approved')`, lead).Scan(&waiting)
	return waiting, err
}

// leadTwins is GET /api/v1/leads/{id}/twins: for the owner and admins, whether the same number is a lead under another client too. A
// quiet marker only: no other client's record is shown (D133).
func (s *server) leadTwins(q *req) error {
	if !q.sc.can("admin") || !slices.Contains(q.sc.scopes, "organization") {
		return forbidden("Only the owner and admins see this.")
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such lead.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var others int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM leads o, leads l WHERE l.id = $1 AND l.org_id = cw_org() AND o.org_id = l.org_id AND o.id <> l.id AND o.deleted_at IS NULL
		AND right(regexp_replace(o.phone, '\D', '', 'g'), 10) = right(regexp_replace(l.phone, '\D', '', 'g'), 10) AND length(regexp_replace(l.phone, '\D', '', 'g')) >= 7
		AND o.client_id IS DISTINCT FROM l.client_id`, id).Scan(&others)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"under_other_clients": others > 0})
	return nil
}
