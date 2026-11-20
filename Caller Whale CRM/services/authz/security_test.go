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

// Step 35, D243: the owner limits the agency to countries and networks; the gateway reads them with the owner exempt.
func TestAccessLimits(t *testing.T) {
	h := newHarness(t)
	h.opened()
	put := func(actor string, body map[string]any) (int, map[string]any) {
		body["actor_id"], body["actor_second_step"] = actor, true
		return h.call(authToken, "PUT", "/v1/orgs/"+org1+"/security", body)
	}
	if code, _ := put(callerID, map[string]any{"countries": []string{"US"}}); code != 403 {
		t.Fatalf("a caller sets limits: %d", code)
	}
	if code, _ := put(ownerID, map[string]any{"countries": []string{"usa"}}); code != 400 {
		t.Fatalf("a bad country: %d", code)
	}
	if code, _ := put(ownerID, map[string]any{"networks": []string{"10.0.0.0/4"}}); code != 400 {
		t.Fatalf("a network that is too wide: %d", code)
	}
	if code, out := put(ownerID, map[string]any{"countries": []string{"us", "CA"}, "networks": []string{"203.0.113.7"}}); code != 200 || len(out["countries"].([]any)) != 2 || out["networks"].([]any)[0] != "203.0.113.7/32" {
		t.Fatalf("limits: %d %v", code, out)
	}
	code, out := h.call(gatewayToken, "GET", "/v1/orgs/"+org1+"/access-limits", nil)
	if code != 200 || len(out["exempt"].([]any)) != 1 || out["exempt"].([]any)[0] != ownerID {
		t.Fatalf("the gateway's view: %d %v", code, out)
	}
}
