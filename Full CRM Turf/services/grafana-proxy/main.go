// Grafana login proxy. Lets only Turf's staff (the platform owner and system administrators, who passed the
// authenticator step) into Grafana: it asks the core API who the person is (GET /api/v1/platform/whoami) and tells
// Grafana in its auth-proxy headers. Grafana trusts those headers only from this proxy's address.
// Plan: docs/plans/grafana-access.md.
//
// Sign-in: a visit without a session goes to the website's /admin/grafana, which posts the person's Turf token to
// /_turf/session. The token stays in this process's memory, never in the cookie (a random session id) or a URL, and is
// used to ask again at most once a RECHECK_EVERY. A refusal ends the session at once; a core API that can't be reached
// lets nobody through. Sessions live in memory, so run one copy; a restart only means signing in again.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	service    = "grafana-proxy"
	version    = "0.1.0"
	cookieName = "turf_grafana"
)

type config struct {
	grafana   *url.URL
	coreAPI   string // the core API's base URL, no trailing slash
	website   string // the website's base URL, no trailing slash
	origin    string // the website's origin: the only page allowed to post a sign-in
	recheck   time.Duration
	maxAge    time.Duration
	adminRole string // Grafana role for system administrators; the owner is always Admin
	secure    bool   // Secure cookies; off only for local http
}

func loadConfig(getenv func(string) string) (config, error) {
	var c config
	need := func(name string) (string, error) {
		v := strings.TrimRight(strings.TrimSpace(getenv(name)), "/")
		if v == "" {
			return "", fmt.Errorf("set %s", name)
		}
		return v, nil
	}
	g, err := need("GRAFANA_URL")
	if err != nil {
		return c, err
	}
	if c.grafana, err = url.Parse(g); err != nil || c.grafana.Host == "" {
		return c, errors.New("GRAFANA_URL is not a URL")
	}
	if c.coreAPI, err = need("TURF_CORE_API_URL"); err != nil {
		return c, err
	}
	if c.website, err = need("TURF_WEBSITE_URL"); err != nil {
		return c, err
	}
	w, err := url.Parse(c.website)
	if err != nil || w.Host == "" {
		return c, errors.New("TURF_WEBSITE_URL is not a URL")
	}
	c.origin = w.Scheme + "://" + w.Host
	duration := func(name string, fallback time.Duration) (time.Duration, error) {
		v := getenv(name)
		if v == "" {
			return fallback, nil
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return 0, fmt.Errorf("%s is not a duration like 60s", name)
		}
		return d, nil
	}
	if c.recheck, err = duration("RECHECK_EVERY", time.Minute); err != nil {
		return c, err
	}
	if c.maxAge, err = duration("SESSION_MAX_AGE", 8*time.Hour); err != nil {
		return c, err
	}
	switch c.adminRole = getenv("ADMIN_GRAFANA_ROLE"); c.adminRole {
	case "":
		c.adminRole = "Editor"
	case "Viewer", "Editor", "Admin":
	default:
		return c, errors.New("ADMIN_GRAFANA_ROLE is Viewer, Editor or Admin")
	}
	c.secure = getenv("COOKIE_SECURE") != "false"
	return c, nil
}

type person struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// What the core API said about a token.
type verdict int

const (
	allowed     verdict = iota
	refused             // signed in, but not staff (403)
	signInAgain         // no valid token, or the authenticator step is missing (401)
	unavailable         // the core API could not answer
)

type session struct {
	mu      sync.Mutex
	person  person
	token   string
	checked time.Time
	expires time.Time
}

type proxy struct {
	cfg      config
	client   *http.Client
	upstream *httputil.ReverseProxy
	now      func() time.Time

	mu       sync.Mutex
	sessions map[string]*session
}

func newProxy(cfg config) *proxy {
	p := &proxy{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second}, now: time.Now, sessions: map[string]*session{}}
	p.upstream = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(cfg.grafana)
			r.Out.Host = r.In.Host // Grafana's root_url is this proxy's domain
			r.SetXForwarded()
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Del("x-frame-options") // framing is limited to the website by frame-ancestors instead
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("grafana: %v", err)
			page(w, http.StatusBadGateway, "Grafana is not answering", "Try again in a minute.")
		},
	}
	return p
}

