package main

import (
	"slices"
	"testing"
)

// Step 19: support access. Staff get into an agency only while its owner allows it, with their second step, to see it and change its
// rules; never to edit, export, message or pay (D83, D202). Each visit is recorded, and the owner can end it early.
func TestSupportAccess(t *testing.T) {
	h := newHarness(t)
	h.opened()
	staff := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	h.mem.staff[staff] = "owner"
	grant := func(action string, second bool) map[string]any {
		_, out := h.call(coreToken, "POST", "/v1/grant", map[string]any{"user_id": staff, "org_id": org1, "action": action, "second_step_passed": second})
		return out
	}
	if out := grant("read", true); out["code"] != "not_member" {
		t.Fatalf("staff without the owner's leave: %v", out)
	}
	if code, out := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/support", map[string]any{"hours": 100, "actor_id": ownerID}); code != 400 {
		t.Fatalf("more than 72 hours: %d %v", code, out)
	}
	if code, out := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/support", map[string]any{"actor_id": ownerID}); code != 200 || out["until"] == nil {
		t.Fatalf("allow support: %d %v", code, out)
	}
	if out := grant("read", false); out["code"] != "second_step_required" {
		t.Fatalf("support without the second step: %v", out)
	}
	if out := grant("read", true); out["allowed"] != true || !slices.Equal(list(out["roles"]), []string{"support"}) || !slices.Equal(list(out["scopes"]), []string{"organization"}) {
		t.Fatalf("support reads the whole agency: %v", out)
	}
	if out := grant("rules", true); out["allowed"] != true {
		t.Fatalf("support changes the rules: %v", out)
	}
	for _, action := range []string{"edit", "export", "message", "pay", "admin", "import"} {
		if out := grant(action, true); out["allowed"] != false {
			t.Fatalf("support may not %s: %v", action, out)
		}
	}
	if _, out := h.call(authToken, "GET", "/v1/people/"+staff, nil); len(out["workspaces"].([]any)) != 1 {
		t.Fatalf("staff see the agency they may support: %v", out)
	}
	if _, out := h.call(authToken, "GET", "/v1/support", nil); len(out["agencies"].([]any)) != 1 {
		t.Fatalf("the staff list: %v", out)
	}
	h.call(authToken, "DELETE", "/v1/orgs/"+org1+"/support", map[string]any{"actor_id": ownerID})
	if out := grant("read", true); out["code"] != "not_member" {
		t.Fatalf("after the owner ended it: %v", out)
	}
	actions := []string{}
	for _, e := range h.mem.log[org1] {
		actions = append(actions, e.Action)
	}
	for _, want := range []string{"support_granted", "support_visited", "support_ended"} {
		if !slices.Contains(actions, want) {
			t.Fatalf("the record has %s: %v", want, actions)
		}
	}
}
