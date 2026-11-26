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
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
)

// disabledRoles are switched off: not listed, not given, and a grant someone still holds allows nothing. None now: the system admin
// platform role is back (D391, which reverses D338) and does what the owner and cofounder do.
var disabledRoles = map[string]bool{}

// agentRoles sit in teams: one team under the old team rules, one to maxTeams under the new ones. A researcher (D337) sits in teams
// like a caller or closer and is managed by the team's leads the same way (D369).
var agentRoles = []string{"caller", "closer", "researcher"}

// newRolesOnly are given only once the new team rules are on for the workspace.
var newRolesOnly = []string{"admin", "researcher"}

const (
	maxTeams     = 5  // D97: teams an agent can be in, a starting number
	maxDeputies  = 10 // deputies one team can have
	defaultAdmin = 3  // D179: admins an agency can have unless staff raise it
	// teamsV2 is the switch for the new team rules (D104): several leads, deputies, admins, researchers, agents in several teams.
	teamsV2 = "teams_v2"
)

func isAgent(roles []string) bool {
	return slices.ContainsFunc(roles, func(r string) bool { return slices.Contains(agentRoles, r) })
}
func isHeld(roles []string) bool {
	return slices.ContainsFunc(roles, func(r string) bool { return slices.Contains(heldRoles, r) })
}
func onlyClient(roles []string) bool { return len(roles) == 1 && roles[0] == "client" }
func staffBoss(staff string) bool    { return staff == "owner" || staff == "cofounder" || staff == "system_admin" }

// team is one team of a workspace: its leads (none, one, or several equal ones; D43) and deputies. ManagerID is the first lead,
// kept for the services and screens that know only one.
type team struct {
	TeamID     string   `json:"team_id"`
	Name       string   `json:"name"`
	ManagerID  string   `json:"manager_id"`
	ManagerIDs []string `json:"manager_ids"`
	DeputyIDs  []string `json:"deputy_ids"`
}

// settle fills ManagerID from ManagerIDs and makes the lists empty rather than missing. A team given only ManagerID (the older
// form, ManagerIDs nil) has that one lead.
func (t *team) settle() {
	if t.ManagerIDs == nil {
		t.ManagerIDs = []string{}
		if t.ManagerID != "" {
			t.ManagerIDs = []string{t.ManagerID}
		}
	}
	if t.DeputyIDs == nil {
		t.DeputyIDs = []string{}
	}
	t.ManagerID = ""
	if len(t.ManagerIDs) > 0 {
		t.ManagerID = t.ManagerIDs[0]
	}
}

// place is what the store says about the person asking for a change, in one workspace.
type place struct {
	UserID  string
	Staff   string   // platform role
	Roles   []string // workspace roles ("" when not a member)
	Managed []string // teams this person leads
	NewTeam bool     // the new team rules are on in this workspace
}

