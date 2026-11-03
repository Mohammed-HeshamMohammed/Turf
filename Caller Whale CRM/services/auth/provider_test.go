package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// fakeProvider stands in for Google and Apple: a token endpoint that signs ID tokens like the real ones, and the keys to check them.
// The "code" it is given is the claims the test wants the person to have, so each test chooses who signs in.
type fakeProvider struct {
	srv *httptest.Server
	rsa *rsa.PrivateKey
	ec  *ecdsa.PrivateKey // the Apple team's key: the client secret is signed with it

	mu       sync.Mutex
	last     url.Values           // the last token request, form fields
	secretOK bool                 // the last Apple client secret checked out
	mutate   func(map[string]any) // changes the claims before they are signed
	other    *rsa.PrivateKey      // when set, tokens are signed with this key instead (a key the provider does not publish)
	down     bool
}

var (
	rsaOnce  sync.Once
	rsaKey   *rsa.PrivateKey
	rsaOther *rsa.PrivateKey
)

func testRSA() (*rsa.PrivateKey, *rsa.PrivateKey) {
	rsaOnce.Do(func() {
		rsaKey, _ = rsa.GenerateKey(rand.Reader, 2048)
		rsaOther, _ = rsa.GenerateKey(rand.Reader, 2048)
	})
	return rsaKey, rsaOther
}

func newFakeProvider(t *testing.T) *fakeProvider {
	t.Helper()
	p := &fakeProvider{}
	p.rsa, _ = testRSA()
	_, p.other = testRSA()
	p.ec, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	mux := http.NewServeMux()
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": base64.RawURLEncoding.EncodeToString(p.rsa.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(p.rsa.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", p.token)
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

// providerPEM is the Apple team's private key in the form AUTH_APPLE_PRIVATE_KEY holds.
func (p *fakeProvider) providerPEM(t *testing.T) string {
	der, err := x509.MarshalPKCS8PrivateKey(p.ec)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func (p *fakeProvider) token(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = r.ParseForm()
	p.last = r.PostForm
	if p.down {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	client := r.PostForm.Get("client_id")
	// Google: the secret and the PKCE verifier. Apple: a JWT signed with the team's key.
	if client == "google-test-client" {
		if r.PostForm.Get("client_secret") != "google-test-secret" || r.PostForm.Get("code_verifier") == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_client"}`))
			return
		}
	} else {
		parsed, err := jwt.Parse(r.PostForm.Get("client_secret"), func(*jwt.Token) (any, error) { return &p.ec.PublicKey, nil }, jwt.WithValidMethods([]string{"ES256"}), jwt.WithAudience("https://appleid.apple.com"), jwt.WithIssuer("TEAMTEST01"), jwt.WithSubject("apple-test-client"))
		p.secretOK = err == nil && parsed.Header["kid"] == "KEYTEST001"
		if !p.secretOK {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_client"}`))
			return
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(r.PostForm.Get("code"))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
		return
	}
	claims := map[string]any{}
	_ = json.Unmarshal(raw, &claims)
	now := time.Now().Unix()
	claims["iss"], claims["aud"], claims["iat"], claims["exp"] = p.srv.URL, client, now, now+300
	if p.mutate != nil {
		p.mutate(claims)
	}
	key := p.rsa
	if p.other != nil && claims["_other_key"] == true {
		key = p.other
	}
	delete(claims, "_other_key")
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims(claims))
	tok.Header["kid"] = "k1"
	signed, _ := tok.SignedString(key)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ignored", "token_type": "Bearer", "id_token": signed})
}

// codeFor is the "code" the provider hands back for a person with these claims.
func codeFor(claims map[string]any) string {
	raw, _ := json.Marshal(claims)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func sha256Of(s string) string {
	sum := sha256.Sum256([]byte(s))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
