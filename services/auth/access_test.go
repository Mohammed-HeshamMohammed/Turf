package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadAccessOnlyReturnsTheRequestedPerson(t *testing.T) {
	const user = "22222222-2222-4222-8222-222222222222"
	other := user
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/people/"+user || r.Header.Get("Authorization") != "Bearer server-token" {
			t.Errorf("unexpected authz request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "refused", http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"user_id":"` + other + `","platform_role":"cofounder","workspaces":[]}`))
	}))
	defer srv.Close()
	profile, err := readAccess(context.Background(), srv.URL, "server-token", user)
	if err != nil || profile.PlatformRole != "cofounder" || len(profile.Workspaces) != 0 {
		t.Fatalf("own profile: %+v %v", profile, err)
	}
	other = "33333333-3333-4333-8333-333333333333"
	if _, err := readAccess(context.Background(), srv.URL, "server-token", user); !errors.Is(err, errAccessUnavailable) {
		t.Fatalf("another person's profile was accepted: %v", err)
	}
}
