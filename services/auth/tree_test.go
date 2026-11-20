package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// authz's own words for a refusal (a full plan, a manager outside their team) reach the person, with the status it chose.
func TestARefusalFromAuthorizationKeepsItsWords(t *testing.T) {
	authz := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/full":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"Every seat on this plan is taken.","code":"seats_full"}`))
		case "/manager":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"A team manager manages the callers and closers of their own teams only.","code":"forbidden"}`))
		case "/silent":
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer authz.Close()
	s := &server{cfg: config{authzURL: authz.URL, authzToken: "token"}}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	for path, want := range map[string]struct {
		status int
		code   string
		words  string
	}{
		"/full":    {409, "seats_full", "Every seat on this plan is taken."},
		"/manager": {403, "forbidden", "A team manager manages the callers and closers of their own teams only."},
		"/silent":  {403, "forbidden", "You cannot change this access."},
		"/broken":  {503, "access_unavailable", "Membership information is unavailable right now."},
	} {
		_, err := s.authzCall(r, http.MethodPost, path, map[string]any{}, nil)
		var api *apiError
		if !errors.As(err, &api) || api.status != want.status || api.code != want.code || api.message != want.words {
			t.Errorf("%s: %#v", path, err)
		}
	}
}
