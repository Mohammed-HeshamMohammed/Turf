package main

// Handing on a person's work (build step 12). Someone who left, was removed or is suspended keeps their name on their leads: the
// leads stay with their teams, where the team's leads hold them and can work them (D20, D26, D182; D365 for a seat lost with a smaller
// plan). Nothing moves until someone hands it on, so a suspended person who comes back finds whatever was not handed on (D26).
// The owner or an admin hands on anyone's work, all to one person or to the team's unassigned leads; a team lead hands on the work in
// the teams they lead (D25, D67). Leads take their deal, open tasks and callbacks along, due times kept; notes stay on the lead (D102).

import (
	"context"
	"net/http"
	"slices"
	"time"
)

// awayPerson is someone whose work waits: no longer a member, or suspended.
type awayPerson struct {
	UserID      string   `json:"user_id"`
	Name        string   `json:"name"`
	Why         string   `json:"why"` // "left" (left or was removed) or "suspended"
	SuspendedAt *int64   `json:"suspended_at,omitempty"`
	Leads       int64    `json:"leads"`
	Tasks       int64    `json:"tasks"`
	TeamIDs     []string `json:"team_ids"`
}

// awayAndActive is who in the workspace is away (gone or suspended), and who is still working.
func (s *server) awayAndActive(ctx context.Context, org string) (map[string]member, []string, error) {
	members, err := s.rules.members(ctx, org)
	if err != nil {
		return nil, nil, err
	}
	suspended := map[string]member{}
	active := []string{}
	for _, m := range members {
		if len(m.Roles) == 0 {
			continue
		}
		if m.SuspendedAt != nil {
			suspended[m.UserID] = m
		} else {
			active = append(active, m.UserID)
		}
	}
	return suspended, active, nil
}

// handOnScope is the teams the person may hand on work in: every team and leads with no team for the owner and admins (all is true),
// else the teams they lead.
func handOnScope(q *req) (all bool, teams []string, err error) {
	if slices.Contains(q.sc.scopes, "organization") {
		return true, nil, nil
	}
	if len(q.grant.ManagedTeamIDs) == 0 {
		return false, nil, forbidden("The owner, an admin or a team lead hands on work.")
	}
	return false, q.grant.ManagedTeamIDs, nil
}

// waitingWork answers GET /api/v1/handon: the people whose work waits to be handed on, with how much, in the asker's reach.
func (s *server) waitingWork(q *req) error {
	all, teams, err := handOnScope(q)
	if err != nil {
		return err
	}
	ctx := q.r.Context()
	suspended, active, err := s.awayAndActive(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT l.assignee_id::text, coalesce(p.name, ''), count(*), array_agg(DISTINCT coalesce(l.team_id::text, '')),
			(SELECT count(*) FROM tasks t WHERE t.assignee_id = l.assignee_id AND t.done_at IS NULL)
		FROM leads l LEFT JOIN people p ON p.user_id = l.assignee_id
		WHERE l.deleted_at IS NULL AND l.archived_at IS NULL AND l.assignee_id IS NOT NULL AND NOT (l.assignee_id = ANY($1::uuid[]))
			AND ($2 OR l.team_id = ANY($3::uuid[]))
		GROUP BY l.assignee_id, p.name ORDER BY count(*) DESC LIMIT 200`, uuidArray(active), all, uuidArray(teams))
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []awayPerson{}
	for rows.Next() {
		var a awayPerson
		if err := rows.Scan(&a.UserID, &a.Name, &a.Leads, &a.TeamIDs, &a.Tasks); err != nil {
			return err
		}
		a.TeamIDs = slices.DeleteFunc(a.TeamIDs, func(t string) bool { return t == "" })
		a.Why = "left"
		if m, ok := suspended[a.UserID]; ok {
			a.Why, a.SuspendedAt = "suspended", m.SuspendedAt
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"people": out})
	return nil
}

// handOn answers POST /api/v1/handon/{user}: the away person's leads (with their deal, open tasks and callbacks) go to one person, or
// back to their teams unassigned for the team's leads to hand out. team_id narrows it to one team, so parts can go to different
// people. Someone still working is not handed on this way: their lead gives their leads to others as usual.
func (s *server) handOn(q *req) error {
	user := q.r.PathValue("user")
	if !validID(user) {
		return bad("Choose a person.")
	}
	all, teams, err := handOnScope(q)
	if err != nil {
		return err
	}
	var body struct {
		To     string `json:"to"`      // the person who takes it; empty: the team's unassigned leads
		TeamID string `json:"team_id"` // only this team's work; empty: all of it in the asker's reach
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	_, active, err := s.awayAndActive(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	if slices.Contains(active, user) {
		return bad("This person is still working. Give their leads to others the usual way.")
	}
	if body.TeamID != "" {
		if !validID(body.TeamID) || (!all && !slices.Contains(teams, body.TeamID)) {
			return forbidden("You hand on work in the teams you lead.")
		}
		all, teams = false, []string{body.TeamID}
	}
	var to any
	if body.To != "" {
		targets, err := s.assignTargets(ctx, q.sc, q.grant.ManagedTeamIDs)
		if err != nil {
			return err
		}
		if _, ok := targets[body.To]; !ok || !slices.Contains(active, body.To) {
			return forbidden("Hand it on to someone working whom you manage.")
		}
		to = body.To
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	leads, err := tx.Query(ctx, `UPDATE leads SET assignee_id = $2, version = version + 1, updated_at = now()
		WHERE assignee_id = $1 AND deleted_at IS NULL AND ($3 OR team_id = ANY($4::uuid[])) RETURNING id::text`, user, to, all, uuidArray(teams))
	if err != nil {
		return err
	}
	var moved []string
	for leads.Next() {
		var id string
		if err := leads.Scan(&id); err != nil {
			leads.Close()
			return err
		}
		moved = append(moved, id)
	}
	leads.Close()
	if err := leads.Err(); err != nil {
		return err
	}
	// Open tasks and callbacks on those leads follow them, their due times kept; with no one to take them they wait with the lead.
	tasks, err := tx.Exec(ctx, `UPDATE tasks SET assignee_id = $2, version = version + 1 WHERE assignee_id = $1 AND done_at IS NULL AND lead_id = ANY($3::uuid[])`,
		user, to, uuidArray(moved))
	if err != nil {
		return err
	}
	// Their own tasks with no lead go to the person taking the work, when handing on everything.
	var own int64
	if all && to != nil {
		tag, err := tx.Exec(ctx, `UPDATE tasks SET assignee_id = $2, version = version + 1 WHERE assignee_id = $1 AND done_at IS NULL AND lead_id IS NULL`, user, to)
		if err != nil {
			return err
		}
		own = tag.RowsAffected()
	}
	reason := "handed on"
	for _, id := range moved {
		if _, err := tx.Exec(ctx, `INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id) VALUES (cw_org(), $1, $2, $3, $4, $5)`, id, user, to, reason, q.sc.userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_events (org_id, actor_id, actor_label, entity, entity_id, action, after, occurred_at)
		VALUES (cw_org(), $1, $2, 'person', $3, 'work.handed_on', $4, now())`, q.sc.userID, q.sc.label, user,
		map[string]any{"to": to, "team_id": body.TeamID, "leads": len(moved), "tasks": tasks.RowsAffected() + own}); err != nil {
		return err
	}
	if len(moved) > 0 {
		if _, err := tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'lead.assigned', 'entity', 'lead', 'seq', 0)::text)`); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"leads": len(moved), "tasks": tasks.RowsAffected() + own, "at": time.Now().Unix()})
	return nil
}
