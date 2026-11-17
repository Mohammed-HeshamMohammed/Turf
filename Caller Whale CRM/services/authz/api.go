package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

var version = "dev"

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(id string) bool { return uuidPattern.MatchString(id) }

type server struct {
	cfg   config
	rules engine
	keys  *keys
	now   func() time.Time
}

type callerKey struct{}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if live, ok := s.rules.(interface{ ping(context.Context) error }); ok {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := live.ping(ctx); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "service": "authz"})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "authz"})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": "authz", "version": version})
	})
	mux.HandleFunc("GET /.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(s.keys.jwks)
	})
	mux.Handle("POST /v1/grant", s.only("grant", s.grant))
	mux.Handle("POST /v1/check", s.only("check", s.check))
	mux.Handle("POST /v1/check-batch", s.only("check", s.checkBatch))
	mux.Handle("PUT /v1/orgs/{org}/owner", s.only("open", s.open))
	mux.Handle("GET /v1/orgs/{org}", s.only("read", s.workspaceAbout))
	mux.Handle("PUT /v1/orgs/{org}/name", s.only("manage", s.nameWorkspace))
	mux.Handle("PUT /v1/orgs/{org}/features/{name}", s.only("manage_staff", s.putFeature))
	mux.Handle("PUT /v1/orgs/{org}/teams/{team}/deputies", s.only("manage_members", s.putDeputies))
	mux.Handle("GET /v1/people/{user}", s.only("read", s.person))
	mux.Handle("GET /v1/roles", s.only("read", s.catalog))
	mux.Handle("GET /v1/orgs/{org}/roles", s.only("read", s.listRoles))
	mux.Handle("PUT /v1/orgs/{org}/roles/{key}", s.only("manage", s.putRole))
	mux.Handle("GET /v1/orgs/{org}/members", s.only("read", s.listMembers))
	mux.Handle("PUT /v1/orgs/{org}/members/{user}", s.only("manage_members", s.putMember))
	mux.Handle("DELETE /v1/orgs/{org}/members/{user}", s.only("manage_members", s.deleteMember))
	mux.Handle("POST /v1/orgs/{org}/members/{user}/suspend", s.only("manage_members", s.suspendMember(false)))
	mux.Handle("POST /v1/orgs/{org}/members/{user}/restore", s.only("manage_members", s.suspendMember(true)))
	mux.Handle("GET /v1/orgs/{org}/teams", s.only("read", s.listTeams))
	mux.Handle("PUT /v1/orgs/{org}/teams/{team}", s.only("manage_members", s.putTeam))
	mux.Handle("DELETE /v1/orgs/{org}/teams/{team}", s.only("manage_members", s.deleteTeam))
	mux.Handle("POST /v1/orgs/{org}/relations/check", s.only("read", s.checkRelation))
	mux.Handle("PUT /v1/orgs/{org}/standing", s.only("standing", s.putStanding))
	mux.Handle("PUT /v1/staff/{user}", s.only("manage_staff", s.putStaff))
	mux.Handle("GET /v1/staff", s.only("read", s.listStaff))
	return logHTTP(mux)
}

// only lets a request through when it carries a calling service's token and that service may make this kind of request.
func (s *server) only(right string, h handler) http.Handler {
	return serve(func(w http.ResponseWriter, r *http.Request) error {
		token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		caller := ""
		for known, name := range s.cfg.tokens {
			if subtle.ConstantTimeCompare([]byte(known), []byte(token)) == 1 {
				caller = name
			}
		}
		if caller == "" {
			log.Printf("WARN refused a request without a known caller token: %s %s", r.Method, r.URL.Path)
			return errNoCaller
		}
		if !slices.Contains(callerRights[caller], right) {
			log.Printf("WARN refused %s: it may not %s (%s %s)", caller, right, r.Method, r.URL.Path)
			return errNotAllowed
		}
		return h(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, caller)))
	})
}

func callerOf(r *http.Request) string {
	name, _ := r.Context().Value(callerKey{}).(string)
	return name
}

// store turns a rules-store failure into "unavailable", so callers refuse instead of guessing.
func store(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errAlreadyOpen) {
		return newError(http.StatusConflict, "conflict", "This workspace already has an owner.")
	}
	log.Printf("ERROR the rules store: %v", err)
	return errUnavailable
}

