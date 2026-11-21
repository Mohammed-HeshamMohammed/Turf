package crm

// Build step 23: clients. Every list and lead belongs to a client (D126): one the agency works for, or its own business (stored as no
// client). The owner and admins keep the clients, link a client's people to it and say which teams work for it (D128, D134). The agency
// shares chosen leads with a client's people (D127); a client sees counts and totals of its work, never names or numbers, and never
// another client's (D127, D281, D223). Data never crosses between clients: no merges, no import matches (D133, D223).

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ownBusiness makes sure the workspace has its "own business" client and answers its id.
func ownBusiness(ctx context.Context, tx pgx.Tx) (string, error) {
	var id string
	if _, err := tx.Exec(ctx, `INSERT INTO clients (org_id, name, own_business) VALUES (cw_org(), 'Own business', true) ON CONFLICT DO NOTHING`); err != nil {
		return "", err
	}
	err := tx.QueryRow(ctx, `SELECT id::text FROM clients WHERE org_id = cw_org() AND own_business`).Scan(&id)
	return id, err
}

// myClient is the client a client-role person belongs to, or "".
func myClient(ctx context.Context, tx pgx.Tx, user string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT client_id::text FROM client_members WHERE org_id = cw_org() AND user_id = $1 LIMIT 1`, user).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return id, err
}

// listClients is GET /api/v1/clients: every client, with lead counts, for the agency's people; a client's own person sees only theirs.
func (s *server) listClients(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	own, err := ownBusiness(ctx, tx)
	if err != nil {
		return err
	}
	only := ""
	if q.sc.external() {
		if only, err = myClient(ctx, tx, q.sc.userID); err != nil {
			return err
		}
		if only == "" {
			writeJSON(q.w, 200, map[string]any{"clients": []any{}})
			return nil
		}
	}
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(c) || jsonb_build_object(
			'leads', (SELECT count(*) FROM leads l WHERE l.org_id = c.org_id AND l.deleted_at IS NULL AND coalesce(l.client_id, $1::uuid) = c.id),
			'members', coalesce((SELECT jsonb_agg(jsonb_build_object('user_id', m.user_id, 'main', m.main)) FROM client_members m WHERE m.client_id = c.id), '[]'::jsonb),
			'team_ids', coalesce((SELECT jsonb_agg(t.team_id) FROM team_clients t WHERE t.client_id = c.id), '[]'::jsonb))
		FROM clients c WHERE c.org_id = cw_org() AND ($2 = '' OR c.id::text = $2) ORDER BY c.own_business DESC, c.name`, own, only)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"clients": rows})
	return nil
}

// saveClient is POST /api/v1/clients {name, approval_required} and PATCH /api/v1/clients/{id} {name, approval_required, ended}: the
// owner and admins.
func (s *server) saveClient(q *req) error {
	if !q.sc.can("admin") || q.sc.external() {
		return forbidden("Only the owner or an admin keeps the clients.")
	}
	var body struct {
		Name             *string `json:"name"`
		ApprovalRequired *bool   `json:"approval_required"`
		Ended            *bool   `json:"ended"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.Name != nil {
		*body.Name = strings.TrimSpace(*body.Name)
		if *body.Name == "" || len([]rune(*body.Name)) > 120 {
			return bad("Name the client (up to 120 characters).")
		}
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var rec []any
	id := q.r.PathValue("id")
	if id == "" {
		if body.Name == nil {
			return bad("Name the client.")
		}
		rows, err := queryJSON(ctx, tx, `INSERT INTO clients (org_id, name, approval_required) VALUES (cw_org(), $1, coalesce($2, false)) RETURNING to_jsonb(clients.*)`, *body.Name, body.ApprovalRequired)
		if err != nil {
			if strings.Contains(err.Error(), "clients_org_id_name_key") {
				return &apiError{http.StatusConflict, "exists", "A client with that name exists."}
			}
			return err
		}
		rec = []any{rows[0]}
	} else {
		if !validID(id) {
			return notFound("No such client.")
		}
		rows, err := queryJSON(ctx, tx, `UPDATE clients SET name = coalesce($2, name), approval_required = coalesce($3, approval_required),
				ended_at = CASE WHEN $4::boolean IS NULL THEN ended_at WHEN $4 THEN coalesce(ended_at, now()) END
			WHERE id = $1 AND org_id = cw_org() AND NOT (own_business AND $4::boolean IS TRUE) RETURNING to_jsonb(clients.*)`, id, body.Name, body.ApprovalRequired, body.Ended)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return notFound("No such client, or it is the agency's own business, which never ends.")
		}
		rec = []any{rows[0]}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rec[0])
	return nil
}

// clientLink is PUT or DELETE /api/v1/clients/{id}/members/{user} {main} and /api/v1/clients/{id}/teams/{team}: the owner and admins
// say who a client's people are and which teams work for it.
func (s *server) clientLink(kind string) handler {
	return func(q *req) error {
		if !q.sc.can("admin") || q.sc.external() {
			return forbidden("Only the owner or an admin changes a client's people and teams.")
		}
		id, other := q.r.PathValue("id"), q.r.PathValue("other")
		if !validID(id) || !validID(other) {
			return notFound("No such client.")
		}
		var body struct {
			Main bool `json:"main"`
		}
		if q.r.Method == http.MethodPut && q.r.ContentLength != 0 {
			if err := readJSON(q.w, q.r, &body); err != nil {
				return err
			}
		}
		ctx := q.r.Context()
		if kind == "members" && q.r.Method == http.MethodPut {
			// A client's person is someone the workspace has as a client (the role that sees only what is shared).
			members, err := s.rules.members(ctx, q.sc.orgID)
			if err != nil {
				return err
			}
			if !slices.ContainsFunc(members, func(m member) bool { return m.UserID == other && slices.Contains(m.Roles, "client") }) {
				return bad("Invite them as a client first.")
			}
		}
		tx, err := s.st.begin(ctx, q.sc)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		var found bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM clients WHERE id = $1 AND org_id = cw_org())`, id).Scan(&found); err != nil {
			return err
		}
		if !found {
			return notFound("No such client.")
		}
		switch {
		case kind == "members" && q.r.Method == http.MethodPut:
			_, err = tx.Exec(ctx, `INSERT INTO client_members (org_id, client_id, user_id, main) VALUES (cw_org(), $1, $2, $3)
				ON CONFLICT (client_id, user_id) DO UPDATE SET main = EXCLUDED.main`, id, other, body.Main)
		case kind == "members":
			_, err = tx.Exec(ctx, `DELETE FROM client_members WHERE client_id = $1 AND user_id = $2`, id, other)
		case q.r.Method == http.MethodPut:
			_, err = tx.Exec(ctx, `INSERT INTO team_clients (org_id, team_id, client_id) VALUES (cw_org(), $2, $1) ON CONFLICT DO NOTHING`, id, other)
		default:
			_, err = tx.Exec(ctx, `DELETE FROM team_clients WHERE client_id = $1 AND team_id = $2`, id, other)
		}
		if err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		writeJSON(q.w, 200, map[string]any{"ok": true})
		return nil
	}
}

