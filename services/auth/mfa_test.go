package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// ---- helpers ----

// codeAt is the six-digit code an authenticator app shows for this secret at this time.
func codeAt(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	code, err := totp.GenerateCodeCustom(secret, at, totpOpts)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func current(t *testing.T, secret string) string { return codeAt(t, secret, time.Now()) }

// confirmed makes an account whose email address is confirmed, with the notification service on.
func (w *world) confirmed(email string) answer {
	w.t.Helper()
	w.withMail()
	made := w.signUp(email)
	token := strings.TrimPrefix(w.mail.links[len(w.mail.links)-1], "http://landing.example/verify?token=")
	if a := w.call("POST", "/v1/email/verify", map[string]any{"token": token}, ""); a.status != 200 {
		w.t.Fatalf("confirm: %d", a.status)
	}
	// A new token that says so.
	return w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": made.refresh()}, "")
}

// addDevice sets up an authenticator for the signed-in person and returns its secret and the confirm answer.
func (w *world) addDevice(access, label string) (string, answer) {
	w.t.Helper()
	setup := w.call("POST", "/v1/mfa/totp/setup", nil, access)
	if setup.status != 200 {
		w.t.Fatalf("setup: %d %v", setup.status, setup.body)
	}
	secret := setup.str("secret")
	if !strings.HasPrefix(setup.str("otpauth_url"), "otpauth://totp/Caller%20Whale:") {
		w.t.Fatalf("link %q", setup.str("otpauth_url"))
	}
	done := w.call("POST", "/v1/mfa/totp/confirm", map[string]any{"code": current(w.t, secret), "label": label}, access)
	if done.status != 200 {
		w.t.Fatalf("confirm: %d %v", done.status, done.body)
	}
	return secret, done
}

func (w *world) signInWith(email string, extra map[string]any) answer {
	body := map[string]any{"email": email, "password": goodPassword}
	for k, v := range extra {
		body[k] = v
	}
	return w.call("POST", "/v1/sessions", body, "")
}

// challengeFor signs in with the password only and returns the challenge the server hands over.
func (w *world) challengeFor(email string) (string, []string) {
	w.t.Helper()
	a := w.signInWith(email, nil)
	if a.status != 401 || a.str("code") != "mfa_required" || a.str("challenge") == "" {
		w.t.Fatalf("expected a challenge: %d %v", a.status, a.body)
	}
	var methods []string
	for _, m := range a.body["methods"].([]any) {
		methods = append(methods, m.(string))
	}
	return a.str("challenge"), methods
}

func (w *world) answerChallenge(challenge, method, code string) answer {
	return w.call("POST", "/v1/mfa/challenge/answer", map[string]any{"challenge": challenge, "method": method, "code": code}, "")
}

func (w *world) claimsOf(a answer) claims {
	w.t.Helper()
	c, err := w.s.keys.verify(a.access(), time.Now())
	if err != nil {
		w.t.Fatalf("token: %v (%v)", err, a.body)
	}
	return c
}

// fakeTelegram records what the bot is asked to send.
type fakeTelegram struct {
	mu   sync.Mutex
	sent [][2]string // chat, text
}

func (w *world) withTelegram() *fakeTelegram {
	f := &fakeTelegram{}
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.sent = append(f.sent, [2]string{fmt.Sprint(in["chat_id"]), fmt.Sprint(in["text"])})
		f.mu.Unlock()
		_, _ = rw.Write([]byte(`{"ok":true}`))
	}))
	w.t.Cleanup(srv.Close)
	w.s.tg = newTelegram("BOT:TOKEN", "@caller_whale_bot", srv.URL)
	w.s.cfg.telegramSecret = "hook-secret"
	return f
}

func (f *fakeTelegram) last() [2]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[len(f.sent)-1]
}

// ---- the authenticator app ----

