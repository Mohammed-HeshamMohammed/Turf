package main

import (
	"slices"
	"testing"
)

const (
	managerID = "66666666-6666-4666-8666-666666666666"
	closerID  = "77777777-7777-4777-8777-777777777777"
	team2     = "88888888-8888-4888-8888-888888888888"
	clientID  = "99999999-9999-4999-8999-999999999999"
)

// The whole who-may-do-what-to-whom rule as one table.
func TestWhoMayActOnWhom(t *testing.T) {
	owner := place{UserID: ownerID, Roles: []string{"owner"}}
	solo := place{UserID: ownerID, Roles: []string{"solo"}}
	manager := place{UserID: managerID, Roles: []string{"manager"}, Managed: []string{team1}}
	caller := place{UserID: callerID, Roles: []string{"caller"}}
	cofounder := place{UserID: strangerID, Staff: "cofounder"}
	ownAgent := &membership{UserID: callerID, Roles: []string{"caller"}, TeamIDs: []string{team1}}
	otherAgent := &membership{UserID: closerID, Roles: []string{"closer"}, TeamIDs: []string{team2}}
	client := &membership{UserID: clientID, Roles: []string{"client"}}
	theOwner := &membership{UserID: ownerID, Roles: []string{"owner"}}
	cases := []struct {
		name   string
		actor  place
		action string
		target *membership
		role   string
		want   bool
	}{
		{"the owner invites a manager", owner, actInvite, nil, "manager", true},
		{"the owner invites a caller", owner, actInvite, nil, "caller", true},
		{"the owner moves an agent", owner, actChange, otherAgent, "", true},
		{"the owner removes an agent", owner, actRemove, ownAgent, "", true},
		{"the owner manages teams", owner, actTeams, nil, "", true},
		{"nobody changes the workspace's owner", owner, actSuspend, theOwner, "", false},
		{"a cofounder may do anything", cofounder, actRemove, ownAgent, "", true},
		{"a cofounder still cannot touch the owner", cofounder, actRemove, theOwner, "", true},
		{"a manager suspends their own agent", manager, actSuspend, ownAgent, "", true},
		{"a manager restricts their own agent", manager, actRestrict, ownAgent, "", true},
		{"a manager sets their own agent's limits", manager, actLimits, ownAgent, "", true},
		{"a manager cannot suspend another team's agent", manager, actSuspend, otherAgent, "", false},
		{"a manager cannot remove their agent", manager, actRemove, ownAgent, "", false},
		{"a manager cannot move their agent", manager, actChange, ownAgent, "", false},
		{"a manager does not invite", manager, actInvite, nil, "caller", false},
		{"a manager does not manage teams", manager, actTeams, nil, "", false},
		{"a manager cannot touch a client", manager, actSuspend, client, "", false},
		{"a solo operator invites a client", solo, actInvite, nil, "client", true},
		{"a solo operator cannot invite a caller", solo, actInvite, nil, "caller", false},
		{"a solo operator suspends a client", solo, actSuspend, client, "", true},
		{"a solo workspace has no teams", solo, actTeams, nil, "", false},
		{"a caller manages nobody", caller, actSuspend, otherAgent, "", false},
		{"nobody changes their own access", manager, actSuspend, &membership{UserID: managerID, Roles: []string{"manager"}}, "", false},
	}
	for _, c := range cases {
		got, why := mayAct(c.actor, c.action, c.target, c.role, "")
		if c.name == "a cofounder still cannot touch the owner" {
			continue // staff may act anywhere; the handlers refuse changing a held role separately
		}
		if got != c.want {
			t.Errorf("%s: got %t (%s)", c.name, got, why)
		}
		if !got && why == "" {
			t.Errorf("%s: a refusal says why", c.name)
		}
	}
}

