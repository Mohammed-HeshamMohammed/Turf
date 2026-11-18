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
