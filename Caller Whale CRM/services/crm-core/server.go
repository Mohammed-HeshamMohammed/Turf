package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

var version = "dev"

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(id string) bool { return uuidPattern.MatchString(id) }

// apiError is an answer a person can act on: a status, a code programs read, a sentence people read.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

func bad(message string) error       { return &apiError{http.StatusBadRequest, "bad_request", message} }
func forbidden(message string) error { return &apiError{http.StatusForbidden, "forbidden", message} }
func notFound(message string) error  { return &apiError{http.StatusNotFound, "not_found", message} }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, err error) {
	var api *apiError
	switch {
	case errors.As(err, &api):
	case errors.Is(err, errUnavailable), errors.Is(err, errNoCaller):
		log.Printf("ERROR %v", err)
		api = &apiError{http.StatusServiceUnavailable, "unavailable", "Caller Whale cannot check your access right now. Try again in a moment."}
	default:
		log.Printf("ERROR %v", err)
		api = &apiError{http.StatusInternalServerError, "internal", "Something went wrong on our side."}
	}
	writeJSON(w, api.status, map[string]any{"error": map[string]any{"code": api.code, "message": api.message}})
}

func readJSON(w http.ResponseWriter, r *http.Request, into any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		return bad("Send a valid JSON body.")
	}
	return nil
}

type server struct {
	cfg   config
	keys  *keyset
	rules rules
	st    *store
	hub   *hub
	now   func() time.Time

	seenPeople sync.Map // user -> last time their name was stored
	seenOrgs   sync.Map // workspace ids that have a row
	sharedName sync.Map // workspace id -> the agency name authz was last told
}

// shareOrgName tells authz the agency's name once per name, so invitations can name the agency. A failure is logged and tried
// again on the next request: the CRM keeps working either way.
func (s *server) shareOrgName(ctx context.Context, org, name string) {
	if told, ok := s.sharedName.Load(org); ok && told == name {
		return
	}
	if err := s.rules.nameOrg(ctx, org, name); err != nil {
		log.Printf("WARN could not tell authz the name of workspace %s: %v", org, err)
		return
	}
	s.sharedName.Store(org, name)
}

// req is one signed-in request. sc is filled for requests inside a workspace.
type req struct {
	w     http.ResponseWriter
	r     *http.Request
	c     claims
	sc    scope
	grant grantReply
	rev   int64
}

