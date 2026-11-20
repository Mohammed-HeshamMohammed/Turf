package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// signInFrom signs in with a browser's description, as a new device would.
func (w *world) signInFrom(email, userAgent string) answer {
	w.t.Helper()
	raw, _ := json.Marshal(map[string]any{"email": email, "password": goodPassword})
	req := httptest.NewRequest("POST", "/v1/sessions", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("CF-IPCountry", "US")
	rec := httptest.NewRecorder()
	w.h.ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return answer{status: rec.Code, body: out}
}

// Step 35: a new device emails the person and "This wasn't me" ends it (D242); the owner signs out a member, an admin not the owner
// (D240); the owner's sign-in rules (D238, D244); a reset needs a second proof, and support helps after 7 days (D239).
func TestSignInSecurity(t *testing.T) {
	w, fake, _ := lifecycleWorld(t)
	defer func() { clock = time.Now }()
	boss := w.stepped("boss@example.com").access()
	member := w.confirmed("member@example.com")
	admin := w.stepped("admin@example.com").access()
	fake.mu.Lock()
	fake.owner = w.idOf("boss@example.com")
	fake.joined[w.idOf("member@example.com")] = true
	fake.joined[w.idOf("admin@example.com")] = true
	fake.roles = map[string][]string{w.idOf("admin@example.com"): {"admin"}}
	fake.mu.Unlock()

	// A new device.
	newDevice := w.signInFrom("member@example.com", "Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")
	if newDevice.status != 200 {
		t.Fatalf("sign in: %d %v", newDevice.status, newDevice.body)
	}
	w.mail.mu.Lock()
	var link string
	for i, tpl := range w.mail.templates {
		if tpl == "new_sign_in" && w.mail.tplTo[i] == "member@example.com" {
			link, _ = w.mail.data[i]["link"].(string)
			if w.mail.data[i]["device"] != "Chrome on Windows" || w.mail.data[i]["place"] != "US" {
				t.Errorf("the email says: %v", w.mail.data[i])
			}
		}
	}
	w.mail.mu.Unlock()
	if link == "" {
		t.Fatal("no new-device email")
	}
	if again := w.signInFrom("member@example.com", "Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36"); again.status != 200 {
		t.Fatal(again.status)
	}
	u, _ := url.Parse(link)
	if a := w.call("POST", "/v1/sessions/not-me", map[string]any{"token": u.Query().Get("token")}, ""); a.status != 200 {
		t.Fatalf("not me: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": newDevice.str("refresh_token")}, ""); a.status != 401 {
		t.Fatalf("the device after 'not me': %d", a.status)
	}
	if a := w.call("POST", "/v1/sessions/not-me", map[string]any{"token": u.Query().Get("token")}, ""); a.status != 404 {
		t.Fatalf("the link twice: %d", a.status)
	}

	// The agency's sign-in rules.
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/security", map[string]any{"idle_minutes": 60}, admin); a.status != 403 {
		t.Fatalf("an admin changes the rules: %d", a.status)
	}
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/security", map[string]any{"idle_minutes": 60, "mfa_everyone": true}, boss); a.status != 200 || a.body["idle_minutes"] != float64(60) || a.body["mfa_everyone"] != true {
		t.Fatalf("rules: %d %v", a.status, a.body)
	}
	// Where members may work from (D243): kept in authz, which the gateway reads.
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/security", map[string]any{"countries": []string{"US"}}, boss); a.status != 200 || len(a.body["countries"].([]any)) != 1 {
		t.Fatalf("countries: %d %v", a.status, a.body)
	}
	idle := w.signInFrom("member@example.com", "")
	onCall := w.signInFrom("member@example.com", "")
	clock = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": idle.str("refresh_token")}, ""); a.status != 401 || a.str("code") != "signed_out_idle" {
		t.Fatalf("idle past the limit: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": onCall.str("refresh_token"), "on_call": true}, ""); a.status != 200 {
		t.Fatalf("a call in progress: %d %v", a.status, a.body)
	}
	clock = time.Now

	// Signing a member out.
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/members/"+w.idOf("boss@example.com")+"/sign-out", nil, admin); a.status != 403 {
		t.Fatalf("an admin signs the owner out: %d", a.status)
	}
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/members/"+w.idOf("member@example.com")+"/sign-out", nil, boss); a.status != 200 {
		t.Fatalf("sign out: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": member.refresh()}, ""); a.status != 401 {
		t.Fatalf("the member is still signed in: %d", a.status)
	}

	// A reset needs a second proof for someone who has one.
	reset := w.confirmed("reset@example.com")
	_, done := w.addDevice(reset.access(), "Phone")
	codes := done.body["recovery_codes"].([]any)
	token := "reset-" + w.fb.accounts["reset@example.com"].uid
	if a := w.call("POST", "/v1/password/reset", map[string]any{"token": token, "new": "An0ther-long-passphrase!"}, ""); a.status != 403 || a.str("code") != "second_proof_required" {
		t.Fatalf("the link alone: %d %v", a.status, a.body)
	}
	if w.fb.accounts["reset@example.com"].password != goodPassword {
		t.Fatal("the password changed without the second proof")
	}
	if a := w.call("POST", "/v1/password/reset", map[string]any{"token": token, "new": "An0ther-long-passphrase!", "code": codes[0]}, ""); a.status != 200 {
		t.Fatalf("with a recovery code: %d %v", a.status, a.body)
	}
	// Lost both: support, after 7 days.
	asked := w.call("POST", "/v1/password/reset/support", map[string]any{"token": token, "reason": "My phone was stolen with my codes in it."}, "")
	if asked.status != 200 {
		t.Fatalf("ask support: %d %v", asked.status, asked.body)
	}
	staff := w.stepped("staff@example.com").access()
	fake.mu.Lock()
	fake.staff = w.idOf("staff@example.com")
	fake.mu.Unlock()
	if a := w.call("POST", "/v1/admin/reset-requests/"+asked.str("id")+"/approve", nil, staff); a.status != 409 {
		t.Fatalf("approved before the wait: %d", a.status)
	}
	clock = func() time.Time { return time.Now().Add(8 * 24 * time.Hour) }
	staff = w.stepped("staff2@example.com").access()
	fake.mu.Lock()
	fake.staff = w.idOf("staff2@example.com")
	fake.mu.Unlock()
	if a := w.call("POST", "/v1/admin/reset-requests/"+asked.str("id")+"/approve", nil, staff); a.status != 200 {
		t.Fatalf("approve: %d %v", a.status, a.body)
	}
	if n := w.count("SELECT count(*) FROM mfa_factors WHERE user_id = $1 AND kind = 'totp'", w.idOf("reset@example.com")); n != 0 {
		t.Fatal("the lost authenticator is still there")
	}
	if a := w.call("POST", "/v1/password/reset", map[string]any{"token": token, "new": "Yet-an0ther-passphrase!"}, ""); a.status != 200 {
		t.Fatalf("the link alone after support: %d %v", a.status, a.body)
	}
	// Microsoft sign-in through Firebase (D237).
	w.fb.brokered = true
	if a := w.call("GET", "/v1/providers", nil, ""); a.body["microsoft"] != true {
		t.Fatalf("providers: %v", a.body)
	}
	if a := w.call("POST", "/v1/oauth/microsoft/start", map[string]any{"target": "landing"}, ""); a.status != 200 || !strings.HasPrefix(a.str("url"), "https://") {
		t.Fatalf("microsoft start: %d %v", a.status, a.body)
	}
	_ = strings.TrimSpace
	_ = http.StatusOK
}
