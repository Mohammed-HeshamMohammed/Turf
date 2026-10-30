// Gateway: the one public entry point for Caller Whale's servers. It routes by the host name to the service behind it
// (the core API, the Grafana login proxy), and checks every request before it gets there: a path that must stay
// private is not found, a request that needs a signed-in person must carry a valid Firebase token (signature, issuer,
// audience and expiry, checked with Google's public keys), staff paths also need the authenticator step, and each
// address and each person has a rate limit. The services behind it check again for themselves: the gateway narrows
// what reaches them, it does not replace their checks. Plan: docs/plans/gateway.md.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	service = "gateway"
	version = "0.2.0"
)

type route struct {
	host     string
	upstream *url.URL
	core     bool // the core API: its paths are classified and need tokens as the policy says
	proxy    *httputil.ReverseProxy
}

type config struct {
	routes        map[string]*route
	project       string // the Firebase project: tokens must be issued for it
	jwksURL       string
	staffSecond   bool // staff paths need the authenticator step in the token
	ipPerMinute   int
	userPerMinute int
	maxBody       int64
	hops          int // proxies in front of this one (Coolify's Traefik: 1), to find the caller's address
}

func loadConfig(getenv func(string) string) (config, error) {
	c := config{routes: map[string]*route{}, jwksURL: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"}
	number := func(name string, fallback int) (int, error) {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return fallback, nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("%s is not a positive number", name)
		}
		return n, nil
	}
	core := strings.ToLower(strings.TrimSpace(getenv("CORE_HOST")))
	for _, item := range strings.Split(getenv("ROUTES"), ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		host, target, ok := strings.Cut(item, "=")
		u, err := url.Parse(strings.TrimSpace(target))
		if !ok || err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return c, fmt.Errorf("ROUTES: %q is not host=http://upstream", item)
		}
		host = strings.ToLower(strings.TrimSpace(host))
		c.routes[host] = &route{host: host, upstream: u, core: host == core}
	}
	if len(c.routes) == 0 {
		return c, errors.New("set ROUTES, like app.example.com=http://core-api:8088")
	}
	if core != "" && c.routes[core] == nil {
		return c, errors.New("CORE_HOST is not one of the ROUTES hosts")
	}
	if core != "" {
		if c.project = strings.TrimSpace(getenv("FIREBASE_PROJECT_ID")); c.project == "" {
			return c, errors.New("set FIREBASE_PROJECT_ID: the core API's tokens are checked against it")
		}
	}
	if v := strings.TrimSpace(getenv("FIREBASE_JWKS_URL")); v != "" {
		c.jwksURL = v
	}
	c.staffSecond = getenv("STAFF_REQUIRE_SECOND_FACTOR") != "false"
	var err error
	if c.ipPerMinute, err = number("IP_PER_MINUTE", 600); err != nil {
		return c, err
	}
	if c.userPerMinute, err = number("USER_PER_MINUTE", 1800); err != nil {
		return c, err
	}
	mb, err := number("MAX_BODY_MB", 64)
	if err != nil {
		return c, err
	}
	c.maxBody = int64(mb) << 20
	if c.hops, err = number("PROXY_HOPS", 1); err != nil {
		return c, err
	}
	return c, nil
}

// need is what a path on the core API asks of the caller.
type need int

const (
	open     need = iota // nothing: the website's files, public information
	signedIn             // a valid token
	staff                // a valid token with the authenticator step
	private              // never reachable from outside: answered as not found
)

// classify decides what a core API request needs. Paths nobody listed as open fall under /api/v1 or the sync and event
// routes and need a token; the internal routes (worker jobs, imports) never leave the private network.
func classify(method, path string) need {
	switch {
	case path == "/healthz":
		return open
	case path == "/internal" || strings.HasPrefix(path, "/internal/") || path == "/readyz":
		return private
	case method == http.MethodGet && (path == "/api/v1/auth/service" || path == "/api/v1/plans" || strings.HasPrefix(path, "/api/v1/download/")):
		return open
	case method == http.MethodPost && path == "/api/v1/billing/webhook": // the payment provider's signature is checked by the core API
		return open
	case path == "/api/v1/platform" || strings.HasPrefix(path, "/api/v1/platform/"):
		return staff
	case strings.HasPrefix(path, "/api/v1/") || path == "/sync" || strings.HasPrefix(path, "/sync/") || path == "/events":
		return signedIn
	}
	return open
}

type gateway struct {
	cfg    config
	keys   *keyset
	ips    *limiter
	people *limiter
	now    func() time.Time
}

