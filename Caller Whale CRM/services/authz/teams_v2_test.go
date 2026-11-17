package main

import (
	"slices"
	"testing"
)

const (
	lead2ID  = "99999999-9999-4999-8999-999999999991"
	adminID  = "99999999-9999-4999-8999-999999999992"
	deputyID = "99999999-9999-4999-8999-999999999993"
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

// The new team rules behind their switch (D104): several equal leads, deputies, admins, agents in several teams.
func TestTheNewTeamRules(t *testing.T) {
	h := newHarness(t)
	h.opened() // owner, team1, callerID a caller in team1
	put := func(actor, user string, body map[string]any) (int, map[string]any) {
		body["actor_id"], body["actor_second_step"] = actor, true
		return h.call(authToken, "PUT", "/v1/orgs/"+org1+"/members/"+user, body)
	}
	teamPut := func(actor, id string, body map[string]any) (int, map[string]any) {
		body["actor_id"], body["actor_second_step"] = actor, true
		return h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+id, body)
	}
	for _, id := range []string{managerID, lead2ID} {
		if code, out := put(ownerID, id, map[string]any{"roles": []string{"manager"}}); code != 200 {
			t.Fatalf("add a lead: %d %v", code, out)
		}
	}

	// Off: one lead per team, one team per agent, no admins, no deputies, and the role list leaves the new roles out.
	if code, _ := teamPut(ownerID, team1, map[string]any{"name": "Team one", "manager_ids": []string{managerID, lead2ID}}); code != 400 {
		t.Fatalf("two leads while off: %d", code)
	}
	if code, _ := put(ownerID, adminID, map[string]any{"roles": []string{"admin"}}); code != 403 {
		t.Fatalf("an admin while off: %d", code)
	}
	_, roles := h.call(authToken, "GET", "/v1/orgs/"+org1+"/roles", nil)
	for _, r := range roles["roles"].([]any) {
		if k := r.(map[string]any)["key"]; k == "admin" || k == "researcher" {
			t.Fatalf("%s is listed while off", k)
		}
	}
	if code, _ := h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/features/teams_v2", map[string]any{"on": true}); code != 403 {
		t.Fatalf("billing cannot flip a switch: %d", code)
	}

	// On.
	if code, out := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/features/teams_v2", map[string]any{"on": true}); code != 200 {
		t.Fatalf("switch on: %d %v", code, out)
	}
	if _, about := h.call(authToken, "GET", "/v1/orgs/"+org1, nil); !slices.Contains(list(about["features"]), "teams_v2") {
		t.Fatalf("the workspace says the switch is on: %v", about)
	}
	if code, out := teamPut(ownerID, team1, map[string]any{"name": "Team one", "manager_ids": []string{managerID, lead2ID}}); code != 200 || len(list(out["team"].(map[string]any)["manager_ids"])) != 2 {
		t.Fatalf("two equal leads: %d %v", code, out)
	}
	if code, _ := teamPut(ownerID, team2, map[string]any{"name": "Team two", "manager_ids": []string{}}); code != 200 {
		t.Fatalf("a team with no lead: %d", code)
	}
	// A caller in two teams; either lead of team one manages them, a lead does not manage the other lead (D64).
	if code, out := put(ownerID, callerID, map[string]any{"roles": []string{"caller"}, "team_ids": []string{team1, team2}}); code != 200 {
		t.Fatalf("caller in two teams: %d %v", code, out)
	}
	suspend := func(actor, user string) int {
		code, _ := h.call(authToken, "POST", "/v1/orgs/"+org1+"/members/"+user+"/suspend", map[string]any{"actor_id": actor, "actor_second_step": true})
		return code
	}
	restore := func(user string) {
		h.call(authToken, "POST", "/v1/orgs/"+org1+"/members/"+user+"/restore", map[string]any{"actor_id": ownerID, "actor_second_step": true})
	}
	if code := suspend(lead2ID, callerID); code != 200 {
		t.Fatalf("the second lead manages the team's caller: %d", code)
	}
	restore(callerID)
	if code := suspend(lead2ID, managerID); code != 403 {
		t.Fatalf("a lead suspends another lead: %d", code)
	}
	// A lead invites agents into their own team only.
	check := func(actor, role, team string) bool {
		_, out := h.call(authToken, "POST", "/v1/orgs/"+org1+"/relations/check", map[string]any{"actor_id": actor, "actor_second_step": true, "action": "invite", "role": role, "team_id": team})
		return out["allowed"] == true
	}
	if !check(managerID, "researcher", team1) || check(managerID, "caller", team2) || check(managerID, "manager", "") {
		t.Fatal("a lead invites callers, closers and researchers into teams they run, nothing else")
	}

	// Deputies: named by a lead; they see the team's leads and nothing of their own team beyond their own.
	if code, out := put(ownerID, deputyID, map[string]any{"roles": []string{"closer"}, "team_ids": []string{team2}}); code != 200 {
		t.Fatalf("add the deputy-to-be: %d %v", code, out)
	}
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+team1+"/deputies", map[string]any{"actor_id": callerID, "actor_second_step": true, "deputy_ids": []string{deputyID}}); code != 403 {
		t.Fatalf("a caller names deputies: %d", code)
	}
	if code, out := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+team1+"/deputies", map[string]any{"actor_id": managerID, "actor_second_step": true, "deputy_ids": []string{deputyID}}); code != 200 {
		t.Fatalf("a lead names a deputy: %d %v", code, out)
	}
	_, g := h.grant(deputyID, "read", false)
	if !slices.Equal(list(g["team_scope_ids"]), []string{team1}) || !slices.Contains(list(g["scopes"]), "team") || !slices.Equal(list(g["deputy_team_ids"]), []string{team1}) {
		t.Fatalf("a deputy's team view is the team they deputise, not their own: %v", g)
	}
	if code := suspend(deputyID, callerID); code != 403 {
		t.Fatalf("a deputy manages nobody: %d", code)
	}
	_, g = h.grant(managerID, "read", false)
	if !slices.Equal(list(g["managed_team_ids"]), []string{team1}) || !slices.Equal(list(g["team_scope_ids"]), []string{team1}) {
		t.Fatalf("a lead's teams: %v", g)
	}

	// Admins: the owner names them, at most three; an admin manages people but not other admins.
	for i, id := range []string{adminID, "99999999-9999-4999-8999-999999999994", "99999999-9999-4999-8999-999999999995"} {
		if code, out := put(ownerID, id, map[string]any{"roles": []string{"admin"}}); code != 200 {
			t.Fatalf("admin %d: %d %v", i+1, code, out)
		}
	}
	if code, out := put(ownerID, "99999999-9999-4999-8999-999999999996", map[string]any{"roles": []string{"admin"}}); code != 409 || out["code"] != "admins_full" {
		t.Fatalf("a fourth admin: %d %v", code, out)
	}
	if code, _ := put(adminID, strangerID, map[string]any{"roles": []string{"admin"}}); code != 403 {
		t.Fatalf("an admin names an admin: %d", code)
	}
	if code := suspend(adminID, "99999999-9999-4999-8999-999999999994"); code != 403 {
		t.Fatalf("an admin suspends an admin: %d", code)
	}
	if code := suspend(adminID, managerID); code != 200 {
		t.Fatalf("an admin suspends a lead: %d", code)
	}
	restore(managerID)
	if code, _ := teamPut(adminID, "99999999-9999-4999-8999-0000000000aa", map[string]any{"name": "Team three"}); code != 200 {
		t.Fatalf("an admin creates a team: %d", code)
	}

	// A lead removed under the new rules simply leaves the team's leads; the other lead stays.
	if code, out := h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/members/"+managerID, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 200 {
		t.Fatalf("remove a lead: %d %v", code, out)
	}
	_, teams := h.call(authToken, "GET", "/v1/orgs/"+org1+"/teams", nil)
	for _, raw := range teams["teams"].([]any) {
		tm := raw.(map[string]any)
		if tm["team_id"] == team1 && (!slices.Equal(list(tm["manager_ids"]), []string{lead2ID}) || tm["manager_id"] != lead2ID) {
			t.Fatalf("team one keeps its other lead: %v", tm)
		}
	}

	// Off again: the switch takes the new abilities away at once.
	h.call(authToken, "PUT", "/v1/orgs/"+org1+"/features/teams_v2", map[string]any{"on": false})
	if code, _ := teamPut(ownerID, team1, map[string]any{"name": "Team one", "manager_ids": []string{lead2ID, ownerID}}); code != 400 {
		t.Fatalf("two leads after switching off: %d", code)
	}
}

