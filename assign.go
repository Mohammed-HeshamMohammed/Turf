package main

// Giving leads to people, following the team tree (docs/plans/database-and-backend.pdf, chapter 17):
//
//   - The agency owner (or anyone who sees the whole workspace) may give leads to any working member: a team manager, a caller,
//     a closer, themself.
//   - A team manager may give leads to themself and to the callers and closers of the teams they run, and only leads they see.
//   - Nobody gives leads to a client or to someone suspended.
//
// A lead given to a caller or closer moves into their team, so their manager sees it; a lead given to a manager who runs one team
// moves into that team. Bulk assignment (POST /api/v1/assignments) takes picked leads, or everything matching a filter, or the
// first N of it, for one person or shared evenly between several, and runs in batches in the background (assignment_runs).

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const assignBatch = 5000

const noTeam = "00000000-0000-0000-0000-000000000000"

// assignTarget is a person who may receive leads from the asker, and the team those leads move into ("" for none).
type assignTarget struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	TeamID string `json:"team_id"`
}

// assignTargets lists who the asking person may give leads to.
func (s *server) assignTargets(ctx context.Context, sc scope, managed []string) (map[string]assignTarget, error) {
	members, err := s.rules.members(ctx, sc.orgID)
	if err != nil {
		return nil, err
	}
	teams, err := s.rules.teams(ctx, sc.orgID)
	if err != nil {
		return nil, err
	}
	runs := map[string][]string{} // manager -> teams they run
	for _, t := range teams {
		if t.ManagerID != "" {
			runs[t.ManagerID] = append(runs[t.ManagerID], t.TeamID)
		}
	}
	everyone := slices.Contains(sc.scopes, "organization")
	out := map[string]assignTarget{}
	for _, m := range members {
		if len(m.Roles) == 0 || m.SuspendedAt != nil || (len(m.Roles) == 1 && m.Roles[0] == "client") {
			continue
		}
		team := ""
		if len(m.TeamIDs) == 1 {
			team = m.TeamIDs[0] // a caller or closer
		} else if len(runs[m.UserID]) == 1 {
			team = runs[m.UserID][0] // a manager who runs one team
		}
		allowed := everyone || m.UserID == sc.userID || (len(m.TeamIDs) == 1 && slices.Contains(managed, m.TeamIDs[0]))
		if allowed {
			out[m.UserID] = assignTarget{UserID: m.UserID, TeamID: team}
		}
	}
	return out, nil
}

// targetsFor is assignTargets for a request: who the asker may give leads to.
func (s *server) targetsFor(ctx context.Context, q *req) (map[string]assignTarget, error) {
	return s.assignTargets(ctx, q.sc, q.grant.ManagedTeamIDs)
}

// listAssignTargets answers GET /api/v1/assignments/targets: the people the asker may give leads to, with their names.
func (s *server) listAssignTargets(q *req) error {
	if !q.sc.can("assign") {
		writeJSON(q.w, http.StatusOK, map[string]any{"targets": []assignTarget{}})
		return nil
	}
	ctx := q.r.Context()
	targets, err := s.targetsFor(ctx, q)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(targets))
	for id := range targets {
		ids = append(ids, id)
	}
	names := map[string]string{}
	if rows, err := s.st.db.Query(ctx, `SELECT user_id::text, name FROM people WHERE user_id = ANY($1::uuid[])`, ids); err == nil {
		for rows.Next() {
			var id, name string
			if rows.Scan(&id, &name) == nil {
				names[id] = name
			}
		}
		rows.Close()
	}
	out := make([]assignTarget, 0, len(targets))
	for _, t := range targets {
		if t.Name = names[t.UserID]; t.Name == "" {
			t.Name = "Member"
		}
		out = append(out, t)
	}
	slices.SortFunc(out, func(a, b assignTarget) int { return strings.Compare(a.Name, b.Name) })
	writeJSON(q.w, http.StatusOK, map[string]any{"targets": out})
	return nil
}

// assignSelection is which leads a bulk assignment takes.
type assignSelection struct {
	IDs       []string `json:"ids"`
	Stage     string   `json:"stage"`
	ProjectID string   `json:"project_id"`
	Assignee  string   `json:"assignee"` // "unassigned", a person's id, or "" for anyone
	TeamID    string   `json:"team_id"`
}

type assignScope struct {
	UserID     string   `json:"user_id"`
	Scopes     []string `json:"scopes"`
	TeamIDs    []string `json:"team_ids"`
	ProjectIDs []string `json:"project_ids"`
	Caps       []string `json:"caps"`
}

