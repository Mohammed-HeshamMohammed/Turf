package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

const newPassword = "Another long password2#"

func TestChangePasswordChecksTheOldOneAndEndsOtherSessions(t *testing.T) {
	w := newWorld(t)
	first := w.signUp("sami@example.com")
	other := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword}, "")
	change := func(current, next string) answer {
		return w.call("POST", "/v1/password", map[string]any{"current": current, "new": next}, first.access())
	}
	if a := change("wrong", newPassword); a.status != 401 || a.str("code") != "wrong_credentials" {
		t.Fatalf("wrong current: %d %v", a.status, a.body)
	}
	if a := change(goodPassword, "short"); a.status != 400 {
		t.Fatalf("weak new: %d %v", a.status, a.body)
	}
	if w.fb.accounts["sami@example.com"].password != goodPassword || w.call("GET", "/v1/me", nil, other.access()).status != 200 {
		t.Fatal("a refused change changes nothing")
	}
	if a := change(goodPassword, newPassword); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if w.fb.accounts["sami@example.com"].password != newPassword {
		t.Fatal("Firebase holds the new password")
	}
	if w.call("GET", "/v1/me", nil, other.access()).status != 401 || w.call("GET", "/v1/me", nil, first.access()).status != 200 {
		t.Fatal("every other session ends; this one stays")
	}
	if a := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": newPassword}, ""); a.status != 200 {
		t.Fatalf("the new password signs in: %d", a.status)
	}
	if a := w.call("POST", "/v1/password", map[string]any{"current": newPassword, "new": goodPassword}, ""); a.status != 401 {
		t.Fatalf("needs a signed-in person: %d", a.status)
	}
}

