package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type invitation struct {
	ID            string `json:"id"`
	Scope         string `json:"scope"`
	OrgID         string `json:"org_id"`
	Email         string `json:"email"`
	Role          string `json:"role"`
	TeamID        string `json:"team_id"`
	InvitedBy     string `json:"-"`
	ExpiresAt     int64  `json:"expires_at"`
	CreatedAt     int64  `json:"-"`
	DeliveryState string `json:"delivery_state"`
}

// invitationDeadline is when an invitation stops working: a platform (staff) invitation after one hour, a workspace invitation after
// 72 hours, long enough for a new caller to find it when email delivery is off and they are told by phone or chat.
func invitationDeadline(scope string, createdAt int64) int64 {
	if scope == "workspace" {
		return createdAt + int64(72*time.Hour/time.Second)
	}
	return createdAt + int64(time.Hour/time.Second)
}

func (s *server) authzCall(r *http.Request, method, path string, body any, out any) (int, error) {
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return 0, errAccessUnavailable
	}
	var raw io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		raw = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(r.Context(), method, s.cfg.authzURL+path, raw)
	if err != nil {
		return 0, errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.authzToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return 0, errAccessUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 && res.StatusCode < 500 && res.StatusCode != http.StatusUnauthorized {
		// authz says why in words people read (a seat limit, a manager acting outside their team); pass that on.
		var refusal struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&refusal)
		if refusal.Error == "" {
			refusal.Error, refusal.Code = "You cannot change this access.", "forbidden"
		}
		if refusal.Code == "" || refusal.Code == "not_allowed" {
			refusal.Code = "forbidden"
		}
		return res.StatusCode, newError(res.StatusCode, refusal.Code, refusal.Error)
	}
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, newError(http.StatusServiceUnavailable, "access_unavailable", "Membership information is unavailable right now.")
	}
	if out != nil && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out) != nil {
		return 0, errAccessUnavailable
	}
	return res.StatusCode, nil
}

// workspaceSeat is how the person asking stands in a workspace: its owner (agency owner or solo operator), a team manager there,
// or the platform owner or cofounder. authz applies the exact rule to every change; this only keeps everyone else out.
type workspaceSeat struct {
	c       claims
	owner   bool
	manager bool
	staff   bool
}

func (s *server) workspaceSeat(r *http.Request, org string) (workspaceSeat, error) {
	if _, err := uuid.Parse(org); err != nil {
		return workspaceSeat{}, bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return workspaceSeat{}, err
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return workspaceSeat{}, errAccessUnavailable
	}
	seat := workspaceSeat{c: c, staff: profile.PlatformRole == "owner" || profile.PlatformRole == "cofounder"}
	for _, space := range profile.Workspaces {
		if space.OrgID == org {
			seat.owner = space.BusinessOwner
			seat.manager = slices.Contains(space.Roles, "manager")
		}
	}
	if !seat.owner && !seat.staff && !seat.manager {
		return workspaceSeat{}, forbidden("Only this workspace's owner and team managers manage its people.")
	}
	// Owners and staff move money and access: they confirm themselves with a second step first.
	if (seat.owner || seat.staff) && !c.MFA {
		return workspaceSeat{}, newError(http.StatusForbidden, "mfa_required", "Confirm your identity with a second step first.")
	}
	return seat, nil
}

// workspaceActor is the workspace's owner or platform staff: the people who invite, place and remove members.
func (s *server) workspaceActor(r *http.Request, org string) (claims, error) {
	seat, err := s.workspaceSeat(r, org)
	if err != nil {
		return claims{}, err
	}
	if !seat.owner && !seat.staff {
		return claims{}, forbidden("Only this workspace's owner can do this.")
	}
	return seat.c, nil
}