// startAssignment answers POST /api/v1/assignments: it checks the request and starts a run.
func (s *server) startAssignment(q *req) error {
	if !q.sc.can("assign") {
		return forbidden("Your role does not give leads to people.")
	}
	var body struct {
		Selection assignSelection `json:"selection"`
		To        []string        `json:"to"` // empty: make the leads unassigned
		Limit     int64           `json:"limit"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	sel := body.Selection
	if len(sel.IDs) > 100000 {
		return bad("Pick at most 100,000 leads at once, or assign by filter.")
	}
	for _, id := range append(slices.Clone(sel.IDs), sel.ProjectID, sel.TeamID) {
		if id != "" && !validID(id) {
			return bad("A lead, list or team id is not valid.")
		}
	}
	if sel.Assignee != "" && sel.Assignee != "unassigned" && !validID(sel.Assignee) {
		return bad("Filter by a person, or by unassigned leads.")
	}
	if sel.Stage != "" && !slices.Contains(leadStages, sel.Stage) {
		return bad("That is not a lead stage.")
	}
	if body.Limit < 0 || body.Limit > 10000000 {
		return bad("Choose how many leads to give, or all of them.")
	}
	if len(body.To) > 200 {
		return bad("Share the leads between at most 200 people.")
	}
	ctx := q.r.Context()
	allowed, err := s.targetsFor(ctx, q)
	if err != nil {
		return err
	}
	teams := make([]string, 0, len(body.To))
	seen := map[string]bool{}
	for _, id := range body.To {
		t, ok := allowed[id]
		if !ok || seen[id] {
			return forbidden("You can give leads only to the people you manage (and not twice to the same person).")
		}
		seen[id] = true
		team := t.TeamID
		if team == "" {
			team = noTeam
		}
		teams = append(teams, team)
	}
	if body.To == nil {
		body.To = []string{}
	}
	selection, _ := json.Marshal(sel)
	actor, _ := json.Marshal(assignScope{UserID: q.sc.userID, Scopes: q.sc.scopes, TeamIDs: q.sc.teamIDs, ProjectIDs: q.sc.projectIDs, Caps: q.sc.caps})
	var limit any
	if body.Limit > 0 {
		limit = body.Limit
	}
	var id string
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `INSERT INTO assignment_runs (org_id, actor_id, actor_scope, selection, targets, target_teams, limit_n)
		VALUES (cw_org(), $1, $2, $3, $4::uuid[], $5::uuid[], $6) RETURNING id::text`, q.sc.userID, actor, selection, body.To, teams, limit).Scan(&id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	go s.runAssignment(context.Background(), q.sc.orgID, id)
	return s.assignmentReply(q, id)
}

func (s *server) assignmentReply(q *req, id string) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', id, 'status', status, 'assigned', assigned, 'limit', limit_n, 'error', error,
		'created_at', created_at, 'finished_at', finished_at) FROM assignment_runs WHERE id = $1 AND (actor_id = $2::uuid OR $3)`, id, q.sc.userID, slices.Contains(q.sc.scopes, "organization"))
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return notFound("No such assignment.")
	}
	q.w.Header().Set("Content-Type", "application/json")
	q.w.WriteHeader(http.StatusOK)
	_, _ = q.w.Write(rows[0])
	return nil
}

// getAssignment answers GET /api/v1/assignments/{id}: how far a run got.
func (s *server) getAssignment(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return bad("Choose an assignment.")
	}
	return s.assignmentReply(q, id)
}

// runAssignment moves the selected leads to their new people, a batch at a time, each batch in its own transaction, until the
// selection or the limit runs out. A restart continues from the last batch (resumeAssignments).
func (s *server) runAssignment(ctx context.Context, org, id string) {
	fail := func(err error) {
		log.Printf("ERROR assignment %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE assignment_runs SET status = 'failed', error = 'The leads could not all be given. Those already given stay given; try again.', finished_at = now() WHERE id = $1`, id)
	}
	var actorRaw, selRaw []byte
	var targets, teams []string
	var limit *int64
	var assigned int64
	var cursor *string
	err := s.st.db.QueryRow(ctx, `SELECT actor_scope, selection, targets::text[], target_teams::text[], limit_n, assigned, cursor_id::text
		FROM assignment_runs WHERE id = $1 AND org_id = $2 AND status = 'running'`, id, org).Scan(&actorRaw, &selRaw, &targets, &teams, &limit, &assigned, &cursor)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			fail(err)
		}
		return
	}
	var actor assignScope
	var sel assignSelection
	_ = json.Unmarshal(actorRaw, &actor)
	_ = json.Unmarshal(selRaw, &sel)
	sc := scope{userID: actor.UserID, orgID: org, scopes: actor.Scopes, teamIDs: actor.TeamIDs, projectIDs: actor.ProjectIDs, caps: actor.Caps}
	after := ""
	if cursor != nil {
		after = *cursor
	}
	for {
		n := int64(assignBatch)
		if limit != nil {
			if assigned >= *limit {
				break
			}
			n = min(n, *limit-assigned)
		}
		done, last, err := s.assignBatch(ctx, sc, id, sel, targets, teams, assigned, after, n)
		if err != nil {
			fail(err)
			return
		}
		if done == 0 {
			break
		}
		assigned += done
		after = last
	}
	_, _ = s.st.db.Exec(ctx, `UPDATE assignment_runs SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'running'`, id)
	s.hub.publish(org, []byte(`{"kind":"assignment.done","entity":"lead","seq":0}`))
}

