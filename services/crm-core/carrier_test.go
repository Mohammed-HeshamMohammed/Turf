package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// Step 39: the dialer reports an agency's carrier registration and texting standing; the owner is told when the step changes; with
// CARRIER_CHECK=on imports wait for the verified brand; only the platform owner or cofounder with a second step see across agencies,
// and their review ends a step, which the dialer reads in the answer (D268, D269, D271, D314).
func TestCarrierStandingFromTheDialer(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const token = "dialer-token-dialer-token-dialer-token"
	e.s.cfg.dialerToken = token
	report := func(body map[string]any, bearer string) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", e.ts.URL+"/internal/v1/dialer/carrier", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+bearer)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := report(map[string]any{"org_id": orgA, "step": "ok"}, "wrong"); code != 401 {
		t.Fatalf("anyone reports: %d", code)
	}

	// With the check on, nothing is open before the dialer reports a verified brand.
	e.s.cfg.carrierCheck = true
	_, me := e.call(alice, orgA, "GET", "/api/v1/me", nil)
	if c := me["carrier"].(map[string]any); c["may_import"] != false || c["state"] != "not_submitted" {
		t.Fatalf("before any report: %v", c)
	}
	report(map[string]any{"org_id": orgA, "state": "campaign_pending", "check_required": true, "may_call": true, "may_text": false, "step": "ok"}, token)
	_, me = e.call(alice, orgA, "GET", "/api/v1/me", nil)
	if c := me["carrier"].(map[string]any); c["may_import"] != true || c["may_text"] != false {
		t.Fatalf("a verified brand: %v", c)
	}

	// A new step reaches the owner as a task.
	report(map[string]any{"org_id": orgA, "state": "approved", "may_call": true, "may_text": true, "step": "suspended", "reason": "10 opt-outs (8.3%)",
		"texts": 120, "opt_outs": 10, "complaints": 0, "appeal": "A bad list"}, token)
	var tasks int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.tasks WHERE org_id = $1 AND assignee_id = $2 AND title LIKE 'Texting is suspended%'`, orgA, alice).Scan(&tasks)
	if tasks != 1 {
		t.Fatalf("the owner's notice: %d", tasks)
	}

	// Staff: support may not; the owner of Caller Whale needs the second step.
	const staffer, boss = "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	e.rules.people_[staffer] = peopleReply{UserID: staffer, PlatformRole: "support"}
	e.rules.people_[boss] = peopleReply{UserID: boss, PlatformRole: "owner"}
	if code, _ := e.call(staffer, "", "GET", "/api/v1/platform/carrier", nil); code != 403 {
		t.Fatalf("support sees across agencies: %d", code)
	}
	signed := func(mfa bool, method, path string, body any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, e.ts.URL+path, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+e.fx.Sign("k1", "EdDSA", func(m map[string]any) { m["sub"], m["name"], m["mfa"] = boss, "Boss", mfa }))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := signed(false, "GET", "/api/v1/platform/carrier", nil); code != 403 {
		t.Fatalf("without the second step: %d", code)
	}
	withStep := func(method, path string, body any) (int, map[string]any) { return signed(true, method, path, body) }
	code, list := withStep("GET", "/api/v1/platform/carrier", nil)
	agencies, _ := list["agencies"].([]any)
	if code != 200 || len(agencies) == 0 || agencies[0].(map[string]any)["step"] != "suspended" || agencies[0].(map[string]any)["opt_out_rate"] == nil {
		t.Fatalf("staff view: %d %v", code, list)
	}
	if code, _ := withStep("POST", "/api/v1/platform/carrier/"+orgA+"/clear", map[string]any{"note": "Vendor list removed; rates fine since."}); code != 200 {
		t.Fatalf("clear: %d", code)
	}
	if _, answer := report(map[string]any{"org_id": orgA, "state": "approved", "may_call": true, "may_text": true, "step": "suspended"}, token); answer["cleared_at"] == nil {
		t.Fatalf("the dialer is not told: %v", answer)
	}
}
