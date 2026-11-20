package main

import (
	"callerwhale/runtimelog"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	authHost = "auth.callerwhale.example"
	coreHost = "gate.callerwhale.example"
)

// humanWorld is a gateway in front of a fake auth service, with a fake Google behind the check.
type humanWorld struct {
	g        *gateway
	reached  atomic.Int32 // requests that got through to the auth service
	asked    atomic.Int32 // questions put to the fake Google
	lastBody atomic.Value // the last body the auth service received
	coreHit  atomic.Int32 // requests that got through to the core API
	google   *httptest.Server
	answer   atomic.Value // func(url.Values) (int, any): what the fake Google says
}

func goodAnswer(action string) func(url.Values) (int, any) {
	return func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "score": 0.9, "action": action, "hostname": "callerwhale.com"}
	}
}

func newHumanWorld(t *testing.T, extra map[string]string) *humanWorld {
	t.Helper()
	w := &humanWorld{}
	auth := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.reached.Add(1)
		raw, _ := io.ReadAll(r.Body)
		w.lastBody.Store(string(raw))
		rw.Header().Set("content-type", "application/json")
		if r.URL.Path == "/v1/security" {
			_, _ = rw.Write([]byte(`{"bot_protection":{"enabled":false,"site_key":""},"password_policy":{"minimum":8}}`))
			return
		}
		_, _ = rw.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(auth.Close)
	core := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.coreHit.Add(1)
		_, _ = rw.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(core.Close)
	w.google = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.asked.Add(1)
		_ = r.ParseForm()
		status, body := w.answer.Load().(func(url.Values) (int, any))(r.PostForm)
		rw.Header().Set("content-type", "application/json")
		rw.WriteHeader(status)
		_ = json.NewEncoder(rw).Encode(body)
	}))
	t.Cleanup(w.google.Close)
	w.answer.Store(goodAnswer("signin"))
	env := map[string]string{
		"ROUTES":               authHost + "=" + auth.URL + "," + coreHost + "=" + core.URL,
		"CORE_HOST":            coreHost,
		"AUTH_JWKS_URL":        auth.URL + "/.well-known/jwks.json",
		"HUMAN_CHECK":          "true",
		"AUTH_HOST":            authHost,
		"RECAPTCHA_SITE_KEY":   "site-key-1",
		"RECAPTCHA_SECRET_KEY": "secret-key-1",
		"RECAPTCHA_HOSTNAMES":  "callerwhale.com, auth.callerwhale.com",
	}
	for k, v := range extra {
		env[k] = v
	}
	cfg, err := loadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	w.g = newGateway(cfg)
	if w.g.human != nil {
		w.g.human.endpoint = w.google.URL
	}
	return w
}

func (w *humanWorld) call(method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+authHost+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "10.0.0.9:4444"
	req.Header.Set("X-Forwarded-For", "203.0.113.9") // public traffic always comes through the proxy
	rec := httptest.NewRecorder()
	runtimelog.LogHTTP(w.g).ServeHTTP(rec, req)
	return rec
}

func (w *humanWorld) callCore(method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+coreHost+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "10.0.0.9:4444"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	rec := httptest.NewRecorder()
	runtimelog.LogHTTP(w.g).ServeHTTP(rec, req)
	return rec
}

func code(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	c, _ := out["code"].(string)
	return c
}

func TestSignInPassesWithAGoodToken(t *testing.T) {
	w := newHumanWorld(t, nil)
	var seen url.Values
	w.answer.Store(func(form url.Values) (int, any) {
		seen = form
		return goodAnswer("signin")(form)
	})
	rec := w.call("POST", "/v1/sessions", `{"email":"a@example.com","password":"x","human_token":"tok-1"}`)
	if rec.Code != 200 || w.reached.Load() != 1 {
		t.Fatalf("status %d reached %d: %s", rec.Code, w.reached.Load(), rec.Body)
	}
	// The service behind gets the request exactly as it was sent.
	if got := w.lastBody.Load().(string); !strings.Contains(got, `"email":"a@example.com"`) || !strings.Contains(got, `"human_token":"tok-1"`) {
		t.Fatalf("body changed on the way: %s", got)
	}
	if seen.Get("secret") != "secret-key-1" || seen.Get("response") != "tok-1" {
		t.Fatalf("google was asked %v", seen)
	}
	if _, sent := seen["remoteip"]; sent {
		t.Fatal("an address must never be sent to Google")
	}
}

