package crm

// The new agency's setup checklist (D170), the data processing agreement (D308),
// walk-throughs per role (D173), and the agency's own material that managers assign (D173).

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"
)

// dpaVersion is the data processing agreement the owner accepts now. The lawyer writes its text (D308); a new version asks again.
const dpaVersion = "2026-11-draft"

var setupSteps = []struct{ id, title string }{
	{"name", "Name your agency"},
	{"hours", "Set your working hours"},
	{"team", "Make your first team"},
	{"client", "Add your first client, or choose \"own business\""},
	{"invite", "Invite your people"},
	{"authenticator", "Turn on your authenticator"},
	{"dpa", "Accept the data processing agreement"},
}

func (s *server) setupRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/setup", s.member(s.setupChecklist))
	mux.Handle("POST /api/v1/setup/{step}", s.member(s.markSetupStep))
	mux.Handle("GET /api/v1/agreements/dpa", s.member(s.dpa))
	mux.Handle("POST /api/v1/agreements/dpa", s.member(s.dpa))
	mux.Handle("GET /api/v1/me/walkthroughs", s.member(s.walkthroughs))
	mux.Handle("POST /api/v1/me/walkthroughs", s.member(s.walkthroughs))
	mux.Handle("GET /api/v1/material", s.member(s.listMaterial))
	mux.Handle("POST /api/v1/material", s.member(s.addMaterial))
	mux.Handle("DELETE /api/v1/material/{id}", s.member(s.archiveMaterial))
	mux.Handle("POST /api/v1/material/{id}/assign", s.member(s.assignMaterial))
	mux.Handle("POST /api/v1/material/{id}/finish", s.member(s.finishMaterial))
	mux.Handle("GET /api/v1/material/{id}/progress", s.member(s.materialProgress))
}

// ---- setup (D170, D308) ----

// setupChecklist is GET /api/v1/setup (the owner and admins): each step done, skipped or to do. What the CRM can see counts by itself:
// a renamed agency, a team, a client, someone besides the owner, an authenticator used in this sign-in, the accepted agreement.
func (s *server) setupChecklist(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the setup checklist.")
	}
	ctx := q.r.Context()
	seen := map[string]bool{}
	if teams, err := s.rules.teams(ctx, q.sc.orgID); err == nil && len(teams) > 0 {
		seen["team"] = true
	}
	if members, err := s.rules.members(ctx, q.sc.orgID); err == nil && len(members) > 1 {
		seen["invite"] = true
	}
	if q.c.SecondFactor {
		seen["authenticator"] = true
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var renamed, client, dpa bool
	if err := tx.QueryRow(ctx, `SELECT o.name NOT IN ('', 'Workspace') AND o.name NOT LIKE '%''s workspace', EXISTS (SELECT 1 FROM clients), EXISTS (SELECT 1 FROM agreements WHERE kind = 'dpa' AND version = $1)
		FROM orgs o WHERE o.id = cw_org()`, dpaVersion).Scan(&renamed, &client, &dpa); err != nil {
		return err
	}
	seen["name"], seen["client"], seen["dpa"] = renamed, client, dpa
	marked := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT step, status FROM setup_steps`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var step, status string
		if err := rows.Scan(&step, &status); err != nil {
			rows.Close()
			return err
		}
		marked[step] = status
	}
	rows.Close()
	out := []map[string]any{}
	left := 0
	for _, st := range setupSteps {
		status := "todo"
		switch {
		case seen[st.id]:
			status = "done"
		case st.id != "dpa" && marked[st.id] != "":
			status = marked[st.id]
		case st.id == "dpa" && marked[st.id] == "skipped":
			status = "skipped"
		}
		if status != "done" {
			left++
		}
		out = append(out, map[string]any{"id": st.id, "title": st.title, "status": status})
	}
	writeJSON(q.w, 200, map[string]any{"steps": out, "left": left, "complete": left == 0})
	return nil
}

// markSetupStep is POST /api/v1/setup/{step} {status: done|skipped|todo}: the owner or an admin marks a step, to come back to it later.
// The agreement is done only by accepting it.
func (s *server) markSetupStep(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins set up the agency.")
	}
	step := q.r.PathValue("step")
	if !slices.ContainsFunc(setupSteps, func(x struct{ id, title string }) bool { return x.id == step }) {
		return notFound("No such setup step.")
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.Status != "done" && body.Status != "skipped" && body.Status != "todo" || (step == "dpa" && body.Status == "done") {
		return bad("status is done, skipped or todo; the agreement is done by accepting it.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if body.Status == "todo" {
		_, err = tx.Exec(ctx, `DELETE FROM setup_steps WHERE step = $1`, step)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO setup_steps (org_id, step, status, set_by) VALUES (cw_org(), $1, $2, $3)
			ON CONFLICT (org_id, step) DO UPDATE SET status = EXCLUDED.status, set_by = EXCLUDED.set_by, set_at = now()`, step, body.Status, q.sc.userID)
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.setupChecklist(q)
}

