package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func newOAuthWorld(t *testing.T) (*world, *fakeProvider) {
	t.Helper()
	p := newFakeProvider(t)
	w := newWorld(t, func(c *config) {
		c.publicURL, c.websiteURL, c.appURL, c.landingURL = "http://auth.example", "http://website.example", "http://app.example", "http://landing.example"
		endpoints := provider{authURL: p.srv.URL + "/authorize", tokenURL: p.srv.URL + "/token", jwksURL: p.srv.URL + "/jwks", issuer: p.srv.URL}
		c.google = endpoints
		c.google.clientID, c.google.clientSecret = "google-test-client", "google-test-secret"
		c.apple = endpoints
		c.apple.clientID, c.apple.teamID, c.apple.keyID, c.apple.privateKey = "apple-test-client", "TEAMTEST01", "KEYTEST001", p.providerPEM(t)
	})
	return w, p
}

// location makes a request that is answered with a redirect and returns where it goes.
func (w *world) location(method, path string, form url.Values) (int, string) {
	w.t.Helper()
	var req *http.Request
	if method == http.MethodPost {
		req = httptest.NewRequest(method, path, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	rec := httptest.NewRecorder()
	w.h.ServeHTTP(rec, req)
	return rec.Code, rec.Header().Get("Location")
}

func param(location, name string) string {
	u, err := url.Parse(location)
	if err != nil {
		return ""
	}
	return u.Query().Get(name)
}

// signInVia starts a sign-in, comes back from the provider with these claims ("nonce": true uses the right nonce) and answers where
// the browser is sent at the end.
func (w *world) signInVia(name, query string, claims map[string]any, appleUser string) string {
	w.t.Helper()
	status, to := w.location("GET", "/v1/oauth/"+name+"/start?"+query, nil)
	if status != http.StatusSeeOther {
		w.t.Fatalf("start sends the browser to the provider: %d %q", status, to)
	}
	state := param(to, "state")
	if claims["nonce"] == true {
		claims["nonce"] = param(to, "nonce")
	}
	code := codeFor(claims)
	var landed string
	if name == "apple" {
		form := url.Values{"code": {code}, "state": {state}}
		if appleUser != "" {
			form.Set("user", appleUser)
		}
		_, landed = w.location("POST", "/v1/oauth/apple/callback", form)
	} else {
		_, landed = w.location("GET", "/v1/oauth/google/callback?"+url.Values{"code": {code}, "state": {state}}.Encode(), nil)
	}
	return landed
}

func (w *world) exchange(code string) answer {
	return w.call("POST", "/v1/oauth/exchange", map[string]any{"code": code}, "")
}

func mona() map[string]any {
	return map[string]any{"sub": "g-100", "email": "Mona@Example.com", "email_verified": true, "name": "Mona Adel", "nonce": true}
}

func TestProviderLinkStartIsBoundToTheCurrentSession(t *testing.T) {
	w, _ := newOAuthWorld(t)
	account := w.signUp("link@example.com")
	if a := w.call("POST", "/v1/me/providers/apple/start", nil, ""); a.status != 401 {
		t.Fatalf("anonymous link start: %d", a.status)
	}
	started := w.call("POST", "/v1/me/providers/apple/start", nil, account.access())
	if started.status != 200 || started.str("url") == "" {
		t.Fatalf("link start: %d %v", started.status, started.body)
	}
	state := param(started.str("url"), "state")
	var linked, session string
	if err := w.s.db.QueryRow(context.Background(), "SELECT link_user_id, link_session_id FROM oauth_states WHERE state_hash = $1", sha256Hex(state)).Scan(&linked, &session); err != nil {
		t.Fatal(err)
	}
	if linked == "" || session == "" || w.count("SELECT COUNT(*) FROM sessions WHERE id = $1 AND user_id = $2", session, linked) != 1 {
		t.Fatalf("link was not tied to the signed-in session")
	}
}

func TestAppleLinkKeepsTheExistingAccount(t *testing.T) {
	w, _ := newOAuthWorld(t)
	account := w.signUp("link@example.com")
	before := w.call("GET", "/v1/me", nil, account.access())
	started := w.call("POST", "/v1/me/providers/apple/start", nil, account.access())
	if started.status != 200 {
		t.Fatalf("start link: %d %v", started.status, started.body)
	}
	to := started.str("url")
	claim := map[string]any{"sub": "apple-link-1", "email": "link@example.com", "email_verified": true, "nonce": param(to, "nonce")}
	code := codeFor(claim)
	_, landed := w.location("POST", "/v1/oauth/apple/callback", url.Values{"code": {code}, "state": {param(to, "state")}})
	if param(landed, "linked") != "apple" || param(landed, "callerwhale_code") != "" {
		t.Fatalf("link callback: %s", landed)
	}
	after := w.call("GET", "/v1/me", nil, account.access())
	if after.body["id"] != before.body["id"] {
		t.Fatalf("link changed account: %v %v", before.body, after.body)
	}
	providers := w.call("GET", "/v1/me/providers", nil, account.access())
	if providers.status != 200 || !contains(toStrings(providers.body["providers"]), "apple") {
		t.Fatalf("linked methods: %d %v", providers.status, providers.body)
	}
}

func TestGoogleSignUpThenSignInAgainAsTheSamePerson(t *testing.T) {
	w, _ := newOAuthWorld(t)
	if a := w.call("GET", "/v1/providers", nil, ""); a.body["google"] != true || a.body["apple"] != true {
		t.Fatalf("%v", a.body)
	}
	// The address sent to Google carries PKCE, the nonce and a state, and comes back to this service.
	status, to := w.location("GET", "/v1/oauth/google/start", nil)
	pu, _ := url.Parse(to)
	if status != 303 || !strings.HasPrefix(to, pu.Scheme+"://"+pu.Host+"/authorize?") || param(to, "code_challenge_method") != "S256" || param(to, "code_challenge") == "" ||
		param(to, "redirect_uri") != "http://auth.example/v1/oauth/google/callback" || param(to, "client_id") != "google-test-client" || param(to, "response_type") != "code" ||
		param(to, "nonce") == "" || param(to, "state") == "" || !strings.Contains(param(to, "scope"), "openid") || param(to, "prompt") != "select_account" {
		t.Fatalf("%d %s", status, to)
	}
	if w.count("SELECT COUNT(*) FROM oauth_states WHERE state_hash = $1", sha256Hex(param(to, "state"))) != 1 || w.count("SELECT COUNT(*) FROM oauth_states WHERE state_hash = $1", param(to, "state")) != 0 {
		t.Fatal("only the hash of a state is kept")
	}

	landed := w.signInVia("google", "", mona(), "")
	if !strings.HasPrefix(landed, "http://website.example/?callerwhale_code=") || !strings.HasSuffix(landed, "#/account") {
		t.Fatalf("%s", landed)
	}
	code := param(landed, "callerwhale_code")
	first := w.exchange(code)
	user, _ := first.body["user"].(map[string]any)
	if first.status != 200 || user["email"] != "mona@example.com" || user["name"] != "Mona Adel" {
		t.Fatalf("%d %v", first.status, first.body)
	}
	if c := w.claimsOf(first); !c.EmailVerified || c.Provider != "google" || c.MFA {
		t.Fatalf("%+v", c)
	}
	// The code works once.
	if a := w.exchange(code); a.status != 403 {
		t.Fatalf("second use: %d", a.status)
	}
	// Signing in again is the same account.
	again := w.signInVia("google", "target=app", mona(), "")
	if !strings.HasPrefix(again, "http://app.example/?callerwhale_code=") {
		t.Fatalf("%s", again)
	}
	second := w.exchange(param(again, "callerwhale_code"))
	if second.body["user"].(map[string]any)["id"] != user["id"] {
		t.Fatalf("%v %v", second.body, user)
	}
	// A password does not work for an account made with Google.
	if a := w.call("POST", "/v1/sessions", map[string]any{"email": "mona@example.com", "password": noPassword}, ""); a.status != 401 {
		t.Fatalf("%d", a.status)
	}
	// What Firebase was handed is the provider's own token, never something we made.
	if len(w.fb.idpTokens) != 2 {
		t.Fatalf("%d", len(w.fb.idpTokens))
	}
}

func TestGoogleLinksAnExistingPasswordAccountAndConfirmsItsEmail(t *testing.T) {
	w, _ := newOAuthWorld(t)
	made := w.signUp("mona@example.com")
	if w.claimsOf(made).EmailVerified {
		t.Fatal("setup")
	}
	landed := w.signInVia("google", "", mona(), "")
	linked := w.exchange(param(landed, "callerwhale_code"))
	if linked.body["user"].(map[string]any)["id"] != made.body["user"].(map[string]any)["id"] {
		t.Fatalf("one person, one account: %v", linked.body)
	}
	if !w.claimsOf(linked).EmailVerified {
		t.Fatal("Google confirmed the address")
	}
	// The password still works too.
	if a := w.signInWith("mona@example.com", nil); a.status != 200 {
		t.Fatalf("%d", a.status)
	}
}

func TestEachTargetGoesBackWhereItBelongs(t *testing.T) {
	w, _ := newOAuthWorld(t)
	for query, prefix := range map[string]string{
		"":                          "http://website.example/?callerwhale_code=",
		"target=website":            "http://website.example/?callerwhale_code=",
		"target=nonsense":           "http://website.example/?callerwhale_code=",
		"target=app":                "http://app.example/?callerwhale_code=",
		"target=landing":            "http://landing.example/signin?callerwhale_code=",
		"target=desktop&port=48123": "http://127.0.0.1:48123/callerwhale-sign-in?code=",
	} {
		if landed := w.signInVia("google", query, mona(), ""); !strings.HasPrefix(landed, prefix) {
			t.Errorf("%q -> %s", query, landed)
		}
	}
	// The desktop's session is a desktop session; nobody can send the result anywhere but this computer.
	landed := w.signInVia("google", "target=desktop&port=48123", mona(), "")
	got := w.exchange(param(landed, "code"))
	list := w.call("GET", "/v1/sessions", nil, got.access())
	if sessions, _ := list.body["sessions"].([]any); sessions[0].(map[string]any)["kind"] != "desktop" {
		t.Fatalf("%v", list.body)
	}
	for _, query := range []string{"target=desktop", "target=desktop&port=80", "target=desktop&port=70000", "target=desktop&port=abc"} {
		if status, _ := w.location("GET", "/v1/oauth/google/start?"+query, nil); status == 303 {
			t.Errorf("%q must not start", query)
		}
	}
	if a := w.call("GET", "/v1/oauth/google/start?target=desktop&port=80", nil, ""); a.status != 400 {
		t.Fatalf("%d", a.status)
	}
	// A failed desktop sign-in still goes only to this computer.
	_, to := w.location("GET", "/v1/oauth/google/start?target=desktop&port=48123", nil)
	_, failed := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"error": {"access_denied"}, "state": {param(to, "state")}}.Encode(), nil)
	if !strings.HasPrefix(failed, "http://127.0.0.1:48123/callerwhale-sign-in?error=") {
		t.Fatalf("%s", failed)
	}
}

