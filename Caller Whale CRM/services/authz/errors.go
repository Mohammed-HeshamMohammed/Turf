package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

// apiError is a refusal: a status, a stable code for programs and a sentence for people.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

func newError(status int, code, message string) *apiError {
	return &apiError{status: status, code: code, message: message}
}

func bad(message string) *apiError       { return newError(http.StatusBadRequest, "bad_request", message) }
func forbidden(message string) *apiError { return newError(http.StatusForbidden, "forbidden", message) }

var (
	errNoCaller   = newError(http.StatusUnauthorized, "unknown_caller", "This service answers Caller Whale's own services only.")
	errNotAllowed = newError(http.StatusForbidden, "not_allowed", "This service may not make that request.")
	// errUnavailable is answered when the rules store cannot be reached. Callers refuse the person's request: they never guess.
	errUnavailable = newError(http.StatusServiceUnavailable, "unavailable", "Permissions are unavailable. Try again in a minute.")
)

// handler is a route that answers with an error instead of writing one.
type handler func(w http.ResponseWriter, r *http.Request) error

// serve turns a handler into an http.Handler. Anything that is not an apiError is a fault: the caller gets a plain sentence,
// the log gets the detail (never a request body or token).
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
		writeJSON(w, api.status, map[string]any{"error": api.message, "code": api.code})
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// readJSON reads a request body of at most 64 KiB into v.
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return bad("That request could not be read.")
	}
	return nil
}