type handler func(*req) error

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if s.st.ping(ctx) != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "service": "crm-core"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "crm-core"})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": "crm-core", "version": version})
	})

	mux.Handle("GET /api/v1/me", s.user(s.me))
	mux.Handle("GET /api/v1/account", s.user(s.account))
	mux.Handle("PUT /api/v1/me/picture", s.user(s.setPicture))
	mux.Handle("POST /api/v1/credits/use", s.user(func(q *req) error { writeJSON(q.w, 200, map[string]any{"limited": false}); return nil }))

	mux.Handle("GET /api/v1/directory", s.member(s.directory))
	mux.Handle("GET /api/v1/admin/teams", s.member(s.teams))
	mux.Handle("GET /api/v1/teams/{id}/settings", s.member(s.getTeamSettings))
	mux.Handle("PUT /api/v1/teams/{id}/settings", s.member(s.putTeamSettings))
	mux.Handle("GET /api/v1/teams/{id}/pool", s.member(s.teamPool))
	mux.Handle("GET /api/v1/tags", s.member(s.listTags))
	mux.Handle("POST /api/v1/tags", s.member(s.createTag))
	mux.Handle("DELETE /api/v1/tags/{id}", s.member(s.deleteTag))
	mux.Handle("GET /api/v1/retention", s.member(s.retention))
	mux.Handle("PUT /api/v1/retention", s.member(s.retention))
	mux.Handle("POST /api/v1/retention/keep", s.member(s.keepLeads))
	mux.Handle("POST /api/v1/retention/remove", s.member(s.removeDue))
	mux.Handle("POST /api/v1/admin/teams", s.member(s.createTeam))
	mux.Handle("GET /api/v1/projects", s.member(s.projects))
	mux.Handle("POST /api/v1/projects", s.member(s.createProject))
	mux.Handle("DELETE /api/v1/projects/{id}", s.member(s.deleteProject))
	mux.Handle("PATCH /api/v1/organization", s.member(s.renameOrg))
	mux.Handle("GET /api/v1/stats/members", s.member(s.memberStats))
	mux.Handle("GET /api/v1/assignments/targets", s.member(s.listAssignTargets))
	mux.Handle("POST /api/v1/assignments", s.member(s.startAssignment))
	mux.Handle("GET /api/v1/assignments/{id}", s.member(s.getAssignment))
	mux.Handle("GET /api/v1/stats/members/{user}/activity", s.member(s.memberActivity))

	mux.Handle("GET /api/v1/leads/search", s.member(s.searchLeads))
	mux.Handle("GET /api/v1/leads/{id}/details", s.member(s.leadDetails))
	mux.Handle("GET /api/v1/leads/{id}/files", s.member(s.listFiles))
	mux.Handle("POST /api/v1/leads/{id}/files", s.member(s.uploadFile))
	mux.Handle("GET /api/v1/files/{id}", s.member(s.downloadFile))
	mux.Handle("DELETE /api/v1/files/{id}", s.member(s.deleteFile))
	mux.HandleFunc("POST /api/v1/public/remove-my-information", s.removeMyInformation)
	mux.Handle("GET /api/v1/learning", s.member(s.learningStatus))
	mux.Handle("POST /api/v1/learning/opt-out", s.member(s.learningChoice(true)))
	mux.Handle("POST /api/v1/learning/opt-in", s.member(s.learningChoice(false)))
	mux.Handle("GET /sync/snapshot", s.member(s.snapshot))
	mux.Handle("GET /sync/pull", s.member(s.pull))
	mux.Handle("POST /sync/push", s.member(s.push))
	mux.Handle("POST /api/v1/ops", s.member(s.oneOp))
	mux.HandleFunc("GET /events", s.events)

	mux.Handle("GET /api/v1/imports", s.member(s.importList))
	mux.Handle("GET /api/v1/imports/{id}", s.member(s.importGet))
	mux.Handle("GET /api/v1/imports/{id}/rows", s.member(s.importRows))
	mux.Handle("PUT /api/v1/imports/{id}/mapping", s.member(s.importMapping))
	mux.Handle("GET /api/v1/imports/{id}/duplicates", s.member(s.importDuplicates))
	mux.Handle("POST /api/v1/imports/{id}/duplicates", s.member(s.importDecide))
	mux.Handle("GET /api/v1/imports/{id}/preview", s.member(s.importPreview))
	mux.Handle("GET /api/v1/imports/{id}/cleared", s.member(s.importCleared))
	mux.Handle("POST /api/v1/imports/{id}/columns-again", s.member(s.importColumnsAgain))
	mux.Handle("GET /api/v1/imports/{id}/merges", s.member(s.importMerges))
	mux.Handle("POST /api/v1/imports/{id}/rows/{row}/undo-merge", s.member(s.importUndoMerge))
	mux.Handle("POST /api/v1/imports/{id}/merge", s.member(s.importMerge))
	mux.Handle("POST /api/v1/imports/{id}/apply-calls", s.member(s.importApplyCalls))
	mux.Handle("POST /api/v1/imports/{id}/retry", s.member(s.importRetryMerge))
	mux.Handle("POST /api/v1/imports/{id}/cancel", s.member(s.importCancel))
	mux.Handle("DELETE /api/v1/imports/{id}", s.member(s.importDelete))
	mux.Handle("DELETE /api/v1/imports/{id}/leads", s.member(s.removeList))
	mux.Handle("GET /api/v1/imports/{id}/other-team", s.member(s.otherTeam))
	mux.Handle("POST /api/v1/imports/{id}/other-team", s.member(s.decideOtherTeam))

	s.dialerRoutes(mux)

	// The website's contact form posts here (through the gateway) and goes on to the notification service, which sends it.
	if s.cfg.notifyURL != "" {
		target, _ := url.Parse(s.cfg.notifyURL)
		proxy := httputil.NewSingleHostReverseProxy(target)
		mux.Handle("/api/v1/public/contact", proxy)
	}
	return logHTTP(withCORS(s.cfg.origins, mux))
}

// user lets a request through when its sign-in token is good.
func (s *server) user(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, err := s.identify(w, r)
		if err == nil {
			err = h(q)
		}
		if err != nil {
			writeError(w, err)
		}
	})
}