func (s *server) listInvitations(w http.ResponseWriter, r *http.Request, scope, org string) error {
	rows, err := s.db.Query(r.Context(), `SELECT id,scope,org_id,email,role,team_id,invited_by,expires_at,delivery_state FROM access_invitations WHERE scope=$1 AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$3 ORDER BY created_at DESC LIMIT 200`, scope, org, now())
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []invitation{}
	for rows.Next() {
		var item invitation
		if err := rows.Scan(&item.ID, &item.Scope, &item.OrgID, &item.Email, &item.Role, &item.TeamID, &item.InvitedBy, &item.ExpiresAt, &item.DeliveryState); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": items})
	return nil
}

func (s *server) listPlatformInvitations(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	return s.listInvitations(w, r, "platform", "")
}
func (s *server) listWorkspaceInvitations(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceActor(r, org); err != nil {
		return err
	}
	return s.listInvitations(w, r, "workspace", org)
}

func (s *server) createInvitation(w http.ResponseWriter, r *http.Request, scope, org string, c claims) error {
	var body struct {
		Email  string `json:"email"`
		Role   string `json:"role"`
		TeamID string `json:"team_id"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	email, err := normalEmail(body.Email)
	if err != nil {
		return err
	}
	role := strings.TrimSpace(body.Role)
	if scope == "platform" {
		if role != "tester" { // system admin is switched off for now
			return bad("Choose tester.")
		}
	} else {
		if role == "owner" || role == "solo" || role == "admin" || role == "" {
			return bad("Choose a workspace member role.")
		}
		var listed struct {
			Roles []struct {
				Key string `json:"key"`
			} `json:"roles"`
		}
		if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/roles", nil, &listed); err != nil {
			return err
		}
		found := false
		for _, item := range listed.Roles {
			if item.Key == role {
				found = true
				break
			}
		}
		if !found {
			return bad("That role is not available in this workspace.")
		}
		if body.TeamID != "" {
			if _, err := uuid.Parse(body.TeamID); err != nil {
				return bad("Choose a team of this workspace.")
			}
		}
		// The team tree and the plan's seats: authz says whether this person may invite this role into this team, counting the
		// invitations already waiting as taken seats.
		var pending int
		clientOnly := role == "client"
		if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM access_invitations WHERE scope='workspace' AND org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2 AND (role='client') = $3`, org, now(), clientOnly).Scan(&pending); err != nil {
			return err
		}
		var verdict struct {
			Allowed bool   `json:"allowed"`
			Code    string `json:"code"`
			Reason  string `json:"reason"`
		}
		check := map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA, "action": "invite", "role": role, "team_id": body.TeamID, "pending": pending}
		if _, err := s.authzCall(r, http.MethodPost, "/v1/orgs/"+org+"/relations/check", check, &verdict); err != nil {
			return err
		}
		if !verdict.Allowed {
			status := http.StatusForbidden
			switch verdict.Code {
			case "seats_full", "clients_full", "conflict":
				status = http.StatusConflict
			case "bad_request":
				status = http.StatusBadRequest
			}
			return newError(status, verdict.Code, verdict.Reason)
		}
	}
	var existing string
	err = s.db.QueryRow(r.Context(), "SELECT id FROM users WHERE email=$1 AND disabled_at IS NULL", email).Scan(&existing)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if existing == c.Sub {
		return bad("You cannot invite yourself.")
	}
	if existing != "" {
		if scope == "platform" {
			profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, existing)
			if err != nil {
				return errAccessUnavailable
			}
			if profile.PlatformRole != "" {
				return conflict("This person already has a platform role. Change it in the staff directory.")
			}
		}
		if scope == "workspace" {
			profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, existing)
			if err != nil {
				return errAccessUnavailable
			}
			for _, space := range profile.Workspaces {
				if space.OrgID == org {
					return conflict("This person is already a workspace member. Change their role in the member list.")
				}
			}
		}
	}
	id := uuid.NewString()
	createdAt := now()
	expires := invitationDeadline(scope, createdAt)
	if _, err := s.db.Exec(r.Context(), "UPDATE access_invitations SET revoked_at=$1 WHERE scope=$2 AND org_id=$3 AND email=$4 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=$1", now(), scope, org, email); err != nil {
		return err
	}
	_, err = s.db.Exec(r.Context(), `INSERT INTO access_invitations (id,scope,org_id,email,role,team_id,invited_by,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, scope, org, email, role, strings.TrimSpace(body.TeamID), c.Sub, createdAt, expires)
	if err != nil {
		if strings.Contains(err.Error(), "access_invitations_open") {
			return conflict("An invitation is already pending for this email.")
		}
		return err
	}
	state := "not_configured"
	if s.mail != nil {
		var inviter string
		if err := s.db.QueryRow(r.Context(), "SELECT display_name FROM users WHERE id=$1", c.Sub).Scan(&inviter); err != nil {
			return err
		}
		link := s.cfg.landingURL + "/dashboard"
		if err := s.mail.sendInvitation(r.Context(), email, inviter, role, link); err == nil {
			state = "sent"
		} else {
			state = "failed"
		}
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE access_invitations SET delivery_state=$1 WHERE id=$2", state, id); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "delivery_state": state, "expires_at": expires})
	return nil
}

func (s *server) invitePlatform(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerActor(r)
	if err != nil {
		return err
	}
	return s.createInvitation(w, r, "platform", "", c)
}
func (s *server) inviteWorkspace(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	c, err := s.workspaceActor(r, org)
	if err != nil {
		return err
	}
	return s.createInvitation(w, r, "workspace", org, c)
}

func (s *server) myInvitations(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if !c.EmailVerified {
		writeJSON(w, http.StatusOK, map[string]any{"invitations": []invitation{}})
		return nil
	}
	rows, err := s.db.Query(r.Context(), `SELECT id,scope,org_id,email,role,invited_by,expires_at,delivery_state FROM access_invitations WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC LIMIT 50`, strings.ToLower(c.Email), now())
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []invitation{}
	for rows.Next() {
		var item invitation
		if err := rows.Scan(&item.ID, &item.Scope, &item.OrgID, &item.Email, &item.Role, &item.InvitedBy, &item.ExpiresAt, &item.DeliveryState); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": items})
	return nil
}

func (s *server) acceptInvitation(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if !c.EmailVerified {
		return forbidden("Confirm your email address before accepting an invitation.")
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return bad("Choose a valid invitation.")
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var item invitation
	err = tx.QueryRow(r.Context(), `SELECT id,scope,org_id,email,role,team_id,invited_by,expires_at,delivery_state,created_at FROM access_invitations WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`, id).Scan(&item.ID, &item.Scope, &item.OrgID, &item.Email, &item.Role, &item.TeamID, &item.InvitedBy, &item.ExpiresAt, &item.DeliveryState, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return newError(http.StatusNotFound, "not_found", "Invitation not found.")
	}
	if err != nil {
		return err
	}
	if item.Email != strings.ToLower(c.Email) || item.ExpiresAt <= now() || invitationDeadline(item.Scope, item.CreatedAt) <= now() {
		return forbidden("This invitation is unavailable for this account.")
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return errAccessUnavailable
	}
	alreadyApplied := false
	if item.Scope == "platform" && profile.PlatformRole != "" {
		if profile.PlatformRole != item.Role {
			return conflict("You already have a different platform role.")
		}
		alreadyApplied = true
	}
	if item.Scope == "workspace" {
		for _, space := range profile.Workspaces {
			if space.OrgID == item.OrgID {
				if len(space.Roles) != 1 || !slices.Contains(space.Roles, item.Role) {
					return conflict("You are already a member of this workspace with a different role.")
				}
				alreadyApplied = true
			}
		}
	}
	actor := map[string]any{"actor_id": item.InvitedBy, "actor_second_step": true}
	path := "/v1/staff/" + c.Sub
	if item.Scope == "platform" {
		actor["role"] = item.Role
	} else {
		path = "/v1/orgs/" + item.OrgID + "/members/" + c.Sub
		actor["roles"] = []string{item.Role}
		if item.TeamID != "" {
			actor["team_ids"] = []string{item.TeamID}
		}
	}
	if !alreadyApplied {
		if _, err := s.authzCall(r, http.MethodPut, path, actor, nil); err != nil {
			return err
		}
	}
	_, err = tx.Exec(r.Context(), "UPDATE access_invitations SET accepted_at=$1 WHERE id=$2", now(), id)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (s *server) revokeInvitation(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return bad("Choose a valid invitation.")
	}
	var scope, org string
	err := s.db.QueryRow(r.Context(), "SELECT scope,org_id FROM access_invitations WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL", id).Scan(&scope, &org)
	if errors.Is(err, pgx.ErrNoRows) {
		return newError(http.StatusNotFound, "not_found", "Invitation not found.")
	}
	if err != nil {
		return err
	}
	if scope == "platform" {
		if _, err := s.ownerActor(r); err != nil {
			return err
		}
	} else {
		if _, err := s.workspaceActor(r, org); err != nil {
			return err
		}
	}
	_, err = s.db.Exec(r.Context(), "UPDATE access_invitations SET revoked_at=$1 WHERE id=$2 AND accepted_at IS NULL AND revoked_at IS NULL", now(), id)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

type member struct {
	UserID          string   `json:"user_id"`
	Roles           []string `json:"roles"`
	Restrictions    []string `json:"restrictions"`
	TeamIDs         []string `json:"team_ids"`
	ProjectIDs      []string `json:"project_ids"`
	SuspendedAt     *int64   `json:"suspended_at,omitempty"`
	SuspendedReason string   `json:"suspended_reason,omitempty"`
	Email           string   `json:"email,omitempty"`
	Name            string   `json:"name,omitempty"`
}

// team is one team of a workspace and its manager, as authz keeps it.
type team struct {
	TeamID    string `json:"team_id"`
	Name      string `json:"name"`
	ManagerID string `json:"manager_id"`
}

func (s *server) workspaceRoles(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceActor(r, org); err != nil {
		return err
	}
	var listed struct {
		Roles []workspaceRole `json:"roles"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/roles", nil, &listed); err != nil {
		return err
	}
	// "roles" stays the plain keys (older screens read it); "catalog" carries the same roles with their names, once each.
	keys, catalog := []string{}, []workspaceRole{}
	seen := map[string]bool{}
	for _, role := range listed.Roles {
		if !role.Assignable || role.Key == "admin" || seen[role.Key] {
			continue
		}
		seen[role.Key] = true
		keys = append(keys, role.Key)
		catalog = append(catalog, role)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": keys, "catalog": catalog})
	return nil
}

