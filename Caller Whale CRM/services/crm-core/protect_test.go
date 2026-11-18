package main

import (
	"context"
	"strings"
	"testing"
)

// Step 30: agents see masked numbers unless the owner shows their team full numbers, and cannot change a number they see masked; team
// leads always see them (D163); exports by the owner and admins, by team leads only for their teams when allowed, never by agents, each
// recorded (D162); who opened a lead (D165, D264); far more opening than usual is flagged and slowed (D164).
func TestProtectingLeads(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT, dave = "aaaaaaaa-0000-4000-8000-000000000101", "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	g := e.rules.grants[alice+"|"+orgA]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call", "export"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "(512) 555-0901"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET team_id = $2, assignee_id = $3 WHERE id = $1`, lead, teamT, bob); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.call_events (org_id, lead_id, agent_id, phone, outcome, meaning, occurred_at) VALUES ($1, $2, $3, '(512) 555-0901', 'No answer', 'no_answer', now())`, orgA, lead, bob); err != nil {
		t.Fatal(err)
	}
	details := func(user string) (string, string) {
		_, out := e.call(user, orgA, "GET", "/api/v1/leads/"+lead+"/details", nil)
		l := out["leads"].([]any)[0].(map[string]any)
		c := out["calls"].([]any)[0].(map[string]any)
		return l["phone"].(string), c["phone"].(string)
	}
	if phone, call := details(bob); phone != "••• 0901" || call != "••• 0901" {
		t.Fatalf("the agent sees: %q %q", phone, call)
	}
	if phone, _ := details(dave); phone != "(512) 555-0901" {
		t.Fatalf("the team's lead sees: %q", phone)
	}
	_, snap := e.call(bob, orgA, "GET", "/sync/snapshot", nil)
	for _, l := range snap["leads"].([]any) {
		if strings.Contains(l.(map[string]any)["phone"].(string), "555") {
			t.Fatal("the snapshot shows the agent a full number")
		}
	}
	if out := e.op(bob, orgA, "lead.update", map[string]any{"id": lead, "changes": map[string]any{"phone": "512-555-0000"}}); out["status"] != "rejected" {
		t.Fatalf("an agent changes a number they see masked: %v", out)
	}
	// A call logged from the agent's device with the masked number keeps the real one.
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": lead, "outcome": "No answer", "phone": "••• 0901"}), "applied")
	var stored string
	if err := e.admin.QueryRow(ctx, `SELECT phone FROM crm.call_events WHERE lead_id = $1 ORDER BY received_at DESC LIMIT 1`, lead).Scan(&stored); err != nil || stored != "(512) 555-0901" {
		t.Fatalf("the logged call's number: %q %v", stored, err)
	}
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/teams/"+teamT+"/full-numbers", map[string]any{"on": true}); status != 403 {
		t.Fatalf("a team lead shows full numbers: %d", status)
	}
	e.call(alice, orgA, "PUT", "/api/v1/teams/"+teamT+"/full-numbers", map[string]any{"on": true})
	if phone, _ := details(bob); phone != "(512) 555-0901" {
		t.Fatalf("full numbers for the team: %q", phone)
	}

	// Exports.
	if status, _ := e.raw(bob, orgA, "GET", "/api/v1/leads/export", nil, nil); status != 403 {
		t.Fatalf("an agent exports: %d", status)
	}
	if status, _ := e.raw(dave, orgA, "GET", "/api/v1/leads/export?team_id="+teamT, nil, nil); status != 403 {
		t.Fatalf("a team lead exports before the owner allows it: %d", status)
	}
	e.call(alice, orgA, "PUT", "/api/v1/protection", map[string]any{"managers_export": true})
	if status, _ := e.raw(dave, orgA, "GET", "/api/v1/leads/export", nil, nil); status != 403 {
		t.Fatalf("a team lead exports the whole agency: %d", status)
	}
	status, csv := e.raw(dave, orgA, "GET", "/api/v1/leads/export?team_id="+teamT, nil, nil)
	if status != 200 || !strings.Contains(string(csv), "Pat,(512) 555-0901") {
		t.Fatalf("export: %d %s", status, csv)
	}
	if _, out := e.call(alice, orgA, "GET", "/api/v1/exports", nil); len(out["exports"].([]any)) != 1 {
		t.Fatalf("the record of exports: %v", out)
	}

	// Who opened the lead, and what a person looked at.
	if _, out := e.call(alice, orgA, "GET", "/api/v1/leads/"+lead+"/views", nil); len(out["views"].([]any)) < 2 {
		t.Fatalf("the lead's views: %v", out)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/leads/"+lead+"/views", nil); status != 403 {
		t.Fatalf("an agent reads the views: %d", status)
	}
	if _, out := e.call(alice, orgA, "GET", "/api/v1/people/"+dave+"/views", nil); len(out["views"].([]any)) != 1 || len(out["exports"].([]any)) != 1 {
		t.Fatalf("what the team lead looked at: %v", out)
	}

	// Far more than usual: flagged and slowed.
	floor, delay := accessFloor, slowDelay
	accessFloor, slowDelay = 5, 0
	defer func() { accessFloor, slowDelay = floor, delay }()
	for i := 0; i < 6; i++ {
		details(bob)
	}
	_, alerts := e.call(alice, orgA, "GET", "/api/v1/protection/alerts", nil)
	if list := alerts["alerts"].([]any); len(list) != 1 || list[0].(map[string]any)["user_id"] != bob {
		t.Fatalf("alerts: %v", alerts)
	}
}