// member lets a request through when the person is in the workspace named by x-callerwhale-org and may work there.
func (s *server) member(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, err := s.identify(w, r)
		if err == nil {
			err = s.enter(r.Context(), q, r.Header.Get("x-callerwhale-org"))
		}
		if err == nil {
			err = h(q)
		}
		if err != nil {
			writeError(w, err)
		}
	})
}

func bearer(r *http.Request) string {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return strings.TrimSpace(token)
}

func (s *server) identify(w http.ResponseWriter, r *http.Request) (*req, error) {
	return s.identifyToken(w, r, bearer(r))
}

func (s *server) identifyToken(w http.ResponseWriter, r *http.Request, token string) (*req, error) {
	unauth := &apiError{http.StatusUnauthorized, "unauthorized", "Sign in again."}
	if token == "" {
		return nil, unauth
	}
	c, err := s.keys.verify(token, s.now())
	if err != nil || !validID(c.sub) {
		return nil, unauth
	}
	return &req{w: w, r: r, c: c}, nil
}

// enter puts the request inside a workspace, or refuses it with the reason authz gave.
func (s *server) enter(ctx context.Context, q *req, org string) error {
	if !validID(org) {
		return bad("Choose a workspace (x-callerwhale-org).")
	}
	g, err := s.rules.grant(ctx, q.c.sub, org, q.c.secondFactor)
	if err != nil {
		return err
	}
	if !g.Allowed {
		return refusal(g)
	}
	q.grant, q.rev = g, accessRevision(g)
	q.sc = scope{userID: q.c.sub, orgID: org, label: label(q.c), scopes: g.Scopes, teamIDs: g.TeamIDs, seeTeams: g.seeTeams(), projectIDs: g.ProjectIDs, caps: g.Capabilities, secondStep: q.c.secondFactor}
	peek, err := s.peekTeams(ctx, q.sc)
	if err != nil {
		return err
	}
	if len(peek) > 0 {
		q.sc.peekTeams, q.rev = peek, accessRevision(g, peek...)
	}
	s.remember(ctx, q.c, org)
	return nil
}

// peekTeams are the person's own teams whose leads switched on "agents see the whole team" (D124), apart from teams they already see
// in full. Someone who sees the whole workspace needs none.
func (s *server) peekTeams(ctx context.Context, sc scope) ([]string, error) {
	if len(sc.teamIDs) == 0 || slices.Contains(sc.scopes, "organization") || slices.Contains(sc.scopes, "shared") && len(sc.scopes) == 1 {
		return nil, nil
	}
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT team_id::text FROM team_settings WHERE agents_see_team AND team_id = ANY($1::uuid[]) ORDER BY 1`, uuidArray(sc.teamIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	full := sc.visibleTeams()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if !(slices.Contains(sc.scopes, "team") && slices.Contains(full, id)) {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

func refusal(g grantReply) error {
	status := http.StatusForbidden
	if g.Code == "payment_required" {
		status = http.StatusPaymentRequired
	}
	return &apiError{status, g.Code, g.Reason}
}

func label(c claims) string {
	if c.name != "" {
		return c.name
	}
	return c.email
}

// remember keeps the person's display name and the workspace row, at most once in a while.
func (s *server) remember(ctx context.Context, c claims, org string) {
	if _, ok := s.seenOrgs.Load(org); !ok {
		if _, err := s.st.db.Exec(ctx, `INSERT INTO orgs (id, name) VALUES ($1, 'Workspace') ON CONFLICT DO NOTHING`, org); err == nil {
			s.seenOrgs.Store(org, true)
		}
	}
	if at, ok := s.seenPeople.Load(c.sub); ok && s.now().Sub(at.(time.Time)) < 10*time.Minute {
		return
	}
	if _, err := s.st.db.Exec(ctx, `INSERT INTO people (user_id, name, email) VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, seen_at = now()`, c.sub, label(c), c.email); err == nil {
		s.seenPeople.Store(c.sub, s.now())
	}
}

// logHTTP records one line per request: the path without its query (tokens never travel there, but ids can).
func logHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %dms", r.Method, r.URL.Path, rec.status, time.Since(start).Milliseconds())
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int)        { s.status = code; s.ResponseWriter.WriteHeader(code) }
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