// dpa is GET /api/v1/agreements/dpa (the owner and admins: the current version and who accepted which) and POST {version} (the owner
// accepts the current version; the acceptance is kept as their copy, D308).
func (s *server) dpa(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the agency's agreements.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPost {
		if !isOwner(q.sc) {
			return forbidden("The owner accepts the data processing agreement.")
		}
		var body struct {
			Version string `json:"version"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if body.Version != dpaVersion {
			return conflictErr("That is not the current agreement. Read the current version and accept that one.")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agreements (org_id, kind, version, accepted_by) VALUES (cw_org(), 'dpa', $1, $2) ON CONFLICT DO NOTHING`, dpaVersion, q.sc.userID); err != nil {
			return err
		}
	}
	accepted, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('version', version, 'accepted_by', accepted_by, 'accepted_at', accepted_at) FROM agreements WHERE kind = 'dpa' ORDER BY accepted_at DESC`)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"current_version": dpaVersion, "accepted": accepted,
		"current_accepted": slices.ContainsFunc(accepted, func(a json.RawMessage) bool { return strings.Contains(string(a), `"`+dpaVersion+`"`) })})
	return nil
}

// ---- walk-throughs (D173) ----

// walkthroughs is GET /api/v1/me/walkthroughs (which of the person's roles still have one to see here) and POST {role} (finished).
func (s *server) walkthroughs(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPost {
		var body struct {
			Role string `json:"role"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if !slices.Contains(q.grant.Roles, body.Role) {
			return bad("That is not one of your roles here.")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO walkthroughs (org_id, user_id, role) VALUES (cw_org(), $1, $2) ON CONFLICT DO NOTHING`, q.sc.userID, body.Role); err != nil {
			return err
		}
	}
	done := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT role FROM walkthroughs WHERE user_id = $1`, q.sc.userID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			rows.Close()
			return err
		}
		done[role] = true
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	todo := []string{}
	for _, role := range q.grant.Roles {
		if !done[role] {
			todo = append(todo, role)
		}
	}
	writeJSON(q.w, 200, map[string]any{"roles": nonNil(q.grant.Roles), "to_see": todo})
	return nil
}

// ---- the agency's material (D173) ----

// assignsTo is whether the person may give material to someone: the owner and admins anyone, a team lead the people of their teams.
func (s *server) assignsTo(ctx context.Context, q *req, user string) (bool, error) {
	if manages(q.sc) {
		return true, nil
	}
	members, err := s.rules.members(ctx, q.sc.orgID)
	if err != nil {
		return false, err
	}
	for _, m := range members {
		if m.UserID == user && slices.ContainsFunc(m.TeamIDs, func(t string) bool { return slices.Contains(q.grant.ManagedTeamIDs, t) }) {
			return true, nil
		}
	}
	return false, nil
}