func TestSignInsThatDoNotCheckOutAreRefusedAndOpenNothing(t *testing.T) {
	cases := map[string]struct {
		claims map[string]any
		change func(*fakeProvider)
		want   string
	}{
		"wrong nonce":       {map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": "somebody-elses"}, nil, "not for this sign-in"},
		"no nonce":          {map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": true}, nil, "not for this sign-in"},
		"unconfirmed email": {map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": false, "nonce": true}, nil, "no confirmed email"},
		"no email":          {map[string]any{"sub": "g-1", "email_verified": true, "nonce": true}, nil, "no confirmed email"},
		"another audience":  {mona(), func(p *fakeProvider) { p.mutate = func(c map[string]any) { c["aud"] = "someone-elses-client" } }, "did not check out"},
		"another issuer":    {mona(), func(p *fakeProvider) { p.mutate = func(c map[string]any) { c["iss"] = "https://evil.example" } }, "did not check out"},
		"expired": {mona(), func(p *fakeProvider) {
			p.mutate = func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() }
		}, "did not check out"},
		"a key it never published": {map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": true, "_other_key": true}, nil, "did not check out"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			w, p := newOAuthWorld(t)
			if c.change != nil {
				c.change(p)
			}
			landed := w.signInVia("google", "", c.claims, "")
			if param(landed, "callerwhale_code") != "" || !strings.Contains(param(landed, "oauth_error"), c.want) {
				t.Fatalf("%s", landed)
			}
			if !strings.HasSuffix(landed, "#/signin") {
				t.Fatalf("a failure goes back to the sign-in page: %s", landed)
			}
			if w.count("SELECT COUNT(*) FROM oauth_handoffs") != 0 || w.count("SELECT COUNT(*) FROM sessions") != 0 || w.count("SELECT COUNT(*) FROM users") != 0 {
				t.Fatal("nothing may be opened")
			}
			if len(w.fb.idpTokens) != 0 {
				t.Fatal("Firebase must never be handed a token that did not check out")
			}
		})
	}
}

func TestAStateWorksOnceAndOnlyForItsOwnProviderAndTime(t *testing.T) {
	w, _ := newOAuthWorld(t)
	_, to := w.location("GET", "/v1/oauth/google/start", nil)
	state := param(to, "state")
	good := codeFor(map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": param(to, "nonce")})
	// Google's state used at Apple's door.
	if _, landed := w.location("POST", "/v1/oauth/apple/callback", url.Values{"code": {good}, "state": {state}}); !strings.Contains(param(landed, "oauth_error"), "expired") {
		t.Fatalf("another provider: %s", landed)
	}
	// And the state is gone for good, even for the right provider.
	if _, landed := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"code": {good}, "state": {state}}.Encode(), nil); !strings.Contains(param(landed, "oauth_error"), "expired") {
		t.Fatalf("after being tried: %s", landed)
	}
	// Forged, empty, missing.
	for _, q := range []string{"code=x&state=forged", "code=x&state=", "code=x", ""} {
		if _, landed := w.location("GET", "/v1/oauth/google/callback?"+q, nil); !strings.Contains(param(landed, "oauth_error"), "expired") {
			t.Errorf("%q: %s", q, landed)
		}
	}
	// A state that ran out.
	_, to = w.location("GET", "/v1/oauth/google/start", nil)
	clock = func() time.Time { return time.Now().Add(11 * time.Minute) }
	good = codeFor(map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": param(to, "nonce")})
	if _, landed := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"code": {good}, "state": {param(to, "state")}}.Encode(), nil); !strings.Contains(param(landed, "oauth_error"), "expired") {
		t.Fatalf("after ten minutes: %s", landed)
	}
	if w.count("SELECT COUNT(*) FROM users") != 0 {
		t.Fatal("none of these made an account")
	}
}