// grant answers "may this person do this here", and when yes, signs the database rights and record scope to use.
func (s *server) grant(w http.ResponseWriter, r *http.Request) error {
	var req grantRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	if !validID(req.UserID) || !knownAction(req.Action) {
		return bad("Send user_id and a known action.")
	}
	var d decision
	if req.Action == "platform" {
		staff, err := s.rules.staffRole(r.Context(), req.UserID)
		if err != nil {
			return store(err)
		}
		d = decideStaff(staff, req.SecondStepPassed, s.cfg.staffSecondStep)
	} else {
		if !validID(req.OrgID) {
			return bad("Send org_id for an action in a workspace.")
		}
		f, err := s.rules.facts(r.Context(), req.UserID, req.OrgID)
		if err != nil {
			return store(err)
		}
		d = decide(f, req, s.cfg.requireSecondStep)
	}
	if !d.Allowed {
		writeJSON(w, http.StatusOK, d)
		return nil
	}
	signed, err := s.keys.sign(callerOf(r), req.UserID, req.OrgID, req.Action, d, s.now(), s.cfg.grantSeconds)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"allowed": true, "grant": signed, "expires_in": s.cfg.grantSeconds, "db_role": d.DBRole, "scopes": d.Scopes,
		"team_ids": d.TeamIDs, "project_ids": d.ProjectIDs, "capabilities": d.Capabilities, "roles": d.Roles, "managed_team_ids": d.ManagedTeamIDs,
		"deputy_team_ids": d.DeputyTeamIDs, "team_scope_ids": d.TeamScopeIDs,
	})
	return nil
}

type checkItem struct {
	UserID     string `json:"user_id"`
	OrgID      string `json:"org_id"`
	Permission string `json:"permission"`
}

func (s *server) answer(ctx context.Context, c checkItem) (bool, error) {
	if !validID(c.UserID) || !(slices.Contains(capabilities, c.Permission) || slices.Contains(checkable, c.Permission)) {
		return false, bad("Send user_id and a known permission.")
	}
	if c.Permission != "staff" && c.Permission != "manage_staff" && c.Permission != "tester" && !validID(c.OrgID) {
		return false, bad("Send org_id for a permission in a workspace.")
	}
	ok, err := s.rules.check(ctx, c.UserID, c.OrgID, c.Permission)
	return ok, store(err)
}

func (s *server) check(w http.ResponseWriter, r *http.Request) error {
	var c checkItem
	if err := readJSON(w, r, &c); err != nil {
		return err
	}
	ok, err := s.answer(r.Context(), c)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"allowed": ok})
	return nil
}

func (s *server) checkBatch(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Items []checkItem `json:"items"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if len(body.Items) == 0 || len(body.Items) > 100 {
		return bad("Send 1 to 100 items.")
	}
	results := make([]bool, len(body.Items))
	for i, c := range body.Items {
		ok, err := s.answer(r.Context(), c)
		if err != nil {
			return err
		}
		results[i] = ok
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
	return nil
}

// actor is the person on whose behalf a change is asked for. The calling service read them from their access token.
type actor struct {
	ActorID         string `json:"actor_id"`
	ActorSecondStep bool   `json:"actor_second_step"`
}

// mayManage refuses a change unless the person asking may administer the workspace, exactly as the core API's admin pages did.
func (s *server) mayManage(ctx context.Context, org string, a actor) error {
	if !validID(a.ActorID) {
		return bad("Send actor_id: the person asking for this change.")
	}
	f, err := s.rules.facts(ctx, a.ActorID, org)
	if err != nil {
		return store(err)
	}
	if d := decide(f, grantRequest{Action: "admin", SecondStepPassed: a.ActorSecondStep}, s.cfg.requireSecondStep); !d.Allowed {
		return forbidden(d.Reason)
	}
	return nil
}

func (s *server) workspace(r *http.Request) (string, error) {
	org := r.PathValue("org")
	if !validID(org) {
		return "", bad("That is not a workspace id.")
	}
	return org, nil
}

// open sets up a new workspace's roles and its owner. Asking again for the same owner changes nothing.
func (s *server) open(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		UserID string `json:"user_id"`
		Role   string `json:"role"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if body.Role == "" {
		body.Role = "owner"
	}
	if !validID(body.UserID) || !slices.Contains(heldRoles, body.Role) {
		return bad("Send user_id, and role owner or solo.")
	}
	if err := store(s.rules.openWorkspace(r.Context(), org, body.UserID, body.Role)); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "access_changed": true})
	return nil
}

