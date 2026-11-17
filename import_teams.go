package main

// Imports and teams (build step 20, part B): a list's rows that match another team's leads (D112), and removing a whole list that
// nobody has worked yet (D219).

import (
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// otherTeam answers GET /api/v1/imports/{id}/other-team: how many rows of this import match a lead another team holds. Never which
// leads, or whose: the importing team learns only that they exist (D112).
func (s *server) otherTeam(q *req) error {
	if _, err := s.job(q.r.Context(), q, q.r.PathValue("id")); err != nil {
		return err
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var n int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND state = 'other_team'`, q.r.PathValue("id")).Scan(&n); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"count": n, "can_decide": q.sc.can("admin"),
		"message": "These leads already exist in another team. The agency owner or an admin decides which team keeps them, or that both keep their own copy."})
	return nil
}

// decideOtherTeam answers POST /api/v1/imports/{id}/other-team: the owner or an admin decides for every held row at once.
//
//	keep_theirs  the other team keeps its lead; the rows are skipped
//	both         this team gets its own copy as a new lead; the other team keeps its lead (D112: separate records)
//	move_here    the lead moves to this import's team, unassigned, and the rows fill what it is missing
func (s *server) decideOtherTeam(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("The agency owner or an admin decides which team keeps a lead.")
	}
	id := q.r.PathValue("id")
	if _, err := s.job(q.r.Context(), q, id); err != nil {
		return err
	}
	var body struct {
		Action string `json:"action"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if !slices.Contains([]string{"keep_theirs", "both", "move_here"}, body.Action) {
		return bad("Choose keep_theirs, both or move_here.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var project, team *string
	if err := tx.QueryRow(ctx, `SELECT project_id::text, team_id::text FROM importing.jobs WHERE id = $1 AND org_id = cw_org() FOR UPDATE`, id).Scan(&project, &team); err != nil {
		return err
	}
	var n int64
	switch body.Action {
	case "keep_theirs":
		tag, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'skip' WHERE job_id = $1 AND state = 'other_team'`, id)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
	case "both":
		tag, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'import', match_lead = NULL WHERE job_id = $1 AND state = 'other_team'`, id)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
	case "move_here":
		if team == nil {
			return bad("This import has no team to move the leads to.")
		}
		if _, err := tx.Exec(ctx, `UPDATE leads l SET team_id = $2::uuid, assignee_id = NULL, version = l.version + 1, updated_at = now()
			FROM importing.rows r WHERE r.job_id = $1 AND r.state = 'other_team' AND l.id = r.match_lead AND l.org_id = cw_org()`, id, *team); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op)
			SELECT DISTINCT cw_org(), 'lead', r.match_lead, r.match_lead, 'upsert' FROM importing.rows r WHERE r.job_id = $1 AND r.state = 'other_team' AND r.match_lead IS NOT NULL`, id); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'merge' WHERE job_id = $1 AND state = 'other_team'`, id)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
	}
	// The rows now waiting are merged at once, as a single undo is (mergeBatchIn), batch after batch.
	for {
		done, err := mergeBatchIn(ctx, tx, q.sc, id, project, team)
		if err != nil {
			return err
		}
		if done == 0 {
			break
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"rows": n, "action": body.Action})
	return nil
}

// removeList answers DELETE /api/v1/imports/{id}/leads: within 24 hours of an import finishing, the person who imported it, a lead of
// its team, or the owner or an admin removes the leads it created, if nobody has called, noted, made a deal on, handed off or changed
// any of them yet (D219). Rows merged into leads that already existed are left as they are. Texts live in the messaging service and
// are not seen here. After that, leads are removed one by one.
func (s *server) removeList(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That import does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var importer, status string
	var team *string
	var finished time.Time
	err = tx.QueryRow(ctx, `SELECT user_id::text, status, team_id::text, updated_at FROM importing.jobs WHERE id = $1 AND org_id = cw_org() FOR UPDATE`, id).Scan(&importer, &status, &team, &finished)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("That import does not exist.")
	}
	if err != nil {
		return err
	}
	allowed := importer == q.sc.userID || q.sc.can("admin") || (team != nil && slices.Contains(q.grant.ManagedTeamIDs, *team))
	if !allowed {
		return forbidden("The person who imported this list, a lead of its team, an admin or the owner removes it.")
	}
	if status != "done" {
		return bad("Only a finished import is removed this way.")
	}
	if s.now().Sub(finished) > 24*time.Hour {
		return bad("More than 24 hours have passed since this list was imported. Remove its leads one by one.")
	}
	var worked bool
	if err := tx.QueryRow(ctx, `WITH made AS (SELECT lead_id FROM importing.rows WHERE job_id = $1 AND state = 'merged' AND match_lead IS NULL AND lead_id IS NOT NULL)
		SELECT EXISTS (SELECT 1 FROM call_events c WHERE c.lead_id IN (SELECT lead_id FROM made))
			OR EXISTS (SELECT 1 FROM notes n WHERE n.lead_id IN (SELECT lead_id FROM made))
			OR EXISTS (SELECT 1 FROM deals d WHERE d.lead_id IN (SELECT lead_id FROM made))
			OR EXISTS (SELECT 1 FROM handoffs h WHERE h.lead_id IN (SELECT lead_id FROM made))
			OR EXISTS (SELECT 1 FROM audit_events a WHERE a.entity = 'lead' AND a.entity_id IN (SELECT lead_id FROM made) AND a.action NOT IN ('lead.created', 'lead.assigned'))`, id).Scan(&worked); err != nil {
		return err
	}
	if worked {
		return bad("Someone has already worked some of these leads. Remove them one by one.")
	}
	tag, err := tx.Exec(ctx, `DELETE FROM leads WHERE id IN (SELECT lead_id FROM importing.rows WHERE job_id = $1 AND state = 'merged' AND match_lead IS NULL AND lead_id IS NOT NULL)`, id)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'skip', lead_id = NULL WHERE job_id = $1 AND state = 'merged' AND match_lead IS NULL`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'access.changed', 'entity', 'organization', 'seq', 0)::text)`); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"removed": tag.RowsAffected()})
	return nil
}
