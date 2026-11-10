package main

// The human check: Google reCAPTCHA in front of the auth service's first-leg requests. RECAPTCHA_KIND picks the kind: "score"
// (v3, invisible, the default) or "checkbox" (v2, the visible "I'm not a robot" box). The two need different keys from Google. The auth
// service does not check it any more: this is the one place a token is verified, because
// Google accepts a token only once. The same check will guard payment routes, each with its own minimum score.
//
// Plan: docs/plans/go-auth.md and docs/plans/bot-protection.md.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	kindScore    = "score"
	kindCheckbox = "checkbox"
)

const (
	siteverifyURL  = "https://www.google.com/recaptcha/api/siteverify"
	maxHumanToken  = 8192     // bytes; a real reCAPTCHA token is about 2.3 KB today and has grown before, so this is a limit on abuse, not on size
	maxCheckedBody = 64 << 10 // a sign-in, sign-up or provider start is a few hundred bytes
)

// humanSettings is what the environment says: nothing here is a secret except the secret key.
type humanSettings struct {
	kind    string // "score" (v3) or "checkbox" (v2); the pages are told which, through /v1/security
	siteKey string
	secret  string
	// The checkbox (v2) keys kept for people the invisible check cannot vouch for: with them, a visitor whose score is too low is shown
	// the "I'm not a robot" box instead of being stuck. Only with kind "score"; both keys or neither.
	fallbackSiteKey string
	fallbackSecret  string
	hostnames       []string // the sites a token may come from, as Google reports them
	minScore        float64  // 0 (bot) to 1 (human); Google's default is 0.5
	authHost        string   // the ROUTES host of the auth service
	perMinute       int      // guarded requests a minute from one address, before any of them reaches Google
}

func loadHuman(getenv func(string) string, routes map[string]*route) (*humanSettings, error) {
	if strings.TrimSpace(getenv("HUMAN_CHECK")) != "true" {
		return nil, nil
	}
	h := &humanSettings{
		siteKey:  strings.TrimSpace(getenv("RECAPTCHA_SITE_KEY")),
		secret:   strings.TrimSpace(getenv("RECAPTCHA_SECRET_KEY")),
		authHost: strings.ToLower(strings.TrimSpace(getenv("AUTH_HOST"))),
		minScore: 0.5, perMinute: 30, kind: kindScore,
	}
	switch kind := strings.ToLower(strings.TrimSpace(getenv("RECAPTCHA_KIND"))); kind {
	case "", kindScore:
	case kindCheckbox:
		h.kind = kindCheckbox
	default:
		return nil, errors.New(`RECAPTCHA_KIND is "score" (v3, invisible) or "checkbox" (v2, the "I'm not a robot" box)`)
	}
	if h.siteKey == "" || h.secret == "" {
		return nil, errors.New("HUMAN_CHECK=true needs RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY")
	}
	h.fallbackSiteKey = strings.TrimSpace(getenv("RECAPTCHA_FALLBACK_SITE_KEY"))
	h.fallbackSecret = strings.TrimSpace(getenv("RECAPTCHA_FALLBACK_SECRET_KEY"))
	if (h.fallbackSiteKey == "") != (h.fallbackSecret == "") {
		return nil, errors.New("RECAPTCHA_FALLBACK_SITE_KEY and RECAPTCHA_FALLBACK_SECRET_KEY go together: set both or neither")
	}
	if h.fallbackSecret != "" && (h.kind != kindScore || h.fallbackSiteKey == h.siteKey || h.fallbackSecret == h.secret) {
		return nil, errors.New("the RECAPTCHA_FALLBACK_* keys are the v2 checkbox keys for RECAPTCHA_KIND=score (v3), and must be different keys from the v3 ones")
	}
	for _, host := range strings.Split(getenv("RECAPTCHA_HOSTNAMES"), ",") {
		if host = strings.ToLower(strings.TrimSpace(host)); host != "" {
			h.hostnames = append(h.hostnames, host)
		}
	}
	if len(h.hostnames) == 0 {
		return nil, errors.New("HUMAN_CHECK=true needs RECAPTCHA_HOSTNAMES, like callerwhale.com,auth.callerwhale.com")
	}
	if h.authHost == "" || routes[h.authHost] == nil {
		return nil, errors.New("HUMAN_CHECK=true needs AUTH_HOST, one of the ROUTES hosts (the auth service)")
	}
	if v := strings.TrimSpace(getenv("RECAPTCHA_MIN_SCORE")); v != "" {
		score, err := strconv.ParseFloat(v, 64)
		if err != nil || score < 0 || score > 1 {
			return nil, errors.New("RECAPTCHA_MIN_SCORE is a number from 0 to 1")
		}
		h.minScore = score
	}
	if v := strings.TrimSpace(getenv("HUMAN_PER_MINUTE")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return nil, errors.New("HUMAN_PER_MINUTE is not a positive number")
		}
		h.perMinute = n
	}
	return h, nil
}

