package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// shieldWorld is a gateway with the auth service behind it, no human check, so only the shield is under test.
func shieldWorld(t *testing.T, extra map[string]string) *humanWorld {
	t.Helper()
	env := map[string]string{"HUMAN_CHECK": "false", "AUTH_HOST": authHost}
	for k, v := range extra {
		env[k] = v
	}
	return newHumanWorld(t, env)
}

func TestAuthAnswersOnlyItsOwnRoutes(t *testing.T) {
	w := shieldWorld(t, nil)
	for _, c := range [][2]string{
		{"GET", "/v1/me"}, {"POST", "/v1/sessions"}, {"GET", "/v1/oauth/google/callback"}, {"DELETE", "/v1/mfa/factors/abc"},
		{"POST", "/v1/mfa/telegram/webhook/some-long-secret"}, {"GET", "/.well-known/jwks.json"}, {"OPTIONS", "/v1/sessions"},
		{"OPTIONS", "/v1/mfa/approvals/xyz"},
	} {
		if rec := w.call(c[0], c[1], `{}`); rec.Code != 200 {
			t.Errorf("%s %s should reach auth: %d", c[0], c[1], rec.Code)
		}
	}
	reached := w.reached.Load()
	for _, c := range [][2]string{
		{"GET", "/"}, {"GET", "/admin"}, {"GET", "/healthz"}, {"GET", "/version"}, {"GET", "/v1"}, {"GET", "/v1/users"}, {"GET", "/api/v1/me"},
		{"POST", "/v1/me"},             // a real path with the wrong method looks like nothing too
		{"GET", "/v1/accounts"},        // ditto
		{"GET", "/v1/mfa/factors/"},    // trailing slash is another path
		{"GET", "/v1/mfa/factors/a/b"}, // a parameter is one segment
		{"GET", "/V1/ME"},
		{"GET", "/.env"}, {"GET", "/.git/config"}, {"GET", "/wp-login.php"},
	} {
		rec := w.call(c[0], c[1], "")
		if rec.Code != 404 || strings.TrimSpace(rec.Body.String()) != `{"error":"Not found."}` {
			t.Errorf("%s %s: %d %s", c[0], c[1], rec.Code, rec.Body)
		}
	}
	if w.reached.Load() != reached {
		t.Fatalf("auth saw %d requests it should not have", w.reached.Load()-reached)
	}
}

func TestEveryNotFoundLooksTheSame(t *testing.T) {
	w := shieldWorld(t, nil)
	first := w.call("GET", "/admin", "")
	for _, path := range []string{"/", "/v1/users", "/healthz", "/.git/config"} {
		rec := w.call("GET", path, "")
		if rec.Code != first.Code || rec.Body.String() != first.Body.String() || rec.Header().Get("Content-Type") != first.Header().Get("Content-Type") {
			t.Fatalf("%s differs: %d %q", path, rec.Code, rec.Body)
		}
	}
	// An unknown host answers the same way too.
	req := httptest.NewRequest("GET", "http://nobody.example/admin", nil)
	req.RemoteAddr = "10.0.0.9:1"
	req.Header.Set("X-Forwarded-For", "198.51.100.1")
	rec := httptest.NewRecorder()
	w.g.ServeHTTP(rec, req)
	if rec.Code != first.Code || rec.Body.String() != first.Body.String() {
		t.Fatalf("unknown host differs: %d %q", rec.Code, rec.Body)
	}
}

func TestAScannerIsPausedAndRealUseIsNot(t *testing.T) {
	w := shieldWorld(t, map[string]string{"SCAN_LIMIT": "5"})
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	w.g.now = func() time.Time { return now }
	// A person using the pages never asks for what is not there.
	for i := 0; i < 50; i++ {
		if rec := w.call("GET", "/v1/me", ""); rec.Code != 200 {
			t.Fatalf("real request %d: %d", i, rec.Code)
		}
	}
	for i := 0; i < 5; i++ {
		if rec := w.call("GET", "/wp-admin/"+string(rune('a'+i)), ""); rec.Code != 404 {
			t.Fatalf("miss %d: %d", i, rec.Code)
		}
	}
	// The sixth miss crosses the limit; from then on everything from this address waits, even real paths.
	w.call("GET", "/phpmyadmin", "")
	if rec := w.call("GET", "/v1/me", ""); rec.Code != 429 || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("paused address: %d", rec.Code)
	}
	// Another address is not affected.
	req := httptest.NewRequest("GET", "http://"+authHost+"/v1/me", nil)
	req.RemoteAddr = "10.0.0.9:1"
	req.Header.Set("X-Forwarded-For", "198.51.100.77")
	rec := httptest.NewRecorder()
	w.g.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("other address: %d", rec.Code)
	}
	// After the pause it is let back in.
	now = now.Add(16 * time.Minute)
	if rec := w.call("GET", "/v1/me", ""); rec.Code != 200 {
		t.Fatalf("after the pause: %d", rec.Code)
	}
}

func TestOldMissesAreForgotten(t *testing.T) {
	w := shieldWorld(t, map[string]string{"SCAN_LIMIT": "5"})
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	w.g.now = func() time.Time { return now }
	for i := 0; i < 5; i++ {
		w.call("GET", "/nothing", "")
		now = now.Add(3 * time.Minute) // slower than the limit allows
	}
	if rec := w.call("GET", "/v1/me", ""); rec.Code != 200 {
		t.Fatalf("slow misses must not pause anyone: %d", rec.Code)
	}
}

