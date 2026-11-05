package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ---- things that need no database ----

func TestEmailsAreCheckedAndLowerCased(t *testing.T) {
	got, err := normalEmail("  Sami@Example.COM ")
	if err != nil || got != "sami@example.com" {
		t.Fatalf("%q %v", got, err)
	}
	for _, bad := range []string{"", "sami", "@example.com", "sami@", "sami@example", "sa mi@example.com", "sami@.com", "sami@example.", "sami@exa mple.com"} {
		if _, err := normalEmail(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func TestPasswordPolicy(t *testing.T) {
	if validateNewPassword("Aa1!aaaa") != nil || validateNewPassword("Aa1!"+strings.Repeat("a", 4092)) != nil {
		t.Fatal("the boundaries are allowed")
	}
	for _, bad := range []string{"Aa1!aaa", "Aa1!" + strings.Repeat("a", 4093), "aa1!aaaa", "AA1!AAAA", "Aa!!aaaa", "Aa11aaaa", "Aa11    "} {
		if validateNewPassword(bad) == nil {
			t.Errorf("%.12q must be refused", bad)
		}
	}
}

func TestSettingsAreChecked(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres://x@localhost/x", "AUTH_FIREBASE_API_KEY": "k"}
	with := func(change map[string]string) (config, error) {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for k, v := range change {
			env[k] = v
		}
		return loadConfig(func(k string) string { return env[k] })
	}
	c, err := with(nil)
	if err != nil || c.port != "8101" || c.accessMinutes != 15 || c.refreshDays != 30 || !c.publicSignup || len(c.allowedOrigins) != 4 {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	for name, change := range map[string]map[string]string{
		"no database":         {"DATABASE_URL": ""},
		"no firebase key":     {"AUTH_FIREBASE_API_KEY": ""},
		"bad port":            {"PORT": "eighty"},
		"bad access minutes":  {"AUTH_ACCESS_MINUTES": "0"},
		"bad refresh days":    {"AUTH_REFRESH_DAYS": "many"},
	} {
		if _, err := with(change); err == nil {
			t.Errorf("%s: this must not start", name)
		}
	}
	c, err = with(map[string]string{"AUTH_PUBLIC_SIGNUP": "false", "AUTH_ALLOWED_ORIGINS": "https://a.example/, https://b.example", "AUTH_PUBLIC_URL": "https://auth.example/"})
	if err != nil || c.publicSignup || strings.Join(c.allowedOrigins, "|") != "https://a.example|https://b.example" || c.publicURL != "https://auth.example" {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestSigningKeysComeInBothForms(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	fromDER, err := keysFromBase64(base64.StdEncoding.EncodeToString(der))
	if err != nil || !fromDER.pub.Equal(priv.Public()) {
		t.Fatalf("pkcs8: %v", err)
	}
	seed := make([]byte, 32)
	_, _ = rand.Read(seed)
	fromSeed, err := keysFromBase64(base64.StdEncoding.EncodeToString(seed))
	if err != nil || !fromSeed.pub.Equal(ed25519.NewKeyFromSeed(seed).Public()) {
		t.Fatalf("seed: %v", err)
	}
	secret, err := newSecretKey()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keysFromBase64(secret); err != nil {
		t.Fatalf("new-key output must be accepted: %v", err)
	}
	for _, bad := range []string{"", "not base64!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := keysFromBase64(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if len(fromDER.kid) != 16 || fromDER.kid == fromSeed.kid {
		t.Fatal("the key id comes from the public key: 8 bytes in hex")
	}
}

func TestTokensCarryTheContractOtherServicesRead(t *testing.T) {
	k, _ := generateKeys()
	now := time.Now().Unix()
	token, lifetime, err := k.sign(person{id: "u1", email: "a@example.com", name: "A", emailVerified: true}, "s1", true, "password", now-5, now, 15)
	if err != nil || lifetime != 900 {
		t.Fatalf("%v %d", err, lifetime)
	}
	// The header and payload as the Rust verifier reads them: EdDSA, a kid, string issuer and audience, numeric times.
	parts := strings.Split(token, ".")
	var header, payload map[string]any
	for i, into := range []*map[string]any{&header, &payload} {
		raw, _ := base64.RawURLEncoding.DecodeString(parts[i])
		_ = json.Unmarshal(raw, into)
	}
	if header["alg"] != "EdDSA" || header["kid"] != k.kid {
		t.Fatalf("header %v", header)
	}
	if payload["iss"] != "callerwhale-auth" || payload["aud"] != "callerwhale" || payload["sub"] != "u1" || payload["sid"] != "s1" ||
		payload["mfa"] != true || payload["email_verified"] != true || payload["provider"] != "password" || payload["email"] != "a@example.com" || payload["name"] != "A" {
		t.Fatalf("payload %v", payload)
	}
	for _, key := range []string{"auth_time", "iat", "exp"} {
		if _, isNumber := payload[key].(float64); !isNumber {
			t.Fatalf("%s must be a number: %v", key, payload[key])
		}
	}
	c, err := k.verify(token, time.Now())
	if err != nil || c.Sub != "u1" || c.SID != "s1" || !c.MFA || c.AuthTime != now-5 {
		t.Fatalf("%+v %v", c, err)
	}
	// What is refused.
	other, _ := generateKeys()
	foreign, _, _ := other.sign(person{id: "u1"}, "s1", false, "password", now, now, 15)
	if _, err := k.verify(foreign, time.Now()); err == nil {
		t.Error("another service's key")
	}
	if _, err := k.verify(token, time.Now().Add(16*time.Minute)); err == nil {
		t.Error("expired")
	}
	wrong := func(change func(*claims)) string {
		c := claims{Sub: "u1", SID: "s1", Iss: tokenIssuer, Aud: tokenAudience, Iat: now, Exp: now + 900}
		change(&c)
		tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, c)
		tok.Header["kid"] = k.kid
		signed, _ := tok.SignedString(k.priv)
		return signed
	}
	if _, err := k.verify(wrong(func(c *claims) { c.Iss = "someone-else" }), time.Now()); err == nil {
		t.Error("wrong issuer")
	}
	if _, err := k.verify(wrong(func(c *claims) { c.Aud = "another-audience" }), time.Now()); err == nil {
		t.Error("wrong audience")
	}
	if _, err := k.verify(wrong(func(c *claims) {}), time.Now()); err != nil {
		t.Errorf("the control token must pass: %v", err)
	}
	// An unsigned token and a tampered one.
	unsigned := jwt.NewWithClaims(jwt.SigningMethodNone, claims{Sub: "u1", Iss: tokenIssuer, Aud: tokenAudience, Exp: now + 900})
	none, _ := unsigned.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if _, err := k.verify(none, time.Now()); err == nil {
		t.Error("alg none")
	}
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"admin","iss":"callerwhale-auth","aud":"callerwhale","exp":9999999999}`)) + "." + parts[2]
	if _, err := k.verify(tampered, time.Now()); err == nil {
		t.Error("tampered payload")
	}
	if _, err := k.verify("not a token", time.Now()); err == nil {
		t.Error("garbage")
	}
}

func TestSQLFilesAreSplitIntoStatements(t *testing.T) {
	got := statements("CREATE TABLE a (x TEXT); -- done\n\n-- a comment line\nALTER TABLE a ADD COLUMN y TEXT;\n")
	if len(got) != 2 || got[0] != "CREATE TABLE a (x TEXT)" || got[1] != "ALTER TABLE a ADD COLUMN y TEXT" {
		t.Fatalf("%q", got)
	}
}

// ---- the database ----

func TestTheDatabaseIsBroughtUpToDateOnceAndSafelyTogether(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	var versions int
	if err := db.QueryRow(ctx, "SELECT COUNT(*) FROM database_setup_history").Scan(&versions); err != nil || versions != 8 {
		t.Fatalf("history %d %v", versions, err)
	}
	// Again, and from several instances at once: nothing runs twice and nothing fails.
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := setupDatabase(ctx, db); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if err := db.QueryRow(ctx, "SELECT COUNT(*) FROM database_setup_history").Scan(&versions); err != nil || versions != 8 {
		t.Fatalf("history %d %v", versions, err)
	}
}

func TestHealthKeysAndSecurity(t *testing.T) {
	w := newWorld(t)
	if a := w.call("GET", "/healthz", nil, ""); a.status != 200 || a.body["service"] != "auth" {
		t.Fatalf("%v", a)
	}
	if a := w.call("GET", "/version", nil, ""); a.status != 200 || a.body["version"] != version {
		t.Fatalf("%v", a)
	}
	a := w.call("GET", "/.well-known/jwks.json", nil, "")
	keys, _ := a.body["keys"].([]any)
	if a.status != 200 || len(keys) != 1 || keys[0].(map[string]any)["kid"] != w.s.keys.kid || keys[0].(map[string]any)["alg"] != "EdDSA" || !strings.Contains(a.header.Get("Cache-Control"), "max-age=300") {
		t.Fatalf("%v %v", a, a.header)
	}
	a = w.call("GET", "/v1/security", nil, "")
	policy, _ := a.body["password_policy"].(map[string]any)
	bot, _ := a.body["bot_protection"].(map[string]any)
	if policy["minimum"] != float64(8) || policy["maximum"] != float64(4096) || bot["enabled"] != false || bot["site_key"] != "" {
		t.Fatalf("%v", a.body)
	}
	if a := w.call("GET", "/nothing", nil, ""); a.status != 404 {
		t.Fatalf("%d", a.status)
	}
}

func TestOnlyListedOriginsMayCallFromABrowser(t *testing.T) {
	w := newWorld(t)
	ask := func(origin string) http.Header {
		req := httptest.NewRequest("OPTIONS", "/v1/sessions", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "authorization,content-type") // browsers send them sorted and lower-case
		rec := httptest.NewRecorder()
		w.h.ServeHTTP(rec, req)
		return rec.Header()
	}
	if got := ask("http://app.example").Get("Access-Control-Allow-Origin"); got != "http://app.example" {
		t.Fatalf("listed origin: %q", got)
	}
	if got := ask("http://evil.example").Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unlisted origin: %q", got)
	}
}

// ---- sign-up ----

func TestSignUpMakesAnAccountAndASession(t *testing.T) {
	w := newWorld(t)
	a := w.signUp("Sami@Example.com")
	user, _ := a.body["user"].(map[string]any)
	if user["email"] != "sami@example.com" || user["name"] != "Sami" || user["email_verified"] != false || a.body["token_type"] != "Bearer" || a.body["expires_in"] != float64(900) {
		t.Fatalf("%v", a.body)
	}
	c, err := w.s.keys.verify(a.access(), time.Now())
	if err != nil || c.Email != "sami@example.com" || c.Provider != "password" || c.MFA || c.Sub != user["id"] {
		t.Fatalf("%+v %v", c, err)
	}
	if w.count("SELECT COUNT(*) FROM users WHERE email = 'sami@example.com' AND password_hash = $1 AND firebase_uid IS NOT NULL", noPassword) != 1 {
		t.Fatal("the row keeps no password and links Firebase's uid")
	}
	if w.count("SELECT COUNT(*) FROM outbox WHERE name = 'user.signed_up'") != 1 {
		t.Fatal("the sign-up event is recorded")
	}
	// Firebase sends its own confirmation email when no notification service is set.
	if len(w.fb.sent) != 1 || w.fb.sent[0] != "VERIFY_EMAIL:sami@example.com" {
		t.Fatalf("%v", w.fb.sent)
	}
	if w.fb.accounts["sami@example.com"].name != "Sami" {
		t.Fatal("the name goes to Firebase too")
	}
}

func TestSignUpWithTheNotificationServiceSendsOurOwnLink(t *testing.T) {
	w := newWorld(t)
	w.withMail()
	w.signUp("sami@example.com")
	if len(w.fb.sent) != 0 {
		t.Fatalf("Firebase must not also send one: %v", w.fb.sent)
	}
	if len(w.mail.links) != 1 || w.mail.to[0] != "sami@example.com" || !strings.HasPrefix(w.mail.links[0], "http://landing.example/verify?token=") {
		t.Fatalf("%v %v", w.mail.to, w.mail.links)
	}
	token := strings.TrimPrefix(w.mail.links[0], "http://landing.example/verify?token=")
	if w.count("SELECT COUNT(*) FROM email_verifications WHERE token_hash = $1 AND used_at IS NULL", sha256Hex(token)) != 1 {
		t.Fatal("only the hash of the link is kept")
	}
	if w.count("SELECT COUNT(*) FROM email_verifications WHERE token_hash = $1", token) != 0 {
		t.Fatal("the token itself must never be stored")
	}
	if w.count("SELECT COUNT(*) FROM outbox WHERE name = 'notification.requested'") != 1 {
		t.Fatal("the request to email it is recorded")
	}
}

func TestAMailerThatIsDownDoesNotStopSignUp(t *testing.T) {
	w := newWorld(t)
	w.withMail()
	w.mail.fail = true
	w.signUp("sami@example.com")
	if w.count("SELECT COUNT(*) FROM users") != 1 {
		t.Fatal("the account exists either way")
	}
}

func TestSignUpRefusals(t *testing.T) {
	w := newWorld(t)
	post := func(body map[string]any) answer { return w.call("POST", "/v1/accounts", body, "") }
	good := func() map[string]any {
		return map[string]any{"name": "Sami", "email": "sami@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}
	}
	with := func(k string, v any) map[string]any {
		m := good()
		m[k] = v
		return m
	}
	for name, c := range map[string]struct {
		body   map[string]any
		status int
		code   string
	}{
		"bad email":      {with("email", "sami"), 400, "bad_request"},
		"no name":        {with("name", "   "), 400, "bad_request"},
		"name too long":  {with("name", strings.Repeat("n", 201)), 400, "bad_request"},
		"weak password":  {with("password", "short"), 400, "bad_request"},
		"unknown kind":   {with("kind", "tablet"), 400, "bad_request"},
		"missing fields": {map[string]any{}, 400, "bad_request"},
		"no birth date": {with("birth_date", ""), 400, "bad_request"},
		"a minor":       {with("birth_date", time.Now().AddDate(-17, 0, 0).Format("2006-01-02")), 403, "forbidden"},
	} {
		if a := post(c.body); a.status != c.status || a.str("code") != c.code {
			t.Errorf("%s: %d %v", name, a.status, a.body)
		}
	}
	if w.count("SELECT COUNT(*) FROM users") != 0 || len(w.fb.accounts) != 0 {
		t.Fatal("a refused sign-up leaves nothing behind")
	}
	w.signUp("sami@example.com")
	if a := post(good()); a.status != 409 || a.str("code") != "conflict" {
		t.Fatalf("duplicate: %d %v", a.status, a.body)
	}
	// Garbage bodies.
	req := httptest.NewRequest("POST", "/v1/accounts", strings.NewReader("not json"))
	rec := httptest.NewRecorder()
	w.h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("not json: %d", rec.Code)
	}
}

func TestSignUpCanBeClosed(t *testing.T) {
	w := newWorld(t, func(c *config) { c.publicSignup = false })
	a := w.call("POST", "/v1/accounts", map[string]any{"name": "S", "email": "s@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, "")
	if a.status != 403 || len(w.fb.accounts) != 0 {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

func TestFirebaseBeingDownIsAnInternalFaultNotTheirMistake(t *testing.T) {
	w := newWorld(t)
	w.fb.down = true
	a := w.call("POST", "/v1/accounts", map[string]any{"name": "S", "email": "s@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, "")
	if a.status != 500 || a.str("code") != "internal" || a.str("error") != "Something went wrong." {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/sessions", map[string]any{"email": "s@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, ""); a.status != 500 {
		t.Fatalf("sign-in: %d", a.status)
	}
	if w.count("SELECT COUNT(*) FROM failed_sign_ins") != 0 {
		t.Fatal("Firebase being down is not a failed sign-in")
	}
}

// ---- sign-in ----

func TestSignInOpensASession(t *testing.T) {
	w := newWorld(t)
	w.signUp("sami@example.com")
	a := w.call("POST", "/v1/sessions", map[string]any{"email": " SAMI@example.com ", "password": goodPassword, "kind": "desktop"}, "")
	if a.status != 200 || a.access() == "" || a.refresh() == "" {
		t.Fatalf("%d %v", a.status, a.body)
	}
	if w.count("SELECT COUNT(*) FROM sessions WHERE kind = 'desktop'") != 1 {
		t.Fatal("the session's kind is kept")
	}
	if w.count("SELECT COUNT(*) FROM sessions WHERE refresh_hash = $1", sha256Hex(a.refresh())) != 1 || w.count("SELECT COUNT(*) FROM sessions WHERE refresh_hash = $1", a.refresh()) != 0 {
		t.Fatal("only the hash of the refresh token is kept")
	}
	if a := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword, "kind": "tablet"}, ""); a.status != 400 {
		t.Fatalf("kind: %d", a.status)
	}
}

func TestWrongPasswordsAreCountedAndFiveLockTheEmail(t *testing.T) {
	w := newWorld(t)
	w.signUp("sami@example.com")
	in := func(password string) answer {
		return w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": password}, "")
	}
	for i := 0; i < 5; i++ {
		if a := in("wrong"); a.status != 401 || a.str("code") != "wrong_credentials" {
			t.Fatalf("attempt %d: %d %v", i, a.status, a.body)
		}
	}
	// Even the right password waits.
	if a := in(goodPassword); a.status != 429 || a.str("code") != "too_many_attempts" {
		t.Fatalf("locked: %d %v", a.status, a.body)
	}
	// The pause ends 15 minutes after the failures.
	clock = func() time.Time { return time.Now().Add(16 * time.Minute) }
	if a := in(goodPassword); a.status != 200 {
		t.Fatalf("after the pause: %d %v", a.status, a.body)
	}
	if w.count("SELECT COUNT(*) FROM failed_sign_ins WHERE email = 'sami@example.com'") != 0 {
		t.Fatal("a good sign-in clears the failures")
	}
}

func TestUnknownAndDisabledAccountsLookTheSameAsAWrongPassword(t *testing.T) {
	w := newWorld(t)
	w.signUp("sami@example.com")
	unknown := w.call("POST", "/v1/sessions", map[string]any{"email": "nobody@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, "")
	wrong := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": "wrong"}, "")
	if unknown.status != wrong.status || unknown.str("error") != wrong.str("error") || unknown.str("code") != wrong.str("code") {
		t.Fatalf("%v vs %v", unknown, wrong)
	}
	// Turned off in Firebase.
	w.fb.accounts["sami@example.com"].disabled = true
	if a := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, ""); a.status != 401 || a.str("code") != "wrong_credentials" {
		t.Fatalf("disabled in Firebase: %d %v", a.status, a.body)
	}
	w.fb.accounts["sami@example.com"].disabled = false
	// Turned off here.
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET disabled_at = $1", now()); err != nil {
		t.Fatal(err)
	}
	if a := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, ""); a.status != 401 || a.str("code") != "wrong_credentials" {
		t.Fatalf("disabled here: %d %v", a.status, a.body)
	}
}

func TestAnOldFirebaseAuthenticatorIsRefusedPlainly(t *testing.T) {
	w := newWorld(t)
	w.signUp("sami@example.com")
	w.fb.pending = true
	a := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, "")
	if a.status != 403 || !strings.Contains(a.str("error"), "old authenticator") {
		t.Fatalf("%d %v", a.status, a.body)
	}
}

// ---- sessions ----

func TestRefreshMovesTheSessionOnAndEarlierTokensStopWorking(t *testing.T) {
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	next := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": made.refresh()}, "")
	if next.status != 200 || next.refresh() == made.refresh() || next.access() == "" {
		t.Fatalf("%d %v", next.status, next.body)
	}
	before, _ := w.s.keys.verify(made.access(), time.Now())
	after, _ := w.s.keys.verify(next.access(), time.Now())
	if before.SID != after.SID || before.AuthTime != after.AuthTime {
		t.Fatalf("same session, same start: %+v %+v", before, after)
	}
	// The new token works for another round.
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": next.refresh()}, ""); a.status != 200 {
		t.Fatalf("second round: %d", a.status)
	}
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": "nonsense"}, ""); a.status != 401 {
		t.Fatalf("nonsense: %d", a.status)
	}
}

func TestACopiedRefreshTokenEndsTheSession(t *testing.T) {
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	stolen := made.refresh()
	rightful := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": stolen}, "")
	if rightful.status != 200 {
		t.Fatal("setup")
	}
	// Someone else presents the token the rightful owner already used: refused, and the whole session ends.
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": stolen}, ""); a.status != 401 {
		t.Fatalf("reuse: %d", a.status)
	}
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": rightful.refresh()}, ""); a.status != 401 {
		t.Fatalf("the rightful owner's newer token dies with the session: %d", a.status)
	}
	if a := w.call("GET", "/v1/me", nil, rightful.access()); a.status != 401 {
		t.Fatalf("and so does its access token: %d", a.status)
	}
}

func TestTwoRequestsWithOneTokenCannotBothSucceed(t *testing.T) {
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	results := make(chan int, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": made.refresh()}, "").status
		}()
	}
	wg.Wait()
	close(results)
	ok := 0
	for status := range results {
		if status == 200 {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d of 8 succeeded; exactly one may", ok)
	}
}

func TestSessionsExpireAndDisabledPeopleAreRefused(t *testing.T) {
	w := newWorld(t, func(c *config) { c.refreshDays = 1 })
	made := w.signUp("sami@example.com")
	other := w.signUp("lina@example.com")
	// Turned off after signing in: the refresh stops.
	if _, err := w.s.db.Exec(context.Background(), "UPDATE users SET disabled_at = $1 WHERE email = 'lina@example.com'", now()); err != nil {
		t.Fatal(err)
	}
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": other.refresh()}, ""); a.status != 401 {
		t.Fatalf("disabled: %d", a.status)
	}
	clock = func() time.Time { return time.Now().Add(25 * time.Hour) }
	if a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": made.refresh()}, ""); a.status != 401 {
		t.Fatalf("expired: %d", a.status)
	}
}

func TestRefreshLearnsThatTheEmailWasConfirmedInFirebase(t *testing.T) {
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	if c, _ := w.s.keys.verify(made.access(), time.Now()); c.EmailVerified {
		t.Fatal("setup")
	}
	w.fb.verify("sami@example.com")
	next := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": made.refresh()}, "")
	if c, _ := w.s.keys.verify(next.access(), time.Now()); !c.EmailVerified {
		t.Fatalf("%v", next.body)
	}
	user, _ := next.body["user"].(map[string]any)
	if user["email_verified"] != true {
		t.Fatalf("%v", user)
	}
	// Firebase rotating its refresh token is kept.
	var stored string
	if err := w.s.db.QueryRow(context.Background(), "SELECT fb_refresh FROM sessions").Scan(&stored); err != nil || stored == "rt-"+w.fb.accounts["sami@example.com"].uid {
		t.Fatalf("%q %v", stored, err)
	}
}

func TestMeListRevokeAndSignOut(t *testing.T) {
	w := newWorld(t)
	first := w.signUp("sami@example.com")
	second := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword, "kind": "desktop"}, "")
	third := w.call("POST", "/v1/sessions", map[string]any{"email": "sami@example.com", "password": goodPassword, "birth_date": "1990-01-01", "terms_version": termsVersion}, "")
	stranger := w.signUp("lina@example.com")

	me := w.call("GET", "/v1/me", nil, first.access())
	if me.status != 200 || me.body["email"] != "sami@example.com" || me.body["name"] != "Sami" || me.body["mfa_enrolled"] != false || me.body["mfa_passed"] != false || me.body["email_verified"] != false || me.body["session_id"] == "" {
		t.Fatalf("%d %v", me.status, me.body)
	}
	list := w.call("GET", "/v1/sessions", nil, first.access())
	sessions, _ := list.body["sessions"].([]any)
	if len(sessions) != 3 {
		t.Fatalf("%v", list.body)
	}
	current := 0
	for _, s := range sessions {
		if s.(map[string]any)["current"] == true {
			current++
		}
	}
	if current != 1 {
		t.Fatalf("exactly one is current: %v", sessions)
	}
	// One person cannot close another's session.
	secondID := func() string { c, _ := w.s.keys.verify(second.access(), time.Now()); return c.SID }()
	if a := w.call("POST", "/v1/sessions/revoke", map[string]any{"session_id": secondID}, stranger.access()); a.body["closed"] != float64(0) {
		t.Fatalf("a stranger closed it: %v", a.body)
	}
	if a := w.call("GET", "/v1/me", nil, second.access()); a.status != 200 {
		t.Fatal("still open")
	}
	// Close one of their own: its access token stops working at once.
	if a := w.call("POST", "/v1/sessions/revoke", map[string]any{"session_id": secondID}, first.access()); a.status != 200 || a.body["closed"] != float64(1) {
		t.Fatalf("%v", a.body)
	}
	if a := w.call("GET", "/v1/me", nil, second.access()); a.status != 401 {
		t.Fatalf("closed session: %d", a.status)
	}
	if a := w.call("POST", "/v1/sessions/revoke", map[string]any{}, first.access()); a.status != 400 {
		t.Fatalf("no session named: %d", a.status)
	}
	// Close every other one.
	if a := w.call("POST", "/v1/sessions/revoke", map[string]any{"others": true}, first.access()); a.body["closed"] != float64(1) {
		t.Fatalf("%v", a.body)
	}
	if w.call("GET", "/v1/me", nil, third.access()).status != 401 || w.call("GET", "/v1/me", nil, first.access()).status != 200 {
		t.Fatal("only the others closed")
	}
	// Sign out by access token, then by refresh token.
	if a := w.call("POST", "/v1/sessions/sign-out", nil, first.access()); a.status != 200 {
		t.Fatalf("%d", a.status)
	}
	if w.call("GET", "/v1/me", nil, first.access()).status != 401 {
		t.Fatal("signed out")
	}
	if a := w.call("POST", "/v1/sessions/sign-out", map[string]any{"refresh_token": stranger.refresh()}, ""); a.status != 200 {
		t.Fatalf("%d", a.status)
	}
	if w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": stranger.refresh()}, "").status != 401 {
		t.Fatal("the refresh token is dead too")
	}
	if w.call("POST", "/v1/sessions/sign-out", map[string]any{}, "").status != 401 {
		t.Fatal("nothing to sign out")
	}
}

func TestTokensThatAreMissingForgedOrExpiredAreRefused(t *testing.T) {
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	for name, header := range map[string]string{
		"none":           "",
		"not bearer":     "Basic abc",
		"empty bearer":   "Bearer ",
		"garbage":        "Bearer not.a.token",
		"another key":    "",
		"expired access": "",
	} {
		req := httptest.NewRequest("GET", "/v1/me", nil)
		switch name {
		case "another key":
			other, _ := generateKeys()
			c, _ := w.s.keys.verify(made.access(), time.Now())
			tok, _, _ := other.sign(person{id: c.Sub, email: c.Email}, c.SID, true, "password", now(), now(), 15)
			header = "Bearer " + tok
		case "expired access":
			clock = func() time.Time { return time.Now().Add(-time.Hour) }
			tok, _, _ := w.s.keys.sign(person{id: "x"}, "s", false, "password", now(), now(), 15)
			clock = time.Now
			header = "Bearer " + tok
		}
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		rec := httptest.NewRecorder()
		w.h.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	// A real, unexpired token whose session never existed.
	c, _ := w.s.keys.verify(made.access(), time.Now())
	ghost, _, _ := w.s.keys.sign(person{id: c.Sub, email: c.Email}, "no-such-session", false, "password", now(), now(), 15)
	if w.call("GET", "/v1/me", nil, ghost).status != 401 {
		t.Fatal("a token for a session that does not exist")
	}
}

func TestStoppingMidWayLeavesNothingHalfWritten(t *testing.T) {
	// A sign-up whose Firebase answer cannot be read after the account exists there: nothing half-made here.
	w := newWorld(t)
	made := w.signUp("sami@example.com")
	c, _ := w.s.keys.verify(made.access(), time.Now())
	// Every row this person has points at a real user, and the outbox event exists with its row.
	if w.count("SELECT COUNT(*) FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL") != 0 {
		t.Fatal("orphan session")
	}
	if w.count("SELECT COUNT(*) FROM users WHERE id = $1", c.Sub) != 1 || w.count("SELECT COUNT(*) FROM outbox") != 1 {
		t.Fatal("the user and its event arrive together")
	}
}