// humanCheck verifies tokens with Google.
type humanCheck struct {
	humanSettings
	endpoint string
	client   *http.Client
}

func newHumanCheck(s humanSettings) *humanCheck {
	return &humanCheck{humanSettings: s, endpoint: siteverifyURL, client: &http.Client{
		Timeout: 8 * time.Second,
		// A redirect from Google's endpoint would be a different server answering for it.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// humanRule says what one guarded request must prove.
type humanRule struct {
	action   string  // the reCAPTCHA action the page asked its token for; empty: the request body says (signin or signup)
	minScore float64 // 0: the default
	refuse   bool    // the request has no way to carry a token and is never allowed
}

// ruleFor is the check a request to the auth service needs, if any. Only the first leg of signing in is guarded: the
// steps after it (the second step, refresh, sign-out, /v1/me) already need something an anonymous bot does not have.
func ruleFor(method, path string) (humanRule, bool) {
	switch {
	case method == http.MethodPost && path == "/v1/accounts":
		return humanRule{action: "signup"}, true
	case method == http.MethodPost && path == "/v1/sessions":
		return humanRule{action: "signin"}, true
	case strings.HasPrefix(path, "/v1/oauth/") && strings.HasSuffix(path, "/start") && !strings.Contains(strings.TrimSuffix(strings.TrimPrefix(path, "/v1/oauth/"), "/start"), "/"):
		if method == http.MethodPost {
			return humanRule{}, true
		}
		// A start by address cannot carry a token: it would be a way around the check.
		if method == http.MethodGet {
			return humanRule{refuse: true}, true
		}
	}
	return humanRule{}, false
}

// formRuleFor is the check the website's two public forms need on the core API: a waitlist sign-up or a contact message is proven
// human here, with a token the page asked Google for under the form's own name.
func formRuleFor(method, path string) (humanRule, bool) {
	if method != http.MethodPost {
		return humanRule{}, false
	}
	switch path {
	case "/api/v1/public/waitlist":
		return humanRule{action: "waitlist"}, true
	case "/api/v1/public/contact":
		return humanRule{action: "contact"}, true
	case "/api/v1/public/remove-my-information":
		return humanRule{action: "removal"}, true
	}
	return humanRule{}, false
}

// fallbackPrefix marks a token that came from the fallback checkbox, so the gateway checks it with the checkbox keys.
const fallbackPrefix = "v2:"

type humanBody struct {
	Token  string `json:"human_token"`
	Action string `json:"action"`
}

// guard answers false after writing the refusal. The body is read to find the token and put back for the service behind.
func (h *humanCheck) guard(w http.ResponseWriter, r *http.Request, rule humanRule) bool {
	if rule.refuse {
		h.refuse(w, false)
		return false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCheckedBody))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "That request is too large.", "code": "bad_request"})
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	r.ContentLength = int64(len(raw))
	var body humanBody
	if json.Unmarshal(raw, &body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "That request could not be read.", "code": "bad_request"})
		return false
	}
	action := rule.action
	if action == "" {
		// A provider start is for signing in or signing up; anything else is not a question the page asks.
		if body.Action = strings.TrimSpace(body.Action); body.Action == "" {
			body.Action = "signin"
		}
		if body.Action != "signin" && body.Action != "signup" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Choose sign-in or sign-up.", "code": "bad_request"})
			return false
		}
		action = body.Action
	}
	min := rule.minScore
	if min == 0 {
		min = h.minScore
	}
	if !h.verify(r.Context(), body.Token, action, min) {
		h.refuse(w, true)
		return false
	}
	return true
}

// verify checks a token the way its page produced it: a token from the fallback checkbox (marked "v2:") with the checkbox keys, any other
// with the main keys. A "v2:" token is refused when no fallback is set up, so the prefix cannot be used to step around the main check.
func (h *humanCheck) verify(ctx context.Context, token, action string, minScore float64) bool {
	if rest, ok := strings.CutPrefix(token, fallbackPrefix); ok {
		if h.fallbackSecret == "" {
			log.Print("WARN human check refused: a fallback checkbox token arrived, but no RECAPTCHA_FALLBACK_* keys are set")
			return false
		}
		return h.verifyWith(ctx, rest, h.fallbackSecret, kindCheckbox, action, minScore)
	}
	return h.verifyWith(ctx, token, h.secret, h.kind, action, minScore)
}

