package crm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Step 45: nothing is used until the switch is on, the owner agreed with the second step and staff checked the notice; a client's
// calls count only once it agrees; only counts by hour and attempt leave, after the check; agencies see figures only over three
// agencies; the discount follows the agreement; withdrawing stops new counts and keeps what was learned (D324-D327).
func TestSharedLearningByAgreement(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	g := owner()
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	var mu sync.Mutex
	var discounts []map[string]any
	billing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		discounts = append(discounts, map[string]any{"path": r.URL.Path, "percent": body["percent"]})
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer billing.Close()
	e.s.cfg.billingURL, e.s.cfg.billingToken = billing.URL, "billing-token-billing-token-billing-token"

	// Calls: two leads of the agency's own work, one of a client that has not agreed.
	_, acme := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme"})
	own, theirs := newID(t), newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": own, "name": "Pat Learned", "phone": "512-555-4501"}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": theirs, "name": "Client Lead", "phone": "512-555-4502"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET client_id = $2 WHERE id = $1`, theirs, acme["id"]); err != nil {
		t.Fatal(err)
	}
	for i, m := range []string{"no_answer", "reached", "reached"} {
		if _, err := e.admin.Exec(ctx, `INSERT INTO crm.call_events (org_id, lead_id, outcome, meaning, occurred_at) VALUES ($1, $2, 'x', $3, now() - make_interval(hours => $4))`, orgA, own, m, 3-i); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.call_events (org_id, lead_id, outcome, meaning, occurred_at) VALUES ($1, $2, 'x', 'reached', now() - interval '1 hour')`, orgA, theirs); err != nil {
		t.Fatal(err)
	}
	patterns := func() (n, calls int) {
		_ = e.admin.QueryRow(ctx, `SELECT count(*), coalesce(sum(calls), 0) FROM crm.shared_patterns WHERE kind = 'reach_by_attempt'`).Scan(&n, &calls)
		return
	}

	// Before the lawyer's switch: the owner may agree, nothing is used.
	sign := map[string]any{"version": learningVersion, "notice_url": "https://agency.test/privacy"}
	if code, _ := e.call(bob, orgA, "POST", "/api/v1/learning/agreement", sign); code != 403 {
		t.Fatalf("a caller agrees: %d", code)
	}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/learning/agreement", map[string]any{"version": "old", "notice_url": "https://agency.test/privacy"}); code != 400 {
		t.Fatalf("an old version: %d", code)
	}
	code, out := e.call(alice, orgA, "POST", "/api/v1/learning/agreement", sign)
	if code != 200 || out["sharing"] != false || !strings.Contains(out["why_not"].(string), "lawyer") {
		t.Fatalf("signed before the switch: %d %v", code, out)
	}
	if err := e.s.contribute(ctx, orgA); err != nil {
		t.Fatal(err)
	}
	if n, _ := patterns(); n != 0 {
		t.Fatal("used before the switch")
	}
	// The switch on, but staff have not checked the notice.
	e.s.cfg.sharedLearning = true
	_, out = e.call(alice, orgA, "GET", "/api/v1/learning/agreement", nil)
	if out["sharing"] != false || !strings.Contains(out["why_not"].(string), "notice") {
		t.Fatalf("before the notice is checked: %v", out)
	}
	const boss = "66666666-6666-4666-8666-666666666666"
	e.rules.people_[boss] = peopleReply{UserID: boss, PlatformRole: "owner"}
	if code, _ := e.call(boss, "", "POST", "/api/v1/platform/learning/"+orgA+"/notice-checked", map[string]any{"ok": true, "note": "Covers it"}); code != 200 {
		t.Fatalf("notice checked: %d", code)
	}
	e.s.contributeAll(ctx)
	if n, calls := patterns(); n == 0 || calls != 3 {
		t.Fatalf("the agency's own calls: %d rows, %d calls (the client's call must not count)", n, calls)
	}
	var leaked int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.shared_patterns WHERE bucket ~ '[^0-9:]' OR source = $1`, orgA).Scan(&leaked)
	if leaked != 0 {
		t.Fatal("something other than counts was shared")
	}

	// The client agrees for its part: its calls count from then.
	cara := newID(t)
	e.rules.grants[cara+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"shared"}, Capabilities: []string{"publicComment"}, Roles: []string{"client"}}
	e.rules.roster[orgA] = append(e.rules.roster[orgA], member{UserID: cara, Roles: []string{"client"}})
	if code, out := e.call(alice, orgA, "PUT", "/api/v1/clients/"+acme["id"].(string)+"/members/"+cara, map[string]any{"main": true}); code != 200 {
		t.Fatalf("client member: %d %v", code, out)
	}
	if code, _ := e.call(bob, orgA, "POST", "/api/v1/learning/clients/"+acme["id"].(string)+"/agree", nil); code != 403 {
		t.Fatalf("someone not of the client agrees for it: %d", code)
	}
	if code, _ := e.call(cara, orgA, "POST", "/api/v1/learning/clients/"+acme["id"].(string)+"/agree", nil); code != 200 {
		t.Fatalf("the client agrees: %d", code)
	}
	e.s.contributeAll(ctx)
	if _, calls := patterns(); calls != 4 {
		t.Fatalf("after the client agreed: %d calls", calls)
	}

	// Agencies see a figure only once three agencies make it up.
	_, shared := e.call(bob, orgA, "GET", "/api/v1/learning/shared-patterns", nil)
	if len(shared["patterns"].([]any)) != 0 {
		t.Fatalf("one agency's figures shown: %v", shared)
	}
	for _, src := range []string{strings.Repeat("a", 64), strings.Repeat("b", 64)} {
		if _, err := e.admin.Exec(ctx, `INSERT INTO crm.shared_patterns (month, kind, bucket, source, calls, reached) VALUES (date_trunc('month', now()), 'reach_by_attempt', '1', $1, 10, 4)`, src); err != nil {
			t.Fatal(err)
		}
	}
	_, shared = e.call(bob, orgA, "GET", "/api/v1/learning/shared-patterns", nil)
	if list := shared["patterns"].([]any); len(list) != 1 || list[0].(map[string]any)["bucket"] != "1" {
		t.Fatalf("three agencies' figure: %v", shared)
	}

	// Withdrawing: nothing new, what was learned stays, the discount ends.
	before, _ := patterns()
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/learning/agreement/withdraw", nil); code != 200 {
		t.Fatalf("withdraw: %d", code)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.call_events (org_id, lead_id, outcome, meaning, occurred_at) VALUES ($1, $2, 'x', 'reached', now())`, orgA, own); err != nil {
		t.Fatal(err)
	}
	e.s.contributeAll(ctx)
	if after, _ := patterns(); after != before {
		t.Fatalf("after withdrawing: %d rows, before %d", after, before)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(discounts) != 2 || discounts[0]["percent"] != float64(learningDiscount) || discounts[1]["percent"] != 0.0 || !strings.HasSuffix(discounts[0]["path"].(string), "/discounts/shared_learning") {
		t.Fatalf("the discount: %v", discounts)
	}
}

// The check lets only known kinds, digit buckets and counts through (D326).
func TestPatternCheck(t *testing.T) {
	if checkPatterns([]patternRow{{"reach_by_hour", "3:14", 5, 2}, {"reach_by_attempt", "10", 1, 0}}) != nil {
		t.Fatal("good rows refused")
	}
	for _, bad := range []patternRow{{"names", "1", 1, 0}, {"reach_by_hour", "Pat", 1, 0}, {"reach_by_hour", "5125554501", 1, 0}, {"reach_by_attempt", "1", 1, 2}} {
		if checkPatterns([]patternRow{bad}) == nil {
			t.Fatalf("let through: %v", bad)
		}
	}
}