func TestTwoCallbacksWithOneStateSignInOnce(t *testing.T) {
	w, _ := newOAuthWorld(t)
	_, to := w.location("GET", "/v1/oauth/google/start", nil)
	code := codeFor(map[string]any{"sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": param(to, "nonce")})
	results := make(chan string, 6)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, landed := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"code": {code}, "state": {param(to, "state")}}.Encode(), nil)
			results <- landed
		}()
	}
	wg.Wait()
	close(results)
	ok := 0
	for landed := range results {
		if param(landed, "callerwhale_code") != "" {
			ok++
		}
	}
	if ok != 1 || w.count("SELECT COUNT(*) FROM oauth_handoffs") != 1 {
		t.Fatalf("%d sign-ins from one state", ok)
	}
}

func TestACancelledOrBrokenProviderIsAPlainMessage(t *testing.T) {
	w, p := newOAuthWorld(t)
	_, to := w.location("GET", "/v1/oauth/google/start", nil)
	_, landed := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"error": {"access_denied"}, "state": {param(to, "state")}}.Encode(), nil)
	if param(landed, "oauth_error") != "Sign-in was cancelled." {
		t.Fatalf("%s", landed)
	}
	// The provider's token endpoint is down: our sentence, no provider text, nothing opened.
	p.down = true
	landed = w.signInVia("google", "", mona(), "")
	if param(landed, "oauth_error") != "Google sign-in did not work. Try again in a moment." || w.count("SELECT COUNT(*) FROM users") != 0 {
		t.Fatalf("%s", landed)
	}
	p.down = false
	// Firebase refusing the token is the same plain message.
	w.fb.idpDown = true
	landed = w.signInVia("google", "", mona(), "")
	if param(landed, "oauth_error") == "" || param(landed, "callerwhale_code") != "" {
		t.Fatalf("%s", landed)
	}
}

