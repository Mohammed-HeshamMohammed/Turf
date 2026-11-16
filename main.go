// Gateway: the one public entry point for Caller Whale's servers. It routes by the host name to the service behind it
// (the core API, the Grafana login proxy), and checks every request before it gets there: a path that must stay
// private is not found, a request that needs a signed-in person must carry a valid Caller Whale token (signature, issuer,
// audience and expiry, checked with the auth service's public keys), staff paths also need the authenticator step, and each
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
	monitoring     *route
	importWorker   *route // upload admission and pieces stay in the import worker's own container
	routes         map[string]*route
	authJWKS       string // the auth service's public keys: the only thing the gateway knows about sign-in
	staffSecond    bool   // staff paths need the authenticator step in the token
	ipPerMinute    int
	userPerMinute  int
	maxBody        int64
	hops           int            // proxies in front of this one (Coolify's Traefik: 1), to find the caller's address
	human          *humanSettings // the human check in front of the auth service (nil: off)
	authHost       string         // the ROUTES host of the auth service: only its real routes are answered
	mcpHost        string         // the ROUTES host of the MCP service (AI assistants): only its few routes are answered, with limits of its own
	liveHost       string         // the ROUTES host of the live server: only its socket address is answered (never its API, metrics or health)
	mcpIPPerMinute int            // per address on the MCP host: assistants call from a few shared addresses, so it is higher than for people
	scanLimit      int            // requests for things that are not there, from one address, before it is paused
	scanWindow     time.Duration
	scanPause      time.Duration
	corsOrigins    map[string]bool // pages (like https://callerwhale.com) that may read the gateway's own replies from a browser
}

func loadConfig(getenv func(string) string) (config, error) {
	c := config{routes: map[string]*route{}}
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
		if c.authJWKS = strings.TrimSpace(getenv("AUTH_JWKS_URL")); c.authJWKS == "" {
			return c, errors.New("set AUTH_JWKS_URL, the auth service's /.well-known/jwks.json: the core API's tokens are checked with it")
		}
	}
	importTarget := strings.TrimSpace(getenv("IMPORT_WORKER_URL"))
	if importTarget == "" && core != "" {
		importTarget = "http://importing-lists:8111"
	}
	if target := importTarget; target != "" {
		u, err := url.Parse(target)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || core == "" {
			return c, errors.New("IMPORT_WORKER_URL needs an http(s) origin and CORE_HOST")
		}
		c.importWorker = &route{host: core, upstream: u}
	}
	if target := strings.TrimSpace(getenv("MONITORING_UPSTREAM")); target != "" {
		u, err := url.Parse(target)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || core == "" {
			return c, errors.New("MONITORING_UPSTREAM needs an http(s) origin and CORE_HOST")
		}
		c.monitoring = &route{host: core, upstream: u}
	}
	c.staffSecond = getenv("STAFF_REQUIRE_SECOND_FACTOR") != "false"
	var err error
	if c.corsOrigins, err = parseOrigins(getenv("CORS_ORIGINS")); err != nil {
		return c, err
	}
	if c.authHost = strings.ToLower(strings.TrimSpace(getenv("AUTH_HOST"))); c.authHost != "" && c.routes[c.authHost] == nil {
		return c, errors.New("AUTH_HOST is not one of the ROUTES hosts")
	}
	if c.mcpHost = strings.ToLower(strings.TrimSpace(getenv("MCP_HOST"))); c.mcpHost != "" && c.routes[c.mcpHost] == nil {
		return c, errors.New("MCP_HOST is not one of the ROUTES hosts")
	}
	if c.liveHost = strings.ToLower(strings.TrimSpace(getenv("LIVE_HOST"))); c.liveHost != "" && c.routes[c.liveHost] == nil {
		return c, errors.New("LIVE_HOST is not one of the ROUTES hosts")
	}
	if c.human, err = loadHuman(getenv, c.routes); err != nil {
		return c, err
	}
	if c.scanLimit, err = number("SCAN_LIMIT", 20); err != nil {
		return c, err
	}
	window, err := number("SCAN_WINDOW_MINUTES", 10)
	if err != nil {
		return c, err
	}
	pause, err := number("SCAN_PAUSE_MINUTES", 15)
	if err != nil {
		return c, err
	}
	c.scanWindow, c.scanPause = time.Duration(window)*time.Minute, time.Duration(pause)*time.Minute
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
	if c.mcpIPPerMinute, err = number("MCP_IP_PER_MINUTE", 6000); err != nil {
		return c, err
	}
	if c.hops, err = number("PROXY_HOPS", 1); err != nil {
		return c, err
	}
	return c, nil
}

// need is what a path on the core API asks of the caller.
type need int

const (
	open     need = iota // nothing: the website's files, public information
	signedIn             // a valid Caller Whale token
	staff                // a valid token with the authenticator step
	private              // never reachable from outside: answered as not found
)

