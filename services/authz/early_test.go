package main

import "testing"

// Step 40, D294: the owner switches an early feature on for the agency; others may not; the list says which are on.
func TestOwnersSwitchEarlyFeatures(t *testing.T) {
	h := newHarness(t)
	h.opened()
	path := "/v1/orgs/" + org1 + "/early-features"
	if code, out := h.call(authToken, "GET", path, nil); code != 200 || out["features"].([]any)[0].(map[string]any)["on"] != false {
		t.Fatalf("list: %d %v", code, out)
	}
	if code, _ := h.call(authToken, "PUT", path+"/teams_v2", map[string]any{"actor_id": callerID, "actor_second_step": true, "on": true}); code != 403 {
		t.Fatalf("a caller switches it: %d", code)
	}
	if code, _ := h.call(authToken, "PUT", path+"/mfa_everyone", map[string]any{"actor_id": ownerID, "actor_second_step": true, "on": true}); code != 400 {
		t.Fatalf("a switch that is not early: %d", code)
	}
	if code, out := h.call(authToken, "PUT", path+"/teams_v2", map[string]any{"actor_id": ownerID, "actor_second_step": true, "on": true}); code != 200 || out["features"].([]any)[0].(map[string]any)["on"] != true {
		t.Fatalf("the owner switches it: %d %v", code, out)
	}
	if _, out := h.call(authToken, "GET", "/v1/orgs/"+org1, nil); len(out["features"].([]any)) != 1 {
		t.Fatalf("the workspace's switches: %v", out)
	}
}
