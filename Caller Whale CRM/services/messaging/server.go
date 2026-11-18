package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
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
func conflict(message string) error  { return &apiError{http.StatusConflict, "conflict", message} }

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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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
	live  *live
	now   func() time.Time
}

// req is one signed-in request. sc is filled for requests inside a workspace.
type req struct {
	w  http.ResponseWriter
	r  *http.Request
	c  claims
	sc scope
}

type handler func(*req) error

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if s.st.ping(ctx) != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "service": "messaging"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "messaging"})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": "messaging", "version": version})
	})

	const base = "/api/v1/messaging"
	mux.Handle("GET "+base+"/live", s.user(s.liveToken))
	mux.Handle("GET "+base+"/conversations", s.member(s.listConversations))
	mux.Handle("POST "+base+"/conversations", s.member(s.createConversation))
	mux.Handle("GET "+base+"/conversations/{id}", s.member(s.getConversation))
	mux.Handle("PATCH "+base+"/conversations/{id}", s.member(s.changeConversation))
	mux.Handle("POST "+base+"/conversations/{id}/members", s.member(s.changeMembers))
	mux.Handle("POST "+base+"/conversations/{id}/read", s.member(s.markRead))
	mux.Handle("GET "+base+"/conversations/{id}/messages", s.member(s.listMessages))
	mux.Handle("POST "+base+"/conversations/{id}/messages", s.member(s.sendMessage))
	mux.Handle("GET "+base+"/messages/search", s.member(s.searchMessages))
	mux.Handle("PATCH "+base+"/messages/{id}", s.member(s.editMessage))
	mux.Handle("DELETE "+base+"/messages/{id}", s.member(s.deleteMessage))
	mux.Handle("PUT "+base+"/messages/{id}/reactions/{emoji}", s.member(s.react(true)))
	mux.Handle("DELETE "+base+"/messages/{id}/reactions/{emoji}", s.member(s.react(false)))
	mux.Handle("POST "+base+"/messages/{id}/vote", s.member(s.vote))
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

// member lets a request through when the person is in the workspace named by x-callerwhale-org, may work there, and is one of
// its own people: a client who only sees shared records is not part of the team's conversations.
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

func (s *server) identify(w http.ResponseWriter, r *http.Request) (*req, error) {
	unauth := &apiError{http.StatusUnauthorized, "unauthorized", "Sign in again."}
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token = strings.TrimSpace(token); token == "" {
		return nil, unauth
	}
	c, err := s.keys.verify(token, s.now())
	if err != nil || !validID(c.sub) {
		return nil, unauth
	}
	return &req{w: w, r: r, c: c}, nil
}

func (s *server) enter(ctx context.Context, q *req, org string) error {
	if !validID(org) {
		return bad("Choose a workspace (x-callerwhale-org).")
	}
	g, err := s.rules.grant(ctx, q.c.sub, org, q.c.secondFactor)
	if err != nil {
		return err
	}
	if !g.Allowed {
		status := http.StatusForbidden
		if g.Code == "payment_required" {
			status = http.StatusPaymentRequired
		}
		return &apiError{status, g.Code, g.Reason}
	}
	q.sc = scope{userID: strings.ToLower(q.c.sub), orgID: strings.ToLower(org), scopes: g.Scopes, caps: g.Capabilities}
	if q.sc.external() || !q.sc.can("message") {
		return forbidden("Your role cannot use conversations in this workspace.")
	}
	return nil
}

// logHTTP records one line per request: the path without its query.
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