// classify decides what a core API request needs. Paths nobody listed as open fall under /api/v1 or the sync and event
// routes and need a token; the internal routes (worker jobs, imports) never leave the private network.
func classify(method, path string) need {
	// Classified case-blind: an upper-case spelling of a guarded path must not fall through to open.
	path = strings.ToLower(path)
	switch {
	// Health and version are for the private network: the container's own check never passes through here.
	case path == "/healthz" || path == "/version":
		return private
	case path == "/internal" || strings.HasPrefix(path, "/internal/") || path == "/readyz":
		return private
	// The services' own interfaces (like the notification service's /v1/mail) are for the private network, whatever sits behind the address.
	case path == "/v1" || strings.HasPrefix(path, "/v1/"):
		return private
	case method == http.MethodGet && (path == "/api/v1/auth/service" || path == "/api/v1/plans" || strings.HasPrefix(path, "/api/v1/download/")):
		return open
	case method == http.MethodPost && (path == "/api/v1/public/waitlist" || path == "/api/v1/public/contact" || path == "/api/v1/public/remove-my-information"): // the website's public forms: no sign-in, the address limit still applies
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
	cfg      config
	keys     *keyset
	ips      *limiter
	mcpIPs   *limiter // addresses calling the MCP host
	people   *limiter
	human    *humanCheck // nil when the check is off
	scans    *scanners
	humanIPs *limiter // guarded requests per address: every one costs a call to Google
	now      func() time.Time
}

func newGateway(cfg config) *gateway {
	g := &gateway{cfg: cfg, ips: newLimiter(cfg.ipPerMinute), mcpIPs: newLimiter(cfg.mcpIPPerMinute), people: newLimiter(cfg.userPerMinute), now: time.Now,
		scans: newScanners(cfg.scanLimit, cfg.scanWindow, cfg.scanPause)}
	if cfg.human != nil {
		g.human = newHumanCheck(*cfg.human)
		g.humanIPs = newLimiter(cfg.human.perMinute)
	}
	if cfg.authJWKS != "" {
		g.keys = newKeyset(cfg.authJWKS)
	}
	routes := make([]*route, 0, len(cfg.routes)+1)
	for _, r := range cfg.routes {
		routes = append(routes, r)
	}
	if cfg.monitoring != nil {
		routes = append(routes, cfg.monitoring)
	}
	if cfg.importWorker != nil {
		routes = append(routes, cfg.importWorker)
	}
	for _, r := range routes {
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
				if g.human != nil && r.host == g.human.authHost && p.In.URL.Path == "/v1/security" {
					p.Out.Header.Del("Accept-Encoding") // the answer is edited below, so it must arrive as plain JSON
				}
			},
			ModifyResponse: func(res *http.Response) error {
				scrub(res)
				harden(res, r == cfg.monitoring)
				if g.human != nil && r.host == g.human.authHost {
					return g.human.announce(res)
				}
				return nil
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
	// The gateway's own refusals (too many requests, not a person, not found) must be readable by the page that asked, or the browser
	// reports them as a CORS failure and hides what they say. Replies from the services behind keep the CORS headers they set.
	if origin := r.Header.Get("Origin"); origin != "" && g.cfg.corsOrigins[origin] {
		w = &corsWriter{ResponseWriter: w, origin: origin}
	}
	switch {
	// The gateway's own health and version are for the private network (the container's health check); through the public proxy
	// they are paths like any other.
	case r.Method == http.MethodGet && r.URL.Path == "/healthz" && !viaProxy(r):
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": service})
		return
	case r.Method == http.MethodGet && r.URL.Path == "/version" && !viaProxy(r):
		writeJSON(w, http.StatusOK, map[string]any{"service": service, "version": version})
		return
	}
	caller := g.clientIP(r)
	if g.scans.blocked(caller, g.now()) {
		paused(w)
		return
	}
	host := strings.ToLower(r.Host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	rt := g.cfg.routes[host]
	if rt == nil {
		g.scans.miss(caller, g.now())
		notFound(w)
		return
	}
	// One spelling per path: what is checked here is what the service behind reads, with no ".." or encoded slash
	// between them.
	lower := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "//") || strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%00") || strings.Contains(lower, "%2e") {
		g.scans.miss(caller, g.now())
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Bad request."})
		return
	}
	limit := g.ips
	if g.cfg.mcpHost != "" && rt.host == g.cfg.mcpHost {
		limit = g.mcpIPs
	}
	if !limit.allow(caller, g.now()) {
		tooMany(w)
		return
	}
	if rt.core && (r.URL.Path == "/staff/monitoring" || strings.HasPrefix(r.URL.Path, "/staff/monitoring/")) {
		if g.cfg.monitoring == nil || r.URL.Path == "/staff/monitoring/_callerwhale/health" {
			g.scans.miss(caller, g.now())
			notFound(w)
			return
		}
		// The private proxy validates the HttpOnly admin session and rechecks the
		// signed token, MFA and staff role with Auth on every request.
		rt = g.cfg.monitoring
	}
	// Upload requests switch upstream only after the normal core-host token and
	// rate-limit checks below. Mapping, review and merge read database rows in Core.
	// The auth service answers only the routes it has; everything else looks the same as nothing at all.
	if g.cfg.authHost != "" && rt.host == g.cfg.authHost && !authAllowed(r.Method, r.URL.Path) {
		g.scans.miss(caller, g.now())
		notFound(w)
		return
	}
	// The live server answers only the socket address; its API (the messaging service reaches it privately), metrics and health look like nothing.
	if g.cfg.liveHost != "" && rt.host == g.cfg.liveHost && !liveAllowed(r.Method, r.URL.Path) {
		g.scans.miss(caller, g.now())
		notFound(w)
		return
	}
	// The MCP service answers only its own few routes, and takes only small requests (a tool call is a few lines of JSON).
	if g.cfg.mcpHost != "" && rt.host == g.cfg.mcpHost {
		if !mcpAllowed(r.Method, r.URL.Path) {
			g.scans.miss(caller, g.now())
			notFound(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	}
	// The first leg of signing in is proven human here, once; the auth service behind does not check it again.
	if g.human != nil && rt.host == g.human.authHost {
		if rule, guarded := ruleFor(r.Method, r.URL.Path); guarded {
			if !g.humanIPs.allow(g.clientIP(r), g.now()) {
				tooMany(w)
				return
			}
			if !g.human.guard(w, r, rule) {
				return
			}
		}
	}
	// The website's two forms are proven human the same way (the core API behind does not check it again).
	if g.human != nil && rt.core {
		if rule, guarded := formRuleFor(r.Method, r.URL.Path); guarded {
			if !g.humanIPs.allow(g.clientIP(r), g.now()) {
				tooMany(w)
				return
			}
			if !g.human.guard(w, r, rule) {
				return
			}
		}
	}
	if r.Header.Get("Upgrade") == "" {
		r.Body = http.MaxBytesReader(w, r.Body, g.cfg.maxBody)
	}
	if rt.core {
		// A browser's CORS preflight carries no bearer token. Let the core API's
		// origin policy answer it; the subsequent request still needs its token.
		// Classify using the method the browser intends to send so private paths
		// cannot be probed through an OPTIONS request.
		if r.Method == http.MethodOptions && r.Header.Get("Origin") != "" {
			requested := r.Header.Get("Access-Control-Request-Method")
			if requested != "" {
				if classify(requested, r.URL.Path) == private {
					g.scans.miss(caller, g.now())
					notFound(w)
					return
				}
				// The website's public forms are answered here, for the pages in CORS_ORIGINS, so the form does not depend on
				// the service behind having the same list (when it did not, the browser refused to send the form at all).
				if _, form := formRuleFor(requested, r.URL.Path); form {
					if g.cfg.corsOrigins[r.Header.Get("Origin")] {
						h := w.Header()
						h.Set("Access-Control-Allow-Methods", "POST")
						h.Set("Access-Control-Allow-Headers", "content-type")
						h.Set("Access-Control-Max-Age", "600")
					}
					w.WriteHeader(http.StatusNoContent)
					return
				}
				rt.proxy.ServeHTTP(w, r)
				return
			}
		}
		switch classify(r.Method, r.URL.Path) {
		case private:
			g.scans.miss(caller, g.now())
			notFound(w)
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
	if rt.core && g.cfg.importWorker != nil && uploadRoute(r.Method, r.URL.Path) {
		g.cfg.importWorker.proxy.ServeHTTP(w, r)
		return
	}
	rt.proxy.ServeHTTP(w, r)
}

func uploadRoute(method, path string) bool {
	if method == http.MethodPost && path == "/api/v1/imports" {
		return true
	}
	parts := strings.Split(path, "/")
	if len(parts) == 5 && parts[1] == "api" && parts[2] == "v1" && parts[3] == "imports" && method == http.MethodGet {
		return true
	}
	if len(parts) == 7 && parts[1] == "api" && parts[2] == "v1" && parts[3] == "imports" && parts[5] == "chunks" && method == http.MethodPut {
		return true
	}
	return len(parts) == 6 && parts[1] == "api" && parts[2] == "v1" && parts[3] == "imports" && parts[5] == "complete" && method == http.MethodPost
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
	return g.keys.verify(token, g.now())
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
	routes := make([]*route, 0, len(cfg.routes)+1)
	for _, r := range cfg.routes {
		routes = append(routes, r)
	}
	if cfg.monitoring != nil {
		routes = append(routes, cfg.monitoring)
	}
	for _, r := range routes {
		log.Printf("%s -> %s (core: %v)", r.host, r.upstream, r.core)
	}
	log.Printf("%s listening on http://localhost:%s", service, port)
	srv := &http.Server{Addr: ":" + port, Handler: logHTTP(g), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, IdleTimeout: 2 * time.Minute}
	serveUntilStopped(srv) // no write timeout: event streams stay open
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
