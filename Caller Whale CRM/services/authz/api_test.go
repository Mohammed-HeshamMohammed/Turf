package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestOnlyKnownServicesMayCall(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.call("", "POST", "/v1/grant", map[string]any{}); code != 401 {
		t.Errorf("no token: %d", code)
	}
	if code, _ := h.call("someone-else-token-0123456789abcdef", "POST", "/v1/grant", map[string]any{}); code != 401 {
		t.Errorf("unknown token: %d", code)
	}
	if code, _ := h.call(gatewayToken, "PUT", "/v1/orgs/"+org1+"/owner", map[string]any{"user_id": ownerID}); code != 403 {
		t.Errorf("the gateway may only check: %d", code)
	}
	if code, _ := h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/members/"+callerID, map[string]any{}); code != 403 {
		t.Errorf("billing may not change members: %d", code)
	}
	if code, out := h.call("", "GET", "/healthz", nil); code != 200 || out["service"] != "authz" {
		t.Errorf("health: %d %v", code, out)
	}
}

func TestStaffDirectoryNeedsAServiceToken(t *testing.T) {
	h := newHarness(t)
	h.mem.staff[ownerID] = "owner"
	h.mem.staff[callerID] = "cofounder"
	if code, _ := h.call("", "GET", "/v1/staff", nil); code != 401 {
		t.Fatalf("anonymous staff list: %d", code)
	}
	if code, _ := h.call(gatewayToken, "GET", "/v1/staff", nil); code != 403 {
		t.Fatalf("gateway staff list: %d", code)
	}
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/roles/helper", map[string]any{}); code != 403 {
		t.Fatalf("auth must not manage workspaces: %d", code)
	}
	if code, _ := h.call(authToken, "GET", "/v1/staff", nil); code != 200 {
		t.Fatalf("auth staff list: %d", code)
	}
	code, out := h.call(coreToken, "GET", "/v1/staff", nil)
	if code != 200 || len(out["staff"].([]any)) != 2 {
		t.Fatalf("staff list: %d %v", code, out)
	}
}

func TestAuthCanApplyAnOwnerApprovedMemberRoleOnly(t *testing.T) {
	h := newHarness(t)
	h.opened()
	body := map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"caller"}}
	path := "/v1/orgs/" + org1 + "/members/" + strangerID
	if code, _ := h.call(authToken, "PUT", path, body); code != 400 {
		t.Fatalf("a caller needs a team: %d", code)
	}
	body["team_ids"] = []string{team1}
	if code, _ := h.call(authToken, "PUT", path, body); code != 200 {
		t.Fatalf("auth may apply an owner-approved member role: %d", code)
	}
	body["actor_id"] = callerID
	if code, _ := h.call(authToken, "PUT", path, body); code != 403 {
		t.Fatalf("a non-owner cannot authorize the same call: %d", code)
	}
	if code, _ := h.call(authToken, "DELETE", path, map[string]any{"actor_id": callerID, "actor_second_step": true}); code != 403 {
		t.Fatalf("a caller cannot remove anyone: %d", code)
	}
	if code, _ := h.call(authToken, "DELETE", path, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 200 {
		t.Fatalf("the owner removes a member through auth's screens: %d", code)
	}
}

