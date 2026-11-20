package main

import "testing"

// Step 19: only the owner lets support in, with their second step, and can end it; staff see which agencies let them in (D83).
func TestOwnerLetsSupportIn(t *testing.T) {
	w, fake, _ := lifecycleWorld(t)
	boss := w.stepped("boss@example.com").access()
	caller := w.confirmed("caller@example.com").access()
	fake.mu.Lock()
	fake.owner = w.idOf("boss@example.com")
	fake.joined[w.idOf("caller@example.com")] = true
	fake.mu.Unlock()
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/support", map[string]any{"hours": 24}, caller); a.status != 403 {
		t.Fatalf("a caller lets support in: %d", a.status)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/support", map[string]any{"hours": 24}, boss); a.status != 200 || a.body["until"] == nil {
		t.Fatalf("allow: %d %v", a.status, a.body)
	}
	staff := w.stepped("staff@example.com").access()
	fake.mu.Lock()
	fake.staff = w.idOf("staff@example.com")
	fake.mu.Unlock()
	if a := w.call("GET", "/v1/admin/support", nil, staff); a.status != 200 || len(a.body["agencies"].([]any)) != 1 {
		t.Fatalf("staff see it: %d %v", a.status, a.body)
	}
	if a := w.call("GET", "/v1/admin/support", nil, boss); a.status != 403 {
		t.Fatalf("someone who is not staff lists it: %d", a.status)
	}
	if a := w.call("DELETE", "/v1/orgs/"+flowOrg+"/support", nil, boss); a.status != 200 || a.body["until"] != nil {
		t.Fatalf("end it early: %d %v", a.status, a.body)
	}
}