// workspaceAbout is who owns a workspace and what it is called, for an invitation that has to say where it comes from.
func (s *server) workspaceAbout(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	owner, name, found, err := s.rules.workspaceInfo(r.Context(), org)
	if err != nil {
		return store(err)
	}
	if !found {
		return newError(http.StatusNotFound, "not_found", "No such workspace.")
	}
	newTeam, err := s.newTeamRules(r.Context(), org)
	if err != nil {
		return store(err)
	}
	switches := []string{}
	if newTeam {
		switches = append(switches, teamsV2)
	}
	writeJSON(w, http.StatusOK, map[string]any{"org_id": org, "owner_id": owner, "name": name, "features": switches})
	return nil
}

// nameWorkspace keeps the agency's name as the CRM has it. Only the CRM (core-api) sets it, since that is where it is changed.
func (s *server) nameWorkspace(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 200 || strings.ContainsAny(name, "\r\n") {
		return bad("Send a name of up to 200 characters on one line.")
	}
	if err := store(s.rules.setWorkspaceName(r.Context(), org, name)); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (s *server) listRoles(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	roles, err := s.rules.roles(r.Context(), org)
	if err != nil {
		return store(err)
	}
	newTeam, err := s.newTeamRules(r.Context(), org)
	if err != nil {
		return store(err)
	}
	// One list with nothing twice: the standard roles, then this workspace's own. Admin and researcher appear once the new team
	// rules are on for this workspace.
	listed := buildCatalog(roles)
	if !newTeam {
		listed = slices.DeleteFunc(listed, func(c catalogRole) bool { return slices.Contains(newRolesOnly, c.Key) })
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": listed})
	return nil
}

func (s *server) putRole(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var body struct {
		actor
		Capabilities []string `json:"capabilities"`
		Scope        string   `json:"scope"`
		SecondStep   bool     `json:"second_step"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	key := r.PathValue("key")
	if !roleKey.MatchString(key) {
		return bad("A role key is lowercase letters, digits and underscores.")
	}
	if slices.Contains(heldRoles, key) || key == "admin" {
		return forbidden("This role cannot be changed.")
	}
	// A custom role may not take a standard role's or a platform role's name: two things would share one label, or a standard
	// role would quietly change for everyone who holds it.
	if reserved(key) {
		return forbidden(key + " is a standard role. Give your own role a different name.")
	}
	for _, c := range body.Capabilities {
		if !slices.Contains(capabilities, c) {
			return bad(c + " is not a capability.")
		}
		if c == "admin" {
			return forbidden("Managing members and access stays with the workspace's owner.")
		}
	}
	if body.Scope == "" {
		body.Scope = "own"
	}
	if body.Scope != "none" && !slices.Contains(scopes, body.Scope) {
		return bad(body.Scope + " is not a scope.")
	}
	if err := s.mayManage(r.Context(), org, body.actor); err != nil {
		return err
	}
	saved := role{Key: key, Capabilities: orderCapabilities(body.Capabilities), Scope: body.Scope, SecondStep: body.SecondStep}
	if err := store(s.rules.setRole(r.Context(), org, saved)); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"role": saved, "access_changed": true})
	return nil
}

func (s *server) listMembers(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	members, err := s.rules.members(r.Context(), org)
	if err != nil {
		return store(err)
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members, "teams": teams})
	return nil
}

// isOwner is true for the member who opened the workspace, whose place nobody else can change.
func (s *server) isOwner(ctx context.Context, org, user string) (bool, error) {
	m, _, err := s.rules.membership(ctx, org, user)
	if err != nil {
		return false, store(err)
	}
	return slices.ContainsFunc(m.Roles, func(r string) bool { return slices.Contains(heldRoles, r) }), nil
}

func (s *server) putMember(w http.ResponseWriter, r *http.Request) error {
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
		Roles        []string `json:"roles"`
		Restrictions []string `json:"restrictions"`
		TeamIDs      []string `json:"team_ids"`
		ProjectIDs   []string `json:"project_ids"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if len(body.Roles) == 0 {
		return bad("Give the person at least one role, or remove them.")
	}
	for _, role := range body.Roles {
		if slices.Contains(heldRoles, role) {
			return forbidden("Only the person who opened this workspace is its owner; that role cannot be given.")
		}
		if !roleKey.MatchString(role) {
			return bad(role + " is not a role.")
		}
	}
	body.Roles, body.TeamIDs, body.ProjectIDs = sortedCopy(body.Roles), sortedCopy(body.TeamIDs), sortedCopy(body.ProjectIDs)
	for _, restriction := range body.Restrictions {
		if !validRestriction(restriction) {
			return bad(restriction + " is not something that can be taken away.")
		}
	}
	for _, id := range append(slices.Clone(body.TeamIDs), body.ProjectIDs...) {
		if !validID(id) {
			return bad("Team and project ids are ids.")
		}
	}
	ctx := r.Context()
	a, err := s.placeOf(ctx, org, body.actor)
	if err != nil {
		return err
	}
	existing, err := s.rules.roles(ctx, org)
	if err != nil {
		return store(err)
	}
	for _, wanted := range body.Roles {
		if !slices.ContainsFunc(existing, func(e role) bool { return e.Key == wanted }) {
			return bad(wanted + " is not a role in this workspace.")
		}
	}
	current, isMember, err := s.rules.membership(ctx, org, user)
	if err != nil {
		return store(err)
	}
	if isMember && isHeld(current.Roles) {
		return forbidden("The owner's role cannot be changed.")
	}
	// What kind of change this is decides who may make it: adding someone, moving them, or only taking capabilities away.
	action := actChange
	switch {
	case !isMember:
		action = actInvite
	case slices.Equal(sortedCopy(current.Roles), body.Roles) && slices.Equal(sortedCopy(current.TeamIDs), body.TeamIDs) && slices.Equal(sortedCopy(current.ProjectIDs), body.ProjectIDs):
		action = actRestrict
	}
	var target *membership
	if isMember {
		target = &current
	}
	roleAsked, teamAsked := body.Roles[0], ""
	if slices.Contains(body.Roles, "admin") && !(isMember && slices.Contains(current.Roles, "admin")) {
		roleAsked = "admin" // naming an admin is the owner's alone (D100)
	}
	if len(body.TeamIDs) == 1 {
		teamAsked = body.TeamIDs[0]
	}
	if ok, why := mayAct(a, action, target, roleAsked, teamAsked); !ok {
		return forbidden(why)
	}
	if action != actRestrict {
		teams, err := s.rules.teams(ctx, org)
		if err != nil {
			return store(err)
		}
		if err := checkPlacement(body.Roles, body.TeamIDs, teams, a.NewTeam); err != nil {
			return err
		}
	}
	// A new seat (or a client becoming a worker) needs a free seat on the plan.
	if !isMember || (onlyClient(current.Roles) && !onlyClient(body.Roles)) {
		if err := s.seatsFree(ctx, org, body.Roles, 0); err != nil {
			return err
		}
	}
	if slices.Contains(body.Roles, "admin") && !(isMember && slices.Contains(current.Roles, "admin")) {
		if err := s.adminPlaceFree(ctx, org); err != nil {
			return err
		}
	}
	demoted := isMember && slices.Contains(current.Roles, "manager") && !slices.Contains(body.Roles, "manager")
	if demoted && !a.NewTeam {
		teams, err := s.rules.teams(ctx, org)
		if err != nil {
			return store(err)
		}
		if slices.ContainsFunc(teams, func(t team) bool { return slices.Contains(t.ManagerIDs, user) }) {
			return newError(http.StatusConflict, "conflict", "Give this manager's teams to another manager first.")
		}
	}
	m := membership{UserID: user, Roles: body.Roles, Restrictions: sortedCopy(body.Restrictions), TeamIDs: body.TeamIDs, ProjectIDs: body.ProjectIDs}
	if err := store(s.rules.setMembership(r.Context(), org, m)); err != nil {
		return err
	}
	if demoted {
		// Under the new rules a team may have no lead (D43): one who is no longer a team lead simply leaves its leads.
		if err := s.leaveTeams(ctx, org, user, false); err != nil {
			return err
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": m, "access_changed": true})
	return nil
}

func (s *server) deleteMember(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	user := r.PathValue("user")
	if !validID(user) {
		return bad("That is not a person's id.")
	}
	var body actor
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	var a place
	if body.ActorID == user {
		// Leaving: even a suspended person may go.
		a = place{UserID: user}
		if a.NewTeam, err = s.newTeamRules(r.Context(), org); err != nil {
			return store(err)
		}
	} else if a, err = s.placeOf(r.Context(), org, body); err != nil {
		return err
	}
	target, isMember, err := s.rules.membership(r.Context(), org, user)
	if err != nil {
		return store(err)
	}
	if isMember && isHeld(target.Roles) {
		if body.ActorID == user {
			return forbidden("The owner cannot leave the agency. Hand it to someone else first.")
		}
		return forbidden("The workspace's owner cannot be removed.")
	}
	if !isMember {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "access_changed": false})
		return nil
	}
	// A person may leave an agency at once (D25); anyone else is removed by those who manage them.
	leaving := a.UserID == user
	if !leaving {
		if ok, why := mayAct(a, actRemove, &target, "", ""); !ok {
			return forbidden(why)
		}
	}
	teams, err := s.rules.teams(r.Context(), org)
	if err != nil {
		return store(err)
	}
	if !a.NewTeam && !leaving && slices.ContainsFunc(teams, func(t team) bool { return slices.Contains(t.ManagerIDs, user) }) {
		return newError(http.StatusConflict, "conflict", "Give this manager's teams to another manager first.")
	}
	if err := store(s.rules.removeMember(r.Context(), org, user)); err != nil {
		return err
	}
	// A person who leaves is no longer a lead or deputy anywhere in the workspace.
	if err := s.leaveTeams(r.Context(), org, user, true); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "access_changed": true})
	return nil
}

// putStanding records that a workspace is suspended, or that its plan needs paying. Billing and staff decide that; this
// service only applies it to every grant.
func (s *server) putStanding(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := readJSON(w, r, &raw); err != nil {
		return err
	}
	change, err := readStanding(raw)
	if err != nil {
		return err
	}
	// Billing owns payment and the plan's seats; it may never lift (or set) a staff suspension.
	if callerOf(r) == "billing" {
		change.Suspended = nil
	}
	if err := store(s.rules.setStanding(r.Context(), org, change)); err != nil {
		return err
	}
	log.Printf("INFO workspace %s standing changed by %s", org, callerOf(r))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "access_changed": true})
	return nil
}