// newTeamRules is whether the switch for the new team rules is on for this workspace, or for every workspace.
func (s *server) newTeamRules(ctx context.Context, org string) (bool, error) {
	if slices.Contains(s.cfg.featuresEverywhere, teamsV2) {
		return true, nil
	}
	on, err := s.rules.features(ctx, org)
	if err != nil {
		return false, err
	}
	return slices.Contains(on, teamsV2), nil
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
	case a.NewTeam && slices.Contains(a.Roles, "admin"):
		// An admin does what the owner does with people and teams (D100), except that only the owner names, changes or
		// removes admins.
		if target != nil && slices.Contains(target.Roles, "admin") {
			return false, "Only the agency owner changes an admin."
		}
		if role == "admin" {
			return false, "Only the agency owner names admins."
		}
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
			// Any lead of a team manages its callers, closers and researchers; leads do not manage each other (D64).
			if target != nil && isAgent(target.Roles) && !slices.Contains(target.Roles, "manager") && !slices.Contains(target.Roles, "admin") &&
				slices.ContainsFunc(target.TeamIDs, func(t string) bool { return slices.Contains(a.Managed, t) }) {
				return true, ""
			}
			return false, "A team lead manages the callers, closers and researchers of their own teams only."
		case actInvite:
			// Under the new team rules a lead invites agents into a team they run (D15, D369).
			if a.NewTeam && slices.Contains(agentRoles, role) && teamID != "" && slices.Contains(a.Managed, teamID) {
				return true, ""
			}
			return false, "A team lead invites callers, closers and researchers into their own teams only."
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
	newTeam, err := s.newTeamRules(ctx, org)
	if err != nil {
		return place{}, store(err)
	}
	p := place{UserID: a.ActorID, Staff: staff, NewTeam: newTeam}
	f, err := s.rules.facts(ctx, a.ActorID, org)
	if err != nil {
		return place{}, store(err)
	}
	if staffBoss(staff) {
		// Staff who are the owner of this workspace act in it as its owner, like any agency owner: no staff second step. Staff
		// acting in someone else's workspace confirm themselves first.
		if f.member && isHeld(f.roles) {
			p.Staff, p.Roles, p.Managed = "", f.roles, f.managed
			return p, nil
		}
		if s.cfg.staffSecondStep && !a.ActorSecondStep {
			return place{}, forbidden("Confirm it's you with your second step first.")
		}
		return p, nil
	}
	if d := decide(f, grantRequest{Action: "read", SecondStepPassed: a.ActorSecondStep}, s.cfg.requireSecondStep); !d.Allowed && d.Code != "no_scope" {
		return place{}, forbidden(d.Reason)
	}
	p.Roles, p.Managed = f.roles, f.managed
	return p, nil
}