// workspaceRole is one role of the authorization service's catalog: its key, the words people read, whether it is a standard role
// or this workspace's own, and whether it can be given to someone (the agency owner's role cannot).
type workspaceRole struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Source     string `json:"source"`
	Scope      string `json:"scope"`
	SecondStep bool   `json:"second_step"`
	Assignable bool   `json:"assignable"`
}

// roleCatalog is every role there is, with nothing twice: the standard workspace roles, and the platform staff roles in their own
// group. It needs no workspace, so any signed-in person's screens can label roles the same way.
func (s *server) roleCatalog(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.person(r); err != nil {
		return err
	}
	var listed struct {
		Workspace []workspaceRole `json:"workspace"`
		Platform  []struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		} `json:"platform"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/roles", nil, &listed); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": listed.Workspace, "platform": listed.Platform})
	return nil
}

func (s *server) workspaceMembers(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	seat, err := s.workspaceSeat(r, org)
	if err != nil {
		return err
	}
	var listed struct {
		Members []member `json:"members"`
		Teams   []team   `json:"teams"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/members", nil, &listed); err != nil {
		return err
	}
	if listed.Teams == nil {
		listed.Teams = []team{}
	}
	shown := listed.Members
	if !seat.owner && !seat.staff {
		// A team manager sees themself and the callers and closers of the teams they run.
		managed := []string{}
		for _, t := range listed.Teams {
			if t.ManagerID == seat.c.Sub {
				managed = append(managed, t.TeamID)
			}
		}
		shown = []member{}
		for _, m := range listed.Members {
			if m.UserID == seat.c.Sub || (len(m.TeamIDs) == 1 && slices.Contains(managed, m.TeamIDs[0])) {
				shown = append(shown, m)
			}
		}
	}
	for i := range shown {
		_ = s.db.QueryRow(r.Context(), "SELECT email,display_name FROM users WHERE id=$1", shown[i].UserID).Scan(&shown[i].Email, &shown[i].Name)
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": shown, "teams": listed.Teams, "you": map[string]bool{"owner": seat.owner, "manager": seat.manager, "staff": seat.staff}})
	return nil
}