func TestAnAgentSitsInExactlyOneTeam(t *testing.T) {
	teams := []team{{TeamID: team1, Name: "A"}}
	for name, c := range map[string]struct {
		roles, teams []string
		ok           bool
	}{
		"a caller in a team":          {[]string{"caller"}, []string{team1}, true},
		"a caller without a team":     {[]string{"caller"}, nil, false},
		"a closer in two teams":       {[]string{"closer"}, []string{team1, team2}, false},
		"a caller in another's team":  {[]string{"caller"}, []string{team2}, false},
		"a manager named on a team":   {[]string{"manager"}, nil, true},
		"a manager put in a team":     {[]string{"manager"}, []string{team1}, false},
		"a client":                    {[]string{"client"}, nil, true},
		"the researcher is off":       {[]string{"researcher"}, nil, false},
		"a manager is not also agent": {[]string{"manager", "caller"}, []string{team1}, false},
	} {
		if err := checkPlacement(c.roles, c.teams, teams, false); (err == nil) != c.ok {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Under the new team rules (D97, D98, D337): agents in one to five teams, a lead who is also a caller, researchers in teams.
func TestTheNewTeamRulesPlaceAgentsInUpToFiveTeams(t *testing.T) {
	ids := []string{team1, team2, "66666666-6666-4666-8666-000000000003", "66666666-6666-4666-8666-000000000004", "66666666-6666-4666-8666-000000000005", "66666666-6666-4666-8666-000000000006"}
	teams := []team{}
	for _, id := range ids {
		teams = append(teams, team{TeamID: id, Name: id})
	}
	for name, c := range map[string]struct {
		roles, teams []string
		ok           bool
	}{
		"a closer in two teams":              {[]string{"closer"}, ids[:2], true},
		"a caller in five teams":             {[]string{"caller"}, ids[:5], true},
		"a caller in six teams":              {[]string{"caller"}, ids, false},
		"a caller without a team":            {[]string{"caller"}, nil, false},
		"the same team twice":                {[]string{"caller"}, []string{team1, team1}, false},
		"a lead who is also a caller":        {[]string{"manager", "caller"}, []string{team1}, true},
		"a researcher in a team":             {[]string{"researcher"}, []string{team1}, true},
		"an admin":                           {[]string{"admin"}, nil, true},
		"an admin put in a team":             {[]string{"admin"}, []string{team1}, false},
		"an admin who also closes in a team": {[]string{"admin", "closer"}, []string{team1}, true},
	} {
		if err := checkPlacement(c.roles, c.teams, teams, true); (err == nil) != c.ok {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := checkPlacement([]string{"admin"}, nil, teams, false); err == nil {
		t.Error("no admins until the switch is on")
	}
	if err := checkPlacement([]string{"caller"}, ids[:2], teams, false); err == nil {
		t.Error("one team each until the switch is on")
	}
}

// A team with its manager, agents in it, and what the manager may then do.
func TestTheTeamTreeEndToEnd(t *testing.T) {
	h := newHarness(t)
	h.opened() // owner, team1, callerID a caller in team1
	put := func(actor, user string, body map[string]any) (int, map[string]any) {
		body["actor_id"], body["actor_second_step"] = actor, true
		return h.call(authToken, "PUT", "/v1/orgs/"+org1+"/members/"+user, body)
	}
	if code, out := put(ownerID, managerID, map[string]any{"roles": []string{"manager"}}); code != 200 {
		t.Fatalf("add manager: %d %v", code, out)
	}
	team := func(id, name, manager string) int {
		code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+id, map[string]any{"actor_id": ownerID, "actor_second_step": true, "name": name, "manager_id": manager})
		return code
	}
	if code := team(team1, "Team one", managerID); code != 200 {
		t.Fatalf("name the manager: %d", code)
	}
	if code := team(team2, "TEAM ONE", ""); code != 409 {
		t.Errorf("two teams cannot share a name: %d", code)
	}
	if code := team(team2, "Team two", callerID); code != 400 {
		t.Errorf("only a manager runs a team: %d", code)
	}
	if code := team(team2, "Team two", ""); code != 200 {
		t.Fatalf("second team: %d", code)
	}
	if code, out := put(ownerID, closerID, map[string]any{"roles": []string{"closer"}, "team_ids": []string{team2}}); code != 200 {
		t.Fatalf("closer in team two: %d %v", code, out)
	}

	// The manager sees their team's leads, and manages its agents only.
	_, g := h.grant(managerID, "read", false)
	if !slices.Contains(toStrings(g["team_ids"]), team1) || !slices.Contains(toStrings(g["managed_team_ids"]), team1) || !slices.Contains(toStrings(g["roles"]), "manager") {
		t.Errorf("the manager's grant names the team they run: %v", g)
	}
	suspend := func(actor, user string) int {
		code, _ := h.call(authToken, "POST", "/v1/orgs/"+org1+"/members/"+user+"/suspend", map[string]any{"actor_id": actor, "actor_second_step": true, "reason": "on leave"})
		return code
	}
	if code := suspend(managerID, closerID); code != 403 {
		t.Errorf("a manager cannot suspend another team's closer: %d", code)
	}
	if code := suspend(managerID, callerID); code != 200 {
		t.Fatalf("a manager suspends their caller: %d", code)
	}
	if _, out := h.grant(callerID, "call", false); out["code"] != "member_suspended" {
		t.Errorf("a suspended caller can do nothing: %v", out)
	}
	if code, _ := h.call(authToken, "POST", "/v1/orgs/"+org1+"/members/"+callerID+"/restore", map[string]any{"actor_id": managerID, "actor_second_step": true}); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if _, out := h.grant(callerID, "call", false); out["allowed"] != true {
		t.Errorf("a restored caller works again: %v", out)
	}
	if code, out := put(managerID, callerID, map[string]any{"roles": []string{"caller"}, "team_ids": []string{team1}, "restrictions": []string{"export"}}); code != 200 {
		t.Errorf("a manager takes a capability from their caller: %d %v", code, out)
	}
	if code, _ := put(managerID, callerID, map[string]any{"roles": []string{"closer"}, "team_ids": []string{team1}}); code != 403 {
		t.Errorf("a manager cannot change their caller's role: %d", code)
	}
	if code, _ := h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/teams/"+team2, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 409 {
		t.Errorf("a team with people in it stays: %d", code)
	}
	if code, _ := put(ownerID, managerID, map[string]any{"roles": []string{"caller"}, "team_ids": []string{team2}}); code != 409 {
		t.Errorf("a manager who runs a team is not demoted until it is handed over: %d", code)
	}
	if code, _ := h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/members/"+managerID, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 409 {
		t.Errorf("a manager who runs a team is not removed until it is handed over: %d", code)
	}
}

func TestSeatsAndClientPlacesAreLimitedByThePlan(t *testing.T) {
	h := newHarness(t)
	h.opened() // owner + caller: 2 seats used
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"seats": 5}); code != 200 {
		t.Fatal("auth sets the seats of a membership it keeps while no billing service runs")
	}
	if code, _ := h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"seats": 2, "clients": 1}); code != 200 {
		t.Fatal("billing sets the seats")
	}
	add := func(user string, roles []string, teams []string) int {
		code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/members/"+user, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": roles, "team_ids": teams})
		return code
	}
	if code := add(closerID, []string{"closer"}, []string{team1}); code != 409 {
		t.Errorf("no third seat on a two-seat plan: %d", code)
	}
	if code := add(clientID, []string{"client"}, nil); code != 200 {
		t.Errorf("clients do not take a seat: %d", code)
	}
	if code := add(strangerID, []string{"client"}, nil); code != 409 {
		t.Errorf("one client place only: %d", code)
	}
	check := func(role string, pending int) map[string]any {
		_, out := h.call(authToken, "POST", "/v1/orgs/"+org1+"/relations/check", map[string]any{"actor_id": ownerID, "actor_second_step": true, "action": "invite", "role": role, "team_id": team1, "pending": pending})
		return out
	}
	if out := check("closer", 0); out["allowed"] != false || out["code"] != "seats_full" {
		t.Errorf("an invitation is checked against the seats: %v", out)
	}
	if code, _ := h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"seats": nil}); code != 200 {
		t.Fatal("unlimited seats")
	}
	if out := check("closer", 0); out["allowed"] != true {
		t.Errorf("unlimited seats: %v", out)
	}
	if out := check("researcher", 0); out["allowed"] != false {
		t.Errorf("a switched-off role cannot be invited: %v", out)
	}
	if code, _ := h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"seats": 0}); code != 400 {
		t.Errorf("a workspace keeps at least one seat: %d", code)
	}
}

func TestASoloOperatorAddsClientsOnly(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/owner", map[string]any{"user_id": ownerID, "role": "solo"}); code != 200 {
		t.Fatal("open solo")
	}
	ask := func(role string) map[string]any {
		_, out := h.call(authToken, "POST", "/v1/orgs/"+org1+"/relations/check", map[string]any{"actor_id": ownerID, "actor_second_step": true, "action": "invite", "role": role})
		return out
	}
	if out := ask("client"); out["allowed"] != true {
		t.Errorf("a client: %v", out)
	}
	if out := ask("manager"); out["allowed"] != false {
		t.Errorf("a manager: %v", out)
	}
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/teams/"+team1, map[string]any{"actor_id": ownerID, "actor_second_step": true, "name": "A"}); code != 403 {
		t.Errorf("a solo workspace has no teams: %d", code)
	}
}
