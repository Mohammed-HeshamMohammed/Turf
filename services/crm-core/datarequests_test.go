package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Step 44: a person's data request finds every record about them by number and email, exports it, and (the owner, with the second
// step) deletes it; the number and email stay blocked as "deleted on request", another person is untouched, and the dialer is told
// to remove its calls and texts (D310, D367).
func TestDataRequestFindsExportsAndDeletes(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	g := owner()
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	pat, other := newID(t), newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": pat, "name": "Pat Private", "phone": "(512) 555-4401", "email": "Pat@Example.test"}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": other, "name": "Someone Else", "phone": "512-555-4402"}), "applied")
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.notes (org_id, lead_id, body) VALUES ($1, $2, 'Wants to sell in spring')`, orgA, pat); err != nil {
		t.Fatal(err)
	}
	e.raw(alice, orgA, "POST", "/api/v1/leads/"+pat+"/files?name=deed.pdf", []byte("%PDF-1.7 deed"), http.Header{"Content-Type": {"application/pdf"}})

	if code, _ := e.call(bob, orgA, "POST", "/api/v1/data-requests", map[string]any{"kind": "access", "phone": "512-555-4401", "received_on": "2026-11-17"}); code != 403 {
		t.Fatalf("a caller enters a request: %d", code)
	}
	// A copy of their data: everything about them, nothing about anyone else.
	code, asked := e.call(alice, orgA, "POST", "/api/v1/data-requests", map[string]any{"kind": "access", "name": "Pat", "email": "pat@example.test", "received_on": "2026-11-17"})
	if code != 201 || len(asked["leads"].([]any)) != 1 {
		t.Fatalf("access request: %d %v", code, asked)
	}
	status, raw := e.raw(alice, orgA, "GET", "/api/v1/data-requests/"+asked["id"].(string)+"/export", nil, nil)
	if status != 200 || !bytes.Contains(raw, []byte("Wants to sell in spring")) || !bytes.Contains(raw, []byte("deed.pdf")) || bytes.Contains(raw, []byte("Someone Else")) || bytes.Contains(raw, []byte("%PDF")) {
		t.Fatalf("export: %d %.400s", status, raw)
	}

	// Deleting: entered by the owner, carried out with the second step.
	code, del := e.call(alice, orgA, "POST", "/api/v1/data-requests", map[string]any{"kind": "delete", "name": "Pat Private", "phone": "512.555.4401", "email": "pat@example.test", "received_on": "2026-11-18"})
	if code != 201 {
		t.Fatalf("delete request: %d %v", code, del)
	}
	id := del["id"].(string)
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/data-requests/"+id+"/delete", map[string]any{}); code != 400 {
		t.Fatalf("deleted without confirming: %d", code)
	}
	noStep := func() (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"confirm": true})
		req, _ := http.NewRequest("POST", e.ts.URL+"/api/v1/data-requests/"+id+"/delete", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+e.fx.Sign("k1", "EdDSA", func(m map[string]any) { m["sub"], m["mfa"] = alice, false }))
		req.Header.Set("x-callerwhale-org", orgA)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := noStep(); code != 403 {
		t.Fatalf("deleted without the second step: %d", code)
	}
	code, done := e.call(alice, orgA, "POST", "/api/v1/data-requests/"+id+"/delete", map[string]any{"confirm": true})
	if code != 200 || done["status"] != "deleted" {
		t.Fatalf("delete: %d %v", code, done)
	}
	var leads, notes, files int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE id = $1`, pat).Scan(&leads)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1`, pat).Scan(&notes)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.lead_files WHERE lead_id = $1`, pat).Scan(&files)
	if leads+notes+files != 0 {
		t.Fatalf("left behind: leads %d notes %d files %d", leads, notes, files)
	}
	var others int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE id = $1`, other).Scan(&others)
	if others != 1 {
		t.Fatal("another person's lead was deleted")
	}
	var reason, name string
	var unsubscribed, queued int
	_ = e.admin.QueryRow(ctx, `SELECT reason FROM crm.number_blocks WHERE org_id = $1 AND phone_key = '5125554401' AND lifted_at IS NULL`, orgA).Scan(&reason)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.email_unsubscribes WHERE org_id = $1 AND address = 'pat@example.test'`, orgA).Scan(&unsubscribed)
	_ = e.admin.QueryRow(ctx, `SELECT name FROM crm.data_requests WHERE id = $1`, id).Scan(&name)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.dialer_erasures WHERE request_id = $1`, id).Scan(&queued)
	if reason != "deleted_on_request" || unsubscribed != 1 || name != "" || queued != 1 {
		t.Fatalf("after deleting: block %q, unsubscribed %d, name kept %q, dialer told %d", reason, unsubscribed, name, queued)
	}
	// A new lead with that number comes in blocked, with the reason.
	newLead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": newLead, "name": "Again", "phone": "512-555-4401"}), "applied")
	var dnc bool
	_ = e.admin.QueryRow(ctx, `SELECT do_not_call FROM crm.leads WHERE id = $1`, newLead).Scan(&dnc)
	if !dnc {
		t.Fatal("the number can be called again")
	}

	// The dialer collects its part and says when it is done.
	const token = "dialer-token-dialer-token-dialer-token"
	e.s.cfg.dialerToken = token
	dialer := func(method, path string) map[string]any {
		req, _ := http.NewRequest(method, e.ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return out
	}
	list := dialer("GET", "/internal/v1/dialer/erasures")["erasures"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["phone_key"] != "5125554401" {
		t.Fatalf("the dialer's list: %v", list)
	}
	dialer("POST", "/internal/v1/dialer/erasures/"+id+"/done")
	_, all := e.call(alice, orgA, "GET", "/api/v1/data-requests", nil)
	var mine map[string]any
	for _, r := range all["requests"].([]any) {
		if r.(map[string]any)["id"] == id {
			mine = r.(map[string]any)
		}
	}
	if mine == nil || mine["dialer_erased_at"] == nil || !strings.Contains(mustString(mine["status"]), "deleted") {
		t.Fatalf("the record: %v", mine)
	}
}

func mustString(v any) string { s, _ := v.(string); return s }