func TestSignUpNeedsASignUpToken(t *testing.T) {
	w := newHumanWorld(t, nil)
	body := `{"name":"A","email":"a@example.com","password":"x","human_token":"tok"}`
	// A token the page asked for sign-in cannot be used to sign up.
	if rec := w.call("POST", "/v1/accounts", body); rec.Code != 403 || code(t, rec) != "human_required" {
		t.Fatalf("wrong action: %d %s", rec.Code, rec.Body)
	}
	w.answer.Store(goodAnswer("signup"))
	if rec := w.call("POST", "/v1/accounts", body); rec.Code != 200 {
		t.Fatalf("right action: %d %s", rec.Code, rec.Body)
	}
	if w.reached.Load() != 1 {
		t.Fatalf("only the good one may reach auth, %d did", w.reached.Load())
	}
}

func TestEveryWayOfFailingIsARefusalAndNeverReachesAuth(t *testing.T) {
	cases := map[string]func(url.Values) (int, any){
		"success false": func(url.Values) (int, any) { return 200, map[string]any{"success": false} },
		"low score": func(url.Values) (int, any) {
			return 200, map[string]any{"success": true, "score": 0.2, "action": "signin", "hostname": "callerwhale.com"}
		},
		"no score": func(url.Values) (int, any) {
			return 200, map[string]any{"success": true, "action": "signin", "hostname": "callerwhale.com"}
		},
		"wrong hostname": func(url.Values) (int, any) {
			return 200, map[string]any{"success": true, "score": 0.9, "action": "signin", "hostname": "evil.example"}
		},
		"no hostname": func(url.Values) (int, any) {
			return 200, map[string]any{"success": true, "score": 0.9, "action": "signin"}
		},
		"wrong action": goodAnswer("signup"),
		"google error": func(url.Values) (int, any) { return 500, map[string]any{"success": true} },
		"not json":     func(url.Values) (int, any) { return 200, "nonsense" },
	}
	for name, answer := range cases {
		t.Run(name, func(t *testing.T) {
			w := newHumanWorld(t, nil)
			w.answer.Store(answer)
			rec := w.call("POST", "/v1/sessions", `{"email":"a@example.com","password":"x","human_token":"tok"}`)
			if rec.Code != 403 || code(t, rec) != "human_required" || w.reached.Load() != 0 {
				t.Fatalf("%d %s reached %d", rec.Code, rec.Body, w.reached.Load())
			}
		})
	}
}

