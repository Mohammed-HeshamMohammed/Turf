package main

// The team tree and who may manage whom (docs/plans/database-and-backend.pdf, chapters 3 and 4).
//
//   - A workspace's teams each have at most one manager (authz_teams). A manager may run several teams.
//   - A caller or closer sits in exactly one team (authz_members.team_ids); a manager's teams come from authz_teams.
//   - The platform owner and cofounder may do anything anywhere. The agency owner may do anything in their workspace. A team
//     manager may suspend, restore and restrict the callers and closers of their own teams. A solo operator may invite and
//     manage clients only. Nobody else manages anyone, and nobody changes the workspace's owner or their own access.
//
// Everything here is a pure function of what the store says, so the whole rule is in one place and tested as one table.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"slices"
	"strings"
)

// disabledRoles are switched off for now: not listed, not given, and a grant someone still holds allows nothing.
var disabledRoles = map[string]bool{"researcher": true, "system_admin": true}

// agentRoles sit in exactly one team.
var agentRoles = []string{"caller", "closer"}

func isAgent(roles []string) bool {
	return slices.ContainsFunc(roles, func(r string) bool { return slices.Contains(agentRoles, r) })
}
func isHeld(roles []string) bool {
	return slices.ContainsFunc(roles, func(r string) bool { return slices.Contains(heldRoles, r) })
}
func onlyClient(roles []string) bool { return len(roles) == 1 && roles[0] == "client" }
func staffBoss(staff string) bool    { return staff == "owner" || staff == "cofounder" }

// team is one team of a workspace and its manager ("" when it has none yet).
type team struct {
	TeamID    string `json:"team_id"`
	Name      string `json:"name"`
	ManagerID string `json:"manager_id"`
}

// place is what the store says about the person asking for a change, in one workspace.
type place struct {
	UserID  string
	Staff   string   // platform role
	Roles   []string // workspace roles ("" when not a member)
	Managed []string // teams this person manages
}

// Actions a person may take on another.
const (
	actInvite   = "invite"   // add someone with a role (and a team, for an agent)
	actChange   = "change"   // change someone's roles or team
	actRestrict = "restrict" // take capabilities away, or give them back
	actSuspend  = "suspend"  // suspend or restore
	actRemove   = "remove"   // remove from the workspace
	actLimits   = "limits"   // set someone's limits
	actTeams    = "teams"    // create, rename or remove teams and name their managers
)

// mayAct answers whether a may do action to target (nil for an invitation, which names role and teamID instead), and why not.
func mayAct(a place, action string, target *membership, role, teamID string) (bool, string) {
	if staffBoss(a.Staff) {
		return true, ""
	}
	if target != nil {
		if isHeld(target.Roles) {
			return false, "The workspace's owner cannot be changed."
		}
		if target.UserID == a.UserID {
			return false, "You cannot change your own access."
		}
	}
	switch {
	case slices.Contains(a.Roles, "owner"):
		return true, ""
	case slices.Contains(a.Roles, "solo"):
		if action == actTeams {
			return false, "A solo workspace has no teams."
		}
		if action == actInvite {
			if role == "client" {
				return true, ""
			}
			return false, "A solo operator can invite clients only."
		}
		if target != nil && onlyClient(target.Roles) {
			return true, ""
		}
		return false, "A solo operator manages clients only."
	case slices.Contains(a.Roles, "manager"):
		switch action {
		case actSuspend, actRestrict, actLimits:
			if target != nil && isAgent(target.Roles) && len(target.TeamIDs) == 1 && slices.Contains(a.Managed, target.TeamIDs[0]) {
				return true, ""
			}
			return false, "A team manager manages the callers and closers of their own teams only."
		default:
			return false, "Only the agency owner does this."
		}
	}
	return false, "Your role does not manage other people."
}

// placeOf reads the person asking, refusing someone who is neither staff nor an active member who passed any second step their
// role needs.
func (s *server) placeOf(ctx context.Context, org string, a actor) (place, error) {
	if !validID(a.ActorID) {
		return place{}, bad("Send actor_id: the person asking for this change.")
	}
	staff, err := s.rules.staffRole(ctx, a.ActorID)
	if err != nil {
		return place{}, store(err)
	}
	p := place{UserID: a.ActorID, Staff: staff}
	if staffBoss(staff) {
		if s.cfg.staffSecondStep && !a.ActorSecondStep {
			return place{}, forbidden("Confirm it's you with your second step first.")
		}
		return p, nil
	}
	f, err := s.rules.facts(ctx, a.ActorID, org)
	if err != nil {
		return place{}, store(err)
	}
	if d := decide(f, grantRequest{Action: "read", SecondStepPassed: a.ActorSecondStep}, s.cfg.requireSecondStep); !d.Allowed && d.Code != "no_scope" {
		return place{}, forbidden(d.Reason)
	}
	p.Roles, p.Managed = f.roles, f.managed
	return p, nil
}

