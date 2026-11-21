package crm

import (
	"context"
	"strconv"
	"testing"
)

// Step 20, part one: team settings, the unassigned pool and claiming, moves between teams, handoffs inside a team, deleting for
// good, and the leaderboard.
func TestLeadsAndTeams(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000b1", "aaaaaaaa-0000-4000-8000-0000000000b2"
	const dave, erin, frank = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	agent := func(team string) grantReply {
		return grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{team}, TeamScopeIDs: []string{}, Capabilities: []string{"edit", "handoff", "accept", "call"}, Roles: []string{"caller"}}
	}
	e.rules.mu.Lock()
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: frank, Roles: []string{"caller"}, TeamIDs: []string{teamT}}, {UserID: dave, Roles: []string{"manager"}}, {UserID: erin, Roles: []string{"caller"}, TeamIDs: []string{teamU}}}
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call", "import", "handoff", "accept"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = agent(teamT)
	e.rules.grants[frank+"|"+orgA] = agent(teamT)
	e.rules.grants[erin+"|"+orgA] = agent(teamU)
	for _, p := range []string{dave, bob, frank, erin} {
		e.rules.people_[p] = peopleReply{UserID: p, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"caller"}}}}
	}
	e.rules.mu.Unlock()
	ctx := context.Background()
	ids := []string{}
	for i := 0; i < 3; i++ {
		id := newID(t)
		ids = append(ids, id)
		e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": id, "name": "Pool " + strconv.Itoa(i), "phone": "555-020" + strconv.Itoa(i)}, newID(t)), "applied")
	}
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil) // the CRM copies the team tree
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = NULL, team_id = $1`, teamT); err != nil {
		t.Fatal(err)
	}

	// Claiming is off by default: the team's agents neither see the pool nor claim.
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/teams/"+teamT+"/pool", nil); status != 403 {
		t.Fatalf("an agent sees the pool while claiming is off: %d", status)
	}
	if out := e.op(bob, orgA, "lead.claim", map[string]any{"id": ids[0]}); out["status"] != "rejected" {
		t.Fatalf("an agent claims while claiming is off: %v", out)
	}
	// The team's lead sets it; an agent cannot; another team's agent cannot even read it.
	if status, _ := e.call(bob, orgA, "PUT", "/api/v1/teams/"+teamT+"/settings", map[string]any{"agents_claim": true}); status != 403 {
		t.Fatalf("an agent changes team settings: %d", status)
	}
	if status, out := e.call(dave, orgA, "PUT", "/api/v1/teams/"+teamT+"/settings", map[string]any{"agents_claim": true, "open_limit": 1}); status != 200 {
		t.Fatalf("the lead sets claiming and a limit: %d %v", status, out)
	}
	if status, _ := e.call(erin, orgA, "GET", "/api/v1/teams/"+teamT+"/settings", nil); status != 403 {
		t.Fatalf("another team's agent reads the settings: %d", status)
	}
	status, pool := e.call(bob, orgA, "GET", "/api/v1/teams/"+teamT+"/pool", nil)
	if status != 200 || len(pool["leads"].([]any)) != 3 {
		t.Fatalf("the team's agent sees the pool: %d %v", status, pool)
	}
	e.want(e.op(bob, orgA, "lead.claim", map[string]any{"id": ids[0]}), "applied")
	if out := e.op(bob, orgA, "lead.claim", map[string]any{"id": ids[1]}); out["status"] != "rejected" {
		t.Fatalf("over the limit of open leads: %v", out)
	}
	if out := e.op(erin, orgA, "lead.claim", map[string]any{"id": ids[1]}); out["status"] != "rejected" {
		t.Fatalf("another team's agent claims: %v", out)
	}
	if out := e.op(frank, orgA, "lead.claim", map[string]any{"id": ids[0]}); out["status"] != "rejected" {
		t.Fatalf("a lead someone holds is claimed again: %v", out)
	}
	e.want(e.op(dave, orgA, "lead.claim", map[string]any{"id": ids[1]}), "applied") // the lead is not limited

	// A team lead moves leads only between teams they lead; the owner moves them anywhere (D108).
	if out := e.op(dave, orgA, "lead.assign", map[string]any{"ids": []string{ids[1]}, "team_id": teamU}); out["status"] != "rejected" {
		t.Fatalf("a lead moves a lead to a team they do not lead: %v", out)
	}
	e.want(e.op(alice, orgA, "lead.assign", map[string]any{"ids": []string{ids[2]}, "team_id": teamU}), "applied")

	// A handoff stays inside the lead's team (D109).
	if out := e.op(bob, orgA, "handoff.request", map[string]any{"lead_id": ids[0], "to_user": erin, "note": "Ready for a closer"}); out["status"] != "rejected" {
		t.Fatalf("a handoff to another team: %v", out)
	}
	e.want(e.op(bob, orgA, "handoff.request", map[string]any{"lead_id": ids[0], "to_user": frank, "note": "Ready for a closer"}), "applied")

	// Only the owner or an admin deletes for good (D232).
	if out := e.op(dave, orgA, "lead.delete", map[string]any{"id": ids[1]}); out["status"] != "rejected" {
		t.Fatalf("a team lead deletes for good: %v", out)
	}
	e.want(e.op(alice, orgA, "lead.delete", map[string]any{"id": ids[1]}), "applied")

	// Numbers: each agent sees only their own until the team's leaderboard is on (D125).
	seen := func(user string) int {
		_, out := e.call(user, orgA, "GET", "/api/v1/stats/members", nil)
		people, _ := out["people"].([]any)
		return len(people)
	}
	if n := seen(bob); n != 1 {
		t.Fatalf("an agent's own numbers only: %d", n)
	}
	e.call(dave, orgA, "PUT", "/api/v1/teams/"+teamT+"/settings", map[string]any{"leaderboard": true})
	if n := seen(bob); n != 2 {
		t.Fatalf("with the leaderboard on, the team's two agents: %d", n)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/stats/members/"+frank+"/activity", nil); status == 200 {
		t.Fatal("a leaderboard shows numbers, not a teammate's activity")
	}
}