func TestHostnameMatchIgnoresCase(t *testing.T) {
	w := newHumanWorld(t, nil)
	w.answer.Store(func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "score": 0.9, "action": "signin", "hostname": "Auth.CallerWhale.com"}
	})
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"tok"}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestGoogleUnreachableFailsClosed(t *testing.T) {
	w := newHumanWorld(t, nil)
	w.google.Close()
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"tok"}`); rec.Code != 403 || w.reached.Load() != 0 {
		t.Fatalf("%d reached %d", rec.Code, w.reached.Load())
	}
}

func TestMissingAndOversizeTokensNeverAskGoogle(t *testing.T) {
	w := newHumanWorld(t, nil)
	for name, body := range map[string]string{
		"missing":    `{"email":"a@example.com"}`,
		"blank":      `{"human_token":"   "}`,
		"too long":   `{"human_token":"` + strings.Repeat("a", maxHumanToken+1) + `"}`,
		"wrong type": `{"human_token":["x"]}`,
	} {
		rec := w.call("POST", "/v1/sessions", body)
		want := 403
		if name == "wrong type" {
			want = 400 // not a request the pages ever send
		}
		if rec.Code != want {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body)
		}
	}
	if w.asked.Load() != 0 || w.reached.Load() != 0 {
		t.Fatalf("google asked %d, auth reached %d", w.asked.Load(), w.reached.Load())
	}
}

func TestBadBodiesAreRefusedBeforeAnything(t *testing.T) {
	w := newHumanWorld(t, nil)
	if rec := w.call("POST", "/v1/sessions", `not json`); rec.Code != 400 {
		t.Fatalf("not json: %d", rec.Code)
	}
	big := `{"human_token":"x","pad":"` + strings.Repeat("a", maxCheckedBody) + `"}`
	if rec := w.call("POST", "/v1/sessions", big); rec.Code != 413 {
		t.Fatalf("too large: %d", rec.Code)
	}
	if w.asked.Load() != 0 || w.reached.Load() != 0 {
		t.Fatal("nothing may get past a body that cannot be read")
	}
}

func TestProviderStartsUseTheBodysActionAndNeverTheAddress(t *testing.T) {
	w := newHumanWorld(t, nil)
	// By address a start cannot carry a token: always refused, never forwarded.
	if rec := w.call("GET", "/v1/oauth/google/start?target=desktop&port=48123", ""); rec.Code != 403 || code(t, rec) != "human_required" {
		t.Fatalf("GET start: %d %s", rec.Code, rec.Body)
	}
	// By POST the body says whether it is a sign-in (the default) or a sign-up.
	if rec := w.call("POST", "/v1/oauth/google/start", `{"target":"landing","human_token":"tok"}`); rec.Code != 200 {
		t.Fatalf("default action: %d %s", rec.Code, rec.Body)
	}
	if rec := w.call("POST", "/v1/oauth/apple/start", `{"target":"landing","human_token":"tok","action":"signup"}`); rec.Code != 403 {
		t.Fatalf("signup token from a signin page: %d", rec.Code)
	}
	if rec := w.call("POST", "/v1/oauth/apple/start", `{"human_token":"tok","action":"transfer"}`); rec.Code != 400 {
		t.Fatalf("unknown action: %d", rec.Code)
	}
	if w.reached.Load() != 1 {
		t.Fatalf("auth was reached %d times", w.reached.Load())
	}
}

func TestOnlyTheFirstLegIsGuarded(t *testing.T) {
	w := newHumanWorld(t, nil)
	for _, c := range [][2]string{
		{"POST", "/v1/sessions/refresh"}, {"POST", "/v1/sessions/sign-out"}, {"GET", "/v1/me"}, {"GET", "/v1/sessions"},
		{"GET", "/v1/providers"}, {"POST", "/v1/handoffs"}, {"GET", "/.well-known/jwks.json"}, {"OPTIONS", "/v1/sessions"},
		{"GET", "/v1/oauth/google/callback"}, {"POST", "/v1/oauth/exchange"},
	} {
		if rec := w.call(c[0], c[1], `{}`); rec.Code != 200 {
			t.Fatalf("%s %s: %d", c[0], c[1], rec.Code)
		}
	}
	if w.asked.Load() != 0 {
		t.Fatal("google must not be asked for these")
	}
	// Asking for a password reset email is guarded: it sends mail to anyone.
	if rule, guarded := ruleFor("POST", "/v1/password/forgot"); !guarded || rule.action != "forgot" {
		t.Fatal("the password reset request must be checked")
	}
	// A path that only looks like a start is not one.
	if _, guarded := ruleFor("POST", "/v1/oauth/google/extra/start"); guarded {
		t.Fatal("a nested path is not a provider start")
	}
}

func TestSecurityAnswerSaysTheCheckIsOn(t *testing.T) {
	w := newHumanWorld(t, nil)
	rec := w.call("GET", "/v1/security", "")
	var out struct {
		Bot struct {
			Enabled bool   `json:"enabled"`
			SiteKey string `json:"site_key"`
		} `json:"bot_protection"`
		Policy map[string]any `json:"password_policy"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%v: %s", err, rec.Body)
	}
	if !out.Bot.Enabled || out.Bot.SiteKey != "site-key-1" || out.Policy["minimum"] != float64(8) {
		t.Fatalf("%s", rec.Body)
	}
	if strings.Contains(rec.Body.String(), "secret-key-1") {
		t.Fatal("the secret key must never be sent out")
	}
	if rec.Header().Get("Content-Length") == "" {
		t.Fatal("the edited answer needs its own length")
	}
}

