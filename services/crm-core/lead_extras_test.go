package crm

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// Step 20, part C: tags (D230), merging two copies of one person with undo (D231), and how long unworked leads are kept (D224).
func TestTagsMergesAndRetention(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000d1", "aaaaaaaa-0000-4000-8000-0000000000d2"
	const dave = "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}}, {UserID: dave, Roles: []string{"manager"}}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	ownerGrant := owner()
	ownerGrant.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = ownerGrant
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call", "import"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{}, Capabilities: []string{"edit", "handoff", "call"}, Roles: []string{"caller"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)
	lead := func(name, phone string) string {
		t.Helper()
		id := newID(t)
		e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": id, "name": name, "phone": phone}, newID(t)), "applied")
		if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2, team_id = $3 WHERE id = $1`, id, bob, teamT); err != nil {
			t.Fatal(err)
		}
		return id
	}

	// Tags: agency tags by the owner, team tags by the team's leads, agents only apply them.
	tagOf := func(user string, body map[string]any) (int, string) {
		status, out := e.call(user, orgA, "POST", "/api/v1/tags", body)
		if tag, ok := out["tag"].(map[string]any); ok {
			return status, tag["id"].(string)
		}
		return status, ""
	}
	status, hot := tagOf(alice, map[string]any{"name": "Hot"})
	if status != 201 {
		t.Fatalf("an agency tag: %d", status)
	}
	if status, _ := tagOf(dave, map[string]any{"name": "Probate", "team_id": teamT}); status != 201 {
		t.Fatalf("a team tag by its lead: %d", status)
	}
	if status, _ := tagOf(dave, map[string]any{"name": "Agency"}); status != 403 {
		t.Fatalf("a team lead makes an agency tag: %d", status)
	}
	if status, _ := tagOf(bob, map[string]any{"name": "Mine", "team_id": teamT}); status != 403 {
		t.Fatalf("an agent makes a tag: %d", status)
	}
	if status, _ := tagOf(alice, map[string]any{"name": "hot"}); status != 409 {
		t.Fatalf("two tags with one name: %d", status)
	}
	_, otherTeamTag := tagOf(alice, map[string]any{"name": "U only", "team_id": teamU})
	if _, out := e.call(bob, orgA, "GET", "/api/v1/tags", nil); len(out["tags"].([]any)) != 2 {
		t.Fatalf("an agent sees the agency's and their team's tags: %v", out)
	}
	a := lead("Pat Owner", "5550401001")
	e.want(e.op(bob, orgA, "lead.tag", map[string]any{"lead_id": a, "tag_id": hot}), "applied")
	if out := e.op(bob, orgA, "lead.tag", map[string]any{"lead_id": a, "tag_id": otherTeamTag}); out["status"] != "rejected" {
		t.Fatalf("another team's tag on this team's lead: %v", out)
	}
	_, details := e.call(bob, orgA, "GET", "/api/v1/leads/"+a+"/details", nil)
	if ids := details["leads"].([]any)[0].(map[string]any)["tag_ids"].([]any); len(ids) != 1 || ids[0] != hot {
		t.Fatalf("the lead carries its tag: %v", ids)
	}

	// Merging: the team's lead folds a second copy into the first; history and ways to reach the person combine; undone within 7 days.
	b := lead("Pat Owner (2)", "5550401002")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET email = 'pat@example.com' WHERE id = $1`, b); err != nil {
		t.Fatal(err)
	}
	for _, l := range []string{a, b} {
		if _, err := e.admin.Exec(ctx, `INSERT INTO crm.notes (org_id, lead_id, body) VALUES ($1, $2, 'spoke to them')`, orgA, l); err != nil {
			t.Fatal(err)
		}
	}
	if out := e.op(bob, orgA, "lead.merge", map[string]any{"keep_id": a, "merge_id": b}); out["status"] != "rejected" {
		t.Fatalf("an agent merges: %v", out)
	}
	merged := e.op(dave, orgA, "lead.merge", map[string]any{"keep_id": a, "merge_id": b})
	e.want(merged, "applied")
	count := func(sql string, args ...any) int {
		var n int
		if err := e.admin.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(`SELECT count(*) FROM crm.notes WHERE lead_id = $1`, a) != 2 || count(`SELECT count(*) FROM crm.leads WHERE id = $1 AND deleted_at IS NOT NULL AND merged_into = $2`, b, a) != 1 {
		t.Fatal("the merged lead's history moved, and it is put aside")
	}
	var email, contacts string
	if err := e.admin.QueryRow(ctx, `SELECT email, contacts::text FROM crm.leads WHERE id = $1`, a).Scan(&email, &contacts); err != nil {
		t.Fatal(err)
	}
	if email != "pat@example.com" || !strings.Contains(contacts, "5550401002") {
		t.Fatalf("the ways to reach the person combine: %s %s", email, contacts)
	}
	var mergeID string
	if err := e.admin.QueryRow(ctx, `SELECT id::text FROM crm.lead_merges WHERE kept_id = $1`, a).Scan(&mergeID); err != nil {
		t.Fatal(err)
	}
	e.want(e.op(dave, orgA, "lead.unmerge", map[string]any{"merge_id": mergeID}), "applied")
	if count(`SELECT count(*) FROM crm.notes WHERE lead_id = $1`, b) != 1 || count(`SELECT count(*) FROM crm.leads WHERE id = $1 AND deleted_at IS NULL`, b) != 1 ||
		count(`SELECT count(*) FROM crm.leads WHERE id = $1 AND email = ''`, a) != 1 {
		t.Fatal("undoing puts everything back")
	}
	if out := e.op(dave, orgA, "lead.unmerge", map[string]any{"merge_id": mergeID}); out["status"] != "rejected" {
		t.Fatalf("undone twice: %v", out)
	}
	e.want(e.op(dave, orgA, "lead.merge", map[string]any{"keep_id": a, "merge_id": b}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.lead_merges SET merged_at = now() - interval '8 days' WHERE kept_id = $1 AND undone_at IS NULL`, a); err != nil {
		t.Fatal(err)
	}
	var late string
	_ = e.admin.QueryRow(ctx, `SELECT id::text FROM crm.lead_merges WHERE kept_id = $1 AND undone_at IS NULL`, a).Scan(&late)
	if out := e.op(dave, orgA, "lead.unmerge", map[string]any{"merge_id": late}); out["status"] != "rejected" {
		t.Fatalf("undone after 7 days: %v", out)
	}

	// Retention: the owner sets the period, sees what is due, keeps some with a reason, and removes the rest.
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/retention", map[string]any{"keep_days": 30}); status != 403 {
		t.Fatalf("a team lead sets retention: %d", status)
	}
	old := lead("Old lead", "5550401009")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}
	status, out := e.call(alice, orgA, "PUT", "/api/v1/retention", map[string]any{"keep_days": 30})
	if status != 200 || out["due_count"] != 1.0 || out["due"].([]any)[0].(map[string]any)["id"] != old {
		t.Fatalf("one lead is due: %d %v", status, out)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/retention/keep", map[string]any{"lead_ids": []string{old}, "reason": "Talking to their lawyer"}); status != 200 {
		t.Fatalf("keep: %d", status)
	}
	if _, out := e.call(alice, orgA, "GET", "/api/v1/retention", nil); out["due_count"] != 0.0 {
		t.Fatalf("a kept lead is not due: %v", out)
	}
	if _, err := e.admin.Exec(ctx, `DELETE FROM crm.lead_keeps WHERE lead_id = $1`, old); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/retention/remove", nil); status != 403 {
		t.Fatalf("a team lead removes due leads: %d", status)
	}
	if status, out := e.call(alice, orgA, "POST", "/api/v1/retention/remove", nil); status != 200 || out["removed"] != 1.0 {
		t.Fatalf("the owner removes what is due: %d %v", status, out)
	}
	if count(`SELECT count(*) FROM crm.leads WHERE id = $1`, old) != 0 || !slices.Contains([]int{1}, count(`SELECT count(*) FROM crm.leads WHERE id = $1`, a)) {
		t.Fatal("only the due lead is gone")
	}
}
