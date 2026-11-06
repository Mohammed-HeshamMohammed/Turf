package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Source of truth: tools/auth-verify/token_test.go, copied with token.go by tools/auth-verify/sync.mjs.

type verifyFixture struct {
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func newVerifyFixture(t *testing.T) verifyFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return verifyFixture{public, private}
}

func (f verifyFixture) jwks(kid string) string {
	b, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": kid, "x": base64.RawURLEncoding.EncodeToString(f.public),
	}}})
	return string(b)
}

func (f verifyFixture) sign(kid, alg string, change func(map[string]any)) string {
	now := time.Now().Unix()
	body := map[string]any{
		"iss": tokenIssuer, "aud": tokenAudience, "sub": "u-1", "email": "a@example.com", "name": "A", "sid": "s-1",
		"mfa": true, "email_verified": true, "provider": "password", "auth_time": now - 60, "iat": now - 5, "exp": now + 600,
	}
	if change != nil {
		change(body)
	}
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	input := enc(map[string]string{"alg": alg, "kid": kid, "typ": "JWT"}) + "." + enc(body)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.private, []byte(input)))
}

func serveVerifyKeys(t *testing.T, body *string, header http.Header) *keyset {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range header {
			w.Header()[k] = v
		}
		_, _ = w.Write([]byte(*body))
	}))
	t.Cleanup(server.Close)
	return newKeyset(server.URL)
}

func TestVerifyAcceptsATokenFromAuthWithEveryClaim(t *testing.T) {
	f := newVerifyFixture(t)
	body := f.jwks("k1")
	keys := serveVerifyKeys(t, &body, nil)
	got, err := keys.verify(f.sign("k1", "EdDSA", nil), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.sub != "u-1" || got.email != "a@example.com" || got.name != "A" || got.sessionID != "s-1" || !got.secondFactor ||
		!got.emailVerified || got.provider != "password" || got.authTime == 0 {
		t.Fatalf("claims lost on the way: %+v", got)
	}
}

func TestVerifyReadsOlderTokensWithoutTheNewerClaims(t *testing.T) {
	f := newVerifyFixture(t)
	body := f.jwks("k1")
	keys := serveVerifyKeys(t, &body, nil)
	token := f.sign("k1", "EdDSA", func(c map[string]any) {
		delete(c, "email_verified")
		delete(c, "provider")
		delete(c, "auth_time")
	})
	got, err := keys.verify(token, time.Now())
	if err != nil || got.emailVerified || got.provider != "" || got.authTime != 0 {
		t.Fatalf("older token: %+v, %v", got, err)
	}
}

func TestVerifyRefusesWhatIsNotCallerWhales(t *testing.T) {
	f := newVerifyFixture(t)
	body := f.jwks("k1")
	keys := serveVerifyKeys(t, &body, nil)
	other := newVerifyFixture(t)
	cases := map[string]string{
		"expired":            f.sign("k1", "EdDSA", func(c map[string]any) { c["exp"] = time.Now().Unix() - 120 }),
		"future":             f.sign("k1", "EdDSA", func(c map[string]any) { c["iat"] = time.Now().Unix() + 3600 }),
		"wrong issuer":       f.sign("k1", "EdDSA", func(c map[string]any) { c["iss"] = "someone-else" }),
		"wrong audience":     f.sign("k1", "EdDSA", func(c map[string]any) { c["aud"] = "other" }),
		"no subject":         f.sign("k1", "EdDSA", func(c map[string]any) { delete(c, "sub") }),
		"another alg":        f.sign("k1", "HS256", nil),
		"unknown key id":     f.sign("k9", "EdDSA", nil),
		"someone else's key": other.sign("k1", "EdDSA", nil),
		"not a token":        "abc",
	}
	for name, token := range cases {
		if _, err := keys.verify(token, time.Now()); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestVerifyAcceptsASmallClockSkew(t *testing.T) {
	f := newVerifyFixture(t)
	body := f.jwks("k1")
	keys := serveVerifyKeys(t, &body, nil)
	token := f.sign("k1", "EdDSA", func(c map[string]any) { c["exp"] = time.Now().Unix() - 10 })
	if _, err := keys.verify(token, time.Now()); err != nil {
		t.Fatalf("10 seconds past expiry is within the 30 seconds of leeway: %v", err)
	}
}

func TestVerifyFollowsAKeyRotation(t *testing.T) {
	old, next := newVerifyFixture(t), newVerifyFixture(t)
	body := old.jwks("k1")
	keys := serveVerifyKeys(t, &body, http.Header{"Cache-Control": {"max-age=3600"}})
	start := time.Now()
	if _, err := keys.verify(old.sign("k1", "EdDSA", nil), start); err != nil {
		t.Fatal(err)
	}
	body = next.jwks("k2")
	// A new key id makes the service fetch the set again, but never more than once every 30 seconds.
	if _, err := keys.verify(next.sign("k2", "EdDSA", nil), start.Add(5*time.Second)); err == nil {
		t.Fatal("a second fetch within 30 seconds should not happen")
	}
	if _, err := keys.verify(next.sign("k2", "EdDSA", nil), start.Add(31*time.Second)); err != nil {
		t.Fatalf("the rotated key should be picked up: %v", err)
	}
}
