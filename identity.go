package main

import (
	"database/sql"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// me is who the person is here: their workspaces, what they may do in the one they are working in, and whether it is usable.
// It answers even when the workspace refuses them (second step, payment), so the app can tell them what to do.
func (s *server) me(q *req) error {
	ctx := q.r.Context()
	ppl, err := s.rules.people(ctx, q.c.sub)
	if err != nil {
		return err
	}
	// Caller Whale's own owner, cofounder and system admins work in a workspace of their own, opened for them the first time (and
	// only after their second step), the way the old server did. Everyone else is given a workspace by an owner or by an invitation.
	if len(ppl.Workspaces) == 0 && q.c.secondFactor && slices.Contains([]string{"owner", "cofounder", "system_admin"}, ppl.PlatformRole) {
		if err = s.rules.open(ctx, staffWorkspaceID(q.c.sub), q.c.sub, "owner"); err != nil {
			return err
		}
		if ppl, err = s.rules.people(ctx, q.c.sub); err != nil {
			return err
		}
	}
	chosen := q.r.Header.Get("x-callerwhale-org")
	var lastOrg sql.NullString
	var lastAt sql.NullTime
	var current *workspaceRoles
	for i := range ppl.Workspaces {
		w := &ppl.Workspaces[i]
		s.remember(ctx, q.c, w.OrgID)
		if w.BusinessOwner {
			// A workspace nobody has named yet is called after the person who opened it.
			_, _ = s.st.db.Exec(ctx, `UPDATE orgs SET name = $2 WHERE id = $1 AND name = 'Workspace'`, w.OrgID, label(q.c)+"'s workspace")
		}
		if w.OrgID == chosen {
			current = w
		}
	}
	orgs := []map[string]any{}
	rows, err := s.st.db.Query(ctx, `SELECT id::text, name FROM orgs WHERE id = ANY($1::uuid[]) ORDER BY name`, orgIDs(ppl.Workspaces))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			return err
		}
		orgs = append(orgs, map[string]any{"id": id, "name": name})
	}
	if err = s.st.db.QueryRow(ctx, `SELECT last_org_id::text, last_org_at FROM people WHERE user_id = $1`, q.c.sub).Scan(&lastOrg, &lastAt); err != nil && err != sql.ErrNoRows {
		return err
	}
	if chosen == "" && lastOrg.Valid {
		chosen = lastOrg.String
		for i := range ppl.Workspaces {
			if ppl.Workspaces[i].OrgID == chosen {
				current = &ppl.Workspaces[i]
			}
		}
	}
	if current == nil && len(orgs) > 0 {
		first := orgs[0]["id"].(string)
		for i := range ppl.Workspaces {
			if ppl.Workspaces[i].OrgID == first {
				current = &ppl.Workspaces[i]
			}
		}
	}
	if current != nil && q.r.Header.Get("x-callerwhale-org") == current.OrgID {
		if _, err = s.st.db.Exec(ctx, `UPDATE people SET last_org_id = $2, last_org_at = now() WHERE user_id = $1`, q.c.sub, current.OrgID); err != nil {
			return err
		}
		lastAt = sql.NullTime{Time: s.now(), Valid: true}
	}
	body := map[string]any{
		"user":              map[string]any{"id": q.c.sub, "email": q.c.email, "name": label(q.c), "sign_in": q.c.provider},
		"organizations":     orgs,
		"last_workspace_at": nil,
		"platform_role":     nilIfEmpty(ppl.PlatformRole), "platform_admin": ppl.PlatformRole != "",
		"organization_id": nil, "roles": []string{}, "capabilities": []string{}, "scopes": []string{}, "team_ids": []string{},
		"access_revision": 0,
		"mfa":             map[string]any{"required": false, "enrolled": false, "passed": q.c.secondFactor},
		"subscription":    map[string]any{"plan": "", "status": "active", "usable": true, "reason": nil},
	}
	if lastAt.Valid {
		body["last_workspace_at"] = lastAt.Time
	}
	if current != nil {
		g, err := s.rules.grant(ctx, q.c.sub, current.OrgID, q.c.secondFactor)
		if err != nil {
			return err
		}
		body["organization_id"], body["roles"] = current.OrgID, current.Roles
		switch {
		case g.Allowed:
			body["capabilities"], body["scopes"], body["team_ids"] = nonNil(g.Capabilities), nonNil(g.Scopes), nonNil(g.TeamIDs)
			body["access_revision"] = accessRevision(g)
		case g.Code == "second_step_required":
			body["mfa"] = map[string]any{"required": true, "enrolled": false, "passed": false}
		default: // suspended, payment_required, not_member: usable is false and the reason says why
			body["subscription"] = map[string]any{"plan": "", "status": g.Code, "usable": false, "reason": g.Reason}
		}
	}
	writeJSON(q.w, 200, body)
	return nil
}

