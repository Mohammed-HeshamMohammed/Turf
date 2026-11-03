package main

// The human check: Google reCAPTCHA v3 (invisible, scored) in front of the auth service's first-leg requests. The auth
// service does not check it any more (AUTH_BOT_PROTECTION=false there): this is the one place a token is verified, because
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
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	siteverifyURL  = "https://www.google.com/recaptcha/api/siteverify"
	maxHumanToken  = 2048     // bytes; a real token is about 1.5 KB
	maxCheckedBody = 64 << 10 // a sign-in, sign-up or provider start is a few hundred bytes
)

// humanSettings is what the environment says: nothing here is a secret except the secret key.
type humanSettings struct {
	siteKey   string
	secret    string
	hostnames []string // the sites a token may come from, as Google reports them
	minScore  float64  // 0 (bot) to 1 (human); Google's default is 0.5
	authHost  string   // the ROUTES host of the auth service
	perMinute int      // guarded requests a minute from one address, before any of them reaches Google
}

func loadHuman(getenv func(string) string, routes map[string]*route) (*humanSettings, error) {
	if strings.TrimSpace(getenv("HUMAN_CHECK")) != "true" {
		return nil, nil
	}
	h := &humanSettings{
		siteKey:  strings.TrimSpace(getenv("RECAPTCHA_SITE_KEY")),
		secret:   strings.TrimSpace(getenv("RECAPTCHA_SECRET_KEY")),
		authHost: strings.ToLower(strings.TrimSpace(getenv("AUTH_HOST"))),
		minScore: 0.5, perMinute: 30,
	}
	if h.siteKey == "" || h.secret == "" {
		return nil, errors.New("HUMAN_CHECK=true needs RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY")
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
	}
	return humanRule{}, false
}

type humanBody struct {
	Token  string `json:"human_token"`
	Action string `json:"action"`
}

// guard answers false after writing the refusal. The body is read to find the token and put back for the service behind.
func (h *humanCheck) guard(w http.ResponseWriter, r *http.Request, rule humanRule) bool {
	if rule.refuse {
		humanRequired(w)
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
		humanRequired(w)
		return false
	}
	return true
}

// verify is true only when Google says the token is good, for this action, from one of our sites, with a high enough score.
// Anything else, including Google not answering, is a refusal.
func (h *humanCheck) verify(ctx context.Context, token, action string, minScore float64) bool {
	if strings.TrimSpace(token) == "" || len(token) > maxHumanToken {
		return false
	}
	// No remoteip: an address from a header or a body is not trusted, and Google does not need it.
	form := url.Values{"secret": {h.secret}, "response": {token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := h.client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	var out struct {
		Success  bool     `json:"success"`
		Score    *float64 `json:"score"`
		Action   string   `json:"action"`
		Hostname string   `json:"hostname"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out) != nil {
		return false
	}
	if !out.Success || out.Score == nil || *out.Score < minScore || out.Action != action {
		return false
	}
	for _, host := range h.hostnames {
		if strings.EqualFold(out.Hostname, host) {
			return true
		}
	}
	return false
}

func humanRequired(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]any{"error": "Verify you are human and try again.", "code": "human_required"})
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
	doc["bot_protection"], _ = json.Marshal(map[string]any{"enabled": true, "site_key": h.siteKey})
	out, _ := json.Marshal(doc)
	res.Body = io.NopCloser(bytes.NewReader(out))
	res.ContentLength = int64(len(out))
	res.Header.Set("Content-Length", strconv.Itoa(len(out)))
	res.Header.Del("Content-Encoding")
	return nil
}