// removeWorkspaceMember takes someone out of the workspace (the owner, or platform staff). authz refuses the owner and a manager
// who still runs a team.
func (s *server) removeWorkspaceMember(w http.ResponseWriter, r *http.Request) error {
	org, user := r.PathValue("org"), r.PathValue("user")
	c, err := s.workspaceActor(r, org)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(user); err != nil {
		return bad("Choose a valid member.")
	}
	if _, err := s.authzCall(r, http.MethodDelete, "/v1/orgs/"+org+"/members/"+user, map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA}, nil); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// suspendWorkspaceMember suspends or restores someone: the owner for anyone, a team manager for their own callers and closers
// (authz decides which).
func (s *server) suspendWorkspaceMember(restore bool) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		org, user := r.PathValue("org"), r.PathValue("user")
		seat, err := s.workspaceSeat(r, org)
		if err != nil {
			return err
		}
		if _, err := uuid.Parse(user); err != nil {
			return bad("Choose a valid member.")
		}
		var body struct {
			Reason string `json:"reason"`
		}
		if r.ContentLength != 0 {
			if err := readJSON(w, r, &body); err != nil {
				return err
			}
		}
		path := "/v1/orgs/" + org + "/members/" + user + "/suspend"
		if restore {
			path = "/v1/orgs/" + org + "/members/" + user + "/restore"
		}
		if _, err := s.authzCall(r, http.MethodPost, path, map[string]any{"actor_id": seat.c.Sub, "actor_second_step": seat.c.MFA, "reason": strings.TrimSpace(body.Reason)}, nil); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "suspended": !restore})
		return nil
	}
}