// putStaff assigns system admins and testers. The platform owner and cofounder may do this;
// neither permanent role can be changed here.
func (s *server) putStaff(w http.ResponseWriter, r *http.Request) error {
	user := r.PathValue("user")
	if !validID(user) {
		return bad("That is not a person's id.")
	}
	var body struct {
		actor
		Role string `json:"role"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if body.Role != "" && body.Role != "system_admin" && body.Role != "tester" {
		return bad("A staff role is system_admin, tester, or empty to take it away.")
	}
	if disabledRoles[body.Role] {
		return forbidden(roleTitle(body.Role) + " is switched off for now.")
	}
	if !validID(body.ActorID) {
		return bad("Send actor_id: the person asking for this change.")
	}
	actorRole, err := s.rules.staffRole(r.Context(), body.ActorID)
	if err != nil {
		return store(err)
	}
	if actorRole != "owner" && actorRole != "cofounder" {
		return forbidden("Only the platform owner or cofounder manages staff.")
	}
	if s.cfg.staffSecondStep && !body.ActorSecondStep {
		return forbidden("Confirm it's you with your second step first.")
	}
	target, err := s.rules.staffRole(r.Context(), user)
	if err != nil {
		return store(err)
	}
	if target == "owner" || target == "cofounder" {
		return forbidden("The platform owner and cofounder cannot be changed here.")
	}
	if err := store(s.rules.setStaff(r.Context(), user, body.Role)); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "access_changed": true})
	return nil
}

// listStaff returns the platform directory only to private services with read rights.
func (s *server) listStaff(w http.ResponseWriter, r *http.Request) error {
	members, err := s.rules.staffMembers(r.Context())
	if err != nil {
		return store(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"staff": members})
	return nil
}

// ladder names the platform places in words people read.
var ladder = map[string]string{
	"owner":        "Caller Whale owner",
	"cofounder":    "Cofounder",
	"system_admin": "System admin",
	"tester":       "Tester",
	"held":         "Agency owner",
}

type workspaceRoles struct {
	OrgID         string   `json:"org_id"`
	Roles         []string `json:"roles"`
	BusinessOwner bool     `json:"business_owner"`
}

// person answers "who is this person here": their place on the platform, and their roles in each workspace.
func (s *server) person(w http.ResponseWriter, r *http.Request) error {
	user := r.PathValue("user")
	if !validID(user) {
		return bad("That is not a person's id.")
	}
	staff, err := s.rules.staffRole(r.Context(), user)
	if err != nil {
		return store(err)
	}
	orgs, err := s.rules.workspaces(r.Context(), user)
	if err != nil {
		return store(err)
	}
	spaces := []workspaceRoles{}
	for _, org := range orgs {
		m, _, err := s.rules.membership(r.Context(), org, user)
		if err != nil {
			return store(err)
		}
		held := slices.ContainsFunc(m.Roles, func(role string) bool { return slices.Contains(heldRoles, role) })
		spaces = append(spaces, workspaceRoles{OrgID: org, Roles: m.Roles, BusinessOwner: held})
	}
	body := map[string]any{"user_id": user, "platform_role": staff, "workspaces": spaces}
	if label := ladder[staff]; label != "" {
		body["platform_label"] = label
	}
	writeJSON(w, http.StatusOK, body)
	return nil
}