func TestOddPathsAndUnknownHostsCountAsMisses(t *testing.T) {
	s := newScanners(2, time.Minute, time.Minute)
	now := time.Now()
	for i := 0; i < 3; i++ {
		s.miss("1.2.3.4", now)
	}
	if !s.blocked("1.2.3.4", now) || s.blocked("1.2.3.5", now) {
		t.Fatal("only the scanner is paused")
	}
	if s.blocked("1.2.3.4", now.Add(2*time.Minute)) {
		t.Fatal("the pause must end")
	}
	// The table cannot be grown without limit.
	for i := 0; i < maxScanEntries+10; i++ {
		s.miss(string(rune(i))+"x", now.Add(10*time.Minute))
	}
	if len(s.entries) > maxScanEntries {
		t.Fatalf("%d entries", len(s.entries))
	}
}

func TestResponsesDoNotNameTheirSoftware(t *testing.T) {
	res := &http.Response{Header: http.Header{"Server": {"nginx/1.27"}, "X-Powered-By": {"Express"}, "Via": {"1.1 x"}, "Content-Type": {"application/json"}}}
	scrub(res)
	if res.Header.Get("Server") != "" || res.Header.Get("X-Powered-By") != "" || res.Header.Get("Via") != "" || res.Header.Get("Content-Type") == "" {
		t.Fatalf("%v", res.Header)
	}
}

func TestAuthHostMustBeARoute(t *testing.T) {
	_, err := loadConfig(func(k string) string {
		return map[string]string{"ROUTES": "a.example=http://127.0.0.1:1", "AUTH_HOST": "b.example"}[k]
	})
	if err == nil {
		t.Fatal("an auth host nobody routes to must not start")
	}
}

// In a full checkout, the list of routes here must be exactly the routes auth has.
func TestTheAllowListMatchesTheAuthSource(t *testing.T) {
	var sources []string
	for _, name := range []string{"routes.rs", "oauth.rs", "mfa.rs", "email.rs", "human.rs"} {
		raw, err := os.ReadFile("../auth/src/" + name)
		if err != nil {
			t.Skip("auth's source is not in this checkout")
		}
		sources = append(sources, string(raw))
	}
	text := strings.Join(sources, "\n")
	found := map[string]bool{}
	paramName := regexp.MustCompile(`\{[a-z_]+\}`)
	for _, m := range regexp.MustCompile(`\.route\("([^"]+)",\s*((?:[a-z_]+\([^()]*\)\.?)+)\)`).FindAllStringSubmatch(text, -1) {
		path := paramName.ReplaceAllStringFunc(m[1], func(string) string { return "{x}" })
		for _, verb := range []string{"get", "post", "delete", "put", "patch"} {
			if regexp.MustCompile(`\b` + verb + `\(`).MatchString(m[2]) {
				found[strings.ToUpper(verb)+" "+path] = true
			}
		}
	}
	listed := map[string]bool{}
	for _, route := range authRoutes {
		path := paramName.ReplaceAllStringFunc(route, func(string) string { return "{x}" })
		listed[path] = true
	}
	for route := range found {
		if route == "GET /healthz" || route == "GET /version" {
			continue // for the private network, never through the gateway
		}
		if !listed[route] {
			t.Errorf("auth has %q, the gateway does not allow it", route)
		}
	}
	for route := range listed {
		if !found[route] {
			t.Errorf("the gateway allows %q, auth has no such route", route)
		}
	}
}

// The Go rebuild of auth (services/auth-go) must have exactly the routes the allow-list has, too. Skipped when its source is not in this checkout.
func TestTheAllowListMatchesTheGoAuthSource(t *testing.T) {
	files, _ := filepath.Glob("../auth-go/*.go")
	if len(files) == 0 {
		t.Skip("the Go auth's source is not in this checkout")
	}
	var text strings.Builder
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		text.Write(raw)
		text.WriteByte('\n')
	}
	paramName := regexp.MustCompile(`\{[a-z_]+\}`)
	norm := func(route string) string { return paramName.ReplaceAllString(route, "{x}") }
	found := map[string]bool{}
	for _, m := range regexp.MustCompile(`mux\.Handle(?:Func)?\("(GET|POST|DELETE|PUT|PATCH) ([^"]+)"`).FindAllStringSubmatch(text.String(), -1) {
		found[norm(m[1]+" "+m[2])] = true
	}
	if len(found) < 30 {
		t.Fatalf("found only %d routes in the Go auth: the pattern no longer matches how it registers them", len(found))
	}
	listed := map[string]bool{}
	for _, route := range authRoutes {
		listed[norm(route)] = true
	}
	for route := range found {
		if route == "GET /healthz" || route == "GET /version" {
			continue // for the private network, never through the gateway
		}
		if !listed[route] {
			t.Errorf("the Go auth has %q, the gateway does not allow it", route)
		}
	}
	for route := range listed {
		if !found[route] {
			t.Errorf("the gateway allows %q, the Go auth has no such route", route)
		}
	}
}