func TestEachAddressHasItsOwnLimitOnGuardedRoutes(t *testing.T) {
	w := newHumanWorld(t, map[string]string{"HUMAN_PER_MINUTE": "3"})
	w.answer.Store(func(url.Values) (int, any) { return 200, map[string]any{"success": false} })
	for i := 0; i < 3; i++ {
		if rec := w.call("POST", "/v1/sessions", `{"human_token":"tok"}`); rec.Code != 403 {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
	}
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"tok"}`); rec.Code != 429 {
		t.Fatalf("fourth attempt: %d", rec.Code)
	}
	if w.asked.Load() != 3 {
		t.Fatalf("a limited request must not cost a call to Google, google was asked %d times", w.asked.Load())
	}
	// Other routes on the same address are not affected.
	if rec := w.call("GET", "/v1/me", ""); rec.Code != 200 {
		t.Fatalf("other route: %d", rec.Code)
	}
}

func TestOffByDefault(t *testing.T) {
	w := newHumanWorld(t, map[string]string{"HUMAN_CHECK": "false"})
	if w.g.human != nil {
		t.Fatal("the check is on without being asked")
	}
	if rec := w.call("POST", "/v1/sessions", `{"email":"a"}`); rec.Code != 200 {
		t.Fatalf("%d", rec.Code)
	}
}

func TestSettingsAreChecked(t *testing.T) {
	base := map[string]string{
		"ROUTES": authHost + "=http://127.0.0.1:1", "HUMAN_CHECK": "true", "AUTH_HOST": authHost,
		"RECAPTCHA_SITE_KEY": "s", "RECAPTCHA_SECRET_KEY": "k", "RECAPTCHA_HOSTNAMES": "callerwhale.com",
	}
	with := func(change map[string]string) error {
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
	if err := with(nil); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]map[string]string{
		"no site key":          {"RECAPTCHA_SITE_KEY": ""},
		"no secret key":        {"RECAPTCHA_SECRET_KEY": " "},
		"no hostnames":         {"RECAPTCHA_HOSTNAMES": ""},
		"no auth host":         {"AUTH_HOST": ""},
		"auth host not routed": {"AUTH_HOST": "elsewhere.example"},
		"score out of range":   {"RECAPTCHA_MIN_SCORE": "1.5"},
		"score not a number":   {"RECAPTCHA_MIN_SCORE": "high"},
		"unknown kind":         {"RECAPTCHA_KIND": "invisible-v4"},
		"limit not a number":   {"HUMAN_PER_MINUTE": "-1"},
	} {
		if err := with(change); err == nil {
			t.Errorf("%s: this must not start", name)
		}
	}
	// Off, none of those matter.
	if err := with(map[string]string{"HUMAN_CHECK": "false", "RECAPTCHA_SITE_KEY": ""}); err != nil {
		t.Fatal(err)
	}
}

func TestTheWebsiteFormsNeedAHumanToken(t *testing.T) {
	for _, form := range []struct{ path, action string }{{"/api/v1/public/waitlist", "waitlist"}, {"/api/v1/public/contact", "contact"}} {
		w := newHumanWorld(t, nil)
		w.answer.Store(goodAnswer(form.action))
		// No token, or a token Google refuses: stopped here, the core API never sees it.
		if rec := w.callCore("POST", form.path, `{"email":"a@example.com"}`); rec.Code != http.StatusForbidden || code(t, rec) != "human_required" || w.coreHit.Load() != 0 {
			t.Fatalf("%s without a token: %d %s (core reached %d)", form.path, rec.Code, rec.Body, w.coreHit.Load())
		}
		// A token asked for under another form's name is not good for this one.
		w.answer.Store(goodAnswer("signin"))
		if rec := w.callCore("POST", form.path, `{"email":"a@example.com","human_token":"tok"}`); rec.Code != http.StatusForbidden || w.coreHit.Load() != 0 {
			t.Fatalf("%s with a token for another action: %d", form.path, rec.Code)
		}
		// The right token goes through, and the core API gets the body as it was sent.
		w.answer.Store(goodAnswer(form.action))
		if rec := w.callCore("POST", form.path, `{"email":"a@example.com","human_token":"tok"}`); rec.Code != 200 || w.coreHit.Load() != 1 {
			t.Fatalf("%s with a good token: %d %s (core reached %d)", form.path, rec.Code, rec.Body, w.coreHit.Load())
		}
	}
}

// The browser asks before it posts a form as JSON. The gateway answers that itself for the website, so a service behind with
// a missing or different origin list cannot stop the form being sent (it did: the live contact form never left the browser).
func TestTheWebsiteFormsPreflightIsAnsweredByTheGateway(t *testing.T) {
	preflight := func(w *humanWorld, path, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodOptions, "http://"+coreHost+path, nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "content-type")
		req.RemoteAddr = "10.0.0.9:4444"
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		rec := httptest.NewRecorder()
		runtimelog.LogHTTP(w.g).ServeHTTP(rec, req)
		return rec
	}
	for _, path := range []string{"/api/v1/public/contact", "/api/v1/public/waitlist"} {
		w := newHumanWorld(t, map[string]string{"CORS_ORIGINS": "https://callerwhale.com"})
		rec := preflight(w, path, "https://callerwhale.com")
		h := rec.Header()
		if rec.Code != http.StatusNoContent || h.Get("Access-Control-Allow-Origin") != "https://callerwhale.com" || h.Get("Access-Control-Allow-Methods") != "POST" || !strings.Contains(h.Get("Access-Control-Allow-Headers"), "content-type") {
			t.Fatalf("%s preflight from the site: %d %v", path, rec.Code, h)
		}
		if w.coreHit.Load() != 0 || w.asked.Load() != 0 {
			t.Fatalf("%s preflight reached the core API (%d) or Google (%d)", path, w.coreHit.Load(), w.asked.Load())
		}
		// Another site gets no permission at all.
		rec = preflight(w, path, "https://evil.example")
		if rec.Header().Get("Access-Control-Allow-Origin") != "" || rec.Header().Get("Access-Control-Allow-Methods") != "" {
			t.Fatalf("%s preflight from another site was allowed: %v", path, rec.Header())
		}
	}
}

func TestOtherCorePathsAreNotAskedForAHumanToken(t *testing.T) {
	w := newHumanWorld(t, nil)
	before := w.asked.Load()
	// Open, no sign-in and no human token: only the two forms are guarded.
	if rec := w.callCore("GET", "/api/v1/plans", ""); rec.Code != 200 {
		t.Fatalf("plans: %d %s", rec.Code, rec.Body)
	}
	if w.asked.Load() != before {
		t.Fatal("Google was asked about a path that is not a form")
	}
}

// The visible "I'm not a robot" box (v2): Google answers with no score and no action, so only success and the site count.
func TestTheCheckboxKind(t *testing.T) {
	w := newHumanWorld(t, map[string]string{"RECAPTCHA_KIND": "checkbox"})
	ticked := func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "hostname": "callerwhale.com"}
	}
	w.answer.Store(ticked)
	for _, path := range []string{"/v1/sessions", "/v1/accounts"} {
		if rec := w.call("POST", path, `{"email":"a@example.com","human_token":"tok"}`); rec.Code != 200 {
			t.Fatalf("%s with a ticked box: %d %s", path, rec.Code, rec.Body)
		}
	}
	if rec := w.call("POST", "/v1/oauth/google/start", `{"target":"landing","human_token":"tok","action":"signup"}`); rec.Code != 200 {
		t.Fatalf("Google start with a ticked box: %d %s", rec.Code, rec.Body)
	}
	reached := w.reached.Load()
	for name, answer := range map[string]map[string]any{
		"not ticked":     {"success": false, "error-codes": []string{"invalid-input-response"}},
		"another site":   {"success": true, "hostname": "evil.example"},
		"v3 keys in use": {"success": true, "hostname": "callerwhale.com", "score": 0.9, "action": "signin"},
	} {
		answer := answer
		w.answer.Store(func(url.Values) (int, any) { return 200, answer })
		if rec := w.call("POST", "/v1/sessions", `{"human_token":"tok"}`); rec.Code != 403 || code(t, rec) != "human_required" {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body)
		}
	}
	if rec := w.call("POST", "/v1/sessions", `{"email":"a"}`); rec.Code != 403 {
		t.Fatalf("no token: %d", rec.Code)
	}
	if w.reached.Load() != reached {
		t.Fatal("a refused request reached auth")
	}
	// The pages are told to show the box.
	rec := w.call("GET", "/v1/security", "")
	if !strings.Contains(rec.Body.String(), `"kind":"checkbox"`) {
		t.Fatalf("security answer: %s", rec.Body)
	}
}

func TestTheScoreKindIsTheDefaultAndSaysSo(t *testing.T) {
	w := newHumanWorld(t, nil)
	if rec := w.call("GET", "/v1/security", ""); !strings.Contains(rec.Body.String(), `"kind":"score"`) {
		t.Fatalf("security answer: %s", rec.Body)
	}
	// A v2 answer (no score) is still refused when the gateway expects v3.
	w.answer.Store(func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "hostname": "callerwhale.com"}
	})
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"tok"}`); rec.Code != 403 {
		t.Fatalf("v2 answer in score mode: %d", rec.Code)
	}
}

