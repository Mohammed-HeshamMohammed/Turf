package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

// apiError is a refusal the service sends: a status, a stable code for programs and a sentence for people. The codes and
// sentences are the Rust service's, so the pages and the desktop app read both the same way.
type apiError struct {
	status  int
	code    string
	message string
	extra   map[string]any // more fields in the answer, like the second step's challenge
}

func (e *apiError) Error() string { return e.message }

func newError(status int, code, message string) *apiError {
	return &apiError{status: status, code: code, message: message}
}

func bad(message string) *apiError       { return newError(http.StatusBadRequest, "bad_request", message) }
func forbidden(message string) *apiError { return newError(http.StatusForbidden, "forbidden", message) }
func conflict(message string) *apiError  { return newError(http.StatusConflict, "conflict", message) }

var (
	errUnauthenticated   = newError(http.StatusUnauthorized, "unauthenticated", "Sign in first.")
	errWrongCredentials  = newError(http.StatusUnauthorized, "wrong_credentials", "Wrong email or password.")
	errWrongCode         = newError(http.StatusUnauthorized, "wrong_code", "That code is not right.")
	errTooMany           = newError(http.StatusTooManyRequests, "too_many_attempts", "Too many attempts. Wait 15 minutes and try again.")
	errSecondStepPending = newError(http.StatusServiceUnavailable, "second_step_unavailable", "Sign-in with a second step is not available on this server yet. Try again later.")
)

// handler is a route that answers with an error instead of writing one.
type handler func(w http.ResponseWriter, r *http.Request) error

// serve turns a handler into an http.Handler. Anything that is not an apiError is an internal fault: the person gets a plain
// sentence, the log gets the detail (never a request body, header or token).
func serve(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		err := h(w, r)
		if err == nil {
			return
		}
		var api *apiError
		if !errors.As(err, &api) {
			log.Printf("ERROR %s %s: %v", r.Method, r.URL.Path, err)
			api = newError(http.StatusInternalServerError, "internal", "Something went wrong.")
		}
		body := map[string]any{"error": api.message, "code": api.code}
		for k, v := range api.extra {
			body[k] = v
		}
		writeJSON(w, api.status, body)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// readJSON reads a request body of at most 1 MiB into v. A body that cannot be read is the person's mistake, not ours.
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return bad("That request could not be read.")
	}
	return nil
}