// whoami asks the core API whether the token belongs to Turf staff.
func (p *proxy) whoami(token string) (person, verdict) {
	req, err := http.NewRequest(http.MethodGet, p.cfg.coreAPI+"/api/v1/platform/whoami", nil)
	if err != nil {
		return person{}, unavailable
	}
	req.Header.Set("authorization", "Bearer "+token)
	res, err := p.client.Do(req)
	if err != nil {
		log.Printf("core API: %v", err)
		return person{}, unavailable
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusOK:
		var who person
		if json.NewDecoder(res.Body).Decode(&who) != nil || who.ID == "" || (who.Role != "owner" && who.Role != "admin") {
			return person{}, unavailable
		}
		return who, allowed
	case res.StatusCode == http.StatusUnauthorized:
		return person{}, signInAgain
	case res.StatusCode == http.StatusForbidden:
		return person{}, refused
	default:
		log.Printf("core API: whoami answered %d", res.StatusCode)
		return person{}, unavailable
	}
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Grafana opens only inside the admin page's frame: no other site may frame it, and a browser visiting its address
	// directly (a page of its own, not a frame) is turned away before anything else is checked.
	w.Header().Set("content-security-policy", "frame-ancestors "+p.cfg.origin)
	if r.URL.Path != "/_turf/health" && r.Header.Get("sec-fetch-dest") == "document" {
		page(w, http.StatusForbidden, "Open Grafana from the admin dashboard", "Grafana has no page of its own. Sign in to Caller Whale as staff, finish the authenticator step, and open it from the admin dashboard.")
		return
	}
	switch r.URL.Path {
	case "/_turf/health":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": service, "version": version})
	case "/_turf/session":
		p.signIn(w, r)
	case "/_turf/logout":
		p.logout(w, r)
	default:
		p.forward(w, r)
	}
}

// signIn takes the token the website posts, and opens a session if the core API says the person is staff.
func (p *proxy) signIn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		page(w, http.StatusMethodNotAllowed, "Not here", "Open Grafana from Turf's admin dashboard.")
		return
	}
	// Only the website may post a sign-in, so no other page can sign someone in as somebody else.
	if r.Header.Get("origin") != p.cfg.origin {
		page(w, http.StatusForbidden, "Not allowed", "Open Grafana from Turf's admin dashboard.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil || r.PostForm.Get("token") == "" {
		page(w, http.StatusBadRequest, "Sign-in missing", "Open Grafana from Turf's admin dashboard.")
		return
	}
	token := r.PostForm.Get("token")
	who, v := p.whoami(token)
	if v == signInAgain {
		// Not back to the website: it would post the same token again, round and round.
		page(w, http.StatusUnauthorized, "Sign in to Turf again", "Grafana needs a fresh sign-in with your authenticator code. Sign in to Turf again, then open Grafana from the admin dashboard.")
		return
	}
	if v != allowed {
		p.deny(w, r, v)
		return
	}
	id, err := randomID()
	if err != nil {
		page(w, http.StatusInternalServerError, "Something went wrong", "Try again.")
		return
	}
	now := p.now()
	s := &session{person: who, token: token, checked: now, expires: now.Add(p.cfg.maxAge)}
	p.mu.Lock()
	for k, old := range p.sessions {
		if now.After(old.expires) {
			delete(p.sessions, k)
		}
	}
	p.sessions[id] = s
	p.mu.Unlock()
	log.Printf("sign-in: %s (%s) as %s", who.Email, who.ID, who.Role)
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: id, Path: "/", HttpOnly: true, Secure: p.cfg.secure,
		// Lax, not Strict: the cookie is set on the post from the website and must come back on the redirect after it.
		SameSite: http.SameSiteLaxMode, MaxAge: int(p.cfg.maxAge / time.Second),
	})
	http.Redirect(w, r, safeReturn(r.PostForm.Get("return")), http.StatusSeeOther)
}

func (p *proxy) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		p.drop(c.Value)
	}
	p.clearCookie(w)
	// Shown in the admin page's frame, which can't load the website itself, so no redirect.
	page(w, http.StatusOK, "Signed out of Grafana", "Open Grafana again from the admin dashboard when you need it.")
}

