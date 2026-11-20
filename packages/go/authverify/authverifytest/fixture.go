// Package authverifytest signs access tokens the way the auth service does, for tests of services that check them with
// callerwhale/authverify. It holds a fresh Ed25519 key, publishes it as a JWKS document and signs tokens with it.
package authverifytest

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"callerwhale/authverify"
)

// Fixture is a signing key for tests.
type Fixture struct {
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

// NewFixture makes a fresh key.
func NewFixture(t testing.TB) Fixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return Fixture{public, private}
}

// JWKS is the key published under the key id kid, as the auth service's /.well-known/jwks.json answers.
func (f Fixture) JWKS(kid string) string {
	b, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": kid, "x": base64.RawURLEncoding.EncodeToString(f.public),
	}}})
	return string(b)
}

// Sign makes a token with every claim the auth service sets; change can alter the claims before signing.
func (f Fixture) Sign(kid, alg string, change func(map[string]any)) string {
	now := time.Now().Unix()
	body := map[string]any{
		"iss": authverify.Issuer, "aud": authverify.Audience, "sub": "u-1", "email": "a@example.com", "name": "A", "sid": "s-1",
		"mfa": true, "email_verified": true, "provider": "password", "auth_time": now - 60, "iat": now - 5, "exp": now + 600,
	}
	if change != nil {
		change(body)
	}
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	input := enc(map[string]string{"alg": alg, "kid": kid, "typ": "JWT"}) + "." + enc(body)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.private, []byte(input)))
}

// ServeKeys serves *body (with header) as the JWKS document for the test and returns a keyset that reads it. Changing *body
// later serves the new document, as a key rotation does.
func ServeKeys(t testing.TB, body *string, header http.Header) *authverify.Keyset {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range header {
			w.Header()[k] = v
		}
		_, _ = w.Write([]byte(*body))
	}))
	t.Cleanup(server.Close)
	return authverify.NewKeyset(server.URL)
}