func TestAnAuthenticatorMayBeOnThreeDevicesAndAFourthRemovesTheOldest(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	var last answer
	for i, label := range []string{"Phone", "Tablet", "Laptop", "Spare"} {
		_, last = w.addDevice(account.access(), label)
		recovery, _ := last.body["recovery_codes"].([]any)
		if i == 0 && len(recovery) != 10 {
			t.Fatalf("the first way set up gives ten recovery codes: %v", last.body)
		}
		if i > 0 && len(recovery) != 0 {
			t.Fatalf("and only the first: %v", last.body)
		}
	}
	if removed, _ := last.body["removed"].([]any); len(removed) != 1 || removed[0] != "Phone" {
		t.Fatalf("the fourth removes the one set up longest ago: %v", last.body)
	}
	fresh := w.signInWith("sami@example.com", nil)
	_ = fresh
	if w.count("SELECT COUNT(*) FROM mfa_factors WHERE kind = 'totp'") != 3 {
		t.Fatal("three devices at most")
	}
	// The setup of a device needs the first code to be right, and starts only once.
	bad := w.call("POST", "/v1/mfa/totp/confirm", map[string]any{"code": "000000"}, account.access())
	if bad.status != 400 || bad.str("code") != "bad_request" {
		t.Fatalf("nothing pending: %d %v", bad.status, bad.body)
	}
	w.call("POST", "/v1/mfa/totp/setup", nil, account.access())
	if a := w.call("POST", "/v1/mfa/totp/confirm", map[string]any{"code": "123456"}, account.access()); a.status != 401 || a.str("code") != "wrong_code" {
		t.Fatalf("wrong first code: %d %v", a.status, a.body)
	}
}

func TestSigningInWithASecondStepNeedsTheCode(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")

	// The password alone is a challenge, and no session opens.
	sessions := w.count("SELECT COUNT(*) FROM sessions")
	challenge, methods := w.challengeFor("sami@example.com")
	if !contains(methods, "totp") || contains(methods, "email") || challenge == "" || w.count("SELECT COUNT(*) FROM sessions") != sessions {
		t.Fatalf("%v", methods)
	}
	if w.count("SELECT COUNT(*) FROM mfa_challenges WHERE token_hash = $1", sha256Hex(challenge)) != 1 || w.count("SELECT COUNT(*) FROM mfa_challenges WHERE token_hash = $1", challenge) != 0 {
		t.Fatal("only the hash of the challenge is kept")
	}
	// A wrong code does not open one and is counted.
	if a := w.signInWith("sami@example.com", map[string]any{"code": "000000"}); a.status != 401 || a.str("code") != "wrong_code" || a.access() != "" {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if w.count("SELECT COUNT(*) FROM failed_sign_ins") != 1 {
		t.Fatal("a wrong code is a failed sign-in")
	}
	// The right one opens a session that says it passed.
	ok := w.signInWith("sami@example.com", map[string]any{"code": " " + current(t, secret) + " "})
	if ok.status != 200 || !w.claimsOf(ok).MFA {
		t.Fatalf("%d %v", ok.status, ok.body)
	}
	if w.count("SELECT COUNT(*) FROM failed_sign_ins") != 0 {
		t.Fatal("success clears the failures")
	}
}

func TestACodeWorksOnceEvenInsideItsClockWindow(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	code := current(t, secret)
	if a := w.signInWith("sami@example.com", map[string]any{"code": code}); a.status != 200 {
		t.Fatalf("first use: %d %v", a.status, a.body)
	}
	if a := w.signInWith("sami@example.com", map[string]any{"code": code}); a.status != 401 || a.str("code") != "wrong_code" {
		t.Fatalf("the same code again must be refused: %d %v", a.status, a.body)
	}
	// An earlier step is refused too; the next one is fine.
	if a := w.signInWith("sami@example.com", map[string]any{"code": codeAt(t, secret, time.Now().Add(-30*time.Second))}); a.status != 401 {
		t.Fatalf("an older code: %d", a.status)
	}
	if a := w.signInWith("sami@example.com", map[string]any{"code": codeAt(t, secret, time.Now().Add(30*time.Second))}); a.status != 200 {
		t.Fatalf("the next step: %d %v", a.status, a.body)
	}
}

func TestCodesFromTheWrongTimeOrShapeAreRefused(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	for name, code := range map[string]string{
		"two minutes old":  codeAt(t, secret, time.Now().Add(-2*time.Minute)),
		"two minutes away": codeAt(t, secret, time.Now().Add(2*time.Minute)),
		"too short":        "12345",
		"too long":         "1234567",
		"letters":          "abcdef",
	} {
		if a := w.signInWith("sami@example.com", map[string]any{"code": code}); a.status != 401 {
			t.Errorf("%s: %d", name, a.status)
		}
		w.s.db.Exec(context.Background(), "DELETE FROM failed_sign_ins")
	}
}

func TestRecoveryCodesWorkOnceAndOnlyForTheirOwner(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	_, done := w.addDevice(account.access(), "Phone")
	var codes []string
	for _, c := range done.body["recovery_codes"].([]any) {
		codes = append(codes, c.(string))
	}
	if len(codes) != 10 || len(codes[0]) != 23 || codes[0][5] != '-' {
		t.Fatalf("%v", codes)
	}
	if w.count("SELECT COUNT(*) FROM recovery_codes WHERE code_hash = $1", codes[0]) != 0 {
		t.Fatal("only hashes are kept")
	}
	// Typed with capitals and no dashes, it still works, once.
	typed := strings.ToUpper(strings.ReplaceAll(codes[0], "-", " "))
	if a := w.signInWith("sami@example.com", map[string]any{"code": typed}); a.status != 200 || !w.claimsOf(a).MFA {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if a := w.signInWith("sami@example.com", map[string]any{"code": codes[0]}); a.status != 401 {
		t.Fatalf("a second use: %d", a.status)
	}
	// Someone else's code is nothing.
	other := w.signUp("lina@example.com")
	_, otherDone := w.addDevice(other.access(), "Phone")
	theirs := otherDone.body["recovery_codes"].([]any)[0].(string)
	if a := w.signInWith("sami@example.com", map[string]any{"code": theirs}); a.status != 401 {
		t.Fatalf("another person's code: %d", a.status)
	}
	// Garbage.
	for _, bad := range []string{"----", "zzzzz-zzzzz-zzzzz-zzzzz", "abc"} {
		if a := w.signInWith("sami@example.com", map[string]any{"code": bad}); a.status != 401 {
			t.Errorf("%q: %d", bad, a.status)
		}
	}
}

func TestFiveWrongAnswersEndAChallengeEvenIfTheNextIsRight(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	challenge, _ := w.challengeFor("sami@example.com")
	for i := 0; i < 5; i++ {
		if a := w.answerChallenge(challenge, "totp", "000000"); a.status != 401 || a.str("code") != "wrong_code" {
			t.Fatalf("try %d: %d %v", i, a.status, a.body)
		}
		w.s.db.Exec(context.Background(), "DELETE FROM failed_sign_ins") // keep the email-wide lockout out of this test
	}
	if a := w.answerChallenge(challenge, "totp", current(t, secret)); a.status != 429 || a.str("code") != "too_many_attempts" || a.access() != "" {
		t.Fatalf("the sixth, right or not: %d %v", a.status, a.body)
	}
	if a := w.answerChallenge(challenge, "totp", current(t, secret)); a.status != 403 {
		t.Fatalf("and the challenge is gone: %d", a.status)
	}
}

func TestParallelGuessesCannotGetMoreThanFiveTries(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	challenge, _ := w.challengeFor("sami@example.com")
	results := make(chan int, 30)
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- w.answerChallenge(challenge, "totp", "000000").status
		}()
	}
	wg.Wait()
	close(results)
	wrong, limited, other := 0, 0, 0
	for status := range results {
		switch status {
		case 401:
			wrong++
		case 429, 403:
			limited++
		default:
			other++
		}
	}
	if wrong > maxTries || other != 0 {
		t.Fatalf("%d answers were looked at, %d refused outright, %d odd", wrong, limited, other)
	}
	if a := w.answerChallenge(challenge, "totp", current(t, secret)); a.access() != "" {
		t.Fatalf("a spent challenge must not open: %d", a.status)
	}
}

