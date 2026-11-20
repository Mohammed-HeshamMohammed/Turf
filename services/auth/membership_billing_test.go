package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The limits staff choose reach billing as they were given (a number, or null for unlimited), with who gave them.
func TestAMembershipSendsItsLimitsToBilling(t *testing.T) {
	var got map[string]any
	var auth string
	billing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if r.Method != http.MethodPut || r.URL.Path != "/v1/admin/orgs/org-1/membership" {
			t.Errorf("billing was asked %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"plan":"team","limits":{"seats":8}}`))
	}))
	defer billing.Close()
	s := &server{cfg: config{billingURL: billing.URL, billingToken: "billing-token"}}
	eight := int64(8)
	body := membershipBody{UserID: "7b0f8f0e-1f0a-4e0b-9d57-0a8d1c0a0001", Plan: "team", Payment: "free", Limits: map[string]*int64{"seats": &eight, "monthly_minutes": nil}}
	if problem := checkMembership(&body); problem != nil {
		t.Fatal(problem)
	}
	out, err := s.billingAssign(context.Background(), "org-1", body, "cofounder@example.com")
	if err != nil {
		t.Fatal(err)
	}
	limits, _ := got["limits"].(map[string]any)
	if auth != "Bearer billing-token" || got["plan"] != "team" || got["set_by"] != "cofounder@example.com" || limits["seats"] != float64(8) {
		t.Fatalf("billing got %v (auth %q)", got, auth)
	}
	if v, ok := limits["monthly_minutes"]; !ok || v != nil {
		t.Fatalf("unlimited minutes must be sent as null, got %v", limits)
	}
	if out["plan"] != "team" {
		t.Fatalf("billing's answer was not passed on: %v", out)
	}
}
