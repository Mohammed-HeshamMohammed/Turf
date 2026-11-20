package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The dialer's private door: each outcome the dialer sends (services/features/dialer-sms, scenarios.go) does to the lead what
// the same outcome logged by hand does, once per call however often it is sent.
func TestTheDialerLogsCarrierCallsAsThePersonWhoMadeThem(t *testing.T) {
	e := newEnv(t)
	alice, org := newID(t), newID(t)
	e.rules.grants[alice+"|"+org] = owner()
	const token = "dialer-token-dialer-token-dialer-token"
	e.s.cfg.dialerToken = token
	door := httptest.NewServer(e.s.handler())
	defer door.Close()
	post := func(path, tok string, body map[string]any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", door.URL+path, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	lead := func(phone string) string {
		id := newID(t)
		e.want(e.op(alice, org, "lead.create", map[string]any{"id": id, "name": "Lead " + phone, "phone": phone}), "applied")
		return id
	}
	who := map[string]any{"org_id": org, "user_id": alice}
	with := func(extra map[string]any) map[string]any {
		m := map[string]any{}
		for k, v := range who {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	record := func(leadID, opID, outcome string, extra map[string]any) map[string]any {
		payload := map[string]any{"lead_id": leadID, "outcome": outcome, "source": "telnyx-sim", "source_record_id": "session-" + opID[:8],
			"occurred_at": time.Now().UTC().Format(time.RFC3339), "details": map[string]any{"talk_seconds": 45, "simulated": true}}
		for k, v := range extra {
			payload[k] = v
		}
		status, out := post("/internal/v1/dialer/calls", token, with(map[string]any{"operation_id": opID, "payload": payload}))
		if status != 200 {
			t.Fatalf("record %s: %d %v", outcome, status, out)
		}
		return out
	}
	leadRow := func(id string) map[string]any {
		var m map[string]any
		_ = e.admin.QueryRow(context.Background(), `SELECT to_jsonb(l) FROM crm.leads l WHERE id = $1`, id).Scan(&m)
		return m
	}

	a := lead("(512) 555-0101")
	if status, _ := post("/internal/v1/dialer/lead", "wrong", with(map[string]any{"lead_id": a})); status != 401 {
		t.Fatalf("no token: %d", status)
	}
	if status, out := post("/internal/v1/dialer/lead", token, with(map[string]any{"lead_id": a})); status != 200 || out["may_call"] != true || out["phone"] != "(512) 555-0101" {
		t.Fatalf("lead: %d %v", status, out)
	}
	// For the lead's text thread (step 10): who works it, its team's leads (the owner when it has none) and the asker's rank.
	g := e.rules.grants[alice+"|"+org]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+org] = g
	if _, out := post("/internal/v1/dialer/lead", token, with(map[string]any{"lead_id": a})); out["rank"] != "owner" || out["team_leads"] == nil || out["team_deputies"] == nil {
		t.Fatalf("thread facts: %v", out)
	}
	if _, out := post("/internal/v1/dialer/find-lead", token, with(map[string]any{"phone": "+15125550101"})); out["found"] != true || out["lead_id"] != a {
		t.Fatalf("find by number: %v", out)
	}

	// Voicemail: a try-again task tomorrow, the carrier's facts kept, and the same call sent again is one call.
	call := newID(t)
	if out := record(a, call, "Voicemail", nil); out["status"] != "applied" {
		t.Fatalf("voicemail: %v", out)
	}
	if out := record(a, call, "Voicemail", nil); out["status"] != "duplicate" {
		t.Fatalf("again: %v", out)
	}
	var n int
	var details map[string]any
	var source, recordID string
	_ = e.admin.QueryRow(context.Background(), `SELECT count(*), max(source), max(source_record_id), (array_agg(details))[1] FROM crm.call_events WHERE lead_id = $1`, a).Scan(&n, &source, &recordID, &details)
	if n != 1 || source != "telnyx-sim" || recordID == "" || details["talk_seconds"] != float64(45) {
		t.Fatalf("call row: %d %s %s %v", n, source, recordID, details)
	}
	// A recording saved after the call was logged is added to it.
	status, out := post("/internal/v1/dialer/recording", token, with(map[string]any{"operation_id": newID(t), "payload": map[string]any{"call_operation_id": call, "recording_url": "https://sim.example/r.mp3"}}))
	if status != 200 || out["status"] != "applied" {
		t.Fatalf("recording: %d %v", status, out)
	}
	_ = e.admin.QueryRow(context.Background(), `SELECT details FROM crm.call_events WHERE operation_id = $1`, call).Scan(&details)
	if details["recording_url"] != "https://sim.example/r.mp3" {
		t.Fatalf("recording not added: %v", details)
	}
	// A device cannot send the dialer's own operation.
	if out := e.op(alice, org, "call.recording", map[string]any{"call_operation_id": call, "recording_url": "https://x.example/a.mp3"}); out["status"] != "rejected" {
		t.Fatalf("device sent call.recording: %v", out)
	}

	cases := []struct {
		outcome, stage, verdict string
		dnc                     bool
		extra                   map[string]any
	}{
		{"Reached", "Contacted", "", false, nil},
		{"Callback", "Contacted", "", false, map[string]any{"callback_at": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)}},
		{"Transfer", "Qualified", "", false, nil},
		{"No answer", "New", "", false, nil},
		{"Not available", "New", "", false, nil},
		{"Dead call", "New", "", false, nil},
		{"Disconnected", "New", "Disconnected", false, nil},
		{"Wrong number", "New", "Wrong number", false, nil},
		{"Do not call", "Closed", "Do not call", true, nil},
	}
	for _, c := range cases {
		id := lead("+1512555" + "0200")
		if out := record(id, newID(t), c.outcome, c.extra); out["status"] != "applied" {
			t.Fatalf("%s: %v", c.outcome, out)
		}
		l := leadRow(id)
		if l["stage"] != c.stage || (c.verdict != "" && l["verdict"] != c.verdict) || l["do_not_call"] != c.dnc {
			t.Fatalf("%s: stage %v verdict %v dnc %v", c.outcome, l["stage"], l["verdict"], l["do_not_call"])
		}
		if c.outcome == "Callback" && l["next_action"] != "Callback" {
			t.Fatalf("callback: %v", l)
		}
		if c.outcome == "Do not call" {
			if _, out := post("/internal/v1/dialer/lead", token, with(map[string]any{"lead_id": id})); out["may_call"] != false {
				t.Fatalf("a do-not-call lead may still be called: %v", out)
			}
			if out := record(id, newID(t), "Reached", nil); out["status"] != "rejected" {
				t.Fatalf("logged a call on a do-not-call lead: %v", out)
			}
		}
	}
	// Someone not in the workspace (or removed) cannot have calls logged.
	if status, _ := post("/internal/v1/dialer/calls", token, map[string]any{"org_id": org, "user_id": newID(t), "operation_id": newID(t), "payload": map[string]any{"lead_id": a, "outcome": "Reached"}}); status != 403 {
		t.Fatalf("stranger: %d", status)
	}
}