// checkPlacement refuses roles and teams that break the tree: switched-off and owner roles, an agent without exactly one team of
// this workspace, a team given to anyone but an agent.
func checkPlacement(roles, teamIDs []string, teams []team) error {
	for _, r := range roles {
		if disabledRoles[r] {
			return forbidden(roleTitle(r) + " is switched off for now.")
		}
		if slices.Contains(heldRoles, r) {
			return forbidden("Only the person who opened this workspace is its owner; that role cannot be given.")
		}
	}
	if isAgent(roles) {
		if len(teamIDs) != 1 {
			return bad("Put a caller or closer in exactly one team.")
		}
		if !slices.ContainsFunc(teams, func(t team) bool { return t.TeamID == teamIDs[0] }) {
			return bad("That team is not in this workspace.")
		}
		if len(roles) > 1 && slices.Contains(roles, "manager") {
			return bad("A team manager is not also a caller or closer.")
		}
	} else if len(teamIDs) > 0 {
		return bad("Only callers and closers sit in a team; a manager is named on the team itself.")
	}
	return nil
}

// seatsFree refuses adding someone when the workspace's seats (or clients) are taken. pending counts invitations not yet accepted.
func (s *server) seatsFree(ctx context.Context, org string, roles []string, pending int) error {
	seats, clients, err := s.rules.seatLimits(ctx, org)
	if err != nil {
		return store(err)
	}
	members, err := s.rules.members(ctx, org)
	if err != nil {
		return store(err)
	}
	usedSeats, usedClients := 0, 0
	for _, m := range members {
		if onlyClient(m.Roles) {
			usedClients++
		} else if len(m.Roles) > 0 {
			usedSeats++
		}
	}
	if onlyClient(roles) {
		if clients != nil && usedClients+pending+1 > *clients {
			return newError(http.StatusConflict, "clients_full", "Every client place on this plan is taken. Ask Caller Whale for more.")
		}
		return nil
	}
	if seats != nil && usedSeats+pending+1 > *seats {
		return newError(http.StatusConflict, "seats_full", "Every seat on this plan is taken. Remove someone or ask Caller Whale for more seats.")
	}
	return nil
}

// ---------------------------------------------------------------------------------------------------------------- handlers

func (s *server) listTeams(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams})
	return nil
}

func (s *server) putTeam(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	id := r.PathValue("team")
	if !validID(id) {
		return bad("That is not a team id.")
	}
	var body struct {
		actor
		Name      string `json:"name"`
		ManagerID string `json:"manager_id"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 100 {
		return bad("Name the team (up to 100 characters).")
	}
	a, err := s.placeOf(r.Context(), org, body.actor)
	if err != nil {
		return err
	}
	if ok, why := mayAct(a, actTeams, nil, "", ""); !ok {
		return forbidden(why)
	}
	if body.ManagerID != "" {
		m, ok, err := s.rules.membership(r.Context(), org, body.ManagerID)
		if err != nil {
			return store(err)
		}
		if !ok || !slices.Contains(m.Roles, "manager") {
			return bad("Choose a team manager of this workspace to run the team.")
		}
		if m.SuspendedAt != nil {
			return bad("That manager is suspended.")
		}
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	for _, t := range teams {
		if t.TeamID != id && strings.EqualFold(t.Name, body.Name) {
			return newError(http.StatusConflict, "conflict", "Another team already has that name.")
		}
	}
	saved := team{TeamID: id, Name: body.Name, ManagerID: body.ManagerID}
	if err := store(s.rules.setTeam(r.Context(), org, saved)); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"team": saved, "access_changed": true})
	return nil
}

func (s *server) deleteTeam(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	id := r.PathValue("team")
	if !validID(id) {
		return bad("That is not a team id.")
	}
	var body actor
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	a, err := s.placeOf(r.Context(), org, body)
	if err != nil {
		return err
	}
	if ok, why := mayAct(a, actTeams, nil, "", ""); !ok {
		return forbidden(why)
	}
	members, err := s.rules.members(r.Context(), org)
	if err != nil {
		return store(err)
	}
	for _, m := range members {
		if slices.Contains(m.TeamIDs, id) {
			return newError(http.StatusConflict, "conflict", "Move the team's callers and closers to another team first.")
		}
	}
	if err := store(s.rules.removeTeam(r.Context(), org, id)); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "access_changed": true})
	return nil
}

// suspendMember suspends or restores someone's access to the workspace. Their place and history stay.
func (s *server) suspendMember(restore bool) handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		org, err := s.workspace(r)
		if err != nil {
			return err
		}
		user := r.PathValue("user")
		if !validID(user) {
			return bad("That is not a person's id.")
		}
		var body struct {
			actor
			Reason string `json:"reason"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		if len(body.Reason) > 200 {
			return bad("Keep the reason under 200 characters.")
		}
		a, err := s.placeOf(r.Context(), org, body.actor)
		if err != nil {
			return err
		}
		target, ok, err := s.rules.membership(r.Context(), org, user)
		if err != nil {
			return store(err)
		}
		if !ok {
			return newError(http.StatusNotFound, "not_found", "That person is not a member of this workspace.")
		}
		if allowed, why := mayAct(a, actSuspend, &target, "", ""); !allowed {
			return forbidden(why)
		}
		if restore {
			err = s.rules.setSuspension(r.Context(), org, user, nil, "", "")
		} else {
			at := s.now().Unix()
			err = s.rules.setSuspension(r.Context(), org, user, &at, a.UserID, strings.TrimSpace(body.Reason))
		}
		if err := store(err); err != nil {
			return err
		}
		log.Printf("INFO workspace %s: %s %s by %s", org, user, map[bool]string{true: "restored", false: "suspended"}[restore], a.UserID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "suspended": !restore, "access_changed": true})
		return nil
	}
}

