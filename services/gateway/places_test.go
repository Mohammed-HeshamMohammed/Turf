package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Step 35, D243: requests inside an agency come only from its countries and office networks; its owner is never limited; requests
// outside an agency, and agencies without rules, go on; the rules are read at most once a minute.
func TestAgencyPlaceLimits(t *testing.T) {
	const org = "aaaaaaaa-0000-4000-8000-0000000000aa"
	var asked atomic.Int32
	authz := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		if r.Header.Get("Authorization") != "Bearer gateway-token" || r.URL.Path != "/v1/orgs/"+org+"/access-limits" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"countries": []string{"US"}, "networks": []string{"203.0.113.0/24"}, "exempt": []string{"owner-1"}})
	}))
	defer authz.Close()
	w := newWorld(t, map[string]string{"AUTHZ_URL": authz.URL, "AUTHZ_TOKEN": "gateway-token"})
	inAgency := func(country, ip string) func(*http.Request) {
		return func(r *http.Request) {
			r.Header.Set("x-callerwhale-org", org)
			r.Header.Set("CF-IPCountry", country)
			r.Header.Set("X-Forwarded-For", ip)
		}
	}
	member := w.token(nil)
	if rec := w.do(appHost, "GET", "/api/v1/leads/search", member, inAgency("US", "203.0.113.7")); rec.Code != 200 {
		t.Fatalf("from the office: %d %s", rec.Code, rec.Body)
	}
	if rec := w.do(appHost, "GET", "/api/v1/leads/search", member, inAgency("FR", "203.0.113.7")); rec.Code != 403 {
		t.Fatalf("from another country: %d", rec.Code)
	}
	if rec := w.do(appHost, "GET", "/api/v1/leads/search", member, inAgency("US", "198.51.100.4")); rec.Code != 403 {
		t.Fatalf("from another network: %d", rec.Code)
	}
	owner := w.token(func(c map[string]any) { c["sub"] = "owner-1" })
	if rec := w.do(appHost, "GET", "/api/v1/leads/search", owner, inAgency("FR", "198.51.100.4")); rec.Code != 200 {
		t.Fatalf("the owner from anywhere: %d", rec.Code)
	}
	if rec := w.do(appHost, "GET", "/api/v1/me", member, func(r *http.Request) { r.Header.Set("CF-IPCountry", "FR") }); rec.Code != 200 {
		t.Fatalf("a request outside an agency: %d", rec.Code)
	}
	if n := asked.Load(); n != 1 {
		t.Fatalf("authz was asked %d times", n)
	}
}