// verifyWith is true only when Google says the token is good, for this action, from one of our sites, with a high enough score.
// Anything else, including Google not answering, is a refusal.
func (h *humanCheck) verifyWith(ctx context.Context, token, secret, kind, action string, minScore float64) bool {
	// Every refusal says why in the log (never the secret or the token), because from the page it only looks like "verify you are human".
	if strings.TrimSpace(token) == "" {
		log.Print("WARN human check refused: the request carried no token")
		return false
	}
	if len(token) > maxHumanToken {
		log.Printf("WARN human check refused: the token is %d bytes, over the %d allowed (maxHumanToken)", len(token), maxHumanToken)
		return false
	}
	// No remoteip: an address from a header or a body is not trusted, and Google does not need it.
	form := url.Values{"secret": {secret}, "response": {token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := h.client.Do(req)
	if err != nil {
		log.Printf("WARN human check refused: Google's check did not answer: %v", err)
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		log.Printf("WARN human check refused: Google's check answered %d", res.StatusCode)
		return false
	}
	var out struct {
		Success    bool     `json:"success"`
		Score      *float64 `json:"score"`
		Action     string   `json:"action"`
		Hostname   string   `json:"hostname"`
		ErrorCodes []string `json:"error-codes"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil {
		log.Printf("WARN human check refused: Google's answer could not be read: %v", err)
		return false
	}
	switch {
	case !out.Success:
		// invalid-input-secret: the secret key is wrong or is for another site key. browser-error or timeout-or-duplicate: the token is bad or used twice.
		log.Printf("WARN human check refused: Google does not accept the token (error codes: %v)", out.ErrorCodes)
		return false
	case kind == kindCheckbox:
		// A ticked box has no score and no action: the person passed Google's own test (and its pictures when it asked for them).
		if out.Score != nil {
			log.Printf("WARN human check refused: Google sent a score, so these keys are v3 keys but a checkbox (v2) check was expected")
			return false
		}
	case out.Score == nil:
		log.Printf("WARN human check refused: Google sent no score, so the keys are not reCAPTCHA v3 keys")
		return false
	case *out.Score < minScore:
		log.Printf("WARN human check refused: score %.2f is below the minimum %.2f (RECAPTCHA_MIN_SCORE)", *out.Score, minScore)
		return false
	case out.Action != action:
		log.Printf("WARN human check refused: the token is for action %q, this request needs %q", out.Action, action)
		return false
	}
	for _, host := range h.hostnames {
		if strings.EqualFold(out.Hostname, host) {
			return true
		}
	}
	log.Printf("WARN human check refused: the token is for the site %q, which is not in RECAPTCHA_HOSTNAMES %v", out.Hostname, h.hostnames)
	return false
}

// refuse answers a failed check. When a fallback checkbox is set up and the request could use it, the answer says so ("fallback": true),
// and the page shows the box.
func (h *humanCheck) refuse(w http.ResponseWriter, mayFallback bool) {
	body := map[string]any{"error": "Verify you are human and try again.", "code": "human_required"}
	if mayFallback && h.fallbackSecret != "" {
		body["fallback"] = true
	}
	writeJSON(w, http.StatusForbidden, body)
}

// announce makes the auth service's GET /v1/security tell the pages that the check is on, and which site key to use.
// The auth service itself answers "off" because it no longer checks; every other field is passed on unchanged.
func (h *humanCheck) announce(res *http.Response) error {
	if res.Request.URL.Path != "/v1/security" || res.Request.Method != http.MethodGet || res.StatusCode != http.StatusOK {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	res.Body.Close()
	if err != nil {
		return err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("security answer: %w", err)
	}
	protection := map[string]any{"enabled": true, "site_key": h.siteKey, "kind": h.kind}
	if h.fallbackSiteKey != "" {
		protection["fallback_site_key"] = h.fallbackSiteKey
	}
	doc["bot_protection"], _ = json.Marshal(protection)
	out, _ := json.Marshal(doc)
	res.Body = io.NopCloser(bytes.NewReader(out))
	res.ContentLength = int64(len(out))
	res.Header.Set("Content-Length", strconv.Itoa(len(out)))
	res.Header.Del("Content-Encoding")
	return nil
}
