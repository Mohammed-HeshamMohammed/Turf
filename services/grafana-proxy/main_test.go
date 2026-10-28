package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const website = "https://app.turf.example"

// A fake core API: each token has an answer to whoami, and every call is counted.
type fakeCore struct {
	mu      sync.Mutex
	answers map[string]int // token -> status; 200 answers as the matching person
	people  map[string]person
	calls   atomic.Int32
}

func (f *fakeCore) set(token string, status int, who person) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[token], f.people[token] = status, who
}

func (f *fakeCore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls.Add(1)
	if r.URL.Path != "/api/v1/platform/whoami" {
		http.NotFound(w, r)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
	f.mu.Lock()
	status, ok := f.answers[token]
	who := f.people[token]
	f.mu.Unlock()
	if !ok {
		status = http.StatusUnauthorized
	}
	w.WriteHeader(status)
	if status == http.StatusOK {
		_ = json.NewEncoder(w).Encode(who)
	}
}

type world struct {
	proxy   *proxy
	core    *fakeCore
	coreSrv *httptest.Server
	clock   time.Time
}

var (
	owner = person{ID: "11111111-1111-1111-1111-111111111111", Email: "owner@turf.example", Name: "App Owner", Role: "owner"}
	admin = person{ID: "22222222-2222-2222-2222-222222222222", Email: "helper@turf.example", Name: "Support Person", Role: "admin"}
)

// newWorld starts a fake core API and a fake Grafana that answers with the headers it was sent.
func newWorld(t *testing.T) *world {
	t.Helper()
	core := &fakeCore{answers: map[string]int{}, people: map[string]person{}}
	core.set("owner-token", 200, owner)
	core.set("admin-token", 200, admin)
	core.set("customer-token", 403, person{})
	core.set("no-mfa-token", 401, person{})
	coreSrv := httptest.NewServer(core)
	t.Cleanup(coreSrv.Close)
	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"path": r.URL.RequestURI(), "host": r.Host, "headers": r.Header})
	}))
	t.Cleanup(grafana.Close)
	env := map[string]string{"GRAFANA_URL": grafana.URL, "TURF_CORE_API_URL": coreSrv.URL, "TURF_WEBSITE_URL": website + "/"}
	cfg, err := loadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	w := &world{core: core, coreSrv: coreSrv, clock: time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)}
	w.proxy = newProxy(cfg)
	w.proxy.now = func() time.Time { return w.clock }
	return w
}

func (w *world) do(r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	w.proxy.ServeHTTP(rec, r)
	return rec
}

// signIn posts a token as the website does, and returns the response.
func (w *world) signIn(token, back string) *httptest.ResponseRecorder {
	form := url.Values{"token": {token}, "return": {back}}
	r := httptest.NewRequest(http.MethodPost, "https://grafana.turf.example/_turf/session", strings.NewReader(form.Encode()))
	r.Header.Set("content-type", "application/x-www-form-urlencoded")
	r.Header.Set("origin", website)
	return w.do(r)
}

func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookieName && c.Value != "" {
			return c
		}
	}
	t.Fatalf("no session cookie (status %d)", rec.Code)
	return nil
}

func hasSessionCookie(rec *httptest.ResponseRecorder) bool {
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookieName && c.Value != "" {
			return true
		}
	}
	return false
}

// page asks for a Grafana page with the session cookie, as a browser would.
func (w *world) page(path string, c *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "https://grafana.turf.example"+path, nil)
	r.Header.Set("accept", "text/html")
	if c != nil {
		r.AddCookie(c)
	}
	return w.do(r)
}

