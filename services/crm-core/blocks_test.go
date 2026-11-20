package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Step 25: a number that asked the agency to stop is blocked for every lead, team and later lead of the agency, and only the owner or
// an admin lifts it, with a reason (D139, D207); "no calls from anyone" goes to Caller Whale's database for every agency at once, a
// complainer once a second agency reports it, and only staff take a number out, after an agency asks (D141, D351).
func TestDoNotCallByNumber(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	lead := func(user, org, phone string) string {
		id := newID(t)
		e.want(e.op(user, org, "lead.create", map[string]any{"id": id, "name": "Lead " + phone, "phone": phone}), "applied")
		return id
	}
	dnc := func(id string) bool {
		var v bool
		if err := e.admin.QueryRow(ctx, `SELECT do_not_call FROM crm.leads WHERE id = $1`, id).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	// The agency's own list: marking one lead blocks its number for the agency's other leads and for leads added later.
	first, twin := lead(alice, orgA, "(512) 555-0101"), lead(alice, orgA, "512-555-0101")
	e.want(e.op(alice, orgA, "lead.update", map[string]any{"id": first, "changes": map[string]any{"do_not_call": true}}), "applied")
	if !dnc(twin) {
		t.Fatal("the same number's other lead is not do-not-call")
	}
	if later := lead(alice, orgA, "+1 512 555 0101"); !dnc(later) {
		t.Fatal("a lead added later with a blocked number can be called")
	}
	if other := lead(carol, orgB, "5125550101"); dnc(other) {
		t.Fatal("one agency's stop blocked another agency")
	}
	e.want(e.op(alice, orgA, "lead.update", map[string]any{"id": twin, "changes": map[string]any{"do_not_call": false}}), "rejected")
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/blocks/lift", map[string]any{"phone": "5125550101", "reason": "Asked us to call again"}); status != 403 {
		t.Fatalf("a caller lifts a block: %d", status)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/blocks/lift", map[string]any{"phone": "5125550101"}); status != 400 {
		t.Fatalf("lifted without a reason: %d", status)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/blocks/lift", map[string]any{"phone": "5125550101", "reason": "They asked us to call again"}); status != 200 || dnc(twin) {
		t.Fatalf("lift: %d, still do-not-call %v", status, dnc(twin))
	}
	_, list := e.call(alice, orgA, "GET", "/api/v1/blocks", nil)
	if b := list["blocks"].([]any); len(b) != 1 || b[0].(map[string]any)["lift_reason"] != "They asked us to call again" {
		t.Fatalf("the record of who marked and lifted: %v", list)
	}

	// A stop for texts only leaves calls open.
	if status, out := e.call(bob, orgA, "POST", "/api/v1/blocks", map[string]any{"phone": "5125550102", "texts": true, "source": "text"}); status != 200 || out["texts"] != true || out["calls"] != false {
		t.Fatalf("texts only: %d %v", status, out)
	}

	// Caller Whale's database: "no calls from anyone", confirmed by the agent on a call, blocks every agency at once.
	anyone := lead(bob, orgA, "512-555-0103")
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": anyone, "outcome": "Do not call", "dnc_kind": "anyone"}), "applied")
	elsewhere := lead(carol, orgB, "5125550103")
	if !dnc(elsewhere) {
		t.Fatal("a number that wants no calls from anyone reached another agency")
	}
	if _, out := e.call(carol, orgB, "GET", "/api/v1/blocks/check?phone=5125550103", nil); out["shared"] != true || out["calls"] != true {
		t.Fatalf("the other agency's check: %v", out)
	}

	// A complainer waits for a second agency.
	if _, out := e.call(alice, orgA, "POST", "/api/v1/blocks", map[string]any{"phone": "5125550104", "kind": "complainer"}); out["shared"] == true {
		t.Fatal("one agency's report confirmed a complainer")
	}
	if _, out := e.call(carol, orgB, "GET", "/api/v1/blocks/check?phone=5125550104", nil); out["calls"] == true {
		t.Fatal("an unconfirmed complainer blocks another agency")
	}
	if _, out := e.call(carol, orgB, "POST", "/api/v1/blocks", map[string]any{"phone": "5125550104", "kind": "complainer"}); out["shared"] != true {
		t.Fatalf("a second agency's report: %v", out)
	}

	// Only staff remove; the agency asks for a review with a reason; the removal is kept.
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/blocks/review", map[string]any{"phone": "5125550103", "reason": "Wrong person marked"}); status != 200 {
		t.Fatalf("review: %d", status)
	}
	if status, _ := e.call(alice, "", "GET", "/api/v1/platform/do-not-call", nil); status != 403 {
		t.Fatalf("an agency owner reads the staff list: %d", status)
	}
	staffer := newID(t)
	e.rules.people_[staffer] = peopleReply{UserID: staffer, PlatformRole: "support"}
	status, waiting := e.call(staffer, "", "GET", "/api/v1/platform/do-not-call", nil)
	reviews, _ := waiting["reviews"].([]any)
	if status != 200 || len(reviews) != 1 {
		t.Fatalf("staff see the review: %d %v", status, waiting)
	}
	block := reviews[0].(map[string]any)["block_id"].(string)
	if status, _ := e.call(staffer, "", "POST", "/api/v1/platform/do-not-call/"+block+"/remove", map[string]any{"reason": "The agent marked the wrong lead"}); status != 200 {
		t.Fatalf("remove: %d", status)
	}
	if _, out := e.call(carol, orgB, "GET", "/api/v1/blocks/check?phone=5125550103", nil); out["shared"] == true {
		t.Fatal("a removed number still blocks")
	}
	var why string
	if err := e.admin.QueryRow(ctx, `SELECT remove_reason FROM crm.shared_blocks WHERE id = $1`, block).Scan(&why); err != nil || why == "" {
		t.Fatalf("the removal is kept: %q %v", why, err)
	}
	// The agency's own block on that number stays: it asked this agency too.
	if _, out := e.call(alice, orgA, "GET", "/api/v1/blocks/check?phone=5125550103", nil); out["calls"] != true {
		t.Fatal("removing from the database lifted the agency's own block")
	}

	// A list's consent to text, confirmed by whoever imports (D355).
	_, proj := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": "Consented list"})
	if status, out := e.call(alice, orgA, "POST", "/api/v1/projects/"+proj["id"].(string)+"/text-consent", map[string]any{"confirm": true}); status != 200 || out["text_consent_at"] == nil {
		t.Fatalf("list consent: %d %v", status, out)
	}
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/projects/"+proj["id"].(string)+"/text-consent", map[string]any{"confirm": true}); status != 403 {
		t.Fatalf("a caller confirms consent: %d", status)
	}
}

