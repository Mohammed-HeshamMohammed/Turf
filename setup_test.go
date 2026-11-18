package main

import "testing"

// Step 31: the owner's setup checklist, with what the CRM sees counted by itself and each step skippable (D170); the data processing
// agreement accepted by the owner only, in its current version (D308); a walk-through per role (D173); the agency's material, assigned by
// a team lead to their own people, finished and followed (D173).
func TestSetupWalkthroughsAndMaterial(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const teamT, dave, erin = "aaaaaaaa-0000-4000-8000-000000000201", "44444444-4444-4444-8444-444444444444", "66666666-6666-4666-8666-666666666666"
	e.rules.mu.Lock()
	g := e.rules.grants[alice+"|"+orgA]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"manager"}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	e.rules.grants[erin+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: dave, Roles: []string{"manager"}, TeamIDs: []string{teamT}}, {UserID: erin, Roles: []string{"caller"}}}
	for _, p := range []string{dave, erin} {
		e.rules.people_[p] = peopleReply{UserID: p, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"caller"}}}}
	}
	e.rules.mu.Unlock()

	status := func(user string) map[string]string {
		_, out := e.call(user, orgA, "GET", "/api/v1/setup", nil)
		got := map[string]string{}
		for _, st := range out["steps"].([]any) {
			st := st.(map[string]any)
			got[st["id"].(string)] = st["status"].(string)
		}
		return got
	}
	if code, _ := e.call(bob, orgA, "GET", "/api/v1/setup", nil); code != 403 {
		t.Fatalf("a caller sees the setup: %d", code)
	}
	first := status(alice)
	if first["name"] != "todo" || first["invite"] != "done" || first["dpa"] != "todo" {
		t.Fatalf("the first checklist: %v", first)
	}
	e.call(alice, orgA, "PATCH", "/api/v1/organization", map[string]any{"name": "Blue Door Homes"})
	e.call(alice, orgA, "POST", "/api/v1/setup/hours", map[string]any{"status": "skipped"})
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/setup/dpa", map[string]any{"status": "done"}); code != 400 {
		t.Fatalf("the agreement marked done without accepting it: %d", code)
	}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/agreements/dpa", map[string]any{"version": "old"}); code != 409 {
		t.Fatalf("an old agreement accepted: %d", code)
	}
	if code, out := e.call(alice, orgA, "POST", "/api/v1/agreements/dpa", map[string]any{"version": dpaVersion}); code != 200 || out["current_accepted"] != true {
		t.Fatalf("accept: %d %v", code, out)
	}
	if now := status(alice); now["name"] != "done" || now["hours"] != "skipped" || now["dpa"] != "done" {
		t.Fatalf("the checklist after: %v", now)
	}

	// Walk-throughs.
	if _, out := e.call(bob, orgA, "GET", "/api/v1/me/walkthroughs", nil); len(out["to_see"].([]any)) != 1 {
		t.Fatalf("to see: %v", out)
	}
	if code, _ := e.call(bob, orgA, "POST", "/api/v1/me/walkthroughs", map[string]any{"role": "owner"}); code != 400 {
		t.Fatalf("someone else's role: %d", code)
	}
	if _, out := e.call(bob, orgA, "POST", "/api/v1/me/walkthroughs", map[string]any{"role": "caller"}); len(out["to_see"].([]any)) != 0 {
		t.Fatalf("after finishing: %v", out)
	}

	// Material.
	if code, _ := e.call(bob, orgA, "POST", "/api/v1/material", map[string]any{"title": "Mine", "body": "x"}); code != 403 {
		t.Fatalf("a caller adds material: %d", code)
	}
	code, m := e.call(dave, orgA, "POST", "/api/v1/material", map[string]any{"title": "Objections", "url": "https://example.com/objections", "team_id": teamT})
	if code != 200 {
		t.Fatalf("material: %d %v", code, m)
	}
	id := m["id"].(string)
	if code, _ := e.call(dave, orgA, "POST", "/api/v1/material/"+id+"/assign", map[string]any{"user_ids": []string{erin}}); code != 403 {
		t.Fatalf("a team lead gives material to someone outside their team: %d", code)
	}
	if code, _ := e.call(dave, orgA, "POST", "/api/v1/material/"+id+"/assign", map[string]any{"user_ids": []string{bob}}); code != 200 {
		t.Fatalf("assign: %d", code)
	}
	if _, out := e.call(bob, orgA, "GET", "/api/v1/material", nil); len(out["mine"].([]any)) != 1 || out["all"] != nil {
		t.Fatalf("what the caller was given: %v", out)
	}
	e.call(bob, orgA, "POST", "/api/v1/material/"+id+"/finish", nil)
	if _, out := e.call(dave, orgA, "GET", "/api/v1/material/"+id+"/progress", nil); out["people"].([]any)[0].(map[string]any)["finished_at"] == nil {
		t.Fatalf("progress: %v", out)
	}
}