// The "I am not a robot" box for people the invisible check cannot vouch for.
func TestTheCheckboxIsTheFallbackForTheInvisibleCheck(t *testing.T) {
	w := newHumanWorld(t, map[string]string{"RECAPTCHA_FALLBACK_SITE_KEY": "box-site", "RECAPTCHA_FALLBACK_SECRET_KEY": "box-secret"})
	var secrets []string
	// The invisible keys say "looks like a bot" (score 0.1); the box keys say "ticked".
	w.answer.Store(func(form url.Values) (int, any) {
		secrets = append(secrets, form.Get("secret"))
		if form.Get("secret") == "box-secret" {
			return 200, map[string]any{"success": true, "hostname": "callerwhale.com"}
		}
		return 200, map[string]any{"success": true, "score": 0.1, "action": "signin", "hostname": "callerwhale.com"}
	})

	rec := w.call("POST", "/v1/sessions", `{"email":"a@example.com","human_token":"low-score-token"}`)
	var refusal map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &refusal)
	if rec.Code != 403 || refusal["code"] != "human_required" || refusal["fallback"] != true {
		t.Fatalf("a low score must say the box can be used: %d %s", rec.Code, rec.Body)
	}
	if rec := w.call("POST", "/v1/sessions", `{"email":"a@example.com","human_token":"v2:ticked-token"}`); rec.Code != 200 {
		t.Fatalf("a ticked box passes: %d %s", rec.Code, rec.Body)
	}
	if rec := w.call("POST", "/v1/accounts", `{"email":"a@example.com","human_token":"v2:ticked-token"}`); rec.Code != 200 {
		t.Fatalf("and for sign-up too, whatever action the page names: %d %s", rec.Code, rec.Body)
	}
	if secrets[len(secrets)-1] != "box-secret" {
		t.Fatalf("a box token is checked with the box keys: %v", secrets)
	}
	// A box that was not ticked, or a box token from the wrong site, is still refused.
	w.answer.Store(func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "hostname": "evil.example"}
	})
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"v2:tok"}`); rec.Code != 403 {
		t.Fatalf("the wrong site: %d", rec.Code)
	}
	w.answer.Store(func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "score": 0.9, "action": "signin", "hostname": "callerwhale.com"}
	})
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"v2:tok"}`); rec.Code != 403 {
		t.Fatalf("a v3 answer for a box token is not a ticked box: %d", rec.Code)
	}
	if rec := w.call("POST", "/v1/sessions", `{"human_token":"v2:"}`); rec.Code != 403 {
		t.Fatalf("an empty box token: %d", rec.Code)
	}
	// The pages learn the box's key.
	if rec := w.call("GET", "/v1/security", ""); !strings.Contains(rec.Body.String(), `"fallback_site_key":"box-site"`) {
		t.Fatalf("security answer: %s", rec.Body)
	}
	// A Google start by address can never carry a token, so it never offers the box.
	rec = w.call("GET", "/v1/oauth/google/start?target=landing", "")
	refusal = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &refusal)
	if rec.Code != 403 || refusal["fallback"] == true {
		t.Fatalf("start by address: %d %s", rec.Code, rec.Body)
	}
}