// checkPlacement refuses roles and teams that break the tree: switched-off and owner roles, roles that need the new team rules
// while they are off, an agent without the right number of teams of this workspace, a team given to anyone but an agent.
func checkPlacement(roles, teamIDs []string, teams []team, newTeam bool) error {
	for _, r := range roles {
		if disabledRoles[r] {
			return forbidden(roleTitle(r) + " is switched off for now.")
		}
		if platformRole(r) {
			return forbidden(roleTitle(r) + " is a Caller Whale staff role, not a workspace role.")
		}
		if slices.Contains(heldRoles, r) {
			return forbidden("Only the person who opened this workspace is its owner; that role cannot be given.")
		}
		if !newTeam && slices.Contains(newRolesOnly, r) {
			return forbidden(roleTitle(r) + " comes with the new team rules, which are not on for this agency yet.")
		}
	}
	if isAgent(roles) {
		switch {
		case !newTeam && len(teamIDs) != 1:
			return bad("Put a caller or closer in exactly one team.")
		case newTeam && (len(teamIDs) < 1 || len(teamIDs) > maxTeams):
			return bad(fmt.Sprintf("Put a caller, closer or researcher in one to %d teams.", maxTeams))
		}
		seen := map[string]bool{}
		for _, id := range teamIDs {
			if seen[id] {
				return bad("Name each team once.")
			}
			seen[id] = true
			if !slices.ContainsFunc(teams, func(t team) bool { return t.TeamID == id }) {
				return bad("That team is not in this workspace.")
			}
		}
		if !newTeam && len(roles) > 1 && slices.Contains(roles, "manager") {
			return bad("A team manager is not also a caller or closer.")
		}
	} else if len(teamIDs) > 0 {
		return bad("Only callers, closers and researchers sit in a team; a team lead is named on the team itself.")
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
		} else if len(m.Roles) > 0 && m.SuspendedAt == nil { // a suspended person keeps their place but not a seat (D81, D365)
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
		Name       string    `json:"name"`
		ManagerID  string    `json:"manager_id"`  // one lead, or "" for none (the older form)
		ManagerIDs *[]string `json:"manager_ids"` // the team's leads; left out, manager_id decides
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
	leads := []string{}
	if body.ManagerIDs != nil {
		leads = *body.ManagerIDs
	} else if body.ManagerID != "" {
		leads = []string{body.ManagerID}
	}
	if !a.NewTeam && len(leads) > 1 {
		return bad("A team has one lead until the new team rules are on for this agency.")
	}
	seen := map[string]bool{}
	for _, lead := range leads {
		if !validID(lead) || seen[lead] {
			return bad("Name each team lead once.")
		}
		seen[lead] = true
		m, ok, err := s.rules.membership(r.Context(), org, lead)
		if err != nil {
			return store(err)
		}
		if !ok || !slices.Contains(m.Roles, "manager") {
			return bad("Choose team leads of this workspace to run the team.")
		}
		if m.SuspendedAt != nil {
			return bad("That team lead is suspended.")
		}
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	saved := team{TeamID: id, Name: body.Name, ManagerIDs: leads}
	for _, t := range teams {
		if t.TeamID != id && strings.EqualFold(t.Name, body.Name) {
			return newError(http.StatusConflict, "conflict", "Another team already has that name.")
		}
		if t.TeamID == id {
			// Deputies stay; one who is now a lead is a lead only.
			saved.DeputyIDs = slices.DeleteFunc(slices.Clone(t.DeputyIDs), func(d string) bool { return seen[d] })
		}
	}
	saved.settle()
	if err := store(s.rules.setTeam(r.Context(), org, saved)); err != nil {
		return err
	}
	s.record(r.Context(), org, a.UserID, "", "team.saved", []string{id}, map[string]any{"name": saved.Name, "lead_ids": saved.ManagerIDs})
	writeJSON(w, http.StatusOK, map[string]any{"team": saved, "access_changed": true})
	return nil
}

// putDeputies names a team's deputies (D43, D62, D63): any member of the agency, named by the team's leads, the owner or an admin.
// A deputy reads the team's leads and threads and can take them over, but manages nobody.
func (s *server) putDeputies(w http.ResponseWriter, r *http.Request) error {
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
		DeputyIDs []string `json:"deputy_ids"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	a, err := s.placeOf(r.Context(), org, body.actor)
	if err != nil {
		return err
	}
	if !a.NewTeam {
		return forbidden("Deputy leads come with the new team rules, which are not on for this agency yet.")
	}
	if ok, _ := mayAct(a, actTeams, nil, "", ""); !ok && !slices.Contains(a.Managed, id) {
		return forbidden("The team's leads, an admin or the owner name its deputies.")
	}
	if len(body.DeputyIDs) > maxDeputies {
		return bad(fmt.Sprintf("A team has at most %d deputy leads.", maxDeputies))
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	i := slices.IndexFunc(teams, func(t team) bool { return t.TeamID == id })
	if i < 0 {
		return newError(http.StatusNotFound, "not_found", "That team is not in this workspace.")
	}
	saved := teams[i]
	seen := map[string]bool{}
	for _, d := range body.DeputyIDs {
		if !validID(d) || seen[d] {
			return bad("Name each deputy once.")
		}
		seen[d] = true
		if slices.Contains(saved.ManagerIDs, d) {
			return bad("A team lead of this team is not also its deputy.")
		}
		m, ok, err := s.rules.membership(r.Context(), org, d)
		if err != nil {
			return store(err)
		}
		if !ok || onlyClient(m.Roles) {
			return bad("A deputy is a member of this agency (not a client).")
		}
		if m.SuspendedAt != nil {
			return bad("That person is suspended.")
		}
	}
	saved.DeputyIDs = slices.Clone(body.DeputyIDs)
	saved.settle()
	if err := store(s.rules.setTeam(r.Context(), org, saved)); err != nil {
		return err
	}
	log.Printf("INFO workspace %s: deputies of team %s set by %s", org, id, a.UserID)
	s.record(r.Context(), org, a.UserID, "", "team.deputies", []string{id}, map[string]any{"name": saved.Name, "deputy_ids": saved.DeputyIDs})
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
			// Coming back needs a free seat: after the plan was lowered, the owner adds one first (D365).
			if target.SuspendedAt != nil && !onlyClient(target.Roles) {
				if err := s.seatsFree(r.Context(), org, target.Roles, 0); err != nil {
					return err
				}
			}
			err = s.rules.setSuspension(r.Context(), org, user, nil, "", "")
		} else {
			at := s.now().Unix()
			err = s.rules.setSuspension(r.Context(), org, user, &at, a.UserID, strings.TrimSpace(body.Reason))
		}
		if err := store(err); err != nil {
			return err
		}
		log.Printf("INFO workspace %s: %s %s by %s", org, user, map[bool]string{true: "restored", false: "suspended"}[restore], a.UserID)
		detail := map[string]any{}
		if reason := strings.TrimSpace(body.Reason); reason != "" && !restore {
			detail["reason"] = reason
		}
		s.record(r.Context(), org, a.UserID, user, map[bool]string{true: "restored", false: "suspended"}[restore], target.TeamIDs, detail)
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
		// An invitation that carries everything (D45): several roles, several teams, and for a team lead the teams they
		// will lead. Left out, role and team_id are the whole invitation.
		Roles       []string `json:"roles"`
		TeamIDs     []string `json:"team_ids"`
		LeadTeamIDs []string `json:"lead_team_ids"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if body.Action == actInvite && (len(body.Roles) > 0 || len(body.TeamIDs) > 0 || len(body.LeadTeamIDs) > 0) {
		return s.checkInvitation(w, r, org, body.actor, body.Roles, body.TeamIDs, body.LeadTeamIDs, body.Role, body.TeamID, max(body.Pending, 0))
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
		if err := checkPlacement([]string{body.Role}, teamIDs, teams, a.NewTeam); err != nil {
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
	Paused          *bool // staff own it, like Suspended
	// When the plan went unpaid (billing may say; otherwise the first "payment_required: true" sets it to now), and an
	// agency its owner closed (auth only).
	UnpaidSinceSet bool
	UnpaidSince    *int64
	Closed         *bool
	SeatsSet       bool
	Seats          *int
	ClientsSet     bool
	Clients        *int
}

func readStanding(raw map[string]json.RawMessage) (standingChange, error) {
	var c standingChange
	var err error
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
	if _, err := decode("paused", &c.Paused); err != nil {
		return c, bad("paused is true or false.")
	}
	if c.UnpaidSinceSet, err = decode("unpaid_since", &c.UnpaidSince); err != nil {
		return c, bad("unpaid_since is a time in seconds, or null.")
	}
	if _, err := decode("closed", &c.Closed); err != nil {
		return c, bad("closed is true or false.")
	}
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

// leaveTeams takes someone off the leads (and, when they leave the workspace, the deputies) of every team.
func (s *server) leaveTeams(ctx context.Context, org, user string, deputiesToo bool) error {
	teams, err := s.rules.teams(ctx, org)
	if err != nil {
		return store(err)
	}
	for _, t := range teams {
		lead, deputy := slices.Contains(t.ManagerIDs, user), slices.Contains(t.DeputyIDs, user)
		if !lead && !(deputiesToo && deputy) {
			continue
		}
		t.ManagerIDs = slices.DeleteFunc(slices.Clone(t.ManagerIDs), func(id string) bool { return id == user })
		if deputiesToo {
			t.DeputyIDs = slices.DeleteFunc(slices.Clone(t.DeputyIDs), func(id string) bool { return id == user })
		}
		t.settle()
		if err := store(s.rules.setTeam(ctx, org, t)); err != nil {
			return err
		}
	}
	return nil
}

// adminPlaceFree refuses a fourth admin (D179) unless staff raised the number for this agency.
func (s *server) adminPlaceFree(ctx context.Context, org string) error {
	limit, err := s.rules.adminLimit(ctx, org)
	if err != nil {
		return store(err)
	}
	allowed := defaultAdmin
	if limit != nil {
		allowed = *limit
	}
	members, err := s.rules.members(ctx, org)
	if err != nil {
		return store(err)
	}
	admins := 0
	for _, m := range members {
		if slices.Contains(m.Roles, "admin") {
			admins++
		}
	}
	if admins >= allowed {
		return newError(http.StatusConflict, "admins_full", fmt.Sprintf("This agency has %d admins, its limit. Ask Caller Whale to raise it.", allowed))
	}
	return nil
}

// putFeature turns one of a workspace's switches on or off (D104): on for the owner's agency first, then for everyone, and off
// again without a release. Only Caller Whale staff do this, through auth.
func (s *server) putFeature(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	name := r.PathValue("name")
	if name != teamsV2 {
		return bad("There is no such switch.")
	}
	var body struct {
		On bool `json:"on"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if _, _, found, err := s.rules.workspaceInfo(r.Context(), org); err != nil {
		return store(err)
	} else if !found {
		return newError(http.StatusNotFound, "not_found", "No such workspace.")
	}
	if err := store(s.rules.setFeature(r.Context(), org, name, body.On)); err != nil {
		return err
	}
	log.Printf("INFO workspace %s: switch %s turned %v by %s", org, name, body.On, callerOf(r))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "on": body.On, "access_changed": true})
	return nil
}

// checkInvitation answers whether an invitation carrying several roles, teams and teams to lead may be sent now, and would be
// accepted: the same rules as each change on its own (who may invite which role into which team, the team tree, the seats), and a
// team to lead must exist and, under the old team rules, have no lead yet. Only the owner, an admin or staff name team leads.
func (s *server) checkInvitation(w http.ResponseWriter, r *http.Request, org string, who actor, roles, teamIDs, leadTeams []string, role, teamID string, pending int) error {
	refuse := func(e error) error {
		var api *apiError
		if ok := asAPI(e, &api); ok && api.status < 500 {
			writeJSON(w, http.StatusOK, map[string]any{"allowed": false, "code": api.code, "reason": api.message})
			return nil
		}
		return e
	}
	if len(roles) == 0 && role != "" {
		roles = []string{role}
	}
	if len(teamIDs) == 0 && teamID != "" {
		teamIDs = []string{teamID}
	}
	if len(roles) == 0 || len(roles) > 4 {
		return refuse(bad("Choose one to four roles."))
	}
	a, err := s.placeOf(r.Context(), org, who)
	if err != nil {
		return refuse(err)
	}
	for _, rl := range roles {
		if slices.Contains(agentRoles, rl) && len(teamIDs) > 0 {
			for _, t := range teamIDs {
				if ok, why := mayAct(a, actInvite, nil, rl, t); !ok {
					return refuse(forbidden(why))
				}
			}
		} else if ok, why := mayAct(a, actInvite, nil, rl, ""); !ok {
			return refuse(forbidden(why))
		}
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	if err := checkPlacement(roles, teamIDs, teams, a.NewTeam); err != nil {
		return refuse(err)
	}
	if len(leadTeams) > 0 {
		if !slices.Contains(roles, "manager") {
			return refuse(bad("Only someone invited as a team lead can be given teams to lead."))
		}
		if ok, _ := mayAct(a, actTeams, nil, "", ""); !ok {
			return refuse(forbidden("Only the agency owner or an admin names team leads."))
		}
		seen := map[string]bool{}
		for _, id := range leadTeams {
			i := slices.IndexFunc(teams, func(t team) bool { return t.TeamID == id })
			if i < 0 || seen[id] {
				return refuse(bad("Choose each team to lead once, from this workspace."))
			}
			seen[id] = true
			if !a.NewTeam && len(teams[i].ManagerIDs) > 0 {
				return refuse(newError(http.StatusConflict, "conflict", teams[i].Name+" already has a team lead. A team gets several leads under the new team rules."))
			}
		}
	}
	if err := s.seatsFree(r.Context(), org, roles, pending); err != nil {
		return refuse(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"allowed": true})
	return nil
}