// forward sends a signed-in staff member's request on to Grafana, saying who they are.
func (p *proxy) forward(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		p.toSignIn(w, r)
		return
	}
	p.mu.Lock()
	s := p.sessions[c.Value]
	p.mu.Unlock()
	if s == nil {
		p.clearCookie(w)
		p.toSignIn(w, r)
		return
	}
	s.mu.Lock()
	now := p.now()
	if now.After(s.expires) {
		s.mu.Unlock()
		p.drop(c.Value)
		p.clearCookie(w)
		p.toSignIn(w, r)
		return
	}
	if now.Sub(s.checked) >= p.cfg.recheck {
		who, v := p.whoami(s.token)
		switch v {
		case allowed:
			s.person, s.checked = who, now
		case unavailable:
			// Fail closed, but keep the session: it works again once the core API answers.
			s.mu.Unlock()
			page(w, http.StatusServiceUnavailable, "Can't check your access", "Turf's API is not answering. Try again in a minute.")
			return
		default:
			s.mu.Unlock()
			log.Printf("session ended: %s (%s), %s", s.person.Email, s.person.ID, map[verdict]string{refused: "no longer staff", signInAgain: "token no longer valid"}[v])
			p.drop(c.Value)
			p.clearCookie(w)
			p.deny(w, r, v)
			return
		}
	}
	who := s.person
	s.mu.Unlock()

	out := r.Clone(r.Context())
	// Nothing the browser sends may speak for the person, or reach Grafana as a credential.
	for name := range out.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-webauth-") {
			out.Header.Del(name)
		}
	}
	out.Header.Del("authorization")
	removeCookie(out, cookieName)
	out.Header.Set("X-WEBAUTH-USER", who.ID)
	out.Header.Set("X-WEBAUTH-EMAIL", who.Email)
	out.Header.Set("X-WEBAUTH-NAME", who.Name)
	out.Header.Set("X-WEBAUTH-ROLE", p.grafanaRole(who.Role))
	p.upstream.ServeHTTP(w, out)
}

func (p *proxy) grafanaRole(role string) string {
	if role == "owner" {
		return "Admin"
	}
	return p.cfg.adminRole
}

func (p *proxy) deny(w http.ResponseWriter, r *http.Request, v verdict) {
	switch v {
	case refused:
		page(w, http.StatusForbidden, "Grafana is for Turf's staff", "Only the platform owner and system administrators can open it.")
	case signInAgain:
		p.toSignIn(w, r)
	default:
		page(w, http.StatusServiceUnavailable, "Can't check your access", "Turf's API is not answering. Try again in a minute.")
	}
}

// toSignIn sends a page visit to the website to sign in and come back; anything else (Grafana's own API calls) gets a
// 401, and Grafana reloads the page.
func (p *proxy) toSignIn(w http.ResponseWriter, r *http.Request) {
	// In the admin page's frame the website can't load (it allows no framing), so the frame asks the page around it
	// to post a fresh sign-in.
	if r.Header.Get("sec-fetch-dest") == "iframe" && strings.Contains(r.Header.Get("accept"), "text/html") {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `<!doctype html><meta charset=utf-8><title>Checking your access</title><p>Checking your access…</p><script>parent.postMessage("turf-grafana-signin",%q)</script>`, p.cfg.origin)
		return
	}
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("accept"), "text/html") {
		back := url.QueryEscape(safeReturn(r.URL.RequestURI()))
		http.Redirect(w, r, p.cfg.website+"/admin/grafana?return="+back, http.StatusSeeOther)
		return
	}
	writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Sign in to Turf first."})
}

func (p *proxy) drop(id string) {
	p.mu.Lock()
	delete(p.sessions, id)
	p.mu.Unlock()
}

func (p *proxy) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true, Secure: p.cfg.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

// safeReturn keeps the place to go back to on this proxy: a path, never another site.
func safeReturn(to string) string {
	// Browsers drop tabs and line breaks inside a URL, so a tab between two slashes would become "//evil.example".
	if strings.IndexFunc(to, unicode.IsControl) >= 0 || strings.Contains(to, "\\") || !strings.HasPrefix(to, "/") || strings.HasPrefix(to, "//") || strings.HasPrefix(to, "/_turf/") {
		return "/"
	}
	return to
}

func removeCookie(r *http.Request, name string) {
	cookies := r.Cookies()
	r.Header.Del("cookie")
	for _, c := range cookies {
		if c.Name != name {
			r.AddCookie(c)
		}
	}
}

func randomID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func page(w http.ResponseWriter, status int, title, text string) {
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, "<!doctype html><meta charset=utf-8><title>%s</title><h1>%s</h1><p>%s</p>", html.EscapeString(title), html.EscapeString(title), html.EscapeString(text))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8120"
	}
	// "service health" is the container's health check: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "health" {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/_turf/health")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("%s listening on http://localhost:%s, in front of %s", service, port, cfg.grafana)
	srv := &http.Server{Addr: ":" + port, Handler: newProxy(cfg), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