func TestWithoutAFallbackABoxTokenIsRefusedAndTheAnswerOffersNoBox(t *testing.T) {
	w := newHumanWorld(t, nil)
	w.answer.Store(func(url.Values) (int, any) {
		return 200, map[string]any{"success": true, "hostname": "callerwhale.com"}
	})
	rec := w.call("POST", "/v1/sessions", `{"human_token":"v2:tok"}`)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 403 || out["fallback"] != nil {
		t.Fatalf("no fallback set up: %d %s", rec.Code, rec.Body)
	}
	if w.asked.Load() != 0 {
		t.Fatal("Google was asked about a box token that can never be accepted")
	}
	if strings.Contains(w.call("GET", "/v1/security", "").Body.String(), "fallback_site_key") {
		t.Fatal("no box key to announce")
	}
}

func TestTheFallbackKeysAreChecked(t *testing.T) {
	cases := map[string]map[string]string{
		"only the site key":      {"RECAPTCHA_FALLBACK_SITE_KEY": "box"},
		"only the secret":        {"RECAPTCHA_FALLBACK_SECRET_KEY": "box"},
		"with the checkbox kind": {"RECAPTCHA_KIND": "checkbox", "RECAPTCHA_FALLBACK_SITE_KEY": "box", "RECAPTCHA_FALLBACK_SECRET_KEY": "box-s"},
		"the same site key":      {"RECAPTCHA_FALLBACK_SITE_KEY": "site-key-1", "RECAPTCHA_FALLBACK_SECRET_KEY": "box-s"},
		"the same secret key":    {"RECAPTCHA_FALLBACK_SITE_KEY": "box", "RECAPTCHA_FALLBACK_SECRET_KEY": "secret-key-1"},
	}
	for name, extra := range cases {
		env := map[string]string{
			"ROUTES": authHost + "=http://127.0.0.1:1", "HUMAN_CHECK": "true", "AUTH_HOST": authHost,
			"RECAPTCHA_SITE_KEY": "site-key-1", "RECAPTCHA_SECRET_KEY": "secret-key-1", "RECAPTCHA_HOSTNAMES": "callerwhale.com",
		}
		for k, v := range extra {
			env[k] = v
		}
		if _, err := loadConfig(func(k string) string { return env[k] }); err == nil {
			t.Errorf("%s must be refused at start", name)
		}
	}
}