func TestTheChallengeOpensAFreshSessionOnce(t *testing.T) {
	w := newWorld(t)
	// The same right code sent several times at once opens exactly one session. The race is run many times, each with its own
	// account and challenge, so a test that passes by luck of timing fails here instead.
	//
	// As many answers as a challenge allows tries, no more: an answer over the limit ends the challenge (429), and when it lands
	// before the right one completes, nobody signs in. That is the safe outcome for the server, but it is not what this test checks.
	const rounds, answers = 30, maxTries
	var code string
	for round := 0; round < rounds; round++ {
		email := fmt.Sprintf("sami%d@example.com", round)
		account := w.signUp(email)
		secret, _ := w.addDevice(account.access(), "Phone")
		challenge, _ := w.challengeFor(email)
		code = current(t, secret)
		results := make(chan answer, answers)
		var wg sync.WaitGroup
		for i := 0; i < answers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results <- w.answerChallenge(challenge, "totp", code)
			}()
		}
		wg.Wait()
		close(results)
		ok := 0
		var statuses []int
		for a := range results {
			statuses = append(statuses, a.status)
			if a.status == 200 {
				ok++
				if c := w.claimsOf(a); !c.MFA || c.Provider != "password" {
					t.Fatalf("%+v", c)
				}
			}
		}
		if ok != 1 {
			t.Fatalf("round %d: %d sessions opened from one challenge (answers: %v)", round, ok, statuses)
		}
	}
	// A challenge that never existed, or has run out.
	if a := w.answerChallenge("nonsense", "totp", code); a.status != 403 {
		t.Fatalf("unknown: %d", a.status)
	}
	c2, _ := w.challengeFor("sami0@example.com")
	clock = func() time.Time { return time.Now().Add(11 * time.Minute) }
	if a := w.answerChallenge(c2, "totp", code); a.status != 403 || !strings.Contains(a.str("error"), "expired") {
		t.Fatalf("expired: %d %v", a.status, a.body)
	}
}

