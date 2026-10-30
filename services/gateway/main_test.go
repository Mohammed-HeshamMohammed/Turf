package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	project  = "turf-test"
	appHost  = "app.turf.example"
	grafHost = "grafana.turf.example"
)

type world struct {
	g       *gateway
	key     *rsa.PrivateKey
	core    *httptest.Server
	graf    *httptest.Server
	fetch   atomic.Int32
	reached atomic.Int32 // requests that got through to the core API
}

func newWorld(t *testing.T, extra map[string]string) *world {
	t.Helper()
	w := &world{}
	var err error
	if w.key, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.fetch.Add(1)
		rw.Header().Set("cache-control", "public, max-age=3600")
		_ = json.NewEncoder(rw).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(w.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(w.key.E)).Bytes()),
		}}})
	}))
	t.Cleanup(jwks.Close)
	echo := func(counter *atomic.Int32) http.Handler {
		return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			if counter != nil {
				counter.Add(1)
			}
			_ = json.NewEncoder(rw).Encode(map[string]any{"path": r.URL.RequestURI(), "host": r.Host, "headers": r.Header})
		})
	}
	w.core = httptest.NewServer(echo(&w.reached))
	w.graf = httptest.NewServer(echo(nil))
	t.Cleanup(w.core.Close)
	t.Cleanup(w.graf.Close)
	env := map[string]string{
		"ROUTES":              appHost + "=" + w.core.URL + "," + grafHost + "=" + w.graf.URL,
		"CORE_HOST":           appHost,
		"FIREBASE_PROJECT_ID": project,
		"FIREBASE_JWKS_URL":   jwks.URL,
	}
	for k, v := range extra {
		env[k] = v
	}
	cfg, err := loadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	w.g = newGateway(cfg)
	return w
}