// clientSummary is GET /api/v1/clients/{id}/summary: the client's work in counts and totals, with no names or numbers (D127, D281), for
// the agency's people who see the whole agency and for the client's own people.
func (s *server) clientSummary(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such client.")
	}
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
		return forbidden("The owner and admins see a client's figures.")
	}
	own, err := ownBusiness(ctx, tx)
	if err != nil {
		return err
	}
	// Counted over all the client's work (row security keeps it to this agency): the client's people see figures, not records.
	var out []byte
	err = tx.QueryRow(ctx, `SELECT jsonb_build_object(
			'leads', count(*),
			'by_stage', coalesce((SELECT jsonb_object_agg(stage, n) FROM (SELECT stage, count(*) n FROM crm.leads WHERE org_id = $1 AND deleted_at IS NULL AND coalesce(client_id, $3::uuid) = $2::uuid GROUP BY stage) s), '{}'::jsonb),
			'calls', (SELECT count(*) FROM crm.call_events c JOIN crm.leads l2 ON l2.id = c.lead_id WHERE l2.org_id = $1 AND coalesce(l2.client_id, $3::uuid) = $2::uuid),
			'deals', (SELECT count(*) FROM crm.deals d JOIN crm.leads l3 ON l3.id = d.lead_id WHERE l3.org_id = $1 AND coalesce(l3.client_id, $3::uuid) = $2::uuid),
			'deal_value', (SELECT coalesce(sum(d.amount), 0) FROM crm.deals d JOIN crm.leads l4 ON l4.id = d.lead_id WHERE l4.org_id = $1 AND coalesce(l4.client_id, $3::uuid) = $2::uuid))
		FROM crm.leads WHERE org_id = $1 AND deleted_at IS NULL AND coalesce(client_id, $3::uuid) = $2::uuid`, q.sc.orgID, id, own).Scan(&out)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", "application/json")
	q.w.WriteHeader(200)
	_, err = q.w.Write(out)
	return err
}

// leadShareClient is the lead.share_client operation {id, shared}: whoever may hand out a lead shares it with its client's people (D127).
func (r *run) leadShareClient(p map[string]any) (any, error) {
	if err := r.need("assign"); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	share := p["shared"] != false
	lead, err := r.visibleLead(id, true)
	if err != nil {
		return nil, err
	}
	if share && asString(lead["client_id"]) == "" {
		return nil, reject("This lead is the agency's own business: there is no client to share it with")
	}
	if err = r.exec(`UPDATE leads SET shared_with_client = $2, version = version + 1, updated_at = now() WHERE id = $1`, id, share); err == nil {
		err = r.accessChanged()
	}
	if err == nil {
		err = r.record(change{entity: "lead", kind: "lead.shared_with_client", id: id, leadID: id, after: map[string]any{"shared_with_client": share}})
	}
	return map[string]any{"id": id, "shared_with_client": share}, err
}

// sameClient refuses a merge of two clients' leads: each client's copy keeps its own history (D133, D223).
func sameClient(a, b map[string]any) error {
	if asString(a["client_id"]) != asString(b["client_id"]) {
		return reject("These leads belong to different clients; each keeps its own record")
	}
	return nil
}
