package crm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Step 36: a form for a client sends its leads, unassigned, to a chosen team; a blocked number comes in as do-not-call and is flagged;
// the consent and its words are kept and let the dialer text that number for that client; robots and floods are turned away (D247).
func TestWebForms(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT = "aaaaaaaa-0000-4000-8000-000000000601"
	e.rules.mu.Lock()
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T"}}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)
	e.s.cfg.emailPublicURL = "https://gate.test"
	_, acme := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme"})

	if code, _ := e.call(bob, orgA, "POST", "/api/v1/forms", map[string]any{"name": "Sellers", "team_id": teamT}); code != 403 {
		t.Fatalf("a caller makes a form: %d", code)
	}
	code, form := e.call(alice, orgA, "POST", "/api/v1/forms", map[string]any{"name": "Acme sellers", "client_id": acme["id"], "team_id": teamT, "embed_origins": []string{"https://www.acme.test"}})
	if code != 200 || !strings.HasPrefix(form["address"].(string), "https://gate.test/api/v1/public/forms/") || !strings.Contains(form["embed"].(string), "<iframe") {
		t.Fatalf("form: %d %v", code, form)
	}
	token := form["token"].(string)

	page := httptest.NewRecorder()
	e.s.handler().ServeHTTP(page, httptest.NewRequest("GET", "/api/v1/public/forms/"+token, nil))
	if page.Code != 200 || !strings.Contains(page.Body.String(), "may call and text me") || !strings.Contains(page.Header().Get("Content-Security-Policy"), "frame-ancestors https://www.acme.test") {
		t.Fatalf("page: %d %s %s", page.Code, page.Header().Get("Content-Security-Policy"), page.Body)
	}
	send := func(fields url.Values, ip string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/public/forms/"+token, strings.NewReader(fields.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("X-Forwarded-For", ip)
		rec := httptest.NewRecorder()
		e.s.handler().ServeHTTP(rec, r)
		return rec
	}
	if rec := send(url.Values{"name": {"Pat Seller"}, "phone": {"(512) 555-1301"}, "address": {"1 Oak St"}, "consent": {"yes"}}, "203.0.113.7"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "Thank you") {
		t.Fatalf("send: %d %s", rec.Code, rec.Body)
	}
	var lead, team, client, source string
	var assignee *string
	if err := e.admin.QueryRow(ctx, `SELECT id::text, team_id::text, client_id::text, assignee_id::text, source FROM crm.leads WHERE name = 'Pat Seller'`).Scan(&lead, &team, &client, &assignee, &source); err != nil {
		t.Fatal(err)
	}
	if team != teamT || client != acme["id"] || assignee != nil || source != "Form: Acme sellers" {
		t.Fatalf("the lead: %s %s %v %s", team, client, assignee, source)
	}
	// The consent lets the dialer text this number for this client's work.
	tx, _ := e.s.st.begin(ctx, scope{orgID: orgA})
	if !formConsent(ctx, tx, "512-555-1301", client) || formConsent(ctx, tx, "512-555-1301", "") {
		t.Fatal("the form's consent is not for this client only")
	}
	tx.Rollback(ctx)

	// A blocked number comes in as do-not-call, flagged.
	e.call(alice, orgA, "POST", "/api/v1/blocks", map[string]any{"phone": "512-555-1302"})
	send(url.Values{"name": {"No Calls"}, "phone": {"512-555-1302"}}, "203.0.113.8")
	var dnc bool
	if err := e.admin.QueryRow(ctx, `SELECT do_not_call FROM crm.leads WHERE name = 'No Calls'`).Scan(&dnc); err != nil || !dnc {
		t.Fatalf("a blocked number: %v %v", dnc, err)
	}
	_, subs := e.call(alice, orgA, "GET", "/api/v1/forms/"+form["id"].(string)+"/submissions", nil)
	list := subs["submissions"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["blocked"] != true || list[1].(map[string]any)["consent"] != true {
		t.Fatalf("submissions: %v", subs)
	}

	// A robot fills the hidden field: thanked, nothing kept. A flood from one address is slowed.
	send(url.Values{"name": {"Robot"}, "phone": {"512-555-1303"}, "website": {"spam.test"}}, "203.0.113.9")
	var robots int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE name = 'Robot'`).Scan(&robots)
	if robots != 0 {
		t.Fatal("a robot's send was kept")
	}
	last := 0
	for i := 0; i < formSendsPerMinute+1; i++ {
		last = send(url.Values{"name": {"Flood"}, "phone": {"512-555-1304"}}, "198.51.100.1").Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("a flood: %d", last)
	}
	// Switched off: closed.
	e.call(alice, orgA, "PATCH", "/api/v1/forms/"+form["id"].(string), map[string]any{"off": true})
	if rec := send(url.Values{"name": {"Late"}, "phone": {"512-555-1305"}}, "203.0.113.10"); rec.Code != 404 {
		t.Fatalf("a closed form: %d", rec.Code)
	}
}