func TestAnAccountTurnedOffMidChallengeOpensNothing(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	challenge, _ := w.challengeFor("sami@example.com")
	w.s.db.Exec(context.Background(), "UPDATE users SET disabled_at = $1", now())
	if a := w.answerChallenge(challenge, "totp", current(t, secret)); a.status != 403 || a.access() != "" {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

// ---- the older step-up, and the hole that is closed ----

func TestVerifyIsTheOlderStepUpAndHasTheSameLimits(t *testing.T) {
	w := newWorld(t)
	first := w.signUp("sami@example.com")
	// A second session, opened before anything was set up.
	second := w.signInWith("sami@example.com", nil)
	secret, _ := w.addDevice(first.access(), "Phone")
	if c := w.claimsOf(second); c.MFA {
		t.Fatal("setup")
	}
	if a := w.call("POST", "/v1/mfa/verify", map[string]any{"code": "000000"}, second.access()); a.status != 401 || a.str("code") != "wrong_code" {
		t.Fatalf("wrong: %d %v", a.status, a.body)
	}
	ok := w.call("POST", "/v1/mfa/verify", map[string]any{"code": current(t, secret)}, second.access())
	if ok.status != 200 || !w.claimsOf(ok).MFA {
		t.Fatalf("%d %v", ok.status, ok.body)
	}
	if w.count("SELECT COUNT(*) FROM sessions WHERE mfa_passed = 1") != 2 {
		t.Fatal("the session itself remembers it passed")
	}
	// Nothing to verify against.
	lina := w.signUp("lina@example.com")
	if a := w.call("POST", "/v1/mfa/verify", map[string]any{"code": "123456"}, lina.access()); a.status != 400 {
		t.Fatalf("no second step set up: %d", a.status)
	}
}

func TestASessionThatNeverPassedASecondStepCannotAddAnAuthenticatorOfItsOwn(t *testing.T) {
	w := newWorld(t)
	first := w.signUp("sami@example.com")
	second := w.signInWith("sami@example.com", nil) // opened before anything is set up: never passes one
	w.addDevice(first.access(), "Phone")

	setup := w.call("POST", "/v1/mfa/totp/setup", nil, second.access())
	secret := setup.str("secret")
	a := w.call("POST", "/v1/mfa/totp/confirm", map[string]any{"code": current(t, secret), "label": "Mine"}, second.access())
	if a.status != 403 {
		t.Fatalf("it must not pick its own second step: %d %v", a.status, a.body)
	}
	if w.claimsOf(second).MFA || w.count("SELECT COUNT(*) FROM mfa_factors") != 1 || w.count("SELECT COUNT(*) FROM sessions WHERE mfa_passed = 1") != 1 {
		t.Fatal("nothing changed")
	}
	// The session that did pass can still add a device with the token it had before.
	if _, again := w.addDevice(first.access(), "Tablet"); again.status != 200 {
		t.Fatal("the legitimate session is not blocked")
	}
}

// ---- email codes ----

func TestACodeByEmailAnswersTheChallengeOnce(t *testing.T) {
	w := newWorld(t)
	account := w.confirmed("sami@example.com")
	w.addDevice(account.access(), "Phone")
	challenge, methods := w.challengeFor("sami@example.com")
	if !contains(methods, "totp") || !contains(methods, "email") {
		t.Fatalf("%v", methods)
	}
	if a := w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "email"}, ""); a.status != 200 || a.body["sent"] != true || a.body["expires_in"] != float64(600) {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if len(w.mail.codes) != 1 || w.mail.codeTo[0] != "sami@example.com" || len(w.mail.codes[0]) != 6 {
		t.Fatalf("%v %v", w.mail.codeTo, w.mail.codes)
	}
	code := w.mail.codes[0]
	if w.count("SELECT COUNT(*) FROM mfa_challenges WHERE code_hash = $1", code) != 0 {
		t.Fatal("only the hash of a code is kept")
	}
	// Asking again at once is refused, so nobody's inbox can be flooded.
	if a := w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "email"}, ""); a.status != 400 || len(w.mail.codes) != 1 {
		t.Fatalf("resend: %d %v", a.status, a.body)
	}
	if a := w.answerChallenge(challenge, "email", "000000"); a.status != 401 {
		t.Fatalf("wrong: %d", a.status)
	}
	if a := w.answerChallenge(challenge, "totp", code); a.status != 401 {
		t.Fatalf("the email code is not a totp code: %d", a.status)
	}
	ok := w.answerChallenge(challenge, "email", code)
	if ok.status != 200 || !w.claimsOf(ok).MFA {
		t.Fatalf("%d %v", ok.status, ok.body)
	}
	// And the challenge is spent.
	if a := w.answerChallenge(challenge, "email", code); a.status != 403 {
		t.Fatalf("reuse: %d", a.status)
	}
}

