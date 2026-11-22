package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// Step 34: the public status from staff incidents and automatic checks, the banner while something is wrong, emails to people who
// chose them (D235); breach notices emailed to each agency's owner, with whether they went within 72 hours (D236).
func TestStatusAndBreachNotices(t *testing.T) {
	w, fake, owner := lifecycleWorld(t)
	staffTok := w.stepped("staff@example.com").access()
	fake.mu.Lock()
	fake.staff = w.idOf("staff@example.com")
	fake.mu.Unlock()
	state := func() (map[string]string, any) {
		a := w.call("GET", "/v1/status", nil, "")
		got := map[string]string{}
		for _, p := range a.body["parts"].([]any) {
			p := p.(map[string]any)
			got[p["id"].(string)] = p["state"].(string)
		}
		return got, a.body["banner"]
	}
	if s, banner := state(); s["calls"] != "up" || banner != nil {
		t.Fatalf("at rest: %v %v", s, banner)
	}
	if a := w.call("POST", "/v1/admin/status/incidents", map[string]any{"components": []string{"calls"}, "severity": "down", "title": "Calls are down"}, owner); a.status != 403 {
		t.Fatalf("an agency owner opens an incident: %d", a.status)
	}
	if a := w.call("PUT", "/v1/me/status-emails", map[string]any{"on": true}, owner); a.status != 200 || a.body["on"] != true {
		t.Fatalf("subscribe: %d %v", a.status, a.body)
	}
	opened := w.call("POST", "/v1/admin/status/incidents", map[string]any{"components": []string{"calls", "texts"}, "severity": "down", "title": "Calls and texts are down", "message": "The carrier is down."}, staffTok)
	if opened.status != 200 {
		t.Fatalf("open: %d %v", opened.status, opened.body)
	}
	if s, banner := state(); s["calls"] != "down" || s["texts"] != "down" || s["crm"] != "up" || banner == nil {
		t.Fatalf("while down: %v %v", s, banner)
	}
	w.call("POST", "/v1/admin/status/incidents/"+opened.str("id"), map[string]any{"message": "Back to normal.", "resolved": true}, staffTok)
	if s, banner := state(); s["calls"] != "up" || banner != nil {
		t.Fatalf("after: %v %v", s, banner)
	}
	w.mail.mu.Lock()
	statusMails := 0
	for i, tpl := range w.mail.templates {
		if tpl == "status" {
			statusMails++
			_ = i
		}
	}
	w.mail.mu.Unlock()
	if statusMails != 2 {
		t.Fatalf("status emails (opened and resolved): %d", statusMails)
	}

	// Automatic checks come from the monitoring stack: a part whose health address it reports down shows down, since then.
	if _, err := parseProbes("calls=ftp://x"); err == nil {
		t.Fatal("a bad probe address was taken")
	}
	chatsUp := true
	monitoring := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(rw).Encode(map[string]any{"probes": []map[string]any{
			{"target": "http://messaging:8108/healthz", "up": chatsUp, "since": 1_800_000_000},
			{"target": "http://crm-core:8107/healthz", "up": true},
		}})
	}))
	defer monitoring.Close()
	probes, _ := parseProbes("chats=http://messaging:8108/healthz,crm=http://crm-core:8107/healthz")
	w.s.probes = newProbeSource(monitoring.URL, probes)
	if s, _ := state(); s["chats"] != "up" {
		t.Fatalf("all answering: %v", s)
	}
	chatsUp = false
	w.s.probes = newProbeSource(monitoring.URL, probes) // a fresh copy (the last one is kept 15 seconds)
	if s, _ := state(); s["chats"] != "down" || s["crm"] != "up" {
		t.Fatalf("chats down: %v", s)
	}
	// The monitoring stack unreachable: incidents only, nothing invented.
	w.s.probes = newProbeSource("http://127.0.0.1:1", probes)
	if s, _ := state(); s["chats"] != "up" {
		t.Fatalf("monitoring unreachable: %v", s)
	}
	w.s.probes = nil

	// Breach notices.
	if a := w.call("POST", "/v1/admin/breach-notices", map[string]any{"org_ids": []string{flowOrg}, "discovered_at": now() - 3600, "what": "x", "to_do": "y"}, owner); a.status != 403 {
		t.Fatalf("an agency owner sends a breach notice: %d", a.status)
	}
	sent := w.call("POST", "/v1/admin/breach-notices", map[string]any{"org_ids": []string{flowOrg}, "discovered_at": now() - 3600,
		"what": "A service key was exposed for two hours.", "to_do": "Sign in again; no action is needed on your leads."}, staffTok)
	if sent.status != 200 {
		t.Fatalf("notice: %d %v", sent.status, sent.body)
	}
	n := sent.body["notices"].([]any)[0].(map[string]any)
	if n["sent"] != true || n["within_72_hours"] != true {
		t.Fatalf("the notice: %v", n)
	}
	w.mail.mu.Lock()
	gotNotice := slices.Contains(w.mail.templates, "breach_notice") && slices.Contains(w.mail.to, "owner@example.com")
	w.mail.mu.Unlock()
	if !gotNotice {
		t.Fatal("the owner was not emailed")
	}
	if listed := w.call("GET", "/v1/admin/breach-notices", nil, staffTok); len(listed.body["notices"].([]any)) != 1 {
		t.Fatalf("the record: %v", listed.body)
	}
}