func orgIDs(w []workspaceRoles) []string {
	ids := []string{}
	for _, x := range w {
		if validID(x.OrgID) {
			ids = append(ids, x.OrgID)
		}
	}
	return ids
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// account is the person's own record and whether their email is confirmed. Invitations, credits and downloads are not here.
func (s *server) account(q *req) error {
	writeJSON(q.w, 200, map[string]any{
		"person":       map[string]any{"id": q.c.sub, "email": q.c.email, "name": label(q.c), "email_verified": q.c.emailVerified},
		"staff":        nil,
		"access":       nil,
		"can_download": false,
		"release":      nil,
	})
	return nil
}

// directory lists the workspace's people with their roles and teams. External clients see nobody.
func (s *server) directory(q *req) error {
	if q.sc.external() {
		writeJSON(q.w, 200, []any{})
		return nil
	}
	ctx := q.r.Context()
	members, err := s.rules.members(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	names := map[string]string{}
	ids := make([]string, 0, len(members))
	for _, m := range members {
		ids = append(ids, m.UserID)
	}
	rows, err := s.st.db.Query(ctx, `SELECT user_id::text, name FROM people WHERE user_id = ANY($1::uuid[])`, onlyIDs(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			return err
		}
		names[id] = name
	}
	out := make([]map[string]any, 0, len(members))
	for _, m := range members {
		name := names[m.UserID]
		if name == "" {
			name = "Member"
		}
		out = append(out, map[string]any{"id": m.UserID, "name": name, "roles": nonNil(m.Roles), "team_ids": nonNil(m.TeamIDs), "sign_in": nil})
	}
	slices.SortFunc(out, func(a, b map[string]any) int { return strings.Compare(a["name"].(string), b["name"].(string)) })
	writeJSON(q.w, 200, out)
	return nil
}

func onlyIDs(ids []string) []string {
	keep := []string{}
	for _, id := range ids {
		if validID(id) {
			keep = append(keep, id)
		}
	}
	return keep
}

func (s *server) teams(q *req) error {
	tx, err := s.st.begin(q.r.Context(), q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(q.r.Context())
	rows, err := queryJSON(q.r.Context(), tx, `SELECT to_jsonb(t) FROM teams t ORDER BY name`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, rows)
	return nil
}

type named struct {
	Name                string   `json:"name"`
	QualificationFields []string `json:"qualification_fields"`
}

func (s *server) createTeam(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("Only an administrator creates teams.")
	}
	var body named
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 200 {
		return bad("Name the team (up to 200 characters).")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rec, err := queryJSON(ctx, tx, `INSERT INTO teams (org_id, name) VALUES (cw_org(), $1) ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING to_jsonb(teams.*)`, name)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rec[0])
	return nil
}

// projects lists the lists of work the person can see: all of them for an organization-wide role, otherwise their projects
// and the ones holding a lead they may see.
func (s *server) projects(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(p) FROM projects p
		WHERE 'organization' = ANY(string_to_array(current_setting('cw.scopes', true), ','))
		   OR p.id = ANY(cw_uuids('cw.project_ids'))
		   OR EXISTS (SELECT 1 FROM leads l WHERE l.project_id = p.id AND cw_visible_lead(l.id))
		ORDER BY name`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, rows)
	return nil
}

func (s *server) createProject(q *req) error {
	if !q.sc.can("import") {
		return forbidden("Your role cannot create lists.")
	}
	var body named
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 200 {
		return bad("Name the list (up to 200 characters).")
	}
	if body.QualificationFields == nil {
		body.QualificationFields = []string{}
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rec, err := queryJSON(ctx, tx, `INSERT INTO projects (org_id, name, qualification_fields) VALUES (cw_org(), $1, $2) RETURNING to_jsonb(projects.*)`, name, body.QualificationFields)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rec[0])
	return nil
}

// Deleting a source list removes the leads and related CRM records in the same database transaction.
func (s *server) deleteProject(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("Only a workspace administrator can delete source lists.")
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That source list does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var found string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id = $1 FOR UPDATE`, id).Scan(&found); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("That source list does not exist.")
		}
		return err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM importing.jobs WHERE project_id = $1 AND status NOT IN ('failed', 'cancelled', 'done'))`, id).Scan(&active); err != nil {
		return err
	}
	if active {
		return bad("Finish or cancel this source list's import before deleting it.")
	}
	if _, err = tx.Exec(ctx, `CREATE TEMP TABLE _project_leads ON COMMIT DROP AS SELECT id, property_id FROM leads WHERE project_id = $1`, id); err != nil {
		return err
	}
	deleted, err := tx.Exec(ctx, `DELETE FROM leads WHERE id IN (SELECT id FROM _project_leads)`)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op)
		SELECT cw_org(), 'lead', id, id, 'delete' FROM _project_leads`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM properties p WHERE p.id IN (SELECT property_id FROM _project_leads)
		AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.property_id = p.id)
		AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.property_id = p.id)`); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `DELETE FROM importing.jobs WHERE project_id = $1 RETURNING id::text`, id)
	if err != nil {
		return err
	}
	var imports []string
	for rows.Next() {
		var jobID string
		if err = rows.Scan(&jobID); err != nil {
			rows.Close()
			return err
		}
		imports = append(imports, jobID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM projects WHERE id = $1`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'project.changed')::text)`); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	for _, jobID := range imports {
		s.dropUpload(jobID)
	}
	writeJSON(q.w, 200, map[string]any{"removed": id, "deleted_leads": deleted.RowsAffected()})
	return nil
}

func (s *server) renameOrg(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("Only an administrator renames the workspace.")
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 200 {
		return bad("Name the workspace (up to 200 characters).")
	}
	if _, err := s.st.db.Exec(q.r.Context(), `UPDATE orgs SET name = $2 WHERE id = $1`, q.sc.orgID, name); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": q.sc.orgID, "name": name})
	return nil
}