func TestChangePasswordWhileFirebaseIsDownIsNotAWrongPassword(t *testing.T) {
	w := newWorld(t)
	first := w.signUp("sami@example.com")
	w.fb.down = true
	if a := w.call("POST", "/v1/password", map[string]any{"current": goodPassword, "new": newPassword}, first.access()); a.status != 500 || a.str("code") == "wrong_credentials" {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

func TestForgotPasswordSaysTheSameForAnyAddressAndCannotFillAnInbox(t *testing.T) {
	w := newWorld(t)
	w.signUp("sami@example.com")
	w.fb.sent = nil
	known := w.call("POST", "/v1/password/forgot", map[string]any{"email": "Sami@Example.com"}, "")
	unknown := w.call("POST", "/v1/password/forgot", map[string]any{"email": "nobody@example.com"}, "")
	if known.status != 200 || unknown.status != 200 || known.body["ok"] != true || unknown.body["ok"] != true {
		t.Fatalf("%v %v", known, unknown)
	}
	if len(w.fb.sent) != 1 || w.fb.sent[0] != "PASSWORD_RESET:sami@example.com" {
		t.Fatalf("only the real address gets one: %v", w.fb.sent)
	}
	if a := w.call("POST", "/v1/password/forgot", map[string]any{"email": "not an address"}, ""); a.status != 400 {
		t.Fatalf("%d", a.status)
	}
	// A fourth request within the hour is answered the same but sends nothing.
	w.call("POST", "/v1/password/forgot", map[string]any{"email": "sami@example.com"}, "")
	w.call("POST", "/v1/password/forgot", map[string]any{"email": "sami@example.com"}, "")
	if a := w.call("POST", "/v1/password/forgot", map[string]any{"email": "sami@example.com"}, ""); a.status != 200 || a.body["ok"] != true {
		t.Fatalf("%d", a.status)
	}
	if n := len(w.fb.sent); n != 3 {
		t.Fatalf("three an hour, %d sent", n)
	}
}

func TestResetPasswordEndsEverySession(t *testing.T) {
	w := newWorld(t)
	first := w.signUp("sami@example.com")
	second := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword}, "")
	stranger := w.signUp("lina@example.com")
	code := "reset-" + w.fb.accounts["sami@example.com"].uid
	if a := w.call("POST", "/v1/password/reset", map[string]any{"token": "bad", "new": newPassword}, ""); a.status != 403 {
		t.Fatalf("bad link: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/password/reset", map[string]any{"token": code, "new": "short"}, ""); a.status != 400 {
		t.Fatalf("weak: %d", a.status)
	}
	if a := w.call("POST", "/v1/password/reset", map[string]any{"token": " " + code + " ", "new": newPassword}, ""); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if w.fb.accounts["sami@example.com"].password != newPassword {
		t.Fatal("Firebase holds the new password")
	}
	if w.call("GET", "/v1/me", nil, first.access()).status != 401 || w.call("GET", "/v1/me", nil, second.access()).status != 401 {
		t.Fatal("every session of that person ends")
	}
	if w.call("GET", "/v1/me", nil, stranger.access()).status != 200 {
		t.Fatal("nobody else's does")
	}
}

func TestOurConfirmationLinkWorksOnce(t *testing.T) {
	w := newWorld(t)
	w.withMail()
	made := w.signUp("sami@example.com")
	token := strings.TrimPrefix(w.mail.links[0], "http://landing.example/verify?token=")
	if a := w.call("POST", "/v1/email/verify", map[string]any{"token": token}, ""); a.status != 200 || a.body["email_verified"] != true {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if w.count("SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL") != 1 {
		t.Fatal("the address is confirmed")
	}
	if a := w.call("POST", "/v1/email/verify", map[string]any{"token": token}, ""); a.status != 403 {
		t.Fatalf("second use: %d", a.status)
	}
	// Tokens made before it still say no until refreshed; a refresh says yes.
	if c, _ := w.s.keys.verify(made.access(), time.Now()); c.EmailVerified {
		t.Fatal("an old token cannot change")
	}
	next := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": made.refresh()}, "")
	if c, _ := w.s.keys.verify(next.access(), time.Now()); !c.EmailVerified {
		t.Fatal("a refreshed token says yes")
	}
}

func TestConfirmationLinksExpireAndGarbageIsRefused(t *testing.T) {
	w := newWorld(t)
	w.withMail()
	w.signUp("sami@example.com")
	token := strings.TrimPrefix(w.mail.links[0], "http://landing.example/verify?token=")
	clock = func() time.Time { return time.Now().Add(49 * time.Hour) }
	if a := w.call("POST", "/v1/email/verify", map[string]any{"token": token}, ""); a.status != 403 {
		t.Fatalf("expired: %d", a.status)
	}
	clock = time.Now
	for _, bad := range []string{"", "nonsense", strings.Repeat("a", 5000)} {
		if a := w.call("POST", "/v1/email/verify", map[string]any{"token": bad}, ""); a.status != 403 {
			t.Fatalf("%.10q: %d", bad, a.status)
		}
	}
	if w.count("SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL") != 0 {
		t.Fatal("nothing was confirmed")
	}
}

func TestAConfirmationLinkFromFirebaseStillWorks(t *testing.T) {
	w := newWorld(t)
	w.signUp("sami@example.com")
	code := "verify-" + w.fb.accounts["sami@example.com"].uid
	if a := w.call("POST", "/v1/email/verify", map[string]any{"token": code}, ""); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if w.count("SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL") != 1 {
		t.Fatal("confirmed")
	}
}

func TestResendWithFirebaseSendingTheEmail(t *testing.T) {
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	w.fb.sent = nil
	if a := w.call("POST", "/v1/email/resend", nil, made.access()); a.status != 200 || a.body["sent"] != true || len(w.fb.sent) != 1 {
		t.Fatalf("%d %v %v", a.status, a.body, w.fb.sent)
	}
	if a := w.call("POST", "/v1/email/resend", nil, ""); a.status != 401 {
		t.Fatalf("needs sign-in: %d", a.status)
	}
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET email_verified_at = $1", now()); err != nil {
		t.Fatal(err)
	}
	w.fb.sent = nil
	if a := w.call("POST", "/v1/email/resend", nil, made.access()); a.body["email_verified"] != true || len(w.fb.sent) != 0 {
		t.Fatalf("already confirmed: %v %v", a.body, w.fb.sent)
	}
}

func TestResendWithTheNotificationServiceIsLimitedToOnceAMinute(t *testing.T) {
	w := newWorld(t, func(c *config) { c.devTokens = true })
	w.withMail()
	made := w.signUp("sami@example.com")
	if a := w.call("POST", "/v1/email/resend", nil, made.access()); a.status != 400 {
		t.Fatalf("just sent at sign-up: %d %v", a.status, a.body)
	}
	clock = func() time.Time { return time.Now().Add(2 * time.Minute) }
	a := w.call("POST", "/v1/email/resend", nil, made.access())
	if a.status != 200 || a.body["sent"] != true || a.str("verification_token") == "" || len(w.mail.links) != 2 {
		t.Fatalf("%d %v %v", a.status, a.body, w.mail.links)
	}
	if !strings.HasSuffix(w.mail.links[1], a.str("verification_token")) {
		t.Fatal("the development token is the one that was sent")
	}
}
