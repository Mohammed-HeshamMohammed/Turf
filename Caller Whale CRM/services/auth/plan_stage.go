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

// seatUse answers GET /v1/orgs/{org}/seats for the owner and admins: the plan's seats, the people using one (with names), and how many
// are over when the plan was lowered (D81).
func (s *server) seatUse(w http.ResponseWriter, r *http.Request) error {
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
	if !slices.ContainsFunc(roles, func(r string) bool { return r == "owner" || r == "solo" || r == "admin" }) {
		return forbidden("Only the owner and admins see the seats.")
	}
	var use struct {
		Seats *int     `json:"seats"`
		Used  int      `json:"used"`
		Over  int      `json:"over"`
		Using []string `json:"using"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/seats", nil, &use); err != nil {
		return err
	}
	people := []map[string]any{}
	for _, id := range use.Using {
		var name, email string
		_ = s.db.QueryRow(r.Context(), "SELECT display_name, email FROM users WHERE id=$1", id).Scan(&name, &email)
		people = append(people, map[string]any{"user_id": id, "name": name, "email": email, "you": id == c.Sub})
	}
	writeJSON(w, http.StatusOK, map[string]any{"seats": use.Seats, "used": use.Used, "over": use.Over, "people": people})
	return nil
}

// keepSeats answers POST /v1/orgs/{org}/seats/keep {keep}: after the plan was lowered, the owner (with their second step) chooses who
// keeps a seat. Everyone else using one is suspended, not removed: their team leads hold their work, and they come back when a seat
// does (D81, D365).
func (s *server) keepSeats(w http.ResponseWriter, r *http.Request) error {
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
		return forbidden("Only the agency's owner chooses who keeps a seat.")
	}
	if !c.MFA {
		return newError(http.StatusForbidden, "mfa_required", "Confirm it's you with your second step first.")
	}
	var body struct {
		Keep []string `json:"keep"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	var use struct {
		Seats *int     `json:"seats"`
		Using []string `json:"using"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/seats", nil, &use); err != nil {
		return err
	}
	keep := map[string]bool{c.Sub: true} // the owner always keeps theirs
	for _, id := range body.Keep {
		if slices.Contains(use.Using, id) {
			keep[id] = true
		}
	}
	if use.Seats != nil && len(keep) > *use.Seats {
		return bad("Keep as many people as the plan has seats, you included.")
	}
	suspended := []string{}
	for _, id := range use.Using {
		if keep[id] {
			continue
		}
		change := map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA, "reason": "The plan was lowered. Your work is held by your team until a seat is free again."}
		if _, err := s.authzCall(r, http.MethodPost, "/v1/orgs/"+org+"/members/"+id+"/suspend", change, nil); err != nil {
			return err
		}
		s.cancelInvitationsBy(r.Context(), org, id)
		suspended = append(suspended, id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "suspended": suspended})
	return nil
}