func TestGrantsCarryDatabaseRightsAndScope(t *testing.T) {
	h := newHarness(t)
	h.opened()

	code, out := h.grant(callerID, "read", false)
	if code != 200 || out["allowed"] != true || out["db_role"] != "cw_read" {
		t.Fatalf("caller read: %d %v", code, out)
	}
	claims, err := h.keys.verify(out["grant"].(string), "core-api", h.clock)
	if err != nil {
		t.Fatalf("the grant verifies for the core API: %v", err)
	}
	if claims.Subject != callerID || claims.Org != org1 || claims.DBRole != "cw_read" || len(claims.Scopes) != 1 || claims.Scopes[0] != "own" || claims.TeamIDs[0] != team1 {
		t.Errorf("grant claims: %+v", claims)
	}
	if _, err := h.keys.verify(out["grant"].(string), "billing", h.clock); err == nil {
		t.Error("a grant made for the core API must not verify for billing")
	}
	if _, err := h.keys.verify(out["grant"].(string), "core-api", h.clock.Add(2*time.Minute)); err == nil {
		t.Error("a grant must expire")
	}

	if _, out := h.grant(callerID, "export", false); out["allowed"] != false || out["code"] != "missing_capability" {
		t.Errorf("caller export: %v", out)
	}
	if _, out := h.grant(strangerID, "read", false); out["allowed"] != false || out["code"] != "not_member" {
		t.Errorf("stranger: %v", out)
	}
	if _, out := h.grant(ownerID, "admin", false); out["db_role"] != "cw_admin" {
		t.Errorf("an agency owner needs no second step (only the platform owner and cofounder do): %v", out)
	}
	if _, out := h.grant(ownerID, "admin", true); out["db_role"] != "cw_admin" {
		t.Errorf("owner admin: %v", out)
	}
	if code, _ := h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": callerID, "org_id": org1, "action": "fly"}); code != 400 {
		t.Errorf("unknown action: %d", code)
	}
}

func TestRestrictionsAndStanding(t *testing.T) {
	h := newHarness(t)
	h.opened()
	code, out := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/members/"+callerID, map[string]any{
		"actor_id": ownerID, "actor_second_step": true, "roles": []string{"caller"}, "restrictions": []string{"call"}, "team_ids": []string{team1},
	})
	if code != 200 {
		t.Fatalf("restrict: %d %v", code, out)
	}
	if _, out := h.grant(callerID, "call", false); out["code"] != "missing_capability" {
		t.Errorf("a restriction takes the capability away: %v", out)
	}
	if _, out := h.grant(callerID, "edit", false); out["allowed"] != true {
		t.Errorf("other capabilities stay: %v", out)
	}

	if code, _ := h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"payment_required": true}); code != 200 {
		t.Fatalf("standing: %d", code)
	}
	if _, out := h.grant(callerID, "edit", false); out["code"] != "payment_required" {
		t.Errorf("unpaid: %v", out)
	}
	if _, out := h.grant(ownerID, "pay", true); out["allowed"] != true {
		t.Errorf("the owner can still pay: %v", out)
	}
	h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"suspended": true})
	if _, out := h.grant(ownerID, "pay", true); out["code"] == "suspended" {
		t.Errorf("billing cannot suspend a workspace: %v", out)
	}
	h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"suspended": true})
	h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"payment_required": false})
	if _, out := h.grant(ownerID, "pay", true); out["code"] != "suspended" {
		t.Errorf("a payment webhook never lifts a suspension: %v", out)
	}
}

func TestMemberChangesFollowTheOwnerRules(t *testing.T) {
	h := newHarness(t)
	h.opened()
	path := "/v1/orgs/" + org1 + "/members/" + strangerID
	if code, _ := h.call(coreToken, "PUT", path, map[string]any{"actor_id": callerID, "roles": []string{"caller"}}); code != 403 {
		t.Errorf("a caller cannot add members: %d", code)
	}
	if code, _ := h.call(coreToken, "PUT", path, map[string]any{"actor_id": ownerID, "roles": []string{"caller"}}); code != 400 {
		t.Errorf("the owner needs no second step, but a caller needs a team: %d", code)
	}
	if code, _ := h.call(coreToken, "PUT", path, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"owner"}}); code != 403 {
		t.Errorf("the owner role cannot be given: %d", code)
	}
	if code, _ := h.call(coreToken, "PUT", path, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"pilot"}}); code != 400 {
		t.Errorf("an unknown role: %d", code)
	}
	if code, _ := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/members/"+ownerID, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"caller"}}); code != 403 {
		t.Errorf("the owner's role cannot be changed: %d", code)
	}
	if code, _ := h.call(coreToken, "DELETE", "/v1/orgs/"+org1+"/members/"+ownerID, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 403 {
		t.Errorf("the owner cannot be removed: %d", code)
	}
	if code, _ := h.call(coreToken, "DELETE", "/v1/orgs/"+org1+"/members/"+callerID, map[string]any{"actor_id": ownerID, "actor_second_step": true}); code != 200 {
		t.Errorf("remove the caller: %d", code)
	}
	if _, out := h.grant(callerID, "read", false); out["code"] != "not_member" {
		t.Errorf("a removed person loses access at once: %v", out)
	}
	if code, _ := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/owner", map[string]any{"user_id": strangerID}); code != 409 {
		t.Errorf("a workspace keeps its first owner: %d", code)
	}
	if code, _ := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/owner", map[string]any{"user_id": ownerID}); code != 200 {
		t.Errorf("opening again for the same owner is harmless: %d", code)
	}
}

