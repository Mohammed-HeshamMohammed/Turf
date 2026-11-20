package main

import (
	"context"
	"testing"
)

// Step 26, part A: a client's script and a team's own version, written only by those who may and read by the agent for each lead
// (D142); calls scored by the team's lead against the agency's checklist, the agent seeing their own scores and the lead the team's
// averages (D143); the owner's switch for the AI's suggestions, a team switching them off, and a person hiding them (D148).
func TestScriptsReviewsAndAISwitches(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT, teamU = "aaaaaaaa-0000-4000-8000-0000000000c1", "aaaaaaaa-0000-4000-8000-0000000000c2"
	const dave = "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	g := e.rules.grants[alice+"|"+orgA]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T", ManagerID: dave}, {TeamID: teamU, Name: "U"}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"manager"}}}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil) // the CRM copies the team tree

	_, acme := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme"})
	acmeID := acme["id"].(string)
	e.call(alice, orgA, "PUT", "/api/v1/clients/"+acmeID+"/teams/"+teamT, nil)
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "512-555-0301"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET client_id = $2, team_id = $3, assignee_id = $4 WHERE id = $1`, lead, acmeID, teamT, bob); err != nil {
		t.Fatal(err)
	}

	// Scripts: an agent never writes; the client's script by the owner or the lead of a team working for it; the team's version by its lead.
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/scripts", map[string]any{"client_id": acmeID, "name": "Mine", "body": "Hi"}); status != 403 {
		t.Fatalf("an agent writes a script: %d", status)
	}
	if status, out := e.call(alice, orgA, "POST", "/api/v1/scripts", map[string]any{"client_id": acmeID, "name": "Acme opener", "body": "Hello, I'm calling for Acme."}); status != 200 {
		t.Fatalf("client script: %d %v", status, out)
	}
	if _, out := e.call(bob, orgA, "GET", "/api/v1/leads/"+lead+"/script", nil); out["script"].(map[string]any)["name"] != "Acme opener" {
		t.Fatalf("the agent reads the client's script: %v", out)
	}
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/scripts", map[string]any{"client_id": acmeID, "team_id": teamU, "name": "U's", "body": "x"}); status != 403 {
		t.Fatalf("a lead writes another team's version: %d", status)
	}
	if status, out := e.call(dave, orgA, "POST", "/api/v1/scripts", map[string]any{"client_id": acmeID, "team_id": teamT, "name": "T's opener", "body": "Hey, Acme here."}); status != 200 {
		t.Fatalf("team version: %d %v", status, out)
	}
	if _, out := e.call(bob, orgA, "GET", "/api/v1/leads/"+lead+"/script", nil); out["script"].(map[string]any)["name"] != "T's opener" {
		t.Fatalf("the team's version wins for its leads: %v", out)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/scripts", map[string]any{"client_id": acmeID, "name": "Second", "body": "x"}); status != 409 {
		t.Fatalf("two scripts for one client: %d", status)
	}

	// Review: the team's lead scores the agent's call; the agent cannot score; the agent sees their own; the lead sees the team.
	var call string
	if err := e.admin.QueryRow(ctx, `INSERT INTO crm.call_events (org_id, lead_id, agent_id, outcome, meaning, occurred_at) VALUES ($1, $2, $3, 'Reached', 'reached', now()) RETURNING id::text`, orgA, lead, bob).Scan(&call); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/calls/"+call+"/review", map[string]any{"scores": map[string]int{"Followed the script": 5}}); status != 403 {
		t.Fatalf("an agent reviews: %d", status)
	}
	if status, _ := e.call(dave, orgA, "POST", "/api/v1/calls/"+call+"/review", map[string]any{"scores": map[string]int{"Made up item": 3}}); status != 400 {
		t.Fatalf("an item off the checklist: %d", status)
	}
	if status, out := e.call(dave, orgA, "POST", "/api/v1/calls/"+call+"/review", map[string]any{"scores": map[string]int{"Followed the script": 4, "Agreed a clear next step": 2}, "comment": "Close with a time"}); status != 200 || out["score"] != float64(3) {
		t.Fatalf("review: %d %v", status, out)
	}
	if _, mine := e.call(bob, orgA, "GET", "/api/v1/reviews/mine", nil); mine["average"] != float64(3) || len(mine["reviews"].([]any)) != 1 {
		t.Fatalf("the agent's own scores: %v", mine)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/teams/"+teamT+"/reviews", nil); status != 403 {
		t.Fatalf("an agent reads the team's reviews: %d", status)
	}
	if _, team := e.call(dave, orgA, "GET", "/api/v1/teams/"+teamT+"/reviews", nil); team["average"] != float64(3) || team["reviews"] != float64(1) {
		t.Fatalf("the team's averages: %v", team)
	}

	// The AI's suggestions: off until the owner switches them on; a team's lead can turn them off for the team; a person hides them.
	callAIFor := func(user string) (bool, bool) {
		tx, _ := e.s.st.begin(ctx, scope{userID: user, orgID: orgA, scopes: []string{"organization"}})
		defer tx.Rollback(ctx)
		s, c, err := callAI(ctx, tx, user, teamT)
		if err != nil {
			t.Fatal(err)
		}
		return s, c
	}
	if s, _ := callAIFor(bob); s {
		t.Fatal("suggestions on before the owner switched them on")
	}
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/ai-settings", map[string]any{"ai_suggestions": true}); status != 403 {
		t.Fatalf("a team lead switches the agency's AI: %d", status)
	}
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/ai-settings", map[string]any{"ai_suggestions": true, "captions_required": true}); status != 200 {
		t.Fatalf("owner switch: %d", status)
	}
	if s, c := callAIFor(bob); !s || !c {
		t.Fatalf("on: %v %v", s, c)
	}
	e.call(bob, orgA, "PUT", "/api/v1/me/suggestions", map[string]any{"hidden": true})
	if s, c := callAIFor(bob); s || !c {
		t.Fatalf("hidden suggestions, captions still required: %v %v", s, c)
	}
	e.call(bob, orgA, "PUT", "/api/v1/me/suggestions", map[string]any{"hidden": false})
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/teams/"+teamT+"/ai", map[string]any{"ai_suggestions": false}); status != 200 {
		t.Fatalf("team off: %d", status)
	}
	if s, _ := callAIFor(bob); s {
		t.Fatal("the team switched suggestions off, yet they show")
	}
}
