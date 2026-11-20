package main

import (
	"net/http"
	"slices"
	"testing"
)

func list(v any) []string {
	out := []string{}
	items, _ := v.([]any)
	for _, item := range items {
		s, _ := item.(string)
		out = append(out, s)
	}
	return out
}

// Step 3: one invitation carries several roles, teams, and the teams a lead will lead; team leads invite into their teams and ask
// the owner for a seat; a former lead's invitations into a team end; people leave.
func TestStep3InvitationsCarryTeamsAndLeadsInvite(t *testing.T) {
	w, fake, owner := lifecycleWorld(t)

	// A team lead invited with the team they will lead gets it when they accept (problems 1, 2).
	sent := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "lead@example.com", "roles": []string{"manager"}, "lead_team_ids": []string{flowTeam}}, owner)
	if sent.status != http.StatusCreated {
		t.Fatalf("invite a lead with their team: %d %v", sent.status, sent.body)
	}
	seen := w.agencySees(owner, sent.str("id"))
	if !slices.Equal(list(seen["roles"]), []string{"manager"}) || !slices.Equal(list(seen["lead_team_ids"]), []string{flowTeam}) {
		t.Fatalf("the invitation carries the role and the team to lead: %v", seen)
	}
	leadToken := w.confirmed("lead@example.com").access()
	accepted := w.call("POST", "/v1/me/invitations/"+sent.str("id")+"/accept", nil, leadToken)
	if accepted.status != 200 || len(list(accepted.body["teams_not_led"])) != 0 {
		t.Fatalf("accept: %d %v", accepted.status, accepted.body)
	}
	lead := w.idOf("lead@example.com")
	fake.mu.Lock()
	leadsNow := slices.Clone(fake.leads[flowTeam])
	gotRoles := slices.Clone(fake.roles[lead])
	fake.mu.Unlock()
	if !slices.Equal(leadsNow, []string{lead}) || !slices.Equal(gotRoles, []string{"manager"}) {
		t.Fatalf("the team got its lead: leads %v, roles %v", leadsNow, gotRoles)
	}

	// Several roles and teams in one invitation.
	both := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "both@example.com", "roles": []string{"manager", "closer"}, "team_ids": []string{flowTeam, goneTeam}}, owner)
	if both.status != http.StatusCreated {
		t.Fatalf("roles and teams: %d %v", both.status, both.body)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "x@example.com", "roles": []string{"caller", "caller"}, "team_ids": []string{flowTeam}}, owner); a.status != 400 {
		t.Fatalf("a role twice: %d", a.status)
	}

	// The lead invites a caller into their team; they see and handle their own invitations, not the owner's.
	byLead := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "caller@example.com", "roles": []string{"caller"}, "team_ids": []string{flowTeam}}, leadToken)
	if byLead.status != http.StatusCreated {
		t.Fatalf("a lead invites: %d %v", byLead.status, byLead.body)
	}
	mine := w.call("GET", "/v1/orgs/"+flowOrg+"/invitations", nil, leadToken)
	if items := mine.body["invitations"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != byLead.str("id") {
		t.Fatalf("a lead sees only what they sent: %v", mine.body)
	}
	if a := w.call("DELETE", "/v1/invitations/"+both.str("id"), nil, leadToken); a.status != 403 {
		t.Fatalf("a lead withdraws the owner's invitation: %d", a.status)
	}

	// No free seat: the lead is told the owner was asked (D71); the owner sees the request and closes it.
	fake.mu.Lock()
	fake.seatsFull = true
	fake.mu.Unlock()
	full := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "full@example.com", "roles": []string{"caller"}, "team_ids": []string{flowTeam}}, leadToken)
	if full.status != 409 || full.str("code") != "seats_full" || full.str("error") != "Every seat is taken. Your agency owner has been asked to add one; nothing is charged until they do." {
		t.Fatalf("no seat for a lead: %d %v", full.status, full.body)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "full2@example.com", "roles": []string{"caller"}, "team_ids": []string{flowTeam}}, owner); a.str("error") != "Every seat on this plan is taken." {
		t.Fatalf("the owner adds seats themselves and is not told they asked: %v", a.body)
	}
	fake.mu.Lock()
	fake.seatsFull = false
	fake.mu.Unlock()
	requests := w.call("GET", "/v1/orgs/"+flowOrg+"/seat-requests", nil, owner)
	items := requests.body["requests"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["for_email"] != "full@example.com" {
		t.Fatalf("the owner sees the request: %v", requests.body)
	}
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/seat-requests", nil, leadToken); a.status != 403 {
		t.Fatalf("a lead reads the owner's requests: %d", a.status)
	}
	w.call("DELETE", "/v1/orgs/"+flowOrg+"/seat-requests/"+items[0].(map[string]any)["id"].(string), nil, owner)
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/seat-requests", nil, owner); len(a.body["requests"].([]any)) != 0 {
		t.Fatalf("closed: %v", a.body)
	}

	// Taken off the team, the lead's waiting invitation into it is cancelled.
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/teams/"+flowTeam, map[string]any{"name": "Team one", "manager_ids": []string{}}, owner); a.status != 200 {
		t.Fatalf("take the lead off: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(owner, byLead.str("id")); seen["status"] != "cancelled" {
		t.Fatalf("a former lead's invitation into the team: %v", seen)
	}

	// Leaving: the lead leaves the agency; whatever they still had waiting is cancelled.
	fake.mu.Lock()
	fake.leads[flowTeam] = []string{lead}
	fake.mu.Unlock()
	again := w.call("POST", "/v1/orgs/"+flowOrg+"/invitations", map[string]any{"email": "caller2@example.com", "roles": []string{"caller"}, "team_ids": []string{flowTeam}}, leadToken)
	if again.status != http.StatusCreated {
		t.Fatalf("invite again: %d %v", again.status, again.body)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/leave", nil, leadToken); a.status != 200 {
		t.Fatalf("leave: %d %v", a.status, a.body)
	}
	if seen := w.agencySees(owner, again.str("id")); seen["status"] != "cancelled" {
		t.Fatalf("a person who left cancels what they sent: %v", seen)
	}
}

// The record of people changes comes with names, for whoever asks, as authz decides what they may see.
func TestTheRecordOfPeopleChangesCarriesNames(t *testing.T) {
	w, _, _ := lifecycleWorld(t)
	sami := w.confirmed("sami@example.com").access()
	a := w.call("GET", "/v1/orgs/"+flowOrg+"/people-log", nil, sami)
	entries, _ := a.body["entries"].([]any)
	if a.status != 200 || len(entries) != 1 {
		t.Fatalf("record: %d %v", a.status, a.body)
	}
	e := entries[0].(map[string]any)
	if e["target_id"] != w.idOf("sami@example.com") || e["actor_name"] != "Sami" || e["target_name"] != "Sami" {
		t.Fatalf("the viewer's own entry with names: %v", e)
	}
}
