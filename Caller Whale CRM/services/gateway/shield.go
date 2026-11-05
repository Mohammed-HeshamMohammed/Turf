package main

// What the outside world may learn from the gateway: nothing it was not meant to. Three rules, applied before any service sees a request:
//
//  1. The auth service answers only the routes it really has. Everything else, including a real path with the wrong method, is the same
//     plain "not found", so a scan learns nothing about what exists or which service is behind.
//  2. An address that keeps asking for things that are not there is paused (scanners, not people: the pages never ask for them).
//  3. The gateway's own health and version answers are for callers inside the private network only; nothing identifies the software in
//     headers.
//
// Plan: docs/plans/gateway.md.

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// authRoutes are the routes of services/auth, by method and path ({name} is one path segment). Add a route to auth, add it here: a test in
// a full checkout compares this list with auth's source.
var authRoutes = []string{
	"POST /v1/accounts",
	"POST /v1/sessions", "GET /v1/sessions",
	"POST /v1/sessions/refresh", "POST /v1/sessions/sign-out", "POST /v1/sessions/revoke",
	"GET /v1/me",
	"POST /v1/me/profile",
	"GET /v1/me/providers", "POST /v1/me/providers/{provider}/start",
	"GET /v1/me/access",
	"GET /v1/admin/staff",
	"POST /v1/admin/staff",
	"GET /v1/admin/invitations", "POST /v1/admin/invitations",
	"GET /v1/admin/members", "GET /v1/admin/overview", "GET /v1/admin/costs", "POST /v1/admin/costs", "DELETE /v1/admin/costs/{id}", "GET /v1/admin/rates", "POST /v1/admin/rates", "DELETE /v1/admin/rates/{id}",
	"GET /v1/orgs/{org}/members", "PUT /v1/orgs/{org}/members/{user}",
	"GET /v1/orgs/{org}/roles",
	"GET /v1/orgs/{org}/invitations", "POST /v1/orgs/{org}/invitations",
	"DELETE /v1/invitations/{id}",
	"GET /v1/me/invitations", "POST /v1/me/invitations/{id}/accept",
	"GET /v1/security", "GET /v1/providers", "GET /.well-known/jwks.json",
	"POST /v1/password", "POST /v1/password/forgot", "POST /v1/password/reset",
	"POST /v1/email/verify", "POST /v1/email/resend",
	"GET /v1/oauth/{provider}/start", "POST /v1/oauth/{provider}/start",
	"GET /v1/oauth/{provider}/callback", "POST /v1/oauth/{provider}/callback",
	"POST /v1/oauth/exchange", "POST /v1/handoffs",
	"GET /v1/mfa/factors", "DELETE /v1/mfa/factors/{id}",
	"POST /v1/mfa/setup", "POST /v1/mfa/totp/setup", "POST /v1/mfa/confirm", "POST /v1/mfa/totp/confirm", "POST /v1/mfa/verify",
	"POST /v1/mfa/challenge/start", "POST /v1/mfa/challenge/send", "POST /v1/mfa/challenge/status", "POST /v1/mfa/challenge/answer",
	"GET /v1/mfa/approvals", "POST /v1/mfa/approvals/{id}",
	"POST /v1/mfa/telegram/link", "POST /v1/mfa/telegram/webhook/{secret}",
}

// authAllowed is true for a request the auth service has a route for. A browser's preflight (OPTIONS) is let through for any
// path it has some route for, so the service behind answers it with its own origin policy.
func authAllowed(method, path string) bool {
	segments := strings.Split(path, "/")
	for _, route := range authRoutes {
		verb, pattern, _ := strings.Cut(route, " ")
		if verb != method && method != http.MethodOptions {
			continue
		}
		want := strings.Split(pattern, "/")
		if len(want) != len(segments) {
			continue
		}
		match := true
		for i, part := range want {
			if strings.HasPrefix(part, "{") {
				if segments[i] == "" {
					match = false
					break
				}
			} else if part != segments[i] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// viaProxy is true for a request that came in through the public proxy in front (it always adds the caller's address). The
// container's own health check and the private network do not.
func viaProxy(r *http.Request) bool {
	return r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != "" || r.Header.Get("X-Real-IP") != ""
}

func notFound(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found."})
}

// scanners counts, per address, the requests for things that are not there. Past the limit the address is paused for a while.
type scanners struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	pause   time.Duration
	entries map[string]*scanEntry
}

type scanEntry struct {
	first   time.Time
	count   int
	blocked time.Time
}

const maxScanEntries = 50000

func newScanners(limit int, window, pause time.Duration) *scanners {
	return &scanners{limit: limit, window: window, pause: pause, entries: map[string]*scanEntry{}}
}

// blocked is true while the address is paused.
func (s *scanners) blocked(ip string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[ip]
	return e != nil && now.Before(e.blocked)
}

// miss records one request for something that is not there.
func (s *scanners) miss(ip string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[ip]
	if e == nil {
		if len(s.entries) >= maxScanEntries {
			s.sweep(now)
		}
		e = &scanEntry{first: now}
		s.entries[ip] = e
	}
	if now.Sub(e.first) > s.window && !now.Before(e.blocked) {
		e.first, e.count = now, 0
	}
	if e.count++; e.count > s.limit {
		e.blocked = now.Add(s.pause)
		e.first, e.count = now, 0
	}
}

// sweep forgets addresses whose window and pause are over; if the table is still full (a flood from many addresses) it starts again.
func (s *scanners) sweep(now time.Time) {
	for ip, e := range s.entries {
		if now.Sub(e.first) > s.window && !now.Before(e.blocked) {
			delete(s.entries, ip)
		}
	}
	if len(s.entries) >= maxScanEntries {
		s.entries = map[string]*scanEntry{}
	}
}

func paused(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "900")
	writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Too many requests. Wait a while and try again."})
}

// scrub removes what would name the software behind a response.
func scrub(res *http.Response) {
	for _, name := range []string{"Server", "X-Powered-By", "X-Aspnet-Version", "Via"} {
		res.Header.Del(name)
	}
}
