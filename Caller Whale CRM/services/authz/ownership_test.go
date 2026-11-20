package main

import (
	"slices"
	"testing"
)

// Step 13: an agency with its owner gone is paused (members read, nobody works), billing cannot lift that, and a handover gives the
// owner's place to a member while the old owner becomes an admin or leaves (D27, D28, D200, D201).
func TestPausedAgencyAndHandingOverOwnership(t *testing.T) {
	h := newHarness(t)
	h.opened()
	if code, out := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"paused": true}); code != 200 {
		t.Fatalf("pause: %d %v", code, out)
	}
	if code, out := h.grant(callerID, "read", false); code != 200 || out["allowed"] != true {
		t.Fatalf("a paused agency can be read: %v", out)
	}
	if _, out := h.grant(callerID, "call", false); out["allowed"] != false || out["code"] != "paused" {
		t.Fatalf("nobody works in a paused agency: %v", out)
	}
	h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"paused": false})
	if _, out := h.grant(callerID, "call", false); out["code"] != "paused" {
		t.Fatalf("a payment lifted the pause: %v", out)
	}

	handover := func(body map[string]any) (int, map[string]any) {
		return h.call(authToken, "PUT", "/v1/orgs/"+org1+"/owner/handover", body)
	}
	if code, _ := handover(map[string]any{"from": callerID, "to": ownerID}); code != 409 {
		t.Fatalf("someone who is not the owner hands over: %d", code)
	}
	if code, _ := handover(map[string]any{"from": ownerID, "to": callerID, "old_roles": []string{"caller"}}); code != 400 {
		t.Fatalf("the old owner as a caller: %d", code)
	}
	if code, out := handover(map[string]any{"from": ownerID, "to": callerID, "old_roles": []string{"admin"}, "actor_id": ownerID}); code != 200 {
		t.Fatalf("hand over: %d %v", code, out)
	}
	if code, out := h.call(authToken, "GET", "/v1/orgs/"+org1, nil); code != 200 || out["owner_id"] != callerID {
		t.Fatalf("the new owner: %v", out)
	}
	if _, out := h.grant(callerID, "admin", true); out["allowed"] != true {
		t.Fatalf("the new owner runs the agency, and the pause ended: %v", out)
	}
	if _, out := h.grant(ownerID, "read", true); out["allowed"] != true || !slices.Equal(list(out["roles"]), []string{"admin"}) {
		t.Fatalf("the old owner is an admin now: %v", out)
	}
	// Handing it back, the old owner leaving.
	if code, out := handover(map[string]any{"from": callerID, "to": ownerID, "old_roles": []string{}}); code != 200 {
		t.Fatalf("hand back: %d %v", code, out)
	}
	if _, out := h.grant(callerID, "read", false); out["code"] != "not_member" {
		t.Fatalf("an old owner who chose to leave: %v", out)
	}
}

// Step 17: a solo workspace becomes an agency in place; the solo operator owns it and leads its first team (D59, D203).
func TestASoloWorkspaceBecomesAnAgency(t *testing.T) {
	h := newHarness(t)
	solo := "abababab-abab-4bab-8bab-abababababab"
	first := "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
	if code, out := h.call(coreToken, "PUT", "/v1/orgs/"+solo+"/owner", map[string]any{"user_id": ownerID, "role": "solo"}); code != 200 {
		t.Fatalf("open solo: %d %v", code, out)
	}
	up := map[string]any{"user_id": ownerID, "team_id": first, "team_name": "Sami's team"}
	if code, _ := h.call(billingToken, "POST", "/v1/orgs/"+solo+"/upgrade", up); code != 403 {
		t.Fatalf("billing upgrades a workspace: %d", code)
	}
	if code, out := h.call(coreToken, "POST", "/v1/orgs/"+solo+"/upgrade", up); code != 200 {
		t.Fatalf("upgrade: %d %v", code, out)
	}
	_, out := h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": ownerID, "org_id": solo, "action": "admin", "second_step_passed": true})
	if out["allowed"] != true || !slices.Equal(list(out["roles"]), []string{"owner"}) || !slices.Equal(list(out["managed_team_ids"]), []string{first}) {
		t.Fatalf("the owner, leading the first team: %v", out)
	}
	if code, _ := h.call(coreToken, "POST", "/v1/orgs/"+solo+"/upgrade", up); code != 409 {
		t.Fatalf("upgrading an agency again: %d", code)
	}
}

// Step 18: a lowered plan leaves more people than seats; suspending someone frees a seat, and they come back only when one is free
// (D81, D365).
func TestSeatsAfterAPlanIsLowered(t *testing.T) {
	h := newHarness(t)
	h.opened() // the owner and a caller
	if code, out := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/members/"+managerID, map[string]any{"actor_id": ownerID, "actor_second_step": true, "roles": []string{"closer"}, "team_ids": []string{team1}}); code != 200 {
		t.Fatalf("add a closer: %d %v", code, out)
	}
	h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"seats": 2})
	if _, out := h.call(authToken, "GET", "/v1/orgs/"+org1+"/seats", nil); out["over"] != float64(1) || out["used"] != float64(3) {
		t.Fatalf("over the seats: %v", out)
	}
	suspend := func(path string) (int, map[string]any) {
		return h.call(coreToken, "POST", "/v1/orgs/"+org1+"/members/"+managerID+"/"+path, map[string]any{"actor_id": ownerID, "actor_second_step": true, "reason": "The plan was lowered"})
	}
	if code, out := suspend("suspend"); code != 200 {
		t.Fatalf("suspend: %d %v", code, out)
	}
	if _, out := h.call(authToken, "GET", "/v1/orgs/"+org1+"/seats", nil); out["over"] != float64(0) {
		t.Fatalf("after the choice: %v", out)
	}
	if code, out := suspend("restore"); code != 409 || out["code"] != "seats_full" {
		t.Fatalf("coming back without a free seat: %d %v", code, out)
	}
	h.call(billingToken, "PUT", "/v1/orgs/"+org1+"/standing", map[string]any{"seats": 3})
	if code, out := suspend("restore"); code != 200 {
		t.Fatalf("coming back once a seat is added: %d %v", code, out)
	}
}