// seen is what fake Grafana received.
func seen(t *testing.T, rec *httptest.ResponseRecorder) (string, http.Header) {
	t.Helper()
	if rec.Code != 200 {
		t.Fatalf("Grafana not reached: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Path    string      `json:"path"`
		Headers http.Header `json:"headers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Path, got.Headers
}

func TestHealthAnswersWithoutSignIn(t *testing.T) {
	w := newWorld(t)
	rec := w.do(httptest.NewRequest(http.MethodGet, "/_turf/health", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"service":"grafana-proxy"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestWithoutASessionPagesGoToTheWebsiteAndCallsGet401(t *testing.T) {
	w := newWorld(t)
	rec := w.page("/d/abc?orgId=1", nil)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("location") != website+"/#/admin/grafana?return="+url.QueryEscape("/d/abc?orgId=1") {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("location"))
	}
	call := httptest.NewRequest(http.MethodGet, "/api/dashboards/home", nil)
	call.Header.Set("accept", "application/json")
	if rec := w.do(call); rec.Code != 401 {
		t.Fatalf("got %d", rec.Code)
	}
	if w.core.calls.Load() != 0 {
		t.Fatal("asked the core API with no token")
	}
}

func TestTheOwnerGetsInAsAdminAndTheBrowserCannotSpeakForThem(t *testing.T) {
	w := newWorld(t)
	rec := w.signIn("owner-token", "/d/abc?orgId=1")
	if rec.Code != http.StatusSeeOther || rec.Header().Get("location") != "/d/abc?orgId=1" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("location"))
	}
	c := sessionCookie(t, rec)
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || strings.Contains(c.Value, "owner-token") {
		t.Fatalf("cookie %+v", c)
	}

	r := httptest.NewRequest(http.MethodGet, "https://grafana.turf.example/d/abc", nil)
	r.AddCookie(c)
	r.AddCookie(&http.Cookie{Name: "grafana_session", Value: "keep"})
	r.Header.Set("X-WEBAUTH-USER", "someone-else")
	r.Header.Set("x-webauth-role", "Admin")
	r.Header.Set("X-Webauth-Extra", "forged")
	r.Header.Set("authorization", "Basic YWRtaW46YWRtaW4=")
	path, h := seen(t, w.do(r))
	if path != "/d/abc" {
		t.Fatalf("path %q", path)
	}
	if got := h.Values("X-Webauth-User"); len(got) != 1 || got[0] != owner.ID {
		t.Fatalf("user %v", got)
	}
	if h.Get("X-Webauth-Email") != owner.Email || h.Get("X-Webauth-Name") != owner.Name || h.Get("X-Webauth-Role") != "Admin" {
		t.Fatalf("headers %v", h)
	}
	if h.Get("X-Webauth-Extra") != "" || h.Get("authorization") != "" {
		t.Fatalf("forged headers reached Grafana: %v", h)
	}
	if cookie := h.Get("cookie"); strings.Contains(cookie, cookieName) || !strings.Contains(cookie, "grafana_session=keep") {
		t.Fatalf("cookie header %q", cookie)
	}
	if h.Get("x-forwarded-host") != "grafana.turf.example" {
		t.Fatalf("forwarded host %q", h.Get("x-forwarded-host"))
	}
}

func TestASystemAdministratorGetsTheConfiguredRole(t *testing.T) {
	w := newWorld(t)
	c := sessionCookie(t, w.signIn("admin-token", "/"))
	if _, h := seen(t, w.page("/", c)); h.Get("X-Webauth-Role") != "Editor" || h.Get("X-Webauth-User") != admin.ID {
		t.Fatalf("headers %v", h)
	}
	w.proxy.cfg.adminRole = "Viewer"
	if _, h := seen(t, w.page("/", c)); h.Get("X-Webauth-Role") != "Viewer" {
		t.Fatalf("role %q", h.Get("X-Webauth-Role"))
	}
}

func TestCustomersAndStaffWithoutTheAuthenticatorStepGetNoSession(t *testing.T) {
	w := newWorld(t)
	rec := w.signIn("customer-token", "/")
	if rec.Code != 403 || hasSessionCookie(rec) {
		t.Fatalf("customer: %d", rec.Code)
	}
	rec = w.signIn("no-mfa-token", "/")
	// A page, not a redirect: back at the website the same token would be posted again, forever.
	if rec.Code != 401 || rec.Header().Get("location") != "" || hasSessionCookie(rec) || !strings.Contains(rec.Body.String(), "authenticator") {
		t.Fatalf("no MFA: %d %q", rec.Code, rec.Header().Get("location"))
	}
	if rec := w.signIn("", "/"); rec.Code != 400 {
		t.Fatalf("no token: %d", rec.Code)
	}
}

func TestOnlyTheWebsiteMayPostASignIn(t *testing.T) {
	w := newWorld(t)
	for _, origin := range []string{"", "https://evil.example", "https://app.turf.example.evil.example", "http://app.turf.example"} {
		form := url.Values{"token": {"owner-token"}}
		r := httptest.NewRequest(http.MethodPost, "/_turf/session", strings.NewReader(form.Encode()))
		r.Header.Set("content-type", "application/x-www-form-urlencoded")
		if origin != "" {
			r.Header.Set("origin", origin)
		}
		if rec := w.do(r); rec.Code != 403 || hasSessionCookie(rec) {
			t.Fatalf("origin %q: %d", origin, rec.Code)
		}
	}
	if rec := w.do(httptest.NewRequest(http.MethodGet, "/_turf/session?token=owner-token", nil)); rec.Code != 405 {
		t.Fatalf("GET: %d", rec.Code)
	}
	if w.core.calls.Load() != 0 {
		t.Fatal("asked the core API for a refused post")
	}
}

func TestAForgedOrUnknownCookieOpensNothing(t *testing.T) {
	w := newWorld(t)
	sessionCookie(t, w.signIn("owner-token", "/"))
	rec := w.page("/", &http.Cookie{Name: cookieName, Value: "made-up"})
	if rec.Code != http.StatusSeeOther || !strings.HasPrefix(rec.Header().Get("location"), website) {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestAccessIsCheckedAgainOnceAMinute(t *testing.T) {
	w := newWorld(t)
	c := sessionCookie(t, w.signIn("admin-token", "/"))
	before := w.core.calls.Load()
	for i := 0; i < 5; i++ {
		w.clock = w.clock.Add(10 * time.Second)
		seen(t, w.page("/", c))
	}
	if got := w.core.calls.Load() - before; got != 0 {
		t.Fatalf("asked %d times within the minute", got)
	}
	w.clock = w.clock.Add(15 * time.Second)
	seen(t, w.page("/", c))
	if got := w.core.calls.Load() - before; got != 1 {
		t.Fatalf("asked %d times after a minute", got)
	}

	// The owner removes them as staff: out on the next check, and the session is gone for good.
	w.core.set("admin-token", 403, person{})
	w.clock = w.clock.Add(time.Minute)
	if rec := w.page("/", c); rec.Code != 403 {
		t.Fatalf("removed admin: %d", rec.Code)
	}
	w.core.set("admin-token", 200, admin)
	if rec := w.page("/", c); rec.Code != http.StatusSeeOther {
		t.Fatalf("the old session came back: %d", rec.Code)
	}
}

func TestAnExpiredTokenSendsThemToSignInAgain(t *testing.T) {
	w := newWorld(t)
	c := sessionCookie(t, w.signIn("owner-token", "/"))
	w.core.set("owner-token", 401, person{})
	w.clock = w.clock.Add(2 * time.Minute)
	rec := w.page("/d/abc", c)
	if rec.Code != http.StatusSeeOther || !strings.Contains(rec.Header().Get("location"), url.QueryEscape("/d/abc")) {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("location"))
	}
}

func TestTheSessionEndsAtItsMaximumAge(t *testing.T) {
	w := newWorld(t)
	c := sessionCookie(t, w.signIn("owner-token", "/"))
	w.clock = w.clock.Add(8*time.Hour + time.Second)
	if rec := w.page("/", c); rec.Code != http.StatusSeeOther {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestWhenTheCoreAPIIsDownNobodyGetsThrough(t *testing.T) {
	w := newWorld(t)
	c := sessionCookie(t, w.signIn("owner-token", "/"))
	w.coreSrv.Close()
	if rec := w.signIn("admin-token", "/"); rec.Code != 503 || hasSessionCookie(rec) {
		t.Fatalf("sign-in: %d", rec.Code)
	}
	w.clock = w.clock.Add(2 * time.Minute)
	if rec := w.page("/", c); rec.Code != 503 || strings.Contains(rec.Body.String(), owner.ID) {
		t.Fatalf("recheck: %d", rec.Code)
	}
}

func TestAStrangeAnswerFromTheCoreAPIIsNotTrusted(t *testing.T) {
	w := newWorld(t)
	w.core.set("odd-token", 200, person{ID: owner.ID, Role: "business-owner"})
	if rec := w.signIn("odd-token", "/"); rec.Code != 503 || hasSessionCookie(rec) {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestLogoutEndsTheSession(t *testing.T) {
	w := newWorld(t)
	c := sessionCookie(t, w.signIn("owner-token", "/"))
	r := httptest.NewRequest(http.MethodPost, "/_turf/logout", nil)
	r.AddCookie(c)
	rec := w.do(r)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("location") != website+"/#/admin" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("location"))
	}
	if rec := w.page("/", c); rec.Code != http.StatusSeeOther {
		t.Fatalf("still signed in: %d", rec.Code)
	}
}

func TestTheReturnPathStaysOnThisSite(t *testing.T) {
	for in, want := range map[string]string{
		"/d/abc?x=1":           "/d/abc?x=1",
		"":                     "/",
		"https://evil.example": "/",
		"//evil.example/x":     "/",
		"/\\evil.example":      "/",
		"/_turf/logout":        "/",
	} {
		if got := safeReturn(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestConfigNeedsItsAddressesAndChecksTheRest(t *testing.T) {
	base := map[string]string{"GRAFANA_URL": "http://grafana:3000", "TURF_CORE_API_URL": "http://core-api:8080", "TURF_WEBSITE_URL": "https://app.turf.example"}
	load := func(change map[string]string) (config, error) {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for k, v := range change {
			env[k] = v
		}
		return loadConfig(func(k string) string { return env[k] })
	}
	c, err := load(nil)
	if err != nil || c.recheck != time.Minute || c.adminRole != "Editor" || !c.secure || c.origin != "https://app.turf.example" {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	for _, bad := range []map[string]string{
		{"GRAFANA_URL": ""}, {"TURF_CORE_API_URL": ""}, {"TURF_WEBSITE_URL": ""}, {"TURF_WEBSITE_URL": "not a url"},
		{"RECHECK_EVERY": "soon"}, {"RECHECK_EVERY": "-1s"}, {"ADMIN_GRAFANA_ROLE": "GrafanaAdmin"},
	} {
		if _, err := load(bad); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
	if c, _ := load(map[string]string{"COOKIE_SECURE": "false", "ADMIN_GRAFANA_ROLE": "Viewer"}); c.secure || c.adminRole != "Viewer" {
		t.Fatalf("%+v", c)
	}
}