func TestAppleSignInPostsBackWithANameTheFirstTime(t *testing.T) {
	w, p := newOAuthWorld(t)
	_, to := w.location("GET", "/v1/oauth/apple/start", nil)
	if param(to, "response_mode") != "form_post" || param(to, "scope") != "name email" || param(to, "code_challenge") != "" || param(to, "client_id") != "apple-test-client" {
		t.Fatalf("%s", to)
	}
	if len(param(to, "nonce")) != 64 {
		t.Fatalf("Apple is sent the hash of the nonce: %q", param(to, "nonce"))
	}
	claims := map[string]any{"sub": "a-7", "email": "lee@example.com", "email_verified": "true", "nonce": true}
	landed := w.signInVia("apple", "", claims, `{"name":{"firstName":"Lee","lastName":"Hana"},"email":"lee@example.com"}`)
	got := w.exchange(param(landed, "callerwhale_code"))
	if got.status != 200 || got.body["user"].(map[string]any)["name"] != "Lee Hana" || w.claimsOf(got).Provider != "apple" || !w.claimsOf(got).EmailVerified {
		t.Fatalf("%d %v", got.status, got.body)
	}
	p.mu.Lock()
	secretOK := p.secretOK
	p.mu.Unlock()
	if !secretOK {
		t.Fatal("the client secret is a JWT signed with the team's key (ES256, team as issuer, client as subject, kid)")
	}
	// Firebase gets the raw nonce, Apple's token the hash.
	if len(w.fb.idpNonces) != 1 || len(w.fb.idpNonces[0]) != 64 || sha256Hex(w.fb.idpNonces[0]) == "" {
		t.Fatalf("%v", w.fb.idpNonces)
	}
	if sha256Hex(w.fb.idpNonces[0]) == w.fb.idpNonces[0] {
		t.Fatal("setup")
	}
	// Apple tells the name once: the second time has none and the first one stays.
	again := w.signInVia("apple", "", map[string]any{"sub": "a-7", "email": "lee@example.com", "email_verified": "true", "nonce": true}, "")
	if g := w.exchange(param(again, "callerwhale_code")); g.body["user"].(map[string]any)["name"] != "Lee Hana" {
		t.Fatalf("%v", g.body)
	}
	// Apple's flag as a real boolean works too, and "false" does not.
	if l := w.signInVia("apple", "", map[string]any{"sub": "a-8", "email": "kim@example.com", "email_verified": true, "nonce": true}, ""); param(l, "callerwhale_code") == "" {
		t.Fatalf("%s", l)
	}
	if l := w.signInVia("apple", "", map[string]any{"sub": "a-9", "email": "ray@example.com", "email_verified": "false", "nonce": true}, ""); param(l, "callerwhale_code") != "" {
		t.Fatalf("%s", l)
	}
}