// addMaterial is POST /api/v1/material {title, url, body, team_id}: the owner and admins for the agency, a team lead for their team.
func (s *server) addMaterial(q *req) error {
	var body struct {
		Title  string `json:"title"`
		URL    string `json:"url"`
		Body   string `json:"body"`
		TeamID string `json:"team_id"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	title, url, text := strings.TrimSpace(body.Title), strings.TrimSpace(body.URL), strings.TrimSpace(body.Body)
	if title == "" || len(title) > 160 || (url == "" && text == "") || (url != "" && !strings.HasPrefix(url, "https://")) || len(text) > 50000 {
		return bad("Give a title and either an https link or the text.")
	}
	switch {
	case manages(q.sc):
	case body.TeamID != "" && slices.Contains(q.grant.ManagedTeamIDs, body.TeamID):
	default:
		return forbidden("The owner and admins add the agency's material; a team lead adds their team's.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `INSERT INTO material (org_id, title, url, body, team_id, created_by) VALUES (cw_org(), $1, $2, $3, $4, $5) RETURNING to_jsonb(material.*)`,
		title, url, text, nullID(body.TeamID), q.sc.userID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

func (s *server) archiveMaterial(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var team *string
	if err := tx.QueryRow(ctx, `SELECT team_id::text FROM material WHERE id = $1 AND archived_at IS NULL`, nullID(q.r.PathValue("id"))).Scan(&team); err != nil {
		return notFound("No such material.")
	}
	if !manages(q.sc) && (team == nil || !slices.Contains(q.grant.ManagedTeamIDs, *team)) {
		return forbidden("Whoever may add it puts it away.")
	}
	if _, err := tx.Exec(ctx, `UPDATE material SET archived_at = now() WHERE id = $1`, q.r.PathValue("id")); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// listMaterial is GET /api/v1/material: what was given to the person, with what they finished; for the owner, admins and team leads,
// also everything they may assign, with how many finished it.
func (s *server) listMaterial(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	mine, err := queryJSON(ctx, tx, `SELECT to_jsonb(m) || jsonb_build_object('due_at', a.due_at, 'finished_at', a.finished_at)
		FROM material_assignments a JOIN material m ON m.id = a.material_id WHERE a.user_id = $1 AND m.archived_at IS NULL ORDER BY a.finished_at NULLS FIRST, a.due_at NULLS LAST`, q.sc.userID)
	if err != nil {
		return err
	}
	body := map[string]any{"mine": mine}
	if manages(q.sc) || len(q.grant.ManagedTeamIDs) > 0 {
		all, err := queryJSON(ctx, tx, `SELECT to_jsonb(m) || jsonb_build_object('assigned', (SELECT count(*) FROM material_assignments a WHERE a.material_id = m.id),
			'finished', (SELECT count(*) FROM material_assignments a WHERE a.material_id = m.id AND a.finished_at IS NOT NULL))
			FROM material m WHERE m.archived_at IS NULL AND ($1 OR m.team_id IS NULL OR m.team_id = ANY($2::uuid[])) ORDER BY m.created_at DESC`,
			manages(q.sc), uuidArray(q.grant.ManagedTeamIDs))
		if err != nil {
			return err
		}
		body["all"] = all
	}
	writeJSON(q.w, 200, body)
	return nil
}

// assignMaterial is POST /api/v1/material/{id}/assign {user_ids, due_at}.
func (s *server) assignMaterial(q *req) error {
	var body struct {
		UserIDs []string   `json:"user_ids"`
		DueAt   *time.Time `json:"due_at"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if len(body.UserIDs) == 0 || len(body.UserIDs) > 500 {
		return bad("Choose 1 to 500 people (user_ids).")
	}
	ctx := q.r.Context()
	for _, u := range body.UserIDs {
		ok, err := s.assignsTo(ctx, q, u)
		if err != nil {
			return err
		}
		if !ok || !validID(u) {
			return forbidden("You give material only to people you manage.")
		}
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id := q.r.PathValue("id")
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM material WHERE id = $1 AND archived_at IS NULL)`, nullID(id)).Scan(&exists); err != nil || !exists {
		return notFound("No such material.")
	}
	for _, u := range body.UserIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO material_assignments (org_id, material_id, user_id, assigned_by, due_at) VALUES (cw_org(), $1, $2, $3, $4)
			ON CONFLICT (material_id, user_id) DO UPDATE SET due_at = EXCLUDED.due_at`, id, u, q.sc.userID, body.DueAt); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"assigned": len(body.UserIDs)})
	return nil
}

// finishMaterial is POST /api/v1/material/{id}/finish: the person finished what they were given.
func (s *server) finishMaterial(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE material_assignments SET finished_at = coalesce(finished_at, now()) WHERE material_id = $1 AND user_id = $2`, nullID(q.r.PathValue("id")), q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("This was not given to you.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// materialProgress is GET /api/v1/material/{id}/progress: who was given it and who finished, for whoever may assign it (a team lead
// sees their own people).
func (s *server) materialProgress(q *req) error {
	if !manages(q.sc) && len(q.grant.ManagedTeamIDs) == 0 {
		return forbidden("The owner, admins and team leads see who finished material.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT user_id::text, assigned_at, due_at, finished_at FROM material_assignments WHERE material_id = $1 ORDER BY finished_at NULLS FIRST`, nullID(q.r.PathValue("id")))
	if err != nil {
		return err
	}
	type line struct {
		UserID     string     `json:"user_id"`
		AssignedAt time.Time  `json:"assigned_at"`
		DueAt      *time.Time `json:"due_at"`
		FinishedAt *time.Time `json:"finished_at"`
	}
	var all []line
	for rows.Next() {
		var l line
		if err := rows.Scan(&l.UserID, &l.AssignedAt, &l.DueAt, &l.FinishedAt); err != nil {
			rows.Close()
			return err
		}
		all = append(all, l)
	}
	rows.Close()
	out := []line{}
	for _, l := range all {
		if ok, err := s.assignsTo(ctx, q, l.UserID); err == nil && ok {
			out = append(out, l)
		}
	}
	writeJSON(q.w, 200, map[string]any{"people": out})
	return nil
}
