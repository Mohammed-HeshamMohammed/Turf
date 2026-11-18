package main

import (
	"net/http"
	"slices"

	"github.com/google/uuid"
)

// Build step 18: an unpaid plan's grace period, then read-only, then closed; and an agency its owner closes, with 30 days to reopen it
// (D80, D82, D204, D205, D206, D364). authz holds the stage and applies it to every request; this file shows it and lets the owner
// close and reopen.

// planStage answers GET /v1/orgs/{org}/plan-stage for the agency's people. During the grace period only the owner and admins are told
// (D204); once it is read-only or closed, everyone is.
func (s *server) planStage(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return err
	}
	roles, err := s.memberRoles(r, org, c.Sub)
	if err != nil {
		return err
	}
	if roles == nil {
		return forbidden("You are not in this agency.")
	}
	var stage map[string]any
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/plan-stage", nil, &stage); err != nil {
		return err
	}
	runsIt := slices.ContainsFunc(roles, func(r string) bool { return r == "owner" || r == "solo" || r == "admin" })
	if stage["stage"] == "grace" && !runsIt {
		stage = map[string]any{"stage": ""}
	}
	stage["owner"] = slices.Contains(roles, "owner") || slices.Contains(roles, "solo")
	writeJSON(w, http.StatusOK, stage)
	return nil
}

// closeWorkspace answers POST /v1/orgs/{org}/close: the owner, with their second step, closes the agency. Its people lose access at
// once; the owner can reopen it or export its data for 30 days (D82). Waiting invitations end.
func (s *server) closeWorkspace(open bool) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
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
			return forbidden("Only the agency's owner closes or reopens it.")
		}
		if !c.MFA {
			return newError(http.StatusForbidden, "mfa_required", "Confirm it's you with your second step first.")
		}
		if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/standing", map[string]any{"closed": !open}, nil); err != nil {
			return err
		}
		if !open {
			if _, err := s.db.Exec(r.Context(), `UPDATE access_invitations SET revoked_at=$1, revoked_reason='agency_closed' WHERE scope='workspace' AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, now(), org); err != nil {
				return err
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": !open})
		return nil
	}
}
