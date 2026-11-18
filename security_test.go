package main

import "testing"

// Step 35, D238: only the owner requires the second step of everyone; then a caller without it is asked for it, and with it works.
func TestOwnerRequiresTheSecondStepOfEveryone(t *testing.T) {
	h := newHarness(t)
	h.opened()
	if code, out := h.grant(callerID, "read", false); code != 200 || out["allowed"] != true {
		t.Fatalf("a caller before: %d %v", code, out)
	}
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/security", map[string]any{"actor_id": callerID, "actor_second_step": true, "mfa_everyone": true}); code != 403 {
		t.Fatalf("a caller requires it: %d", code)
	}
	if code, out := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/security", map[string]any{"actor_id": ownerID, "actor_second_step": true, "mfa_everyone": true}); code != 200 || out["mfa_everyone"] != true {
		t.Fatalf("the owner requires it: %d %v", code, out)
	}
	if _, out := h.grant(callerID, "read", false); out["allowed"] != false || out["code"] != "second_step_required" {
		t.Fatalf("a caller without the second step: %v", out)
	}
	if _, out := h.grant(callerID, "read", true); out["allowed"] != true {
		t.Fatalf("a caller with it: %v", out)
	}
	h.call(authToken, "PUT", "/v1/orgs/"+org1+"/security", map[string]any{"actor_id": ownerID, "actor_second_step": true, "mfa_everyone": false})
	if _, out := h.grant(callerID, "read", false); out["allowed"] != true {
		t.Fatalf("switched off again: %v", out)
	}
}
