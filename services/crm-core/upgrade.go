package main

import (
	"context"
	"net/http"
	"net/url"
	"slices"
)

// upgrade asks authz to make a solo workspace an agency (build step 17): the solo operator becomes its owner and leads its first team.
func (a *authzClient) upgrade(ctx context.Context, org, user, teamID, teamName string) error {
	var out map[string]any
	return a.call(ctx, http.MethodPost, "/v1/orgs/"+url.PathEscape(org)+"/upgrade", map[string]any{"user_id": user, "team_id": teamID, "team_name": teamName}, &out)
}

// upgradeToAgency answers POST /api/v1/workspace/upgrade: a solo operator who wants to add callers makes the same workspace an agency
// (D59, D203). A first team named after them is made, they lead it as well as owning the agency, and all their leads go into it, with
// their history; their clients stay the agency's clients. Nothing is copied or moved elsewhere.
func (s *server) upgradeToAgency(q *req) error {
	if !slices.Contains(q.grant.Roles, "solo") {
		return &apiError{http.StatusConflict, "not_solo", "This workspace is already an agency."}
	}
	ctx := q.r.Context()
	name := label(q.c) + "'s team"
	if len(name) > 100 {
		name = name[:100]
	}
	id := randomID()
	if err := s.rules.upgrade(ctx, q.sc.orgID, q.sc.userID, id, name); err != nil {
		return err
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rec, err := queryJSON(ctx, tx, `INSERT INTO teams (id, org_id, name) VALUES ($2, cw_org(), $1)
		ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING to_jsonb(teams.*)`, name, id)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE leads SET team_id = $1::uuid, version = version + 1, updated_at = now() WHERE org_id = cw_org() AND team_id IS DISTINCT FROM $1::uuid`, id)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) SELECT cw_org(), 'lead', l.id, l.id, 'upsert' FROM leads l WHERE l.org_id = cw_org() AND l.team_id = $1::uuid`, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"team": rec[0], "leads_moved": tag.RowsAffected()})
	return nil
}