func TestAnAccountTurnedOffCannotSignInWithAProvider(t *testing.T) {
	w, _ := newOAuthWorld(t)
	landed := w.signInVia("google", "", mona(), "")
	w.exchange(param(landed, "callerwhale_code"))
	w.fb.accounts["mona@example.com"].disabled = true
	if l := w.signInVia("google", "", mona(), ""); param(l, "callerwhale_code") != "" || param(l, "oauth_error") == "" {
		t.Fatalf("disabled in Firebase: %s", l)
	}
	w.fb.accounts["mona@example.com"].disabled = false
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET disabled_at = $1", now()); err != nil {
		t.Fatal(err)
	}
	if l := w.signInVia("google", "", mona(), ""); param(l, "callerwhale_code") != "" || !strings.Contains(param(l, "oauth_error"), "disabled") {
		t.Fatalf("disabled here: %s", l)
	}
	// Turned off after the sign-in finished but before the code was used.
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET disabled_at = NULL"); err != nil {
		t.Fatal(err)
	}
	landed = w.signInVia("google", "", mona(), "")
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET disabled_at = $1", now()); err != nil {
		t.Fatal(err)
	}
	if a := w.exchange(param(landed, "callerwhale_code")); a.status != 403 || a.access() != "" {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

func TestAProviderFirebaseOwnsGoesThroughFirebase(t *testing.T) {
	w := newWorld(t, func(c *config) {
		c.publicURL, c.websiteURL, c.appURL = "http://auth.example", "http://website.example", "http://app.example"
	})
	// No client of our own and Firebase not set up for it: off, and starting says so.
	if a := w.call("GET", "/v1/providers", nil, ""); a.body["google"] != false || a.body["apple"] != false {
		t.Fatalf("%v", a.body)
	}
	if a := w.call("GET", "/v1/oauth/google/start", nil, ""); a.status != 400 || !strings.Contains(a.str("error"), "unavailable") {
		t.Fatalf("%d %v", a.status, a.body)
	}
	w.fb.brokered, w.fb.brokeredEmail = true, "Nora@Example.com"
	w.s.seen.Range(func(k, _ any) bool { w.s.seen.Delete(k); return true })
	if a := w.call("GET", "/v1/providers", nil, ""); a.body["google"] != true {
		t.Fatalf("%v", a.body)
	}
	status, to := w.location("GET", "/v1/oauth/google/start?target=app", nil)
	if status != 303 || !strings.HasPrefix(to, "https://accounts.google.com/") {
		t.Fatalf("%d %s", status, to)
	}
	state := param(to, "state")
	if !strings.HasPrefix(state, "fbstate-") {
		t.Fatalf("%s", state)
	}
	_, landed := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"code": {"provider-code"}, "state": {state}}.Encode(), nil)
	if !strings.HasPrefix(landed, "http://app.example/?callerwhale_code=") {
		t.Fatalf("%s", landed)
	}
	got := w.exchange(param(landed, "callerwhale_code"))
	if got.status != 200 || got.body["user"].(map[string]any)["email"] != "nora@example.com" || !w.claimsOf(got).EmailVerified {
		t.Fatalf("%d %v", got.status, got.body)
	}
	// The state is for that provider and once.
	if _, again := w.location("GET", "/v1/oauth/google/callback?"+url.Values{"code": {"provider-code"}, "state": {state}}.Encode(), nil); !strings.Contains(param(again, "oauth_error"), "expired") {
		t.Fatalf("%s", again)
	}
}

