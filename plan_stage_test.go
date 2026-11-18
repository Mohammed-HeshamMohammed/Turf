package main

import "testing"

// Step 18: the grace period is told to the owner and admins only; the owner closes and reopens the agency with their second step, and
// closing ends the invitations still waiting (D82, D204).
func TestPlanStageAndClosingAnAgency(t *testing.T) {
	w, fake, _ := lifecycleWorld(t)
	boss := w.stepped("boss@example.com").access()
	caller := w.confirmed("caller@example.com").access()
	fake.mu.Lock()
	fake.owner = w.idOf("boss@example.com")
	fake.joined[w.idOf("caller@example.com")] = true
	fake.stage = "grace"
	fake.mu.Unlock()
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/plan-stage", nil, boss); a.status != 200 || a.str("stage") != "grace" || a.body["owner"] != true {
		t.Fatalf("the owner is warned in the grace period: %d %v", a.status, a.body)
	}
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/plan-stage", nil, caller); a.str("stage") != "" {
		t.Fatalf("a caller is not told during the grace period: %v", a.body)
	}
	fake.mu.Lock()
	fake.stage = "read_only"
	fake.mu.Unlock()
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/plan-stage", nil, caller); a.str("stage") != "read_only" {
		t.Fatalf("everyone is told once it is read-only: %v", a.body)
	}
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/plan-stage", nil, w.confirmed("stranger@example.com").access()); a.status != 403 {
		t.Fatalf("someone outside the agency: %d", a.status)
	}

	invited := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "new@example.com", "role": "caller", "team_id": flowTeam}, boss)
	if invited.status != 201 {
		t.Fatalf("invite: %d %v", invited.status, invited.body)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/close", nil, caller); a.status != 403 {
		t.Fatalf("a caller closes the agency: %d", a.status)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/close", nil, boss); a.status != 200 || !fake.closed {
		t.Fatalf("close: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(boss, invited.str("id")); seen["status"] != "cancelled" {
		t.Fatalf("closing ends waiting invitations: %v", seen)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/reopen", nil, boss); a.status != 200 || fake.closed {
		t.Fatalf("reopen: %d %v", a.status, a.body)
	}
}
