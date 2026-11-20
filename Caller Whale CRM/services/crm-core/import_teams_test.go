package main

import (
	"context"
	"fmt"
	"testing"
)

// Step 20, part B: the read-only whole-team view (D124), imports into a team (D110), rows that match another team's lead (D112), and
// removing a list nobody has worked yet (D219).
func TestTheTeamViewAndImportsIntoATeam(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000c1", "aaaaaaaa-0000-4000-8000-0000000000c2"
	const dave, erin, frank = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	agent := func(team string) grantReply {
		return grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{team}, TeamScopeIDs: []string{}, Capabilities: []string{"edit", "handoff", "accept", "call"}, Roles: []string{"caller"}}
	}
	daveGrant := grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call", "import"}, Roles: []string{"manager"}}
	e.rules.mu.Lock()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: frank, Roles: []string{"caller"}, TeamIDs: []string{teamT}}, {UserID: dave, Roles: []string{"manager"}}, {UserID: erin, Roles: []string{"caller"}, TeamIDs: []string{teamU}}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.grants[dave+"|"+orgA] = daveGrant
	e.rules.grants[bob+"|"+orgA] = agent(teamT)
	e.rules.grants[frank+"|"+orgA] = agent(teamT)
	e.rules.grants[erin+"|"+orgA] = agent(teamU)
	for _, p := range []string{dave, bob, frank, erin} {
		e.rules.people_[p] = peopleReply{UserID: p, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"caller"}}}}
	}
	e.rules.mu.Unlock()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)
	lead := func(name, owner, team string) string {
		t.Helper()
		id := newID(t)
		e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": id, "name": name, "phone": "555-03" + name[len(name)-2:]}, newID(t)), "applied")
		if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2, team_id = $3 WHERE id = $1`, id, owner, team); err != nil {
			t.Fatal(err)
		}
		return id
	}
	mine, theirs := lead("Bob lead 01", bob, teamT), lead("Frank lead 02", frank, teamT)
	other := lead("Erin lead 03", erin, teamU)
	found := func(user string) map[string]bool {
		_, out := e.call(user, orgA, "GET", "/api/v1/leads/search", nil)
		seen := map[string]bool{}
		items, _ := out["leads"].([]any)
		for _, raw := range items {
			l := raw.(map[string]any)
			seen[l["id"].(string)] = l["read_only"] == true
		}
		return seen
	}

	// Off: an agent sees only their own leads.
	if seen := found(bob); len(seen) != 1 {
		t.Fatalf("an agent's own leads only: %v", seen)
	}
	// On: the team's leads, read-only; never another team's.
	if status, out := e.call(dave, orgA, "PUT", "/api/v1/teams/"+teamT+"/settings", map[string]any{"agents_see_team": true}); status != 200 {
		t.Fatalf("switch the team view on: %d %v", status, out)
	}
	seen := found(bob)
	if ro, ok := seen[theirs]; !ok || !ro || seen[mine] || len(seen) != 2 {
		t.Fatalf("a teammate's lead is shown read-only, their own is not: %v", seen)
	}
	if _, ok := found(erin)[theirs]; ok {
		t.Fatal("another team's agent sees the lead")
	}
	if status, out := e.call(bob, orgA, "GET", "/api/v1/leads/"+theirs+"/details", nil); status != 200 || out["leads"].([]any)[0].(map[string]any)["read_only"] != true {
		t.Fatalf("details of a teammate's lead: %d %v", status, out)
	}
	if out := e.op(bob, orgA, "lead.update", map[string]any{"id": theirs, "changes": map[string]any{"stage": "Contacted"}}); out["status"] != "rejected" || out["message"] == "Nothing to change" {
		t.Fatalf("a teammate's lead is changed through the team view: %v", out)
	}
	if out := e.op(bob, orgA, "note.add", map[string]any{"lead_id": theirs, "body": "hello"}); out["status"] != "rejected" {
		t.Fatalf("a note on a teammate's lead: %v", out)
	}
	_, snap := e.call(bob, orgA, "GET", "/sync/snapshot", nil)
	inSnapshot := false
	for _, raw := range snap["leads"].([]any) {
		if l := raw.(map[string]any); l["id"] == theirs && l["read_only"] == true {
			inSnapshot = true
		}
	}
	if !inSnapshot {
		t.Fatal("the snapshot carries the teammate's lead, read-only")
	}

	// An import into team T: new leads start unassigned in the team; a row matching team U's lead waits instead of changing it.
	var job string
	if err := e.admin.QueryRow(ctx, fmt.Sprintf(`INSERT INTO importing.jobs (org_id, user_id, team_id, name, filename, size, chunk_size, total_chunks, status, kind, columns)
		VALUES ('%s', '%s', '%s', 'T list', 't.csv', 10, 10, 1, 'merging', 'lead_list', '[]') RETURNING id::text`, orgA, dave, teamT)).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, state, match_lead)
		VALUES ($1, 1, '\x0201', ARRAY['New one'], 'New one', '5550399001', 'clean', NULL),
		       ($1, 2, '\x0202', ARRAY['Erin dup'], 'Erin dup', '5550399002', 'merge', $2)`, job, other); err != nil {
		t.Fatal(err)
	}
	daveScope := scope{userID: dave, orgID: orgA, scopes: daveGrant.Scopes, teamIDs: daveGrant.TeamIDs, seeTeams: daveGrant.TeamScopeIDs, caps: daveGrant.Capabilities}
	team := teamT
	for {
		n, err := e.s.mergeBatch(ctx, daveScope, job, nil, &team)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	var assignee *string
	var leadTeam string
	if err := e.admin.QueryRow(ctx, `SELECT l.assignee_id::text, l.team_id::text FROM crm.leads l JOIN importing.rows r ON r.lead_id = l.id WHERE r.job_id = $1 AND r.row_no = 1`, job).Scan(&assignee, &leadTeam); err != nil {
		t.Fatal(err)
	}
	if assignee != nil || leadTeam != teamT {
		t.Fatalf("an imported lead starts unassigned in the team: %v %s", assignee, leadTeam)
	}
	var state, otherTeam string
	if err := e.admin.QueryRow(ctx, `SELECT r.state, l.team_id::text FROM importing.rows r JOIN crm.leads l ON l.id = $2 WHERE r.job_id = $1 AND r.row_no = 2`, job, other).Scan(&state, &otherTeam); err != nil {
		t.Fatal(err)
	}
	if state != "other_team" || otherTeam != teamU {
		t.Fatalf("a row matching another team's lead waits: %s, lead still in %s", state, otherTeam)
	}
	if status, out := e.call(dave, orgA, "GET", "/api/v1/imports/"+job+"/other-team", nil); status != 200 || out["count"] != 1.0 || out["can_decide"] != false {
		t.Fatalf("the importing team sees only how many: %d %v", status, out)
	}
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/imports/"+job+"/other-team", map[string]any{"action": "move_here"}); status != 403 {
		t.Fatalf("a team lead decides: %d", status)
	}
	if status, out := e.call(alice, orgA, "POST", "/api/v1/imports/"+job+"/other-team", map[string]any{"action": "both"}); status != 200 {
		t.Fatalf("the owner decides both keep a copy: %d %v", status, out)
	}
	var copies int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE phone = '5550399002' OR id = $1`, other).Scan(&copies); err != nil {
		t.Fatal(err)
	}
	if copies != 2 {
		t.Fatalf("both teams keep their own copy: %d", copies)
	}

	// Removing the list: refused once someone worked a lead, allowed while nobody has.
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'done', updated_at = now() WHERE id = $1`, job); err != nil {
		t.Fatal(err)
	}
	var made string
	if err := e.admin.QueryRow(ctx, `SELECT lead_id::text FROM importing.rows WHERE job_id = $1 AND row_no = 1`, job).Scan(&made); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.notes (org_id, lead_id, body) VALUES ($1, $2, 'called back')`, orgA, made); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(dave, orgA, "DELETE", "/api/v1/imports/"+job+"/leads", nil); status != 400 {
		t.Fatalf("a worked list is removed: %d", status)
	}
	if _, err := e.admin.Exec(ctx, `DELETE FROM crm.notes WHERE lead_id = $1`, made); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(bob, orgA, "DELETE", "/api/v1/imports/"+job+"/leads", nil); status != 403 {
		t.Fatalf("a caller removes the team's list: %d", status)
	}
	if status, out := e.call(dave, orgA, "DELETE", "/api/v1/imports/"+job+"/leads", nil); status != 200 || out["removed"] != 2.0 {
		t.Fatalf("the team's lead removes the untouched list: %d %v", status, out)
	}
	var left int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE id = $1`, other).Scan(&left); err != nil || left != 1 {
		t.Fatalf("the other team's lead stays: %d %v", left, err)
	}
}