func newGateway(cfg config) *gateway {
	g := &gateway{cfg: cfg, ips: newLimiter(cfg.ipPerMinute), people: newLimiter(cfg.userPerMinute), now: time.Now}
	if cfg.project != "" {
		g.keys = newKeyset(cfg.jwksURL)
	}
	for _, r := range cfg.routes {
		r := r
		r.proxy = &httputil.ReverseProxy{
			Rewrite: func(p *httputil.ProxyRequest) {
				p.SetURL(r.upstream)
				p.Out.Host = p.In.Host // the services behind know the public name (Grafana's root URL)
				// Nothing the caller sends may speak for a proxy or for the Grafana login.
				for name := range p.Out.Header {
					if l := strings.ToLower(name); strings.HasPrefix(l, "x-webauth-") || strings.HasPrefix(l, "x-forwarded-") || l == "forwarded" || l == "x-real-ip" {
						p.Out.Header.Del(name)
					}
				}
				p.Out.Header.Set("X-Forwarded-For", g.clientIP(p.In))
				p.Out.Header.Set("X-Forwarded-Host", p.In.Host)
				p.Out.Header.Set("X-Forwarded-Proto", g.proto(p.In))
			},
			ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
				log.Printf("upstream %s: %v", r.host, err)
				writeJSON(w, http.StatusBadGateway, map[string]any{"error": "The service is not answering. Try again in a minute."})
			},
		}
	}
	return g
}

// clientIP is the caller's address as the proxy in front saw it: the entry that many hops from the end of
// X-Forwarded-For. Without a proxy in front it is the connection's own address.
func (g *gateway) clientIP(r *http.Request) string {
	var chain []string
	for _, part := range strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",") {
		if part = strings.TrimSpace(part); part != "" {
			chain = append(chain, part)
		}
	}
	if i := len(chain) - g.cfg.hops; i >= 0 && i < len(chain) && net.ParseIP(chain[i]) != nil {
		return chain[i]
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (g *gateway) proto(r *http.Request) string {
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		return "https"
	}
	return "http"
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/healthz":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": service})
		return
	case r.Method == http.MethodGet && r.URL.Path == "/version":
		writeJSON(w, http.StatusOK, map[string]any{"service": service, "version": version})
		return
	}
	host := strings.ToLower(r.Host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	rt := g.cfg.routes[host]
	if rt == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found."})
		return
	}
	// One spelling per path: what is checked here is what the service behind reads, with no ".." or encoded slash
	// between them.
	lower := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "//") || strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%00") || strings.Contains(lower, "%2e") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Bad request."})
		return
	}
	if !g.ips.allow(g.clientIP(r), g.now()) {
		tooMany(w)
		return
	}
	if rt.core {
		switch classify(r.Method, r.URL.Path) {
		case private:
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found."})
			return
		case signedIn, staff:
			c, err := g.identify(r)
			if err != nil {
				w.Header().Set("WWW-Authenticate", "Bearer")
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Sign in again."})
				return
			}
			if classify(r.Method, r.URL.Path) == staff && g.cfg.staffSecond && !c.secondFactor {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "Staff pages need the authenticator step. Sign in again with your authenticator code.", "code": "mfa_required"})
				return
			}
			if !g.people.allow(c.sub, g.now()) {
				tooMany(w)
				return
			}
		}
	}
	if r.Header.Get("Upgrade") == "" {
		r.Body = http.MaxBytesReader(w, r.Body, g.cfg.maxBody)
	}
	rt.proxy.ServeHTTP(w, r)
}

// identify reads the token from the Authorization header, or from the subprotocol list a browser WebSocket uses
// (["callerwhale.v1", "bearer.<token>", ...]), and checks it.
func (g *gateway) identify(r *http.Request) (claims, error) {
	token := ""
	if v := r.Header.Get("Authorization"); len(v) > 7 && strings.EqualFold(v[:7], "bearer ") {
		token = strings.TrimSpace(v[7:])
	}
	if token == "" {
		for _, item := range strings.Split(strings.Join(r.Header.Values("Sec-WebSocket-Protocol"), ","), ",") {
			if t, ok := strings.CutPrefix(strings.TrimSpace(item), "bearer."); ok {
				token = t
			}
		}
	}
	if token == "" || g.keys == nil {
		return claims{}, errors.New("no token")
	}
	return g.keys.verify(token, g.cfg.project, g.now())
}

func tooMany(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "30")
	writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Too many requests. Wait a moment and try again."})
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
		port = "8100"
	}
	// "service health" is the container's health check: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "health" {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	g := newGateway(cfg)
	for _, r := range cfg.routes {
		log.Printf("%s -> %s (core: %v)", r.host, r.upstream, r.core)
	}
	log.Printf("%s listening on http://localhost:%s", service, port)
	srv := &http.Server{Addr: ":" + port, Handler: g, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	log.Fatal(srv.ListenAndServe())
}

// limiter counts requests per key in one-minute windows.
type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Time
	counts map[string]int
}

func newLimiter(limit int) *limiter { return &limiter{limit: limit, counts: map[string]int{}} }

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if w := now.Truncate(time.Minute); !w.Equal(l.window) {
		l.window, l.counts = w, map[string]int{}
	}
	l.counts[key]++
	return l.counts[key] <= l.limit
}
