package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// rolesAuthz answers /v1/people/{user} with the platform role the test gives each person.
type rolesAuthz struct {
	mu    sync.Mutex
	roles map[string]string
}

func (f *rolesAuthz) serve(w http.ResponseWriter, r *http.Request) {
	user := strings.TrimPrefix(r.URL.Path, "/v1/people/")
	f.mu.Lock()
	role := f.roles[user]
	f.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"user_id": user, "platform_role": role, "workspaces": []any{}})
}

func (f *rolesAuthz) set(user, role string) {
	f.mu.Lock()
	f.roles[user] = role
	f.mu.Unlock()
}

func TestOnlyTheOwnerAndCofounderCarryOwnerAndCoOwner(t *testing.T) {
	fake := &rolesAuthz{roles: map[string]string{}}
	authz := httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(authz.Close)
	w := newWorld(t, func(c *config) { c.authzURL = authz.URL; c.authzToken = "token" })
	owner := w.confirmed("owner@example.com").access()
	cofounder := w.confirmed("cofounder@example.com").access()
	someone := w.confirmed("someone@example.com").access()
	fake.set(w.idOf("owner@example.com"), "owner")
	fake.set(w.idOf("cofounder@example.com"), "cofounder")
	tagOf := func(token string) string { return w.call("GET", "/v1/me", nil, token).str("tag") }

	// Their tag follows the role as soon as their access is read.
	for _, token := range []string{owner, cofounder, someone} {
		if a := w.call("GET", "/v1/me/access", nil, token); a.status != 200 {
			t.Fatalf("access: %d %v", a.status, a.body)
		}
	}
	if tagOf(owner) != "Owner" || tagOf(cofounder) != "Co-Owner" || isFounderTag(tagOf(someone)) {
		t.Fatalf("tags: %q %q %q", tagOf(owner), tagOf(cofounder), tagOf(someone))
	}

	// Nobody can choose them, and the founders cannot give theirs up.
	for _, tag := range []string{"Owner", "OWNER", "#Co-Owner", "CO-OWNER"} {
		if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": tag}, someone); a.status != 400 {
			t.Fatalf("someone chose %s: %d", tag, a.status)
		}
	}
	if a := w.call("POST", "/v1/me/tag", map[string]any{"tag": "K7P2"}, owner); a.status != 403 || tagOf(owner) != "Owner" {
		t.Fatalf("the owner changed theirs: %d", a.status)
	}

	// The database refuses them to anything but the founder step, and a second holder even then.
	ctx := context.Background()
	if _, err := w.s.db.Exec(ctx, "UPDATE users SET tag = 'Owner' WHERE email = 'someone@example.com'"); err == nil {
		t.Fatal("the database let another person be #Owner")
	}
	fake.set(w.idOf("someone@example.com"), "owner") // a mistake in authz's setup
	w.call("GET", "/v1/me/access", nil, someone)
	if isFounderTag(tagOf(someone)) {
		t.Fatal("two people were #Owner")
	}

	// A full Name#Owner finds the owner, whatever the letter case.
	name := w.call("GET", "/v1/me", nil, owner).str("name")
	found := w.call("GET", "/v1/people/search?q="+strings.ReplaceAll(name, " ", "+")+"%23owner", nil, someone)
	if people, _ := found.body["people"].([]any); found.status != 200 || len(people) != 1 {
		t.Fatalf("search: %d %v", found.status, found.body)
	}

	// Without the role, the tag goes and a new random one comes.
	fake.set(w.idOf("cofounder@example.com"), "")
	w.call("GET", "/v1/me/access", nil, cofounder)
	if after := tagOf(cofounder); isFounderTag(after) || !tagPattern.MatchString(after) {
		t.Fatalf("after the role went: %q", after)
	}
}

// staffAuthz is rolesAuthz that also takes staff changes (PUT /v1/staff/{user}) and remembers them.
type staffAuthz struct {
	rolesAuthz
	given map[string]string
}

func (f *staffAuthz) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/v1/staff/") {
		var body struct {
			Role string `json:"role"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.given[strings.TrimPrefix(r.URL.Path, "/v1/staff/")] = body.Role
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		return
	}
	f.rolesAuthz.serve(w, r)
}

func TestTheDashboardGivesSystemAdminAndTester(t *testing.T) {
	fake := &staffAuthz{rolesAuthz: rolesAuthz{roles: map[string]string{}}, given: map[string]string{}}
	authz := httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(authz.Close)
	w := newWorld(t, func(c *config) { c.authzURL = authz.URL; c.authzToken = "token" })
	owner := w.stepped("owner@example.com").access()
	w.confirmed("helper@example.com")
	fake.set(w.idOf("owner@example.com"), "owner")
	helper := w.idOf("helper@example.com")

	for _, role := range []string{"system_admin", "tester", ""} {
		if a := w.call("POST", "/v1/admin/staff", map[string]any{"email": "helper@example.com", "role": role}, owner); a.status != 200 {
			t.Fatalf("%q: %d %v", role, a.status, a.body)
		}
		if fake.given[helper] != role {
			t.Fatalf("authz was asked for %q, not %q", fake.given[helper], role)
		}
	}
	for _, role := range []string{"owner", "cofounder", "admin"} {
		if a := w.call("POST", "/v1/admin/staff", map[string]any{"email": "helper@example.com", "role": role}, owner); a.status != 400 {
			t.Fatalf("%q given: %d", role, a.status)
		}
	}
}
