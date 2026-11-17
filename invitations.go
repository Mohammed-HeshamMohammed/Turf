package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
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
	CreatedAt     int64  `json:"created_at"`
	DeliveryState string `json:"delivery_state"`
	// Where it comes from (D92): the agency and its owner as named when it was sent, and who sent it.
	OrgName     string `json:"org_name"`
	OwnerName   string `json:"owner_name"`
	InviterName string `json:"inviter_name"`
	// Status is pending, blocked (it cannot be accepted until the agency fixes something, StatusReason says what), expired,
	// declined or cancelled. The limits on resending and extending it (D175) come with it.
	Status       string `json:"status"`
	StatusReason string `json:"status_reason,omitempty"`
	ResendsLeft  int    `json:"resends_left"`
	ExtendsLeft  int    `json:"extends_left"`
	NextResendAt int64  `json:"next_resend_at"`

	revokedReason   string
	resent          int
	extended        int
	lastSentAt      int64
	acceptedAt      *int64
	revokedAt       *int64
	inviterDisabled bool
}

// invitationColumns are read for every invitation shown; scanInvitation fills them in the same order.
const invitationColumns = `i.id,i.scope,i.org_id,i.email,i.role,i.team_id,i.invited_by,i.expires_at,i.created_at,i.delivery_state,i.org_name,i.owner_name,coalesce(u.display_name,''),` +
	`i.revoked_reason,i.resent_count,i.extended_count,coalesce(i.last_sent_at,i.created_at),i.accepted_at,i.revoked_at,coalesce(u.disabled_at IS NOT NULL,false)`
const invitationFrom = ` FROM access_invitations i LEFT JOIN users u ON u.id = i.invited_by `

func scanInvitation(row pgx.Row) (invitation, error) {
	var item invitation
	err := row.Scan(&item.ID, &item.Scope, &item.OrgID, &item.Email, &item.Role, &item.TeamID, &item.InvitedBy, &item.ExpiresAt, &item.CreatedAt, &item.DeliveryState, &item.OrgName, &item.OwnerName, &item.InviterName,
		&item.revokedReason, &item.resent, &item.extended, &item.lastSentAt, &item.acceptedAt, &item.revokedAt, &item.inviterDisabled)
	if err == nil {
		item.settle()
	}
	return item, err
}

// maskEmail shows an address by its first letter and its domain, m•••••@gmail.com, so a person signed in with another address
// learns which one the invitation was sent to without the whole of it being shown (D177).
func maskEmail(email string) string {
	at := strings.LastIndexByte(email, '@')
	if at < 1 {
		return "•••••"
	}
	first := []rune(email[:at])[0]
	return string(first) + "•••••" + email[at:]
}

// invitationLink opens the invitation itself rather than the dashboard in general (problem 11).
func (s *server) invitationLink(id string) string {
	return s.cfg.landingURL + "/dashboard?invitation=" + id
}