func TestRoleChanges(t *testing.T) {
	h := newHarness(t)
	h.opened()
	put := func(key string, body map[string]any) int {
		body["actor_id"], body["actor_second_step"] = ownerID, true
		code, _ := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/roles/"+key, body)
		return code
	}
	if code := put("owner", map[string]any{"capabilities": []string{"edit"}}); code != 403 {
		t.Errorf("held roles cannot change: %d", code)
	}
	if code := put("helper", map[string]any{"capabilities": []string{"admin"}}); code != 403 {
		t.Errorf("no role but the owner's manages access: %d", code)
	}
	if code := put("helper", map[string]any{"capabilities": []string{"fly"}}); code != 400 {
		t.Errorf("unknown capability: %d", code)
	}
	if code := put("helper", map[string]any{"capabilities": []string{"export"}, "scope": "team"}); code != 200 {
		t.Fatalf("custom role: %d", code)
	}
	h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/members/"+callerID, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"caller", "helper"}, "team_ids": []string{team1}})
	_, out := h.grant(callerID, "export", false)
	if out["allowed"] != true || !strings.Contains(strings.Join(toStrings(out["scopes"]), ","), "team") {
		t.Errorf("roles combine: %v", out)
	}
}

func TestStaffChanges(t *testing.T) {
	h := newHarness(t)
	h.mem.staff[ownerID] = "owner"
	put := func(actor, target, role string, second bool) int {
		code, _ := h.call(coreToken, "PUT", "/v1/staff/"+target, map[string]any{"actor_id": actor, "actor_second_step": second, "role": role})
		return code
	}
	if code := put(callerID, strangerID, "system_admin", true); code != 403 {
		t.Errorf("only the platform owner manages staff: %d", code)
	}
	if code := put(ownerID, strangerID, "system_admin", false); code != 403 {
		t.Errorf("the platform owner needs the second step: %d", code)
	}
	if code := put(ownerID, strangerID, "owner", true); code != 400 {
		t.Errorf("there is one platform owner: %d", code)
	}
	if code := put(ownerID, strangerID, "system_admin", true); code != 403 {
		t.Errorf("system admin is switched off: %d", code)
	}
	h.mem.staff[strangerID] = "system_admin" // given before it was switched off
	if code, out := h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": strangerID, "action": "platform", "second_step_passed": true}); code != 200 || out["allowed"] != false {
		t.Errorf("a system admin kept from before gets nothing: %d %v", code, out)
	}
	delete(h.mem.staff, strangerID)
	code, out := h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": ownerID, "action": "platform", "second_step_passed": true})
	if code != 200 || out["db_role"] != "cw_staff" {
		t.Errorf("staff grant: %d %v", code, out)
	}
	if code := put(ownerID, ownerID, "", true); code != 403 {
		t.Errorf("the platform owner's access cannot change: %d", code)
	}
	if err := h.mem.setCofounder(context.Background(), callerID); err != nil {
		t.Fatal(err)
	}
	if code := put(callerID, ownerID, "tester", true); code != 403 {
		t.Errorf("the cofounder cannot change the owner: %d", code)
	}
	if code := put(ownerID, callerID, "tester", true); code != 403 {
		t.Errorf("the owner cannot change the cofounder: %d", code)
	}
	if code := put(callerID, strangerID, "tester", true); code != 200 {
		t.Errorf("cofounder assigns tester: %d", code)
	}
	if code, out := h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": strangerID, "action": "platform", "second_step_passed": true}); code != 200 || out["allowed"] != false {
		t.Errorf("tester cannot get staff grant: %d %v", code, out)
	}
	if code, out := h.call(gatewayToken, "POST", "/v1/check", map[string]any{"user_id": strangerID, "permission": "tester"}); code != 200 || out["allowed"] != true {
		t.Errorf("tester check: %d %v", code, out)
	}
	if code := put(callerID, strangerID, "system_admin", true); code != 403 {
		t.Errorf("nobody assigns system admin while it is switched off: %d", code)
	}
}