func TestStartingByPostAnswersWithTheAddress(t *testing.T) {
	w, _ := newOAuthWorld(t)
	a := w.call("POST", "/v1/oauth/google/start", map[string]any{"target": "landing", "human_token": "checked at the gateway", "action": "signup"}, "")
	if a.status != 200 || !strings.Contains(a.str("url"), "/authorize?") || w.count("SELECT COUNT(*) FROM oauth_states WHERE target = 'landing'") != 1 {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/oauth/google/start", map[string]any{"action": "transfer"}, ""); a.status != 400 {
		t.Fatalf("%d", a.status)
	}
	if a := w.call("POST", "/v1/oauth/github/start", map[string]any{}, ""); a.status != 400 {
		t.Fatalf("an unknown provider: %d", a.status)
	}
	if a := w.call("POST", "/v1/oauth/desktop/start", map[string]any{"target": "desktop"}, ""); a.status != 400 {
		t.Fatalf("%d", a.status)
	}
	if a := w.call("POST", "/v1/oauth/google/start", map[string]any{"target": "desktop", "port": 48123}, ""); a.status != 200 {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

// ---- the desktop handoff ----

func TestABrowserSignInIsHandedToTheDesktopAppOnce(t *testing.T) {
	w, _ := newOAuthWorld(t)
	if a := w.call("POST", "/v1/handoffs", map[string]any{}, ""); a.status != 401 {
		t.Fatalf("not signed in: %d", a.status)
	}
	made := w.signUp("mona@example.com")
	handed := w.call("POST", "/v1/handoffs", map[string]any{}, made.access())
	code := handed.str("code")
	if handed.status != 200 || code == "" {
		t.Fatalf("%d %v", handed.status, handed.body)
	}
	if w.count("SELECT COUNT(*) FROM oauth_handoffs WHERE code_hash = $1", code) != 0 {
		t.Fatal("only the hash of the code is kept")
	}
	desktop := w.exchange(code)
	if desktop.status != 200 || desktop.access() == made.access() || w.claimsOf(desktop).Provider != "password" {
		t.Fatalf("%d %v", desktop.status, desktop.body)
	}
	if w.count("SELECT COUNT(*) FROM sessions WHERE kind = 'desktop'") != 1 {
		t.Fatal("the app gets a session of its own")
	}
	if a := w.exchange(code); a.status != 403 {
		t.Fatalf("second use: %d", a.status)
	}
	if a := w.call("GET", "/v1/me", nil, made.access()); a.status != 200 {
		t.Fatal("the browser's own session is untouched")
	}
	// Only two minutes.
	late := w.call("POST", "/v1/handoffs", map[string]any{}, made.access()).str("code")
	clock = func() time.Time { return time.Now().Add(3 * time.Minute) }
	if a := w.exchange(late); a.status != 403 {
		t.Fatalf("after two minutes: %d", a.status)
	}
	if a := w.exchange("nonsense"); a.status != 403 {
		t.Fatalf("garbage: %d", a.status)
	}
}

func TestAHandedOverSignInKeepsWhatTheSessionPassed(t *testing.T) {
	w, _ := newOAuthWorld(t)
	first := w.signUp("mona@example.com")
	second := w.signInWith("mona@example.com", nil) // opened before a second step existed: never passes one
	secret, _ := w.addDevice(first.access(), "Phone")
	// The first session passed one (reading the session, not its older token); the second did not.
	passed := w.exchange(w.call("POST", "/v1/handoffs", map[string]any{}, first.access()).str("code"))
	if !w.claimsOf(passed).MFA {
		t.Fatal("a session that passed a second step hands over one that did")
	}
	notPassed := w.exchange(w.call("POST", "/v1/handoffs", map[string]any{}, second.access()).str("code"))
	if w.claimsOf(notPassed).MFA {
		t.Fatal("a session that never passed one must not hand over one that did")
	}
	// The handed-over session can pass the second step itself.
	step := w.call("POST", "/v1/mfa/verify", map[string]any{"code": current(t, secret)}, notPassed.access())
	if step.status != 200 || !w.claimsOf(step).MFA {
		t.Fatalf("%d %v", step.status, step.body)
	}
}

func TestAProviderSignInStepsUpWithTheAuthenticatorCode(t *testing.T) {
	w, _ := newOAuthWorld(t)
	made := w.signUp("mona@example.com")
	secret, _ := w.addDevice(made.access(), "Phone")
	// Google does not pass the second step: the session says so, and a step-up on it does.
	landed := w.signInVia("google", "", mona(), "")
	google := w.exchange(param(landed, "callerwhale_code"))
	if google.status != 200 || w.claimsOf(google).MFA || w.claimsOf(google).Provider != "google" {
		t.Fatalf("%d %+v", google.status, w.claimsOf(google))
	}
	if a := w.call("POST", "/v1/mfa/verify", map[string]any{"code": "000000"}, google.access()); a.status != 401 {
		t.Fatalf("wrong code: %d", a.status)
	}
	stepped := w.call("POST", "/v1/mfa/verify", map[string]any{"code": current(t, secret)}, google.access())
	if c := w.claimsOf(stepped); stepped.status != 200 || !c.MFA || c.Provider != "google" {
		t.Fatalf("%d %+v", stepped.status, c)
	}
	// Later tokens for the same session keep it.
	next := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": google.refresh()}, "")
	if c := w.claimsOf(next); !c.MFA || c.Provider != "google" {
		t.Fatalf("%+v", c)
	}
	// The same person may also use the challenge route, which is what the apps use.
	again := w.exchange(param(w.signInVia("google", "", mona(), ""), "callerwhale_code"))
	start := w.call("POST", "/v1/mfa/challenge/start", nil, again.access())
	if start.status != 200 || !contains(toStrings(start.body["methods"]), "totp") {
		t.Fatalf("%d %v", start.status, start.body)
	}
	if a := w.answerChallenge(start.str("challenge"), "totp", codeAt(t, secret, time.Now().Add(30*time.Second))); a.status != 200 || !w.claimsOf(a).MFA || a.refresh() != "" {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

func toStrings(v any) []string {
	var out []string
	list, _ := v.([]any)
	for _, x := range list {
		out = append(out, x.(string))
	}
	return out
}

func TestConfirmationTokensAreNeverShownOutsideDevelopment(t *testing.T) {
	w := newWorld(t) // devTokens is off
	w.withMail()
	made := w.signUp("sami@example.com")
	if _, shown := made.body["verification_token"]; shown {
		t.Fatalf("%v", made.body)
	}
	clock = func() time.Time { return time.Now().Add(2 * time.Minute) }
	resent := w.call("POST", "/v1/email/resend", nil, made.access())
	if resent.status != 200 || resent.body["sent"] != true {
		t.Fatalf("%d %v", resent.status, resent.body)
	}
	if _, shown := resent.body["verification_token"]; shown {
		t.Fatalf("the token only ever goes by email: %v", resent.body)
	}
}
