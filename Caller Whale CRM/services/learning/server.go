package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const (
	maxBody = 8 << 20
	maxRows = 2000
)

type server struct {
	st      *store
	token   string
	enabled bool // LEARNING_ENABLED: until the terms and privacy notice say what is kept, nothing is taken in
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		reply(w, 200, map[string]any{"ok": true, "service": "learning"})
	})
	mux.Handle("POST /v1/ingest", s.guard(s.ingest))
	mux.Handle("POST /v1/outcomes", s.guard(s.outcomes))
	mux.Handle("POST /v1/erase-person", s.guard(s.erasePerson))
	mux.Handle("POST /v1/workspaces/{org}/opt-out", s.guard(func(w http.ResponseWriter, r *http.Request) { s.optOut(w, r, true) }))
	mux.Handle("POST /v1/workspaces/{org}/opt-in", s.guard(func(w http.ResponseWriter, r *http.Request) { s.optOut(w, r, false) }))
	mux.Handle("DELETE /v1/workspaces/{org}", s.guard(s.eraseWorkspace))
	mux.Handle("GET /v1/workspaces/{org}", s.guard(s.workspaceStatus))
	mux.Handle("POST /v1/erase-everywhere", s.guard(s.eraseEverywhere))
	mux.Handle("GET /v1/stats", s.guard(s.stats))
	return logged(mux)
}

// logged writes one line per request: method, path, status. Never a body, a query or a header, so no value can reach a log.
func logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path != "/healthz" {
			log.Printf("INFO %s %s %d", r.Method, r.URL.Path, rec.status)
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// workspaceStatus says whether a workspace's lists are being taken (for the opt-out screen).
func (s *server) workspaceStatus(w http.ResponseWriter, r *http.Request) {
	org := r.PathValue("org")
	if !uuidRe.MatchString(org) {
		fail(w, 400, "that is not a workspace id")
		return
	}
	blocked, err := s.st.blocked(r.Context(), org)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"enabled": s.enabled, "opted_out": blocked})
}

// eraseEverywhere removes one person (by phone or email) from every workspace: the answer to a person's own request to be removed.
func (s *server) eraseEverywhere(w http.ResponseWriter, r *http.Request) {
	var in outcome
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || (phoneKey(in.Phone) == "" && emailKey(in.Email) == "") {
		fail(w, 400, "send a phone or an email")
		return
	}
	n, err := s.st.eraseEverywhere(r.Context(), in.Phone, in.Email)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"erased": n})
}

// stats is counts only, so the owners can see that the store works without reading anyone's details.
func (s *server) stats(w http.ResponseWriter, r *http.Request) {
	var rows, orgs, imports, flagged int64
	err := s.st.db.QueryRow(r.Context(), `SELECT count(*), count(DISTINCT org_id), count(DISTINCT job_id), count(*) FILTER (WHERE flagged_at IS NOT NULL) FROM learning.leads`).Scan(&rows, &orgs, &imports, &flagged)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"rows": rows, "workspaces": orgs, "imports": imports, "with_flags": flagged, "enabled": s.enabled})
}

// guard answers only to crm-core's token (compared in constant time), reads at most 8 MB, and never logs a body.
func (s *server) guard(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(given), []byte(s.token)) != 1 {
			reply(w, 401, map[string]any{"error": "not allowed"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		next(w, r)
	})
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]any{"error": message})
}

func (s *server) off(w http.ResponseWriter) bool {
	if !s.enabled {
		fail(w, http.StatusServiceUnavailable, "learning is switched off")
		return true
	}
	return false
}

func (s *server) ingest(w http.ResponseWriter, r *http.Request) {
	if s.off(w) {
		return
	}
	var in ingest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "send a valid batch")
		return
	}
	if !uuidRe.MatchString(in.OrgID) || !uuidRe.MatchString(in.JobID) || (in.ProjectID != "" && !uuidRe.MatchString(in.ProjectID)) || len(in.Rows) == 0 || len(in.Rows) > maxRows || len(in.Mapping) > 500 {
		fail(w, 400, "the batch needs a workspace, an import, and 1 to 2000 rows")
		return
	}
	blocked, err := s.st.blocked(r.Context(), in.OrgID)
	if err != nil {
		s.problem(w, err)
		return
	}
	if blocked {
		reply(w, 200, map[string]any{"stored": 0, "skipped": "workspace opted out"})
		return
	}
	stored, err := s.st.add(r.Context(), in)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"stored": stored})
}

type outcome struct {
	OrgID string            `json:"org_id"`
	Phone string            `json:"phone"`
	Email string            `json:"email"`
	Flags map[string]string `json:"flags"`
}

func (s *server) outcomes(w http.ResponseWriter, r *http.Request) {
	if s.off(w) {
		return
	}
	var in outcome
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || !uuidRe.MatchString(in.OrgID) || (phoneKey(in.Phone) == "" && emailKey(in.Email) == "") {
		fail(w, 400, "send a workspace and a phone or an email")
		return
	}
	n, err := s.st.flag(r.Context(), in.OrgID, in.Phone, in.Email, in.Flags)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"updated": n})
}

// Erasure and opting out work even while learning is switched off: a request to be removed is never refused for that.
func (s *server) erasePerson(w http.ResponseWriter, r *http.Request) {
	var in outcome
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || !uuidRe.MatchString(in.OrgID) || (phoneKey(in.Phone) == "" && emailKey(in.Email) == "") {
		fail(w, 400, "send a workspace and a phone or an email")
		return
	}
	n, err := s.st.erasePerson(r.Context(), in.OrgID, in.Phone, in.Email)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"erased": n})
}

func (s *server) optOut(w http.ResponseWriter, r *http.Request, out bool) {
	org := r.PathValue("org")
	if !uuidRe.MatchString(org) {
		fail(w, 400, "that is not a workspace id")
		return
	}
	n, err := s.st.setOptOut(r.Context(), org, out)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"opted_out": out, "erased": n})
}

func (s *server) eraseWorkspace(w http.ResponseWriter, r *http.Request) {
	org := r.PathValue("org")
	if !uuidRe.MatchString(org) {
		fail(w, 400, "that is not a workspace id")
		return
	}
	n, err := s.st.eraseWorkspace(r.Context(), org)
	if err != nil {
		s.problem(w, err)
		return
	}
	reply(w, 200, map[string]any{"erased": n})
}

// problem logs the kind of failure only: an error text could hold a value from the request.
func (s *server) problem(w http.ResponseWriter, err error) {
	log.Printf("ERROR learning store: %T", err)
	fail(w, http.StatusInternalServerError, "the learning store could not do that")
}

// purgeEvery removes what has been kept past its time, once an hour.
func (s *server) purgeEvery(ctx context.Context) {
	for {
		if n, err := s.st.purge(ctx); err != nil {
			log.Printf("WARN purge: %T", err)
		} else if n > 0 {
			log.Printf("INFO purged %d expired rows", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Hour):
		}
	}
}
