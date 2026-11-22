package main

import (
	"net/http"

	"github.com/google/uuid"
)

// The owner lets Caller Whale's staff into the agency for a set time, and can end it early (D83). authz decides what
// staff may do there (see services/authz/support.go) and records each visit in the agency's record of people changes.

// support answers GET, POST {hours} and DELETE /v1/orgs/{org}/support for the agency's owner; allowing it needs their second step.
func (s *server) support(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return err
	}
	owner, _, err := s.ownerOf(r, org)
	if err != nil {
		return err
	}
	if owner != c.Sub {
		return forbidden("Only the agency's owner lets Caller Whale's support in.")
	}
	var out map[string]any
	switch r.Method {
	case http.MethodGet:
		_, err = s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/support", nil, &out)
	case http.MethodDelete:
		_, err = s.authzCall(r, http.MethodDelete, "/v1/orgs/"+org+"/support", map[string]any{"actor_id": c.Sub}, &out)
	default:
		if !c.MFA {
			return newError(http.StatusForbidden, "mfa_required", "Confirm it's you with your second step first.")
		}
		var body struct {
			Hours int `json:"hours"`
		}
		if r.ContentLength != 0 {
			if err := readJSON(w, r, &body); err != nil {
				return err
			}
		}
		_, err = s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/support", map[string]any{"hours": body.Hours, "actor_id": c.Sub}, &out)
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

// supportedAgencies answers GET /v1/admin/support for staff: the agencies whose owners let support in now, and until when.
func (s *server) supportedAgencies(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	var out map[string]any
	if _, err := s.authzCall(r, http.MethodGet, "/v1/support", nil, &out); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}