// assignBatch gives up to n leads after the cursor, sharing them between the targets in turn (counting from `given`, so the
// shares stay even across batches). It returns how many it gave and the last lead's id.
func (s *server) assignBatch(ctx context.Context, sc scope, id string, sel assignSelection, targets, teams []string, given int64, after string, n int64) (int64, string, error) {
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)
	visible, args := leadVisible(sc, "l", nil)
	where := []string{visible, "l.archived_at IS NULL"}
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	if len(sel.IDs) > 0 {
		where = append(where, "l.id = ANY("+add(sel.IDs)+"::uuid[])")
	}
	if sel.Stage != "" {
		where = append(where, "l.stage = "+add(sel.Stage))
	}
	if sel.ProjectID != "" {
		where = append(where, "l.project_id = "+add(sel.ProjectID)+"::uuid")
	}
	if sel.TeamID != "" {
		where = append(where, "l.team_id = "+add(sel.TeamID)+"::uuid")
	}
	switch sel.Assignee {
	case "":
	case "unassigned":
		where = append(where, "l.assignee_id IS NULL")
	default:
		where = append(where, "l.assignee_id = "+add(sel.Assignee)+"::uuid")
	}
	if after != "" {
		where = append(where, "l.id > "+add(after)+"::uuid")
	}
	rows, err := tx.Query(ctx, `SELECT l.id::text, coalesce(l.assignee_id::text, '') FROM leads l WHERE `+strings.Join(where, " AND ")+
		` ORDER BY l.id LIMIT `+add(n)+` FOR UPDATE OF l SKIP LOCKED`, args...)
	if err != nil {
		return 0, "", err
	}
	var ids, from, to, team []string
	for rows.Next() {
		var lead, was string
		if err := rows.Scan(&lead, &was); err != nil {
			rows.Close()
			return 0, "", err
		}
		k := given + int64(len(ids))
		ids, from = append(ids, lead), append(from, was)
		if len(targets) == 0 {
			to, team = append(to, ""), append(team, "")
		} else {
			to, team = append(to, targets[k%int64(len(targets))]), append(team, teams[k%int64(len(targets))])
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, "", err
	}
	if len(ids) == 0 {
		return 0, "", tx.Commit(ctx)
	}
	// One statement each: the leads, their history, their open tasks, and the change feed every device pulls.
	if _, err := tx.Exec(ctx, `UPDATE leads l SET assignee_id = nullif(t.to_user, '')::uuid,
			team_id = CASE WHEN t.team = '' OR t.team = $4 THEN l.team_id ELSE t.team::uuid END, version = l.version + 1, updated_at = now()
		FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, to_user, team) WHERE l.id = t.id::uuid AND l.org_id = cw_org()`, ids, to, team, noTeam); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id)
		SELECT cw_org(), t.id::uuid, nullif(t.was, '')::uuid, nullif(t.to_user, '')::uuid, 'Bulk assignment', $4::uuid
		FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, was, to_user)`, ids, from, to, sc.userID); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx, `WITH moved AS (
			UPDATE tasks k SET assignee_id = nullif(t.to_user, '')::uuid, version = k.version + 1
			FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, was, to_user)
			WHERE k.lead_id = t.id::uuid AND k.done_at IS NULL AND k.assignee_id IS NOT DISTINCT FROM nullif(t.was, '')::uuid RETURNING k.id, k.lead_id)
		INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) SELECT cw_org(), 'task', id, lead_id, 'upsert' FROM moved`, ids, from, to); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) SELECT cw_org(), 'lead', x::uuid, x::uuid, 'upsert' FROM unnest($1::text[]) AS x`, ids); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE assignment_runs SET assigned = assigned + $2, cursor_id = $3::uuid WHERE id = $1`, id, len(ids), ids[len(ids)-1]); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'assignment.batch', 'entity', 'lead', 'seq', 0)::text)`); err != nil {
		return 0, "", err
	}
	return int64(len(ids)), ids[len(ids)-1], tx.Commit(ctx)
}

// resumeAssignments continues runs that were going when the service last stopped.
func (s *server) resumeAssignments(ctx context.Context) {
	rows, err := s.st.db.Query(ctx, `SELECT id::text, org_id::text FROM assignment_runs WHERE status = 'running'`)
	if err != nil {
		log.Printf("WARN looking for assignments to continue: %v", err)
		return
	}
	type pending struct{ id, org string }
	var runs []pending
	for rows.Next() {
		var p pending
		if rows.Scan(&p.id, &p.org) == nil {
			runs = append(runs, p)
		}
	}
	rows.Close()
	for _, p := range runs {
		s.runAssignment(ctx, p.org, p.id)
	}
}