func TestChecks(t *testing.T) {
	h := newHarness(t)
	h.opened()
	code, out := h.call(gatewayToken, "POST", "/v1/check", map[string]any{"user_id": callerID, "org_id": org1, "permission": "call"})
	if code != 200 || out["allowed"] != true {
		t.Errorf("check: %d %v", code, out)
	}
	_, out = h.call(gatewayToken, "POST", "/v1/check-batch", map[string]any{"items": []map[string]any{
		{"user_id": callerID, "org_id": org1, "permission": "export"},
		{"user_id": ownerID, "org_id": org1, "permission": "manage_access"},
	}})
	if r := out["results"].([]any); r[0] != false || r[1] != true {
		t.Errorf("batch: %v", r)
	}
	if code, _ := h.call(gatewayToken, "POST", "/v1/check", map[string]any{"user_id": callerID, "org_id": org1, "permission": "fly"}); code != 400 {
		t.Errorf("unknown permission: %d", code)
	}
}

func TestStoreDownMeansRefuse(t *testing.T) {
	h := newHarness(t)
	h.opened()
	h.mem.failNext = true
	code, out := h.grant(callerID, "read", false)
	if code != 503 || out["code"] != "unavailable" || out["grant"] != nil {
		t.Errorf("a rules-store failure is never a grant: %d %v", code, out)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestWhoIsThisPerson(t *testing.T) {
	h := newHarness(t)
	h.opened()
	h.mem.staff[strangerID] = "system_admin"
	h.mem.staff[callerID] = ""
	get := func(user string) map[string]any {
		code, out := h.call(coreToken, "GET", "/v1/people/"+user, nil)
		if code != 200 {
			t.Fatalf("person %s: %d %v", user, code, out)
		}
		return out
	}
	owner := get(ownerID)
	spaces := owner["workspaces"].([]any)
	if owner["platform_role"] != "" || len(spaces) != 1 || spaces[0].(map[string]any)["business_owner"] != true {
		t.Errorf("a agency owner: %v", owner)
	}
	if _, has := owner["platform_label"]; has {
		t.Errorf("a agency owner is not on the platform ladder: %v", owner)
	}
	caller := get(callerID)
	if caller["workspaces"].([]any)[0].(map[string]any)["business_owner"] != false {
		t.Errorf("a caller is not a agency owner: %v", caller)
	}
	admin := get(strangerID)
	if admin["platform_role"] != "system_admin" || admin["platform_label"] != "System admin" || len(admin["workspaces"].([]any)) != 0 {
		t.Errorf("a system admin: %v", admin)
	}
	h.mem.staff[ownerID] = "owner"
	if get(ownerID)["platform_label"] != "Caller Whale owner" {
		t.Errorf("the Caller Whale owner is named")
	}
	h.mem.staff[callerID] = "cofounder"
	if get(callerID)["platform_label"] != "Cofounder" {
		t.Error("the cofounder is named")
	}
	h.mem.staff[strangerID] = "tester"
	if get(strangerID)["platform_label"] != "Tester" {
		t.Error("the tester is named")
	}
	if code, _ := h.call(coreToken, "GET", "/v1/people/not-an-id", nil); code != 400 {
		t.Errorf("a bad id: %d", code)
	}
	if code, _ := h.call(gatewayToken, "GET", "/v1/people/"+ownerID, nil); code != 403 {
		t.Errorf("the gateway may only check: %d", code)
	}
}

func TestPlatformOwnerIsSetOnceAndNeverReplaced(t *testing.T) {
	m := newMem()
	ctx := context.Background()
	if err := m.setPlatformOwner(ctx, ownerID); err != nil {
		t.Fatal(err)
	}
	if err := m.setPlatformOwner(ctx, ownerID); err != nil {
		t.Errorf("the same owner again is harmless: %v", err)
	}
	if err := m.setPlatformOwner(ctx, callerID); !errors.Is(err, errOwnerTaken) {
		t.Errorf("a second owner: %v", err)
	}
	if err := m.setCofounder(ctx, callerID); err != nil {
		t.Fatal(err)
	}
	if err := m.setCofounder(ctx, callerID); err != nil {
		t.Errorf("same cofounder: %v", err)
	}
	if err := m.setCofounder(ctx, strangerID); !errors.Is(err, errCofounderTaken) {
		t.Errorf("second cofounder: %v", err)
	}
	if err := m.setStaff(ctx, callerID, "system_admin"); err != nil {
		t.Fatal(err)
	}
	if m.staff[callerID] != "cofounder" {
		t.Error("cofounder cannot be changed")
	}
}

func TestACustomRoleCannotTakeAStandardRolesName(t *testing.T) {
	h := newHarness(t)
	h.opened()
	put := func(key string) int {
		code, _ := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/roles/"+key, map[string]any{"actor_id": ownerID, "actor_second_step": true, "capabilities": []string{"edit"}})
		return code
	}
	for _, key := range []string{"caller", "closer", "manager", "researcher", "client", "solo", "owner", "cofounder", "system_admin", "tester", "admin"} {
		if code := put(key); code != 403 {
			t.Errorf("a custom role called %s was accepted: %d", key, code)
		}
	}
	if code := put("senior_closer"); code != 200 {
		t.Fatalf("a role with its own name: %d", code)
	}
}

func TestTheCatalogListsEachRoleOnce(t *testing.T) {
	stored := []role{
		{Key: "caller", Capabilities: []string{"call"}, Scope: "team"}, // kept from before presets were protected
		{Key: "senior_closer", Capabilities: []string{"edit"}, Scope: "own"},
		{Key: "helper", Capabilities: []string{"export"}, Scope: "team"},
		{Key: "helper", Capabilities: []string{"export"}, Scope: "team"}, // a repeat is still one role
		{Key: "researcher", Capabilities: []string{"import"}, Scope: "project"}, // switched off: never listed
	}
	got := buildCatalog(stored)
	seen := map[string]bool{}
	for _, r := range got {
		if seen[r.Key] {
			t.Fatalf("%s is listed twice", r.Key)
		}
		seen[r.Key] = true
	}
	if len(got) != len(presets)-1+2 {
		t.Fatalf("expected the %d standard roles (researcher is switched off) and 2 custom ones, got %d", len(presets)-1, len(got))
	}
	// Standard roles come first in their usual order, then custom ones by key.
	if got[0].Key != presets[0].key || got[len(got)-2].Key != "helper" || got[len(got)-1].Key != "senior_closer" {
		t.Fatalf("order: %+v", got)
	}
	var caller, owner catalogRole
	for _, r := range got {
		switch r.Key {
		case "caller":
			caller = r
		case "owner":
			owner = r
		}
	}
	if caller.Source != "preset" || caller.Scope != "team" {
		t.Errorf("a kept standard role is shown once, as itself, with what the workspace stored: %+v", caller)
	}
	if owner.Name != "Agency owner" || owner.Assignable {
		t.Errorf("the agency owner's role is named so and cannot be handed out: %+v", owner)
	}
	if got[len(got)-1].Name != "Senior closer" || got[len(got)-1].Source != "custom" {
		t.Errorf("a custom role is named from its key: %+v", got[len(got)-1])
	}
}

func TestTheRoleCatalogHasThePlatformRolesInTheirOwnGroup(t *testing.T) {
	h := newHarness(t)
	code, out := h.call(authToken, "GET", "/v1/roles", nil)
	if code != 200 {
		t.Fatalf("catalog: %d", code)
	}
	workspace, _ := out["workspace"].([]any)
	platform, _ := out["platform"].([]any)
	if len(workspace) != len(presets)-1 || len(platform) != 3 { // researcher and system admin are switched off
		t.Fatalf("workspace %d, platform %d", len(workspace), len(platform))
	}
	first, _ := platform[0].(map[string]any)
	if first["name"] != "Platform owner" {
		t.Errorf("the platform owner is labelled so: %v", first)
	}
}