// The dialer's side (step 25): a lead's opt-out reply blocks the number as the lead's doing, START lifts only that, and the dialer is
// told calls and texts apart, with list consent (D207, D209, D355).
func TestTheDialerBlocksAndAsksByNumber(t *testing.T) {
	e := newEnv(t)
	e.seed()
	const token = "dialer-token-dialer-token-dialer-token"
	e.s.cfg.dialerToken = token
	door := httptest.NewServer(e.s.handler())
	defer door.Close()
	post := func(path string, body map[string]any) map[string]any {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", door.URL+path, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		if res.StatusCode != 200 {
			t.Fatalf("%s: %d %v", path, res.StatusCode, out)
		}
		return out
	}
	_, proj := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": "Consented"})
	e.call(alice, orgA, "POST", "/api/v1/projects/"+proj["id"].(string)+"/text-consent", map[string]any{"confirm": true})
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "512-555-0201", "project_id": proj["id"]}), "applied")
	ask := func() map[string]any {
		return post("/internal/v1/dialer/lead", map[string]any{"org_id": orgA, "user_id": alice, "lead_id": lead})
	}
	if l := ask(); l["list_consent"] != true || l["blocked_texts"] != false || l["may_call"] != true {
		t.Fatalf("before: %v", l)
	}
	post("/internal/v1/dialer/block", map[string]any{"org_id": orgA, "user_id": alice, "phone": "+15125550201", "payload": map[string]any{"texts": true}})
	if l := ask(); l["blocked_texts"] != true || l["blocked_calls"] != false || l["may_call"] != true {
		t.Fatalf("texts only: %v", l)
	}
	post("/internal/v1/dialer/block", map[string]any{"org_id": orgA, "user_id": alice, "phone": "+15125550201", "payload": map[string]any{"calls": true, "texts": true}})
	if l := ask(); l["blocked_calls"] != true || l["may_call"] != false {
		t.Fatalf("both: %v", l)
	}
	post("/internal/v1/dialer/block", map[string]any{"org_id": orgA, "user_id": alice, "phone": "+15125550201", "payload": map[string]any{"lift": true}})
	if l := ask(); l["blocked_calls"] != false || l["blocked_texts"] != false || l["do_not_call"] != false {
		t.Fatalf("START lifts the reply's block: %v", l)
	}
	// START never lifts a block a person made.
	e.want(e.op(alice, orgA, "lead.update", map[string]any{"id": lead, "changes": map[string]any{"do_not_call": true}}), "applied")
	post("/internal/v1/dialer/block", map[string]any{"org_id": orgA, "user_id": alice, "phone": "+15125550201", "payload": map[string]any{"lift": true}})
	if l := ask(); l["blocked_calls"] != true {
		t.Fatalf("START lifted the agency's own block: %v", l)
	}
}
