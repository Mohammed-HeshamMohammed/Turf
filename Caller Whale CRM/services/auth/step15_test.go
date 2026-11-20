package main

import (
	"net/url"
	"strings"
	"testing"
)

// lastLink is the newest emailed link.
func (w *world) lastLink() string {
	w.t.Helper()
	w.mail.mu.Lock()
	defer w.mail.mu.Unlock()
	if len(w.mail.links) == 0 {
		w.t.Fatal("nothing was emailed")
	}
	return w.mail.links[len(w.mail.links)-1]
}

// Step 15: a new person signs up inside the emailed invitation, the address confirmed by the link, even where sign-up is closed
// (D47, D368); the link works once; the copy the agency sees carries no key.
func TestSigningUpInsideAnInvitation(t *testing.T) {
	w, _, owner := lifecycleWorld(t)
	w.withMail()
	w.s.cfg.publicSignup = false
	sent := w.inviteInto(owner, "new@example.com", flowTeam)
	if sent.status != 201 || strings.Contains(sent.str("link"), "key=") {
		t.Fatalf("the agency's copy of the link: %d %v", sent.status, sent.body)
	}
	link, err := url.Parse(w.lastLink())
	if err != nil {
		t.Fatal(err)
	}
	id, key := link.Query().Get("invitation"), link.Query().Get("key")
	if id != sent.str("id") || key == "" {
		t.Fatalf("the emailed link: %s", link)
	}
	if a := w.call("GET", "/v1/invitations/"+id+"/preview?key=wrong", nil, ""); a.status != 403 {
		t.Fatalf("a wrong key: %d", a.status)
	}
	preview := w.call("GET", "/v1/invitations/"+id+"/preview?key="+url.QueryEscape(key), nil, "")
	if preview.status != 200 || preview.str("email") != "new@example.com" || preview.str("org_name") != "Blue Door Homes" || preview.body["account_exists"] != false {
		t.Fatalf("preview: %d %v", preview.status, preview.body)
	}
	form := func(email, key string) map[string]any {
		return map[string]any{"name": "Nia", "email": email, "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion, "invitation_id": id, "invitation_key": key}
	}
	if a := w.call("POST", "/v1/accounts", form("other@example.com", key), ""); a.status != 403 {
		t.Fatalf("another address: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/accounts", map[string]any{"name": "X", "email": "x@example.com", "password": goodPassword, "terms_version": termsVersion}, ""); a.status != 403 {
		t.Fatalf("sign-up is closed without an invitation: %d", a.status)
	}
	made := w.call("POST", "/v1/accounts", form("new@example.com", key), "")
	if made.status != 201 {
		t.Fatalf("sign up inside the invitation: %d %v", made.status, made.body)
	}
	if me := w.call("GET", "/v1/me", nil, made.access()); me.body["email_verified"] != true {
		t.Fatalf("the address is confirmed by the link: %v", me.body)
	}
	if a := w.call("POST", "/v1/me/invitations/"+id+"/accept", nil, made.access()); a.status != 200 {
		t.Fatalf("accept: %d %v", a.status, a.body)
	}
	if a := w.call("GET", "/v1/invitations/"+id+"/preview?key="+url.QueryEscape(key), nil, ""); a.status != 403 {
		t.Fatalf("the link a second time: %d", a.status)
	}
}

// Step 15: a shared device's sign-in lasts 12 hours and says so; owners, admins and leads give their code again after 7 days (D38,
// D188); My access lists the agencies; the person downloads their own data (D91, D99).
func TestDevicesAccessAndMyData(t *testing.T) {
	w, fake, owner := lifecycleWorld(t)
	shared := w.call("POST", "/v1/sessions", map[string]any{"email": "owner@example.com", "password": goodPassword, "kind": "shared"}, "")
	if shared.status != 200 || shared.str("device") != "shared" {
		t.Fatalf("a shared sign-in: %d %v", shared.status, shared.body)
	}
	if n := w.count("SELECT count(*) FROM sessions WHERE kind = 'shared' AND expires_at <= $1", now()+sharedSessionSeconds); n != 1 {
		t.Fatalf("shared sessions lasting 12 hours: %d", n)
	}
	again := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": shared.refresh()}, "")
	if again.status != 200 || again.str("device") != "shared" {
		t.Fatalf("refreshing a shared sign-in: %d %v", again.status, again.body)
	}
	mine := w.call("POST", "/v1/sessions", map[string]any{"email": "owner@example.com", "password": goodPassword}, "")
	if mine.str("device") != "mine" {
		t.Fatalf("my device: %v", mine.body)
	}

	// The owner's second step, passed 8 days ago, is asked again; a caller's is not.
	caller := w.confirmed("caller@example.com")
	fake.mu.Lock()
	fake.joined[w.idOf("caller@example.com")] = true
	fake.mu.Unlock()
	w.exec("UPDATE sessions SET mfa_passed = 1, mfa_at = $1", now()-8*86_400)
	ownerAgain := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": mine.refresh()}, "")
	if me := w.call("GET", "/v1/me", nil, ownerAgain.access()); me.body["mfa_passed"] != false {
		t.Fatalf("the owner after 7 days: %v", me.body)
	}
	callerAgain := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": caller.refresh()}, "")
	if me := w.call("GET", "/v1/me", nil, callerAgain.access()); me.body["mfa_passed"] != true {
		t.Fatalf("a caller after 7 days: %v", me.body)
	}

	agencies := w.call("GET", "/v1/me/agencies", nil, owner)
	list, _ := agencies.body["agencies"].([]any)
	if agencies.status != 200 || len(list) != 1 || list[0].(map[string]any)["name"] != "Blue Door Homes" || list[0].(map[string]any)["owner"] != true {
		t.Fatalf("my agencies: %d %v", agencies.status, agencies.body)
	}
	data := w.call("GET", "/v1/me/export", nil, owner)
	profile, _ := data.body["profile"].(map[string]any)
	if data.status != 200 || profile["email"] != "owner@example.com" || profile["tag"] == "" || !strings.Contains(data.header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("my data: %d %v", data.status, data.body)
	}
}