// invitationDeadline is when an invitation stops working: a platform (staff) invitation after one hour, a workspace invitation after
// the days its agency chose (D41, 7 unless changed). Extending a workspace invitation starts that length again from now.
func invitationDeadline(scope string, from int64, validDays int) int64 {
	if scope == "workspace" {
		return from + int64(validDays)*int64(24*time.Hour/time.Second)
	}
	return from + int64(time.Hour/time.Second)
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
	owner   bool // the agency owner, or an admin (D100: an admin does what the owner does with people and teams)
	manager bool
	staff   bool
	admin   bool
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
			seat.admin = slices.Contains(space.Roles, "admin")
			seat.owner = space.BusinessOwner || seat.admin
			seat.manager = slices.Contains(space.Roles, "manager")
		}
	}
	if !seat.owner && !seat.staff && !seat.manager {
		return workspaceSeat{}, forbidden("Only this workspace's owner, admins and team leads manage its people.")
	}
	// Platform staff confirm themselves with a second step first; people inside a workspace do not need one.
	if seat.staff && !seat.owner && !seat.manager && !c.MFA {
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

// listInvitations is what the agency sees: invitations still waiting, and those that ended in the last week without being
// accepted (declined, cancelled, expired), so the sender sees what happened (D68) and can extend an expired one.
func (s *server) listInvitations(w http.ResponseWriter, r *http.Request, scope, org string) error {
	week := now() - int64(7*24*time.Hour/time.Second)
	rows, err := s.db.Query(r.Context(), `SELECT `+invitationColumns+invitationFrom+`WHERE i.scope=$1 AND i.org_id=$2 AND i.accepted_at IS NULL AND i.revoked_reason<>'replaced'
		AND ((i.revoked_at IS NULL AND i.expires_at>$3) OR i.revoked_at>$3) ORDER BY i.created_at DESC LIMIT 200`, scope, org, week)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []invitation{}
	for rows.Next() {
		item, err := scanInvitation(rows)
		if err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	s.markBlocked(r, items)
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
	settings := invitationSettings{ValidDays: 7, DailyCap: 50}
	if scope == "workspace" {
		if settings, err = s.invitationSettings(r.Context(), org); err != nil {
			return err
		}
		// A person who blocked this agency is never invited by it again (D93).
		var blocked bool
		if err := s.db.QueryRow(r.Context(), "SELECT EXISTS (SELECT 1 FROM invitation_blocks WHERE email=$1 AND org_id=$2)", email, org).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return forbidden("This person has chosen not to receive invitations from this agency.")
		}
		// At most so many new invitations a day (D176); staff can raise it for a large agency.
		var today int
		if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM access_invitations WHERE scope='workspace' AND org_id=$1 AND created_at>$2", org, now()-int64(24*time.Hour/time.Second)).Scan(&today); err != nil {
			return err
		}
		if today >= settings.DailyCap {
			return newError(http.StatusTooManyRequests, "daily_cap", fmt.Sprintf("This agency has sent %d invitations in the last 24 hours, its daily limit. Try again later, or ask Caller Whale to raise it.", settings.DailyCap))
		}
	}
	role := strings.TrimSpace(body.Role)
	if scope == "platform" {
		if role != "tester" { // system admin is switched off for now
			return bad("Choose tester.")
		}
	} else {
		if role == "owner" || role == "solo" || role == "" {
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
	// The invitation names where it comes from (D92). The CRM keeps the agency's name in authz; a workspace not named there yet
	// is shown as its owner's.
	orgName, ownerName := "Caller Whale", ""
	if scope == "workspace" {
		var about struct {
			OwnerID string `json:"owner_id"`
			Name    string `json:"name"`
		}
		// Not found (or an authz from before names were kept): the invitation goes out without the name rather than not at all.
		if status, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org, nil, &about); err != nil && status != http.StatusNotFound {
			return err
		}
		if about.OwnerID != "" {
			if err := s.db.QueryRow(r.Context(), "SELECT display_name FROM users WHERE id=$1", about.OwnerID).Scan(&ownerName); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		orgName = strings.TrimSpace(about.Name)
		if orgName == "" && ownerName != "" {
			orgName = ownerName + "'s workspace"
		}
	}
	id := uuid.NewString()
	createdAt := now()
	expires := invitationDeadline(scope, createdAt, settings.ValidDays)
	if _, err := s.db.Exec(r.Context(), "UPDATE access_invitations SET revoked_at=$1, revoked_reason='replaced' WHERE scope=$2 AND org_id=$3 AND email=$4 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=$1", now(), scope, org, email); err != nil {
		return err
	}
	_, err = s.db.Exec(r.Context(), `INSERT INTO access_invitations (id,scope,org_id,email,role,team_id,invited_by,created_at,expires_at,org_name,owner_name,last_sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8)`, id, scope, org, email, role, strings.TrimSpace(body.TeamID), c.Sub, createdAt, expires, orgName, ownerName)
	if err != nil {
		if strings.Contains(err.Error(), "access_invitations_open") {
			return conflict("An invitation is already pending for this email.")
		}
		return err
	}
	state, err := s.emailInvitation(r.Context(), id, c.Sub, email, orgName, role, scope, settings.ValidDays)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "delivery_state": state, "expires_at": expires, "link": s.invitationLink(id)})
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
		// Nothing about the invitation is shown before the address is confirmed, only that one waits (problem 7).
		var waiting bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM access_invitations WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2)`, strings.ToLower(c.Email), now()).Scan(&waiting); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"invitations": []invitation{}, "waiting": waiting, "email_verified": false})
		return nil
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+invitationColumns+invitationFrom+`WHERE i.email=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>$2 ORDER BY i.created_at DESC LIMIT 50`, strings.ToLower(c.Email), now())
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []invitation{}
	for rows.Next() {
		item, err := scanInvitation(rows)
		if err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	// A blocked invitation says so before the person tries to accept it (problems 12, 13).
	s.markBlocked(r, items)
	writeJSON(w, http.StatusOK, map[string]any{"invitations": items, "waiting": len(items) > 0, "email_verified": true})
	return nil
}

// readMyInvitation finds one invitation for the signed-in person and says, in words they can act on, why it cannot be used:
// sent to another address (shown masked), address not yet confirmed, cancelled, already accepted, or ended.
func (s *server) readMyInvitation(r *http.Request, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, c claims, id string, lock bool) (invitation, error) {
	if _, err := uuid.Parse(id); err != nil {
		return invitation{}, bad("Choose a valid invitation.")
	}
	query := `SELECT ` + invitationColumns + invitationFrom + `WHERE i.id=$1`
	if lock {
		query += " FOR UPDATE OF i"
	}
	item, err := scanInvitation(q.QueryRow(r.Context(), query, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return invitation{}, newError(http.StatusNotFound, "not_found", "Invitation not found.")
	}
	if err != nil {
		return invitation{}, err
	}
	if item.Email != strings.ToLower(c.Email) {
		return invitation{}, newError(http.StatusForbidden, "other_address", "This invitation was sent to "+maskEmail(item.Email)+". Sign in with that address to accept it.")
	}
	if !c.EmailVerified {
		return invitation{}, newError(http.StatusForbidden, "email_unverified", "An invitation is waiting. Confirm your email to see it.")
	}
	switch item.Status {
	case "accepted":
		return invitation{}, newError(http.StatusConflict, "accepted", "You already accepted this invitation.")
	case "declined":
		if item.revokedReason == "blocked_agency" {
			return invitation{}, newError(http.StatusGone, "declined", "You blocked this agency, so this invitation was declined.")
		}
		return invitation{}, newError(http.StatusGone, "declined", "You declined this invitation.")
	case "cancelled":
		// Withdrawn, its inviter removed, or replaced: the person is told it was cancelled and nothing more (D174).
		return invitation{}, newError(http.StatusGone, "cancelled", "This invitation was cancelled.")
	case "expired":
		return invitation{}, newError(http.StatusGone, "expired", "This invitation has ended. Ask whoever invited you to send a new one.")
	}
	return item, nil
}

// myInvitation is the invitation an email link opens (GET /v1/me/invitations/{id}).
func (s *server) myInvitation(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	item, err := s.readMyInvitation(r, s.db, c, r.PathValue("id"), false)
	if err != nil {
		return err
	}
	items := []invitation{item}
	s.markBlocked(r, items)
	writeJSON(w, http.StatusOK, map[string]any{"invitation": items[0]})
	return nil
}

// reportInvitation sends an invitation to Caller Whale staff as suspicious (D92). Only the person it was sent to can report it,
// once; reporting does not decline it.
func (s *server) reportInvitation(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return bad("Choose a valid invitation.")
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if r.ContentLength != 0 {
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) > 1000 {
		return bad("Keep the reason under 1000 characters.")
	}
	var email string
	err = s.db.QueryRow(r.Context(), "SELECT email FROM access_invitations WHERE id=$1", id).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && email != strings.ToLower(c.Email)) {
		return newError(http.StatusNotFound, "not_found", "Invitation not found.")
	}
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `INSERT INTO invitation_reports (invitation_id,reporter_id,reason,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (invitation_id,reporter_id) DO NOTHING`, id, c.Sub, reason, now()); err != nil {
		return err
	}
	log.Printf("INFO invitation %s was reported to staff", id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// invitationReports lists reported invitations for Caller Whale staff, newest first.
func (s *server) invitationReports(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT p.invitation_id,p.reason,p.created_at,i.org_id,i.org_name,i.owner_name,coalesce(u.display_name,''),i.invited_by,i.created_at FROM invitation_reports p JOIN access_invitations i ON i.id=p.invitation_id LEFT JOIN users u ON u.id=i.invited_by ORDER BY p.created_at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type report struct {
		InvitationID string `json:"invitation_id"`
		Reason       string `json:"reason"`
		ReportedAt   int64  `json:"reported_at"`
		OrgID        string `json:"org_id"`
		OrgName      string `json:"org_name"`
		OwnerName    string `json:"owner_name"`
		InviterName  string `json:"inviter_name"`
		InviterID    string `json:"inviter_id"`
		SentAt       int64  `json:"sent_at"`
	}
	items := []report{}
	for rows.Next() {
		var item report
		if err := rows.Scan(&item.InvitationID, &item.Reason, &item.ReportedAt, &item.OrgID, &item.OrgName, &item.OwnerName, &item.InviterName, &item.InviterID, &item.SentAt); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": items})
	return nil
}

func (s *server) acceptInvitation(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	item, err := s.readMyInvitation(r, tx, c, id, true)
	if err != nil {
		return err
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
	// org_id lets the app open the agency just joined rather than the one used last (problem 17).
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scope": item.Scope, "org_id": item.OrgID})
	return nil
}

func (s *server) revokeInvitation(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.person(r); err != nil {
		return err
	}
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
	_, err = s.db.Exec(r.Context(), "UPDATE access_invitations SET revoked_at=$1, revoked_reason='withdrawn' WHERE id=$2 AND accepted_at IS NULL AND revoked_at IS NULL", now(), id)
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

// team is one team of a workspace with its leads and deputies, as authz keeps it. ManagerID is the first lead.
type team struct {
	TeamID     string   `json:"team_id"`
	Name       string   `json:"name"`
	ManagerID  string   `json:"manager_id"`
	ManagerIDs []string `json:"manager_ids"`
	DeputyIDs  []string `json:"deputy_ids"`
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
		if !role.Assignable || seen[role.Key] {
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
		// A team lead sees themself and the people of the teams they lead (any one of their teams, D97).
		managed := []string{}
		for _, t := range listed.Teams {
			if slices.Contains(t.ManagerIDs, seat.c.Sub) || t.ManagerID == seat.c.Sub {
				managed = append(managed, t.TeamID)
			}
		}
		shown = []member{}
		for _, m := range listed.Members {
			if m.UserID == seat.c.Sub || slices.ContainsFunc(m.TeamIDs, func(t string) bool { return slices.Contains(managed, t) }) {
				shown = append(shown, m)
			}
		}
	}
	for i := range shown {
		_ = s.db.QueryRow(r.Context(), "SELECT email,display_name FROM users WHERE id=$1", shown[i].UserID).Scan(&shown[i].Email, &shown[i].Name)
	}
	// The switches on for this workspace (D104), so the screens offer several leads, deputies and admins only when they work.
	var about struct {
		Features []string `json:"features"`
	}
	if status, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org, nil, &about); err != nil && status != http.StatusNotFound {
		return err
	}
	if about.Features == nil {
		about.Features = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": shown, "teams": listed.Teams, "features": about.Features,
		"you": map[string]bool{"owner": seat.owner, "admin": seat.admin, "manager": seat.manager, "staff": seat.staff}})
	return nil
}

// putTeamDeputies names a team's deputy leads (D43, D62): its leads, an admin or the owner (authz decides).
func (s *server) putTeamDeputies(w http.ResponseWriter, r *http.Request) error {
	org, id := r.PathValue("org"), r.PathValue("team")
	seat, err := s.workspaceSeat(r, org)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(id); err != nil {
		return bad("Choose a valid team.")
	}
	var body struct {
		DeputyIDs []string `json:"deputy_ids"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if body.DeputyIDs == nil {
		body.DeputyIDs = []string{}
	}
	var saved struct {
		Team team `json:"team"`
	}
	change := map[string]any{"actor_id": seat.c.Sub, "actor_second_step": seat.c.MFA, "deputy_ids": body.DeputyIDs}
	if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/teams/"+id+"/deputies", change, &saved); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"team": saved.Team})
	return nil
}

