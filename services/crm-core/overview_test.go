package crm

import (
	"context"
	"sync"
	"testing"
)

// Step 32: the owner's overview opens with what needs them (D225); a team lead's with their team now (D226); members' activity for the
// owner (D267); a scheduled report emails totals only to its maker or a client's people, then moves to the next period (D227, D228).
func TestOverviewsAndReports(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT, dave, gone = "aaaaaaaa-0000-4000-8000-000000000301", "44444444-4444-4444-8444-444444444444", "88888888-8888-4888-8888-888888888888"
	cara := newID(t)
	e.rules.mu.Lock()
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"manager"}}
	e.rules.grants[cara+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"shared"}, Capabilities: []string{"publicComment"}, Roles: []string{"client"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: dave, Roles: []string{"manager"}, TeamIDs: []string{teamT}}, {UserID: cara, Roles: []string{"client"}}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)

	lead, orphan := newID(t), newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "512-555-1001"}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": orphan, "name": "Left Behind", "phone": "512-555-1002"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET team_id = $2, assignee_id = $3 WHERE id = $1`, lead, teamT, bob); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2 WHERE id = $1`, orphan, gone); err != nil {
		t.Fatal(err)
	}
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": lead, "outcome": "Reached"}), "applied")
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.tasks (org_id, lead_id, assignee_id, title, type, due_at) VALUES ($1, $2, $3, 'Call back', 'Callback', now() - interval '1 hour')`, orgA, lead, bob); err != nil {
		t.Fatal(err)
	}

	if code, _ := e.call(dave, orgA, "GET", "/api/v1/overview", nil); code != 403 {
		t.Fatalf("a team lead sees the agency's overview: %d", code)
	}
	_, over := e.call(alice, orgA, "GET", "/api/v1/overview", nil)
	needs := over["needs_you"].(map[string]any)
	if needs["work_to_hand_on"] != float64(1) || len(needs["overdue_callbacks_by_team"].([]any)) != 1 || over["today"].(map[string]any)["calls"] != float64(1) {
		t.Fatalf("the owner's overview: %v", over)
	}
	if code, _ := e.call(bob, orgA, "GET", "/api/v1/overview/teams/"+teamT, nil); code != 403 {
		t.Fatalf("an agent sees the team's overview: %d", code)
	}
	_, team := e.call(dave, orgA, "GET", "/api/v1/overview/teams/"+teamT, nil)
	if team["now"].(map[string]any)["overdue_callbacks"] != float64(1) || team["today"].(map[string]any)["reached"] != float64(1) {
		t.Fatalf("the team's overview: %v", team)
	}
	_, members := e.call(alice, orgA, "GET", "/api/v1/overview/members", nil)
	active := map[string]float64{}
	for _, m := range members["members"].([]any) {
		m := m.(map[string]any)
		active[m["user_id"].(string)] = m["days_active_this_month"].(float64)
	}
	if active[bob] != 1 || active[cara] != 0 {
		t.Fatalf("days active: %v", active)
	}

	// Reports.
	var mu sync.Mutex
	sent := map[string]map[string]any{}
	e.s.reportMailer = func(_ context.Context, to string, data map[string]any) error {
		mu.Lock()
		defer mu.Unlock()
		sent[to] = data
		return nil
	}
	e.s.cfg.appURL = "https://app.test"
	if code, _ := e.call(dave, orgA, "POST", "/api/v1/reports/schedules", map[string]any{"frequency": "weekly"}); code != 403 {
		t.Fatalf("a team lead schedules the agency's report: %d", code)
	}
	if code, _ := e.call(dave, orgA, "POST", "/api/v1/reports/schedules", map[string]any{"frequency": "weekly", "team_id": teamT}); code != 200 {
		t.Fatalf("team report: %d", code)
	}
	_, acme := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme"})
	e.call(alice, orgA, "PUT", "/api/v1/clients/"+acme["id"].(string)+"/members/"+cara, map[string]any{"main": true})
	e.call(cara, orgA, "GET", "/api/v1/directory", nil) // the client's person has been seen in the agency, with their email
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/reports/schedules", map[string]any{"frequency": "monthly", "client_id": acme["id"], "to_client": true}); code != 200 {
		t.Fatalf("client report: %d", code)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE crm.report_due SET next_at = now() - interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	if err := e.s.sendDueReports(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	n := len(sent)
	var anyReport map[string]any
	for _, d := range sent {
		anyReport = d
	}
	mu.Unlock()
	if n != 2 || anyReport["link"] == "" || len(anyReport["lines"].([]map[string]any)) != 5 {
		t.Fatalf("reports sent: %v", sent)
	}
	var later int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.report_due WHERE next_at > now()`).Scan(&later); err != nil || later != 2 {
		t.Fatalf("the next period: %d %v", later, err)
	}
}