func TestAnEmailCodeExpiresAndWorksOnlyForItsOwnMethodAndChallenge(t *testing.T) {
	w := newWorld(t)
	account := w.confirmed("sami@example.com")
	w.addDevice(account.access(), "Phone")
	one, _ := w.challengeFor("sami@example.com")
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": one, "method": "email"}, "")
	code := w.mail.codes[0]
	// Another challenge of the same person cannot use it.
	two, _ := w.challengeFor("sami@example.com")
	if a := w.answerChallenge(two, "email", code); a.status != 401 {
		t.Fatalf("another challenge: %d", a.status)
	}
	clock = func() time.Time { return time.Now().Add(11 * time.Minute) }
	if a := w.answerChallenge(one, "email", code); a.status != 403 {
		t.Fatalf("after the challenge ran out: %d", a.status)
	}
}

func TestTwoAnswersWithOneEmailCodeOpenOneSession(t *testing.T) {
	w := newWorld(t)
	account := w.confirmed("sami@example.com")
	w.addDevice(account.access(), "Phone")
	challenge, _ := w.challengeFor("sami@example.com")
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "email"}, "")
	code := w.mail.codes[0]
	results := make(chan int, 6)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- w.answerChallenge(challenge, "email", code).status
		}()
	}
	wg.Wait()
	close(results)
	ok := 0
	for s := range results {
		if s == 200 {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d sessions", ok)
	}
}

func TestEmailIsNotOfferedWithoutAConfirmedAddressOrAMailServer(t *testing.T) {
	w := newWorld(t)
	w.withMail()
	account := w.signUp("sami@example.com") // not confirmed
	w.addDevice(account.access(), "Phone")
	challenge, methods := w.challengeFor("sami@example.com")
	if contains(methods, "email") {
		t.Fatalf("unconfirmed: %v", methods)
	}
	if a := w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "email"}, ""); a.status != 400 || len(w.mail.codes) != 0 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	// No mail server at all.
	w2 := newWorld(t)
	acc2 := w2.signUp("lee@example.com")
	w2.addDevice(acc2.access(), "Phone")
	if _, m := w2.challengeFor("lee@example.com"); contains(m, "email") {
		t.Fatalf("no mailer: %v", m)
	}
	// The way is checked even for a method nobody listed.
	if a := w2.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "carrier-pigeon"}, ""); a.status != 403 && a.status != 400 {
		t.Fatalf("%d", a.status)
	}
}

func TestASessionThatHasSetNothingUpStepsUpWithAnEmailCode(t *testing.T) {
	w := newWorld(t)
	account := w.confirmed("sami@example.com")
	start := w.call("POST", "/v1/mfa/challenge/start", nil, account.access())
	if start.status != 200 || start.str("challenge") == "" {
		t.Fatalf("%d %v", start.status, start.body)
	}
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": start.str("challenge"), "method": "email"}, "")
	got := w.answerChallenge(start.str("challenge"), "email", w.mail.codes[0])
	if got.status != 200 || got.str("refresh_token") != "" {
		t.Fatalf("a step-up gives a token for the same session, not a new one: %d %v", got.status, got.body)
	}
	before := w.claimsOf(account)
	after := w.claimsOf(got)
	if !after.MFA || after.SID != before.SID || after.AuthTime != before.AuthTime {
		t.Fatalf("%+v %+v", before, after)
	}
	if w.count("SELECT COUNT(*) FROM sessions WHERE id = $1 AND mfa_passed = 1", before.SID) != 1 {
		t.Fatal("the session remembers")
	}
	// A person with nothing available is told so.
	w2 := newWorld(t)
	lone := w2.signUp("lee@example.com")
	if a := w2.call("POST", "/v1/mfa/challenge/start", nil, lone.access()); a.status != 400 {
		t.Fatalf("nothing available: %d %v", a.status, a.body)
	}
	if a := w2.call("POST", "/v1/mfa/challenge/start", nil, ""); a.status != 401 {
		t.Fatalf("signed out: %d", a.status)
	}
}