// token signs a Firebase-style ID token; change adjusts the claims.
func (w *world) token(change func(map[string]any)) string {
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": "https://securetoken.google.com/" + project, "aud": project, "sub": "user-1",
		"iat": now - 5, "auth_time": now - 5, "exp": now + 3600,
		"firebase": map[string]any{"sign_in_provider": "password"},
	}
	if change != nil {
		change(claims)
	}
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	input := enc(map[string]string{"alg": "RS256", "kid": "k1", "typ": "JWT"}) + "." + enc(claims)
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, w.key, crypto.SHA256, sum[:])
	if err != nil {
		panic(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (w *world) staffToken() string {
	return w.token(func(c map[string]any) { c["firebase"] = map[string]any{"sign_in_second_factor": "totp"} })
}

func (w *world) do(host, method, path, token string, mod ...func(*http.Request)) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://"+host+path, nil)
	r.RemoteAddr = "10.0.0.9:5555"
	r.Header.Set("X-Forwarded-For", "203.0.113.7")
	if token != "" {
		r.Header.Set("authorization", "Bearer "+token)
	}
	for _, m := range mod {
		m(r)
	}
	rec := httptest.NewRecorder()
	w.g.ServeHTTP(rec, r)
	return rec
}

func TestHealthAndVersionAnswerOnAnyHost(t *testing.T) {
	w := newWorld(t, nil)
	rec := w.do("anything.example", "GET", "/healthz", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"service":"gateway"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	if rec := w.do("anything.example", "GET", "/version", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), version) {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestAnUnknownHostIsNotFound(t *testing.T) {
	w := newWorld(t, nil)
	if rec := w.do("other.example", "GET", "/api/v1/me", w.token(nil)); rec.Code != 404 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestInternalRoutesNeverLeave(t *testing.T) {
	w := newWorld(t, nil)
	for _, path := range []string{"/internal/jobs/claim", "/internal", "/readyz"} {
		if rec := w.do(appHost, "POST", path, w.staffToken()); rec.Code != 404 {
			t.Fatalf("%s: got %d", path, rec.Code)
		}
	}
	if w.reached.Load() != 0 {
		t.Fatal("an internal route reached the core API")
	}
}

func TestSignedInPathsNeedAValidToken(t *testing.T) {
	w := newWorld(t, nil)
	for _, path := range []string{"/api/v1/me", "/api/v1/leads", "/sync/pull", "/events", "/api/v1/ops"} {
		if rec := w.do(appHost, "GET", path, ""); rec.Code != 401 {
			t.Fatalf("%s without a token: %d", path, rec.Code)
		}
	}
	bad := map[string]string{
		"garbage":      "not.a.token",
		"wrong aud":    w.token(func(c map[string]any) { c["aud"] = "another" }),
		"wrong issuer": w.token(func(c map[string]any) { c["iss"] = "https://securetoken.google.com/another" }),
		"expired":      w.token(func(c map[string]any) { c["exp"] = time.Now().Unix() - 10 }),
		"no subject":   w.token(func(c map[string]any) { c["sub"] = "" }),
		"future":       w.token(func(c map[string]any) { c["iat"] = time.Now().Unix() + 3600 }),
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	forged := &world{key: other}
	bad["wrong key"] = forged.token(nil)
	for name, token := range bad {
		if rec := w.do(appHost, "GET", "/api/v1/me", token); rec.Code != 401 {
			t.Fatalf("%s: got %d", name, rec.Code)
		}
	}
	if w.reached.Load() != 0 {
		t.Fatal("a bad token reached the core API")
	}
	if rec := w.do(appHost, "GET", "/api/v1/me", w.token(nil)); rec.Code != 200 {
		t.Fatalf("good token: %d", rec.Code)
	}
}

func TestAnAlgorithmSwapIsRefused(t *testing.T) {
	w := newWorld(t, nil)
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	none := enc(map[string]string{"alg": "none", "kid": "k1"}) + "." + enc(map[string]any{"iss": "https://securetoken.google.com/" + project, "aud": project, "sub": "x", "exp": time.Now().Unix() + 60}) + "."
	if rec := w.do(appHost, "GET", "/api/v1/me", none); rec.Code != 401 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestPublicPathsNeedNoToken(t *testing.T) {
	w := newWorld(t, nil)
	for _, c := range [][2]string{{"GET", "/api/v1/auth/service"}, {"GET", "/api/v1/plans"}, {"POST", "/api/v1/billing/webhook"}, {"GET", "/api/v1/download/abc"}, {"GET", "/"}, {"GET", "/app.js"}} {
		if rec := w.do(appHost, c[0], c[1], ""); rec.Code != 200 {
			t.Fatalf("%s %s: got %d", c[0], c[1], rec.Code)
		}
	}
	// The same words with another method are not public.
	if rec := w.do(appHost, "POST", "/api/v1/plans", ""); rec.Code != 401 {
		t.Fatalf("POST plans: %d", rec.Code)
	}
}

func TestStaffPathsNeedTheAuthenticatorStep(t *testing.T) {
	w := newWorld(t, nil)
	if rec := w.do(appHost, "GET", "/api/v1/platform/whoami", ""); rec.Code != 401 {
		t.Fatalf("no token: %d", rec.Code)
	}
	rec := w.do(appHost, "GET", "/api/v1/platform/people", w.token(nil))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "mfa_required") {
		t.Fatalf("no second factor: %d %s", rec.Code, rec.Body.String())
	}
	if w.reached.Load() != 0 {
		t.Fatal("reached the core API without the authenticator step")
	}
	if rec := w.do(appHost, "GET", "/api/v1/platform/people", w.staffToken()); rec.Code != 200 {
		t.Fatalf("with second factor: %d", rec.Code)
	}
	// Switched off for a server that has no authenticator step yet.
	off := newWorld(t, map[string]string{"STAFF_REQUIRE_SECOND_FACTOR": "false"})
	if rec := off.do(appHost, "GET", "/api/v1/platform/people", off.token(nil)); rec.Code != 200 {
		t.Fatalf("switched off: %d", rec.Code)
	}
}

func TestOddSpellingsOfAPathAreRefused(t *testing.T) {
	w := newWorld(t, nil)
	for _, path := range []string{"/api/v1/../internal/jobs/claim", "/api/v1/platform%2Fpeople", "/api//v1/me", "/api/v1/%2e%2e/internal", "/api/v1/me%00"} {
		r := httptest.NewRequest("GET", "http://"+appHost+"/", nil)
		r.URL.Path, r.URL.RawPath = strings.NewReplacer("%2F", "/", "%2f", "/", "%2e", ".", "%00", "\x00").Replace(path), path
		r.RemoteAddr = "10.0.0.9:1"
		rec := httptest.NewRecorder()
		w.g.ServeHTTP(rec, r)
		if rec.Code != 400 {
			t.Fatalf("%s: got %d", path, rec.Code)
		}
	}
	if w.reached.Load() != 0 {
		t.Fatal("an odd path reached the core API")
	}
}

func seen(t *testing.T, rec *httptest.ResponseRecorder) http.Header {
	t.Helper()
	if rec.Code != 200 {
		t.Fatalf("not forwarded: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Host    string      `json:"host"`
		Headers http.Header `json:"headers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	got.Headers.Set("Seen-Host", got.Host)
	return got.Headers
}

func TestCallersCannotSpeakForAProxyOrForGrafana(t *testing.T) {
	w := newWorld(t, nil)
	h := seen(t, w.do(grafHost, "GET", "/d/abc", "", func(r *http.Request) {
		r.Header.Set("X-WEBAUTH-USER", "someone")
		r.Header.Set("x-webauth-role", "Admin")
		r.Header.Set("X-Real-IP", "1.2.3.4")
		r.Header.Set("X-Forwarded-For", "9.9.9.9, 203.0.113.7")
		r.Header.Set("X-Forwarded-Proto", "https")
	}))
	for name := range h {
		if strings.HasPrefix(strings.ToLower(name), "x-webauth-") {
			t.Fatalf("passed on %s", name)
		}
	}
	if h.Get("X-Forwarded-For") != "203.0.113.7" || h.Get("X-Real-Ip") != "" || h.Get("Seen-Host") != grafHost || h.Get("X-Forwarded-Proto") != "https" {
		t.Fatalf("forwarded headers wrong: %v", h)
	}
}

func TestGrafanaHostIsNotHeldToTheCorePolicy(t *testing.T) {
	w := newWorld(t, nil)
	// Grafana's own paths overlap the core API's names, and its login proxy does its own checks.
	if rec := w.do(grafHost, "GET", "/api/v1/platform/x", ""); rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	if rec := w.do(grafHost, "GET", "/internal/x", ""); rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestEachAddressAndEachPersonHasALimit(t *testing.T) {
	w := newWorld(t, map[string]string{"IP_PER_MINUTE": "3", "USER_PER_MINUTE": "2"})
	token := w.token(nil)
	if rec := w.do(appHost, "GET", "/api/v1/me", token); rec.Code != 200 {
		t.Fatalf("first: %d", rec.Code)
	}
	if rec := w.do(appHost, "GET", "/api/v1/me", token); rec.Code != 200 {
		t.Fatalf("second: %d", rec.Code)
	}
	// The person's limit (2) comes before the address's (3).
	if rec := w.do(appHost, "GET", "/api/v1/me", token); rec.Code != 429 || rec.Header().Get("retry-after") == "" {
		t.Fatalf("third: %d", rec.Code)
	}
	// Another address, own count; the first address is now over.
	if rec := w.do(appHost, "GET", "/api/v1/leads", "", func(r *http.Request) { r.Header.Set("X-Forwarded-For", "198.51.100.1") }); rec.Code != 401 {
		t.Fatalf("other address: %d", rec.Code)
	}
	if rec := w.do(appHost, "GET", "/api/v1/leads", ""); rec.Code != 429 {
		t.Fatalf("over the address limit: %d", rec.Code)
	}
}

func TestTheCallersAddressComesFromTheProxyInFront(t *testing.T) {
	w := newWorld(t, nil)
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.9:5555"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.7")
	if got := w.g.clientIP(r); got != "203.0.113.7" {
		t.Fatalf("got %s: the entry added by our own proxy is the one to trust", got)
	}
	r.Header.Del("X-Forwarded-For")
	if got := w.g.clientIP(r); got != "10.0.0.9" {
		t.Fatalf("got %s", got)
	}
}

func TestAWebSocketCarriesItsTokenInTheSubprotocolList(t *testing.T) {
	w := newWorld(t, nil)
	rec := w.do(appHost, "GET", "/events", "", func(r *http.Request) {
		r.Header.Set("Sec-WebSocket-Protocol", "turf.v1, bearer."+w.token(nil)+", org.abc")
	})
	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	rec = w.do(appHost, "GET", "/events", "", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Protocol", "turf.v1, bearer.nope") })
	if rec.Code != 401 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestKeysAreFetchedOnceAndNotOnEveryRequest(t *testing.T) {
	w := newWorld(t, nil)
	token := w.token(nil)
	for i := 0; i < 5; i++ {
		w.do(appHost, "GET", "/api/v1/me", token)
	}
	if n := w.fetch.Load(); n != 1 {
		t.Fatalf("fetched the key set %d times", n)
	}
}

func TestUpstreamsThatDoNotAnswerGet502(t *testing.T) {
	w := newWorld(t, nil)
	w.core.Close()
	if rec := w.do(appHost, "GET", "/api/v1/auth/service", ""); rec.Code != 502 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestConfigNeedsItsRoutesAndChecksTheRest(t *testing.T) {
	base := map[string]string{"ROUTES": "app.x.example=http://core:8088", "CORE_HOST": "app.x.example", "FIREBASE_PROJECT_ID": "p"}
	try := func(change map[string]string) error {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for k, v := range change {
			env[k] = v
		}
		_, err := loadConfig(func(k string) string { return env[k] })
		return err
	}
	if err := try(nil); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]map[string]string{
		"no routes":       {"ROUTES": ""},
		"bad route":       {"ROUTES": "app.x.example"},
		"bad scheme":      {"ROUTES": "app.x.example=ftp://core"},
		"core not routed": {"CORE_HOST": "other.example"},
		"no project":      {"FIREBASE_PROJECT_ID": ""},
		"bad limit":       {"IP_PER_MINUTE": "zero"},
	} {
		if try(change) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestClassifyListsWhatEachPathNeeds(t *testing.T) {
	for _, c := range []struct {
		method, path string
		want         need
	}{
		{"GET", "/healthz", open}, {"GET", "/", open}, {"GET", "/index.html", open},
		{"POST", "/internal/events/claim", private}, {"GET", "/readyz", private},
		{"GET", "/api/v1/me", signedIn}, {"POST", "/sync/push", signedIn}, {"GET", "/events", signedIn},
		{"GET", "/api/v1/platform/staff", staff}, {"GET", "/api/v1/platform", staff},
		{"GET", "/api/v1/platformx", signedIn},
	} {
		if got := classify(c.method, c.path); got != c.want {
			t.Errorf("%s %s: got %d, want %d", c.method, c.path, got, c.want)
		}
	}
}
