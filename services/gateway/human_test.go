package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

const authHost = "auth.callerwhale.example"

// humanWorld is a gateway in front of a fake auth service, with a fake Google behind the check.
type humanWorld struct {
	g        *gateway
	reached  atomic.Int32 // requests that got through to the auth service
	asked    atomic.Int32 // questions put to the fake Google
	lastBody atomic.Value // the last body the auth service received
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
		"ROUTES":               authHost + "=" + auth.URL,
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
	req.RemoteAddr = "203.0.113.9:4444"
	rec := httptest.NewRecorder()
	logHTTP(w.g).ServeHTTP(rec, req)
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