// ---- approving on a device that is already signed in ----

func TestASignInIsApprovedOnADeviceThatIsAlreadySignedIn(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	trusted := w.signInWith("sami@example.com", map[string]any{"code": current(t, secret)}) // a session that has passed one
	challenge, methods := w.challengeFor("sami@example.com")
	if !contains(methods, "push") {
		t.Fatalf("%v", methods)
	}
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "push", "device": "  Chrome on Windows  "}, "")
	if s := w.call("POST", "/v1/mfa/challenge/status", map[string]any{"challenge": challenge}, ""); s.body["push"] != "pending" {
		t.Fatalf("%v", s.body)
	}
	waiting := w.call("GET", "/v1/mfa/approvals", nil, trusted.access())
	list, _ := waiting.body["approvals"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["device"] != "Chrome on Windows" {
		t.Fatalf("%v", waiting.body)
	}
	// Not approved yet: nothing opens.
	if a := w.answerChallenge(challenge, "push", ""); a.status != 401 {
		t.Fatalf("before approval: %d", a.status)
	}
	id := list[0].(map[string]any)["id"].(string)
	if a := w.call("POST", "/v1/mfa/approvals/"+id, map[string]any{"approve": true}, trusted.access()); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if s := w.call("POST", "/v1/mfa/challenge/status", map[string]any{"challenge": challenge}, ""); s.body["push"] != "approved" {
		t.Fatalf("%v", s.body)
	}
	ok := w.answerChallenge(challenge, "push", "")
	if ok.status != 200 || !w.claimsOf(ok).MFA {
		t.Fatalf("%d %v", ok.status, ok.body)
	}
	// An approval is decided once.
	if a := w.call("POST", "/v1/mfa/approvals/"+id, map[string]any{"approve": false}, trusted.access()); a.status != 403 {
		t.Fatalf("decided twice: %d", a.status)
	}
}

func TestAnApprovalIsNotUsableAfterItsTimeAndADenialOpensNothing(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	trusted := w.signInWith("sami@example.com", map[string]any{"code": current(t, secret)})

	denied, _ := w.challengeFor("sami@example.com")
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": denied, "method": "push"}, "")
	id := w.call("GET", "/v1/mfa/approvals", nil, trusted.access()).body["approvals"].([]any)[0].(map[string]any)["id"].(string)
	w.call("POST", "/v1/mfa/approvals/"+id, map[string]any{"approve": false}, trusted.access())
	if a := w.answerChallenge(denied, "push", ""); a.status != 403 || !strings.Contains(a.str("error"), "denied") || a.access() != "" {
		t.Fatalf("%d %v", a.status, a.body)
	}

	late, _ := w.challengeFor("sami@example.com")
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": late, "method": "push"}, "")
	id = w.call("GET", "/v1/mfa/approvals", nil, trusted.access()).body["approvals"].([]any)[0].(map[string]any)["id"].(string)
	w.call("POST", "/v1/mfa/approvals/"+id, map[string]any{"approve": true}, trusted.access())
	clock = func() time.Time { return time.Now().Add(6 * time.Minute) }
	if a := w.answerChallenge(late, "push", ""); a.status != 401 || a.access() != "" {
		t.Fatalf("approved too long ago: %d %v", a.status, a.body)
	}
	if s := w.call("POST", "/v1/mfa/challenge/status", map[string]any{"challenge": late}, ""); s.body["push"] != "approved" && s.body["push"] != "expired" {
		t.Fatalf("%v", s.body)
	}
}