// checkRelation answers "may this person do this to that person (or invite this role)" without changing anything, for the
// services that hold the screens: auth asks it before saving an invitation.
func (s *server) checkRelation(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		actor
		Action   string `json:"action"`
		TargetID string `json:"target_id"`
		Role     string `json:"role"`
		TeamID   string `json:"team_id"`
		Pending  int    `json:"pending"` // invitations already waiting, which hold a seat each
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	refuse := func(e error) error {
		var api *apiError
		if ok := asAPI(e, &api); ok && api.status < 500 {
			writeJSON(w, http.StatusOK, map[string]any{"allowed": false, "code": api.code, "reason": api.message})
			return nil
		}
		return e
	}
	a, err := s.placeOf(r.Context(), org, body.actor)
	if err != nil {
		return refuse(err)
	}
	var target *membership
	if body.Action != actInvite {
		m, ok, err := s.rules.membership(r.Context(), org, body.TargetID)
		if err != nil {
			return store(err)
		}
		if !ok {
			return refuse(newError(http.StatusNotFound, "not_found", "That person is not a member of this workspace."))
		}
		target = &m
	}
	if ok, why := mayAct(a, body.Action, target, body.Role, body.TeamID); !ok {
		return refuse(forbidden(why))
	}
	if body.Action == actInvite {
		teams, err := s.rules.teams(r.Context(), org)
		if err != nil {
			return store(err)
		}
		var teamIDs []string
		if body.TeamID != "" {
			teamIDs = []string{body.TeamID}
		}
		if err := checkPlacement([]string{body.Role}, teamIDs, teams); err != nil {
			return refuse(err)
		}
		if err := s.seatsFree(r.Context(), org, []string{body.Role}, max(body.Pending, 0)); err != nil {
			return refuse(err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"allowed": true})
	return nil
}

// standingChange is what a PUT of a workspace's standing changes: only the fields it sends. Billing owns payment_required and the
// seats; staff own suspended, so a payment webhook can never lift a suspension.
type standingChange struct {
	Suspended       *bool
	PaymentRequired *bool
	SeatsSet        bool
	Seats           *int
	ClientsSet      bool
	Clients         *int
}

func readStanding(raw map[string]json.RawMessage) (standingChange, error) {
	var c standingChange
	decode := func(key string, into any) (bool, error) {
		v, ok := raw[key]
		if !ok {
			return false, nil
		}
		return true, json.Unmarshal(v, into)
	}
	if _, err := decode("suspended", &c.Suspended); err != nil {
		return c, bad("suspended is true or false.")
	}
	if _, err := decode("payment_required", &c.PaymentRequired); err != nil {
		return c, bad("payment_required is true or false.")
	}
	var err error
	if c.SeatsSet, err = decode("seats", &c.Seats); err != nil || (c.Seats != nil && *c.Seats < 1) {
		return c, bad("seats is a number of 1 or more, or null for unlimited.")
	}
	if c.ClientsSet, err = decode("clients", &c.Clients); err != nil || (c.Clients != nil && *c.Clients < 0) {
		return c, bad("clients is a number of 0 or more, or null for unlimited.")
	}
	return c, nil
}

// activeRoles leaves out the switched-off roles.
func activeRoles(roles []string) []string {
	out := []string{}
	for _, r := range roles {
		if !disabledRoles[r] {
			out = append(out, r)
		}
	}
	return out
}

// teamsSeen is the teams whose leads a person sees: their own team, and the teams they manage.
func teamsSeen(own, managed []string) []string {
	out := slices.Clone(own)
	for _, id := range managed {
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}
