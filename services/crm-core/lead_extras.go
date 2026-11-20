package main

// Step 20, part C: tags (D230), merging two copies of one person with undo (D231), and how long unworked leads are kept (D224).

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// leadTagsColumn adds a lead's tags to its record, so every read of a lead carries them.
func leadTagsColumn(alias string) string {
	return `jsonb_build_object('tag_ids', coalesce((SELECT jsonb_agg(lt.tag_id ORDER BY lt.added_at) FROM lead_tags lt WHERE lt.lead_id = ` + alias + `.id), '[]'::jsonb))`
}

// ------------------------------------------------------------------------------------------------------------------- tags

// listTags answers GET /api/v1/tags: the agency's tags and those of the person's teams.
func (s *server) listTags(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	teams := append(append(append([]string{}, q.sc.teamIDs...), q.grant.ManagedTeamIDs...), q.grant.DeputyTeamIDs...)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(t) FROM tags t WHERE t.team_id IS NULL OR $1 OR t.team_id = ANY($2::uuid[]) ORDER BY t.team_id NULLS FIRST, lower(t.name)`,
		slices.Contains(q.sc.scopes, "organization"), uuidArray(teams))
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"tags": rows})
	return nil
}

// createTag answers POST /api/v1/tags: an agency tag by the owner or an admin, a team tag by that team's leads (D230).
func (s *server) createTag(q *req) error {
	var body struct {
		Name   string `json:"name"`
		Color  string `json:"color"`
		TeamID string `json:"team_id"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 40 || len(body.Color) > 20 {
		return bad("Name the tag in 40 characters or fewer.")
	}
	var team any
	if body.TeamID == "" {
		if !q.sc.can("admin") {
			return forbidden("The owner or an admin makes agency tags; a team lead makes tags for their team.")
		}
	} else {
		if !validID(body.TeamID) || !runsTeam(q.sc, q.grant, body.TeamID) {
			return forbidden("A team's tags are made by its leads, an admin or the owner.")
		}
		team = body.TeamID
	}
	ctx := q.r.Context()
	if team != nil {
		if listed, err := s.rules.teams(ctx, q.sc.orgID); err == nil {
			if err := s.copyTeams(ctx, q.sc, listed); err != nil {
				return err
			}
		}
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := queryOne(ctx, tx, `INSERT INTO tags (org_id, team_id, name, color, created_by) VALUES (cw_org(), $1, $2, $3, $4) RETURNING to_jsonb(tags.*)`, team, body.Name, body.Color, q.sc.userID)
	if err != nil {
		if strings.Contains(err.Error(), "tags_name") {
			return &apiError{http.StatusConflict, "conflict", "There is already a tag with that name."}
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusCreated, map[string]any{"tag": tag})
	return nil
}

// deleteTag answers DELETE /api/v1/tags/{id}: by whoever may make it. Leads lose it.
func (s *server) deleteTag(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That tag does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var team *string
	err = tx.QueryRow(ctx, `SELECT team_id::text FROM tags WHERE id = $1`, id).Scan(&team)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("That tag does not exist.")
	}
	if err != nil {
		return err
	}
	if (team == nil && !q.sc.can("admin")) || (team != nil && !runsTeam(q.sc, q.grant, *team)) {
		return forbidden("Only whoever may make this tag removes it.")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tags WHERE id = $1`, id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// leadTag puts an existing tag on a lead or takes it off: anyone who may edit the lead, with an agency tag or one of the lead's team.
func (r *run) leadTag(p map[string]any, on bool) (any, error) {
	if err := r.need("edit"); err != nil {
		return nil, err
	}
	leadID, err := uuidField(p, "lead_id")
	if err != nil {
		return nil, err
	}
	tagID, err := uuidField(p, "tag_id")
	if err != nil {
		return nil, err
	}
	before, err := r.visibleLead(leadID, true)
	if err != nil {
		return nil, err
	}
	if !canEditLead(r.sc, before) {
		return nil, reject("You can only tag leads you can edit")
	}
	var team *string
	if err := r.tx.QueryRow(r.ctx, `SELECT team_id::text FROM tags WHERE id = $1`, tagID).Scan(&team); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, reject("That tag does not exist")
		}
		return nil, err
	}
	if team != nil && *team != asString(before["team_id"]) {
		return nil, reject("That tag belongs to another team")
	}
	if on {
		err = r.exec(`INSERT INTO lead_tags (org_id, lead_id, tag_id, added_by) VALUES (cw_org(), $1, $2, $3) ON CONFLICT DO NOTHING`, leadID, tagID, r.sc.userID)
	} else {
		err = r.exec(`DELETE FROM lead_tags WHERE lead_id = $1 AND tag_id = $2`, leadID, tagID)
	}
	if err != nil {
		return nil, err
	}
	if err = r.exec(`UPDATE leads SET version = version + 1, updated_at = now() WHERE id = $1`, leadID); err != nil {
		return nil, err
	}
	after, err := r.one(`SELECT to_jsonb(l) || `+leadTagsColumn("l")+` FROM leads l WHERE id = $1`, leadID)
	if err != nil {
		return nil, err
	}
	kind := "lead.untagged"
	if on {
		kind = "lead.tagged"
	}
	if err = r.record(change{entity: "lead", kind: kind, id: leadID, leadID: leadID, before: before, after: after}); err != nil {
		return nil, err
	}
	return redactLead(after, r.sc), nil
}

// ---------------------------------------------------------------------------------------------------------------- merging

// mergeRights is whether the person may merge these two leads: the owner or an admin, or a lead of the team both belong to (D231).
func (r *run) mergeRights(a, b map[string]any) error {
	if slices.Contains(r.sc.scopes, "organization") && r.sc.can("admin") {
		return nil
	}
	team := asString(a["team_id"])
	if team == "" || team != asString(b["team_id"]) {
		return reject("Only the owner or an admin merges leads of different teams")
	}
	g, err := r.s.rules.grant(r.ctx, r.sc.userID, r.sc.orgID, r.sc.secondStep)
	if err != nil {
		return err
	}
	if !slices.Contains(g.ManagedTeamIDs, team) {
		return reject("A team lead, an admin or the owner merges leads")
	}
	return nil
}

// leadMerge folds one lead into another: its notes, calls, tasks, deals, handoffs and tags move to the kept lead, its numbers and
// emails join the kept lead's, and it is put aside (deleted, merged_into). Undone for 7 days with lead.unmerge.
func (r *run) leadMerge(p map[string]any) (any, error) {
	keepID, err := uuidField(p, "keep_id")
	if err != nil {
		return nil, err
	}
	mergeID, err := uuidField(p, "merge_id")
	if err != nil {
		return nil, err
	}
	if keepID == mergeID {
		return nil, reject("Choose two different leads")
	}
	keep, err := r.visibleLead(keepID, true)
	if err != nil {
		return nil, err
	}
	gone, err := r.visibleLead(mergeID, true)
	if err != nil {
		return nil, err
	}
	if err := r.mergeRights(keep, gone); err != nil {
		return nil, err
	}
	if err := sameClient(keep, gone); err != nil {
		return nil, err
	}
	var open bool
	if err := r.tx.QueryRow(r.ctx, `SELECT EXISTS (SELECT 1 FROM handoffs WHERE lead_id IN ($1, $2) AND status = 'Requested')`, keepID, mergeID).Scan(&open); err != nil {
		return nil, err
	}
	if open {
		return nil, reject("Finish the open handoff first")
	}
	moved := map[string]any{}
	for name, table := range map[string]string{"notes": "notes", "calls": "call_events", "tasks": "tasks", "deals": "deals", "handoffs": "handoffs"} {
		var ids []string
		rows, err := r.tx.Query(r.ctx, `UPDATE `+table+` SET lead_id = $1 WHERE lead_id = $2 RETURNING id::text`, keepID, mergeID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		moved[name] = nonNilList(ids)
	}
	var tags []string
	rows, err := r.tx.Query(r.ctx, `INSERT INTO lead_tags (org_id, lead_id, tag_id, added_by) SELECT org_id, $1, tag_id, added_by FROM lead_tags WHERE lead_id = $2
		ON CONFLICT DO NOTHING RETURNING tag_id::text`, keepID, mergeID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		tags = append(tags, id)
	}
	rows.Close()
	moved["tags"] = nonNilList(tags)
	keptBefore := map[string]any{"phone": keep["phone"], "email": keep["email"], "contacts": keep["contacts"]}
	// Every way to reach the person joins the kept lead; its own phone and email stay first.
	if err = r.exec(`UPDATE leads k SET
			phone = CASE WHEN k.phone = '' THEN m.phone ELSE k.phone END,
			email = CASE WHEN k.email = '' THEN m.email ELSE k.email END,
			contacts = jsonb_build_object(
				'owners', (SELECT coalesce(jsonb_agg(DISTINCT v), '[]') FROM jsonb_array_elements(coalesce(k.contacts->'owners', '[]') || coalesce(m.contacts->'owners', '[]')) v),
				'phones', (SELECT coalesce(jsonb_agg(DISTINCT v), '[]') FROM jsonb_array_elements(coalesce(k.contacts->'phones', '[]') || coalesce(m.contacts->'phones', '[]')
					|| CASE WHEN m.phone <> '' AND m.phone <> k.phone THEN jsonb_build_array(jsonb_build_object('number', m.phone)) ELSE '[]'::jsonb END) v),
				'emails', (SELECT coalesce(jsonb_agg(DISTINCT v), '[]') FROM jsonb_array_elements(coalesce(k.contacts->'emails', '[]') || coalesce(m.contacts->'emails', '[]')
					|| CASE WHEN m.email <> '' AND m.email <> k.email THEN jsonb_build_array(m.email) ELSE '[]'::jsonb END) v)),
			version = k.version + 1, updated_at = now()
		FROM leads m WHERE k.id = $1 AND m.id = $2`, keepID, mergeID); err != nil {
		return nil, err
	}
	if err = r.exec(`UPDATE leads SET deleted_at = now(), merged_into = $2, version = version + 1, updated_at = now() WHERE id = $1`, mergeID, keepID); err != nil {
		return nil, err
	}
	merge, err := r.one(`INSERT INTO lead_merges (org_id, kept_id, merged_id, moved, kept_before, merged_by) VALUES (cw_org(), $1, $2, $3, $4, $5) RETURNING to_jsonb(lead_merges.*)`,
		keepID, mergeID, moved, keptBefore, r.sc.userID)
	if err != nil {
		return nil, err
	}
	after, err := r.one(`SELECT to_jsonb(l) || `+leadTagsColumn("l")+` FROM leads l WHERE id = $1`, keepID)
	if err != nil {
		return nil, err
	}
	if err = r.record(change{entity: "lead", kind: "lead.merged", id: keepID, leadID: keepID, before: keep, after: after}); err != nil {
		return nil, err
	}
	if err = r.record(change{entity: "lead", kind: "lead.merged_away", id: mergeID, leadID: mergeID, before: gone, deleted: true}); err != nil {
		return nil, err
	}
	return map[string]any{"merge": merge, "lead": redactLead(after, r.sc)}, nil
}

// leadUnmerge undoes a merge within 7 days: what moved goes back, the kept lead's numbers are as they were, and the merged lead returns.
func (r *run) leadUnmerge(p map[string]any) (any, error) {
	id, err := uuidField(p, "merge_id")
	if err != nil {
		return nil, err
	}
	m, err := r.one(`SELECT to_jsonb(x) FROM lead_merges x WHERE id = $1 FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if m == nil || !isNull(m["undone_at"]) {
		return nil, reject("That merge does not exist or was already undone")
	}
	at, err := time.Parse(time.RFC3339Nano, asString(m["merged_at"]))
	if err != nil {
		return nil, err
	}
	if r.s.now().Sub(at) > 7*24*time.Hour {
		return nil, reject("A merge can be undone for 7 days")
	}
	keepID, mergeID := asString(m["kept_id"]), asString(m["merged_id"])
	keep, err := r.visibleLead(keepID, true)
	if err != nil {
		return nil, err
	}
	gone, err := r.one(`SELECT to_jsonb(l) FROM leads l WHERE id = $1 FOR UPDATE`, mergeID)
	if err != nil || gone == nil {
		return nil, reject("The merged lead is gone")
	}
	if err := r.mergeRights(keep, gone); err != nil {
		return nil, err
	}
	moved, _ := m["moved"].(map[string]any)
	for name, table := range map[string]string{"notes": "notes", "calls": "call_events", "tasks": "tasks", "deals": "deals", "handoffs": "handoffs"} {
		ids := stringsOf(moved[name])
		if len(ids) == 0 {
			continue
		}
		if err := r.exec(`UPDATE `+table+` SET lead_id = $1 WHERE id = ANY($2::uuid[]) AND lead_id = $3`, mergeID, uuidArray(ids), keepID); err != nil {
			return nil, err
		}
	}
	if tags := stringsOf(moved["tags"]); len(tags) > 0 {
		if err := r.exec(`DELETE FROM lead_tags WHERE lead_id = $1 AND tag_id = ANY($2::uuid[])`, keepID, uuidArray(tags)); err != nil {
			return nil, err
		}
	}
	before, _ := m["kept_before"].(map[string]any)
	if err := r.exec(`UPDATE leads SET phone = coalesce($2, phone), email = coalesce($3, email), contacts = coalesce($4::jsonb, contacts), version = version + 1, updated_at = now() WHERE id = $1`,
		keepID, before["phone"], before["email"], before["contacts"]); err != nil {
		return nil, err
	}
	if err := r.exec(`UPDATE leads SET deleted_at = NULL, merged_into = NULL, version = version + 1, updated_at = now() WHERE id = $1`, mergeID); err != nil {
		return nil, err
	}
	if err := r.exec(`UPDATE lead_merges SET undone_at = now() WHERE id = $1`, id); err != nil {
		return nil, err
	}
	for _, lead := range []string{keepID, mergeID} {
		after, err := r.one(`SELECT to_jsonb(l) || `+leadTagsColumn("l")+` FROM leads l WHERE id = $1`, lead)
		if err != nil {
			return nil, err
		}
		if err := r.record(change{entity: "lead", kind: "lead.unmerged", id: lead, leadID: lead, after: after}); err != nil {
			return nil, err
		}
	}
	return map[string]any{"merge_id": id, "restored": mergeID}, nil
}

func nonNilList(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

func stringsOf(v any) []string {
	items, _ := v.([]any)
	out := []string{}
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// -------------------------------------------------------------------------------------------------------------- retention

// retentionLimitDays is the longest an agency may keep an unworked lead until the lawyer sets the period (D224). Nothing is deleted
// on its own: the owner looks at the list and removes what is due.
const retentionLimitDays = 3650

// dueSince is when a lead counts as unworked: no call, note or change since.
const dueWhere = `l.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM lead_keeps k WHERE k.lead_id = l.id)
	AND greatest(l.updated_at, coalesce((SELECT max(c.occurred_at) FROM call_events c WHERE c.lead_id = l.id), l.created_at),
		coalesce((SELECT max(n.occurred_at) FROM notes n WHERE n.lead_id = l.id), l.created_at)) < now() - make_interval(days => $1)`

func (s *server) retention(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("The owner or an admin sets how long leads are kept.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPut {
		var body struct {
			KeepDays *int `json:"keep_days"` // null: keep everything
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if body.KeepDays != nil && (*body.KeepDays < 30 || *body.KeepDays > retentionLimitDays) {
			return bad("Keep unworked leads between 30 days and 10 years, or always.")
		}
		if _, err := tx.Exec(ctx, `UPDATE orgs SET keep_days = $1 WHERE id = cw_org()`, body.KeepDays); err != nil {
			return err
		}
	}
	var days *int
	if err := tx.QueryRow(ctx, `SELECT keep_days FROM orgs WHERE id = cw_org()`).Scan(&days); err != nil {
		return err
	}
	answer := map[string]any{"keep_days": days, "due": []any{}, "due_count": 0}
	if days != nil {
		due, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', l.id, 'name', l.name, 'stage', l.stage, 'team_id', l.team_id, 'updated_at', l.updated_at)
			FROM leads l WHERE `+dueWhere+` ORDER BY l.updated_at LIMIT 500`, *days)
		if err != nil {
			return err
		}
		var n int64
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM leads l WHERE `+dueWhere, *days).Scan(&n); err != nil {
			return err
		}
		answer["due"], answer["due_count"] = due, n
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, answer)
	return nil
}

// keepLeads answers POST /api/v1/retention/keep: the owner or an admin keeps leads past the period, with why.
func (s *server) keepLeads(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("The owner or an admin keeps leads past the period.")
	}
	var body struct {
		LeadIDs []string `json:"lead_ids"`
		Reason  string   `json:"reason"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if len(body.LeadIDs) == 0 || len(body.LeadIDs) > 5000 || body.Reason == "" || len(body.Reason) > 500 {
		return bad("Choose leads and say why they are kept.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `INSERT INTO lead_keeps (lead_id, org_id, reason, kept_by) SELECT id, cw_org(), $2, $3 FROM leads WHERE id = ANY($1::uuid[])
		ON CONFLICT (lead_id) DO UPDATE SET reason = EXCLUDED.reason, kept_by = EXCLUDED.kept_by, kept_at = now()`, uuidArray(body.LeadIDs), body.Reason, q.sc.userID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"kept": tag.RowsAffected()})
	return nil
}

// removeDue answers POST /api/v1/retention/remove: the owner (not an admin: deleting for good is the owner's) removes the leads that are
// due, after looking at the list. Kept leads stay.
func (s *server) removeDue(q *req) error {
	if !slices.Contains(q.grant.Roles, "owner") && !slices.Contains(q.grant.Roles, "solo") {
		return forbidden("The agency owner removes leads that are due.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var days *int
	if err := tx.QueryRow(ctx, `SELECT keep_days FROM orgs WHERE id = cw_org()`).Scan(&days); err != nil {
		return err
	}
	if days == nil {
		return bad("This agency keeps every lead. Set how long first.")
	}
	removed, err := removeDueIn(ctx, tx, *days)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'access.changed', 'entity', 'organization', 'seq', 0)::text)`); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"removed": removed})
	return nil
}

func removeDueIn(ctx context.Context, tx pgx.Tx, days int) (int64, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM leads WHERE id IN (SELECT l.id FROM leads l WHERE `+dueWhere+`)`, days)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