func TestADeviceWithoutASecondStepCannotApproveAndSomeoneElsesApprovalIsNotYours(t *testing.T) {
	w := newWorld(t)
	sami := w.signUp("sami@example.com")
	secret, _ := w.addDevice(sami.access(), "Phone")
	trusted := w.signInWith("sami@example.com", map[string]any{"code": current(t, secret)})
	weak := w.signInWith("sami@example.com", map[string]any{"code": codeAt(t, secret, time.Now().Add(30*time.Second))})
	// (the session above passed one; one that did not is a plain one opened before setup)
	plain := w.signUp("lina@example.com")

	challenge, _ := w.challengeFor("sami@example.com")
	w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "push"}, "")
	id := w.call("GET", "/v1/mfa/approvals", nil, trusted.access()).body["approvals"].([]any)[0].(map[string]any)["id"].(string)
	if a := w.call("GET", "/v1/mfa/approvals", nil, plain.access()); a.status != 403 {
		t.Fatalf("a device that never passed a second step lists nothing: %d", a.status)
	}
	if a := w.call("POST", "/v1/mfa/approvals/"+id, map[string]any{"approve": true}, plain.access()); a.status != 403 {
		t.Fatalf("and cannot approve: %d", a.status)
	}
	// Someone else's session that did pass one still cannot decide Sami's request.
	lina2, _ := w.addDevice(plain.access(), "Phone")
	lina := w.signInWith("lina@example.com", map[string]any{"code": current(t, lina2)})
	if a := w.call("POST", "/v1/mfa/approvals/"+id, map[string]any{"approve": true}, lina.access()); a.status != 403 {
		t.Fatalf("someone else's: %d", a.status)
	}
	if s := w.call("POST", "/v1/mfa/challenge/status", map[string]any{"challenge": challenge}, ""); s.body["push"] != "pending" {
		t.Fatalf("it is still waiting: %v", s.body)
	}
	_ = weak
}

// ---- Telegram ----

func TestACodeByTelegramAfterLinkingTheChat(t *testing.T) {
	w := newWorld(t)
	tg := w.withTelegram()
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	trusted := w.signInWith("sami@example.com", map[string]any{"code": current(t, secret)})

	// Linking needs a session that passed a second step.
	if a := w.call("POST", "/v1/mfa/telegram/link", nil, account.access()); a.status != 403 {
		t.Fatalf("an unproven session: %d", a.status)
	}
	link := w.call("POST", "/v1/mfa/telegram/link", nil, trusted.access())
	url := link.str("url")
	if link.status != 200 || !strings.HasPrefix(url, "https://t.me/caller_whale_bot?start=") || link.body["expires_in"] != float64(600) {
		t.Fatalf("%d %v", link.status, link.body)
	}
	code := strings.TrimPrefix(url, "https://t.me/caller_whale_bot?start=")
	if w.count("SELECT COUNT(*) FROM telegram_links WHERE code_hash = $1", code) != 0 {
		t.Fatal("only the hash of a link code is kept")
	}
	update := func(secret, text string) answer {
		return w.call("POST", "/v1/mfa/telegram/webhook/"+secret, map[string]any{"update_id": 1, "message": map[string]any{"chat": map[string]any{"id": 4242}, "text": text}}, "")
	}
	// Only Telegram, with the secret, gets in; everyone else finds nothing.
	if a := update("wrong-secret", "/start "+code); a.status != 403 {
		t.Fatalf("wrong secret: %d", a.status)
	}
	if w.count("SELECT COUNT(*) FROM mfa_factors WHERE kind = 'telegram'") != 0 {
		t.Fatal("nothing was linked")
	}
	if a := update("hook-secret", "hello"); a.status != 200 || !strings.Contains(tg.last()[1], "open the link") {
		t.Fatalf("%d %v", a.status, tg.last())
	}
	if a := update("hook-secret", "/start deadbeefdeadbeef"); a.status != 200 || !strings.Contains(tg.last()[1], "expired") {
		t.Fatalf("an unknown link code: %d %v", a.status, tg.last())
	}
	if a := update("hook-secret", "/start "+code); a.status != 200 || tg.last() != [2]string{"4242", "Linked. Caller Whale will send your sign-in codes here."} {
		t.Fatalf("%d %v", a.status, tg.last())
	}
	// The link works once.
	if update("hook-secret", "/start "+code); !strings.Contains(tg.last()[1], "expired") {
		t.Fatalf("a second use: %v", tg.last())
	}
	// Now a sign-in can ask for a code there.
	challenge, methods := w.challengeFor("sami@example.com")
	if !contains(methods, "telegram") {
		t.Fatalf("%v", methods)
	}
	if a := w.call("POST", "/v1/mfa/challenge/send", map[string]any{"challenge": challenge, "method": "telegram"}, ""); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	sent := tg.last()
	if sent[0] != "4242" || !strings.Contains(sent[1], "is your Caller Whale code") {
		t.Fatalf("%v", sent)
	}
	got := strings.Fields(sent[1])[0]
	if a := w.answerChallenge(challenge, "email", got); a.status != 401 {
		t.Fatalf("a telegram code is not an email code: %d", a.status)
	}
	if ok := w.answerChallenge(challenge, "telegram", got); ok.status != 200 || !w.claimsOf(ok).MFA {
		t.Fatalf("%d %v", ok.status, ok.body)
	}
	// Linking again replaces the old chat.
	link2 := w.call("POST", "/v1/mfa/telegram/link", nil, trusted.access())
	update("hook-secret", "/start "+strings.TrimPrefix(link2.str("url"), "https://t.me/caller_whale_bot?start="))
	if w.count("SELECT COUNT(*) FROM mfa_factors WHERE kind = 'telegram'") != 1 {
		t.Fatal("one Telegram chat at most")
	}
}