// putWorkspaceFeature turns a workspace's switch on or off (D104): Caller Whale's owner or cofounder, with a second step.
func (s *server) putWorkspaceFeature(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, true); err != nil {
		return err
	}
	org, name := r.PathValue("org"), r.PathValue("name")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	var body struct {
		On bool `json:"on"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/features/"+name, map[string]any{"on": body.On}, nil); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "on": body.On})
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
	s.cancelInvitationsBy(r.Context(), org, user)
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
		if !restore {
			s.cancelInvitationsBy(r.Context(), org, user)
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
		Name       string    `json:"name"`
		ManagerID  string    `json:"manager_id"`
		ManagerIDs *[]string `json:"manager_ids"` // several equal leads under the new team rules (D43)
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	var saved struct {
		Team team `json:"team"`
	}
	change := map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA, "name": body.Name, "manager_id": strings.TrimSpace(body.ManagerID)}
	if body.ManagerIDs != nil {
		change["manager_ids"] = *body.ManagerIDs
	}
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
		if role == "owner" || role == "solo" || seen[role] {
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
	// A team lead who is no longer one cannot invite, so what they sent is cancelled (D7).
	if slices.Contains(current.Roles, "manager") && !slices.Contains(body.Roles, "manager") {
		s.cancelInvitationsBy(r.Context(), org, user)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// roleWords is a role as people read it in an email.
func roleWords(role string) string {
	switch role {
	case "owner":
		return "Agency owner"
	case "solo":
		return "Solo operator"
	case "manager":
		return "Team lead"
	case "admin":
		return "Admin"
	case "researcher":
		return "Data researcher"
	case "caller":
		return "Caller"
	case "closer":
		return "Acquisitions / closer"
	case "client":
		return "Client"
	case "tester":
		return "Tester"
	}
	return strings.ReplaceAll(role, "_", " ")
}