func (s *server) workspaceTeams(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceSeat(r, org); err != nil {
		return err
	}
	var listed struct {
		Teams []team `json:"teams"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/teams", nil, &listed); err != nil {
		return err
	}
	if listed.Teams == nil {
		listed.Teams = []team{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": listed.Teams})
	return nil
}

// putWorkspaceTeam creates or renames a team and names its manager (the owner, or platform staff).
func (s *server) putWorkspaceTeam(w http.ResponseWriter, r *http.Request) error {
	org, id := r.PathValue("org"), r.PathValue("team")
	c, err := s.workspaceActor(r, org)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(id); err != nil {
		return bad("Choose a valid team.")
	}
	var body struct {
		Name      string `json:"name"`
		ManagerID string `json:"manager_id"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	var saved struct {
		Team team `json:"team"`
	}
	change := map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA, "name": body.Name, "manager_id": strings.TrimSpace(body.ManagerID)}
	if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/teams/"+id, change, &saved); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"team": saved.Team})
	return nil
}

func (s *server) deleteWorkspaceTeam(w http.ResponseWriter, r *http.Request) error {
	org, id := r.PathValue("org"), r.PathValue("team")
	c, err := s.workspaceActor(r, org)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(id); err != nil {
		return bad("Choose a valid team.")
	}
	if _, err := s.authzCall(r, http.MethodDelete, "/v1/orgs/"+org+"/teams/"+id, map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA}, nil); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
func (s *server) changeWorkspaceMember(w http.ResponseWriter, r *http.Request) error {
	org, user := r.PathValue("org"), r.PathValue("user")
	c, err := s.workspaceActor(r, org)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(user); err != nil {
		return bad("Choose a valid member.")
	}
	var body struct {
		Roles   []string  `json:"roles"`
		TeamIDs *[]string `json:"team_ids"` // left out: the person keeps their team
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if len(body.Roles) == 0 || len(body.Roles) > 8 {
		return bad("Choose one to eight member roles.")
	}
	seen := map[string]bool{}
	for _, role := range body.Roles {
		if role == "owner" || role == "solo" || role == "admin" || seen[role] {
			return bad("Choose unique editable member roles.")
		}
		seen[role] = true
	}
	var listed struct {
		Members []member `json:"members"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/members", nil, &listed); err != nil {
		return err
	}
	var current *member
	for i := range listed.Members {
		if listed.Members[i].UserID == user {
			current = &listed.Members[i]
			break
		}
	}
	if current == nil {
		return newError(http.StatusNotFound, "not_found", "Member not found.")
	}
	if current.Roles != nil {
		for _, role := range current.Roles {
			if role == "owner" || role == "solo" {
				return forbidden("The workspace owner's role is permanent.")
			}
		}
	}
	teams := current.TeamIDs
	if body.TeamIDs != nil {
		teams = *body.TeamIDs
	}
	change := map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA, "roles": body.Roles, "restrictions": current.Restrictions, "team_ids": teams, "project_ids": current.ProjectIDs}
	if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/members/"+user, change, nil); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
