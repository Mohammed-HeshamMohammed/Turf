package main

import (
	"net/http"
	"slices"
)

// Handing an agency to a new owner (D28, D200) and an agency paused while it has no owner who can act (D27, D201). The
// auth service runs the handover (both people confirm with their second step, the new owner's payment) and asks for the change here
// once it may happen; this file makes it.

// handOver answers PUT /v1/orgs/{org}/owner/handover {from, to, old_roles, actor_id}: the new owner gets the owner's place, and the
// old owner the roles they chose (admin or team lead), or leaves when old_roles is empty. Only auth calls it.
func (s *server) handOver(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		From     string   `json:"from"`
		To       string   `json:"to"`
		OldRoles []string `json:"old_roles"`
		ActorID  string   `json:"actor_id"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if !validID(body.From) || !validID(body.To) || body.From == body.To {
		return bad("Send from and to: the owner now and the person taking over.")
	}
	for _, role := range body.OldRoles {
		if role != "admin" && role != "manager" {
			return bad("The old owner becomes an admin or a team lead, or leaves.")
		}
	}
	owner, _, found, err := s.rules.workspaceInfo(r.Context(), org)
	if err != nil {
		return store(err)
	}
	if !found || owner != body.From {
		return newError(http.StatusConflict, "not_owner", "That person does not own this agency.")
	}
	current, ok, err := s.rules.membership(r.Context(), org, body.From)
	if err != nil {
		return store(err)
	}
	taker, isMember, err := s.rules.membership(r.Context(), org, body.To)
	if err != nil {
		return store(err)
	}
	if !isMember || !slices.ContainsFunc(taker.Roles, func(r string) bool { return r != "client" }) {
		return bad("The new owner must be a member of the agency.")
	}
	ownerRole := "owner"
	if ok && slices.Contains(current.Roles, "solo") {
		ownerRole = "solo"
	}
	// The new owner sees the whole agency: their teams stay (they may still lead or call in them), their roles become the owner's.
	taker.Roles = []string{ownerRole}
	taker.SuspendedAt = nil
	if err := store(s.rules.setMembership(r.Context(), org, taker)); err != nil {
		return err
	}
	if err := store(s.rules.setSuspension(r.Context(), org, body.To, nil, "", "")); err != nil {
		return err
	}
	if err := store(s.rules.setOwner(r.Context(), org, body.To)); err != nil {
		return err
	}
	if len(body.OldRoles) == 0 {
		if err := s.leaveTeams(r.Context(), org, body.From, true); err != nil {
			return err
		}
		if err := store(s.rules.removeMember(r.Context(), org, body.From)); err != nil {
			return err
		}
	} else {
		current.Roles = sortedCopy(body.OldRoles)
		if err := store(s.rules.setMembership(r.Context(), org, current)); err != nil {
			return err
		}
	}
	// A handover by Caller Whale's staff (D201) also ends the pause the owner's absence caused.
	paused := false
	if err := store(s.rules.setStanding(r.Context(), org, standingChange{Paused: &paused})); err != nil {
		return err
	}
	actor := body.ActorID
	if !validID(actor) {
		actor = body.From
	}
	s.record(r.Context(), org, actor, body.To, "ownership_handed_over", nil, map[string]any{"from": body.From, "old_roles": nonNil(body.OldRoles)})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "owner_id": body.To, "access_changed": true})
	return nil
}

// upgrade answers POST /v1/orgs/{org}/upgrade {user_id, team_id, team_name}: a solo workspace becomes an agency in place
// (D59, D203). The solo operator becomes its owner and the lead of a first team, which the CRM names after them and moves their leads
// into. Their clients stay the agency's clients. Only the CRM asks.
func (s *server) upgrade(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		UserID   string `json:"user_id"`
		TeamID   string `json:"team_id"`
		TeamName string `json:"team_name"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if !validID(body.UserID) || !validID(body.TeamID) || body.TeamName == "" || len(body.TeamName) > 100 {
		return bad("Send user_id, team_id and team_name.")
	}
	m, ok, err := s.rules.membership(r.Context(), org, body.UserID)
	if err != nil {
		return store(err)
	}
	if !ok || !slices.Contains(m.Roles, "solo") {
		return newError(http.StatusConflict, "not_solo", "This workspace is already an agency.")
	}
	m.Roles = []string{"owner"}
	if err := store(s.rules.setMembership(r.Context(), org, m)); err != nil {
		return err
	}
	if err := store(s.rules.setOwner(r.Context(), org, body.UserID)); err != nil {
		return err
	}
	t := team{TeamID: body.TeamID, Name: body.TeamName, ManagerIDs: []string{body.UserID}}
	t.settle()
	if err := store(s.rules.setTeam(r.Context(), org, t)); err != nil {
		return err
	}
	s.record(r.Context(), org, body.UserID, body.UserID, "upgraded_to_agency", []string{body.TeamID}, map[string]any{"team_name": body.TeamName})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "team": t, "access_changed": true})
	return nil
}