// The platform owner who also owns an agency acts in that agency as its owner, with no staff second step; in another agency they
// are staff and confirm themselves first.
func TestStaffWhoOwnTheAgencyActAsItsOwner(t *testing.T) {
	h := newHarness(t)
	h.opened()
	h.mem.staff[ownerID] = "owner"
	team := func(org string) int {
		code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org+"/teams/"+team2, map[string]any{"actor_id": ownerID, "actor_second_step": false, "name": "Team two"})
		return code
	}
	if code := team(org1); code != 200 {
		t.Fatalf("in their own agency: %d", code)
	}
	other := "12121212-1212-4212-8212-121212121212"
	if code, out := h.call(coreToken, "PUT", "/v1/orgs/"+other+"/owner", map[string]any{"user_id": strangerID}); code != 200 {
		t.Fatalf("open another agency: %d %v", code, out)
	}
	if code := team(other); code != 403 {
		t.Fatalf("in someone else's agency without a second step: %d", code)
	}
}

// Step 3: one invitation carries several roles, several teams and teams to lead; anyone but the owner can leave.
func TestAnInvitationCarriesEverythingAndPeopleCanLeave(t *testing.T) {
	h := newHarness(t)
	h.opened()
	h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+team2, map[string]any{"actor_id": ownerID, "actor_second_step": true, "name": "Team two"})
	check := func(actor string, body map[string]any) map[string]any {
		body["actor_id"], body["actor_second_step"], body["action"] = actor, true, "invite"
		_, out := h.call(authToken, "POST", "/v1/orgs/"+org1+"/relations/check", body)
		return out
	}
	// A team lead invited with the team they will lead: allowed under the old rules while the team has no lead.
	if out := check(ownerID, map[string]any{"roles": []string{"manager"}, "lead_team_ids": []string{team2}}); out["allowed"] != true {
		t.Fatalf("a lead with their team: %v", out)
	}
	if out := check(ownerID, map[string]any{"roles": []string{"caller"}, "lead_team_ids": []string{team2}}); out["allowed"] == true {
		t.Fatal("only a team lead is given teams to lead")
	}
	if out := check(ownerID, map[string]any{"roles": []string{"manager", "closer"}, "team_ids": []string{team1}}); out["allowed"] == true {
		t.Fatal("a lead who also closes needs the new team rules")
	}
	h.call(authToken, "PUT", "/v1/orgs/"+org1+"/features/teams_v2", map[string]any{"on": true})
	if out := check(ownerID, map[string]any{"roles": []string{"manager", "closer"}, "team_ids": []string{team1, team2}, "lead_team_ids": []string{team1}}); out["allowed"] != true {
		t.Fatalf("everything at once: %v", out)
	}
	// A lead invites into a team they lead, not another, and names no leads.
	h.call(authToken, "PUT", "/v1/orgs/"+org1+"/members/"+managerID, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"manager"}})
	h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+team1, map[string]any{"actor_id": ownerID, "actor_second_step": true, "name": "Team one", "manager_ids": []string{managerID}})
	if out := check(managerID, map[string]any{"roles": []string{"caller"}, "team_ids": []string{team1}}); out["allowed"] != true {
		t.Fatalf("a lead invites into their team: %v", out)
	}
	if out := check(managerID, map[string]any{"roles": []string{"caller"}, "team_ids": []string{team1, team2}}); out["allowed"] == true {
		t.Fatal("a lead invites into a team they do not lead")
	}
	// Leaving: a caller, even suspended, leaves; the owner cannot.
	h.call(authToken, "POST", "/v1/orgs/"+org1+"/members/"+callerID+"/suspend", map[string]any{"actor_id": ownerID, "actor_second_step": true})
	if code, out := h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/members/"+callerID, map[string]any{"actor_id": callerID, "actor_second_step": false}); code != 200 {
		t.Fatalf("a caller leaves: %d %v", code, out)
	}
	if code, out := h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/members/"+ownerID, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 403 {
		t.Fatalf("the owner leaves: %d %v", code, out)
	}
	if code, _ := h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/members/"+managerID, map[string]any{"actor_id": managerID}); code != 200 {
		t.Fatalf("a lead leaves: %d", code)
	}
	_, teams := h.call(authToken, "GET", "/v1/orgs/"+org1+"/teams", nil)
	for _, raw := range teams["teams"].([]any) {
		if tm := raw.(map[string]any); tm["team_id"] == team1 && len(list(tm["manager_ids"])) != 0 {
			t.Fatalf("a lead who left no longer leads: %v", tm)
		}
	}
}