func TestTelegramIsNotOfferedWithoutABot(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	trusted := w.signInWith("sami@example.com", map[string]any{"code": current(t, secret)})
	if a := w.call("POST", "/v1/mfa/telegram/link", nil, trusted.access()); a.status != 400 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	// A webhook with no secret configured answers nobody, even with an empty one in the address.
	if a := w.call("POST", "/v1/mfa/telegram/webhook/anything", map[string]any{}, ""); a.status != 403 {
		t.Fatalf("%d", a.status)
	}
	if f := w.call("GET", "/v1/mfa/factors", nil, trusted.access()); f.body["available"].(map[string]any)["telegram"] != false {
		t.Fatalf("%v", f.body)
	}
}

// ---- what the person has set up ----

func TestAWayIsRemovedOnlyAfterASecondStepAndOnlyYourOwn(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	signed := w.signInWith("sami@example.com", map[string]any{"code": current(t, secret)})
	factors := w.call("GET", "/v1/mfa/factors", nil, signed.access())
	list, _ := factors.body["factors"].([]any)
	if len(list) != 1 || factors.body["max_totp"] != float64(3) {
		t.Fatalf("%v", factors.body)
	}
	id := list[0].(map[string]any)["id"].(string)
	if kind := list[0].(map[string]any)["kind"]; kind != "totp" {
		t.Fatalf("%v", kind)
	}
	other := w.signUp("lee@example.com")
	if a := w.call("DELETE", "/v1/mfa/factors/"+id, nil, other.access()); a.status != 403 {
		t.Fatalf("no second step on that session: %d", a.status)
	}
	leeSecret, _ := w.addDevice(other.access(), "Phone")
	leeSigned := w.signInWith("lee@example.com", map[string]any{"code": current(t, leeSecret)})
	if a := w.call("DELETE", "/v1/mfa/factors/"+id, nil, leeSigned.access()); a.body["removed"] != float64(0) || w.count("SELECT COUNT(*) FROM mfa_factors WHERE id = $1", id) != 1 {
		t.Fatalf("someone else's: %v", a.body)
	}
	if a := w.call("DELETE", "/v1/mfa/factors/"+id, nil, account.access()); a.status != 403 {
		t.Fatalf("a session that has not passed: %d", a.status)
	}
	if a := w.call("DELETE", "/v1/mfa/factors/"+id, nil, signed.access()); a.status != 200 || a.body["removed"] != float64(1) {
		t.Fatalf("%d %v", a.status, a.body)
	}
	// With nothing left, a password is enough again.
	if a := w.signInWith("sami@example.com", nil); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

func TestTheFactorsListNeverShowsASecret(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	secret, _ := w.addDevice(account.access(), "Phone")
	raw, _ := json.Marshal(w.call("GET", "/v1/mfa/factors", nil, account.access()).body)
	if strings.Contains(string(raw), secret) {
		t.Fatal("the authenticator secret must never leave the service after setup")
	}
}

func TestTheOtpauthLinkAndSecretHaveTheShapeAppsRead(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("sami@example.com")
	setup := w.call("POST", "/v1/mfa/setup", nil, account.access()) // the older path answers too
	url := setup.str("otpauth_url")
	if len(setup.str("secret")) != 32 || !strings.Contains(url, "secret="+setup.str("secret")) || !strings.Contains(url, "digits=6") || !strings.Contains(url, "period=30") || !strings.Contains(url, "sami%40example.com") {
		t.Fatalf("%v", setup.body)
	}
}
