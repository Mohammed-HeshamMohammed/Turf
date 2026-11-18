package main

// What happens to an invitation after it is sent (build step 2): its status, held seats and the "Blocked" state, resending and
// extending it, the invited person declining it or blocking the agency, the agency's own validity and daily limit, and
// cancelling an inviter's invitations when they lose the right to invite.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxResends    = 3              // D175
	maxExtends    = 2              // D175
	resendSpacing = int64(60 * 60) // at most once an hour
)

// settle works out an invitation's status and what can still be done with it from what is stored.
func (item *invitation) settle() {
	switch {
	case item.acceptedAt != nil:
		item.Status = "accepted"
	case item.revokedAt != nil && (item.revokedReason == "declined" || item.revokedReason == "blocked_agency"):
		item.Status = "declined"
	case item.revokedAt != nil:
		item.Status = "cancelled"
		if item.revokedReason == "inviter_removed" {
			item.StatusReason = "The person who sent it can no longer invite."
		}
	case item.inviterDisabled:
		// A second guard (D7): an inviter whose account is closed cannot let anyone in.
		item.Status, item.StatusReason = "cancelled", "The person who sent it can no longer invite."
	case item.ExpiresAt <= now() || (item.Scope == "platform" && invitationDeadline("platform", item.CreatedAt, 0) <= now()):
		item.Status = "expired"
	default:
		item.Status = "pending"
	}
	open := item.Status == "pending" || item.Status == "expired"
	if open && item.Scope == "workspace" {
		item.ResendsLeft = max(0, maxResends-item.resent)
		item.ExtendsLeft = max(0, maxExtends-item.extended)
		item.NextResendAt = item.lastSentAt + resendSpacing
	}
	if item.Status == "expired" {
		item.ResendsLeft = 0 // an ended invitation is extended first, then resent
	}
}

// markBlocked asks authz, for each waiting workspace invitation, whether accepting it would work now: the same question acceptance
// asks, as the inviter, counting the invitations sent before it as holding their seats. One that would fail is shown as Blocked
// with the reason (a team that is gone, no free seat after the plan was lowered), so nobody meets it at the last step. When authz
// cannot answer, nothing is marked.
func (s *server) markBlocked(r *http.Request, items []invitation) {
	asked := 0
	for i := range items {
		item := &items[i]
		if item.Scope != "workspace" || item.Status != "pending" || asked >= 50 {
			continue
		}
		asked++
		var earlier int
		if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM access_invitations WHERE scope='workspace' AND org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2
			AND (role='client') = $3 AND (created_at < $4 OR (created_at = $4 AND id < $5))`, item.OrgID, now(), item.Role == "client", item.CreatedAt, item.ID).Scan(&earlier); err != nil {
			return
		}
		var verdict struct {
			Allowed bool   `json:"allowed"`
			Reason  string `json:"reason"`
		}
		check := invitationCheck(item.InvitedBy, true, *item, earlier)
		if _, err := s.authzCall(r, http.MethodPost, "/v1/orgs/"+item.OrgID+"/relations/check", check, &verdict); err != nil {
			return
		}
		if !verdict.Allowed {
			item.Status, item.StatusReason = "blocked", verdict.Reason
		}
	}
}

type invitationSettings struct {
	ValidDays int `json:"valid_days"`
	DailyCap  int `json:"daily_cap"`
}

func (s *server) invitationSettings(ctx context.Context, org string) (invitationSettings, error) {
	settings := invitationSettings{ValidDays: 7, DailyCap: 50}
	err := s.db.QueryRow(ctx, "SELECT valid_days, daily_cap FROM workspace_invitation_settings WHERE org_id=$1", org).Scan(&settings.ValidDays, &settings.DailyCap)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return settings, err
}

// validWords is how long an invitation works, as an email says it.
func validWords(scope string, days int) string {
	switch {
	case scope != "workspace":
		return "one hour"
	case days == 1:
		return "1 day"
	}
	return fmt.Sprintf("%d days", days)
}

// emailInvitation sends (or sends again) an invitation's email and records how it went: sent, failed (tried and refused), or
// not_configured (email is switched off on this server; problem 9).
func (s *server) emailInvitation(ctx context.Context, id, inviterID, email, orgName, role, scope string, validDays int) (string, error) {
	state := "not_configured"
	if s.mail != nil {
		var inviter string
		if err := s.db.QueryRow(ctx, "SELECT display_name FROM users WHERE id=$1", inviterID).Scan(&inviter); err != nil {
			return "", err
		}
		if err := s.mail.sendInvitation(ctx, email, inviter, orgName, role, roleWords(role), validWords(scope, validDays), s.invitationLink(id)); err == nil {
			state = "sent"
		} else {
			log.Printf("WARN invitation %s was not emailed: %v", id, err)
			state = "failed"
		}
	}
	if _, err := s.db.Exec(ctx, "UPDATE access_invitations SET delivery_state=$1, last_sent_at=$2 WHERE id=$3", state, now(), id); err != nil {
		return "", err
	}
	return state, nil
}

// cancelInvitationsBy cancels what someone sent in a workspace when they are removed, suspended or lose the right to invite (D7,
// D13). People who already accepted keep their access; a restored inviter does not bring these back.
func (s *server) cancelInvitationsBy(ctx context.Context, org, user string) {
	tag, err := s.db.Exec(ctx, "UPDATE access_invitations SET revoked_at=$1, revoked_reason='inviter_removed' WHERE scope='workspace' AND org_id=$2 AND invited_by=$3 AND accepted_at IS NULL AND revoked_at IS NULL", now(), org, user)
	if err != nil {
		// Acceptance still asks authz as the inviter, so a missed cancel cannot let anyone in.
		log.Printf("ERROR could not cancel the invitations of %s in %s: %v", user, org, err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("INFO cancelled %d invitations of a removed inviter in %s", n, org)
	}
}

// agencyInvitation finds a workspace invitation the agency may act on (resend, extend), with its owner or platform staff asking.
func (s *server) agencyInvitation(r *http.Request) (invitation, error) {
	// Signed in first, so nobody learns whether an invitation exists without being someone.
	if _, err := s.person(r); err != nil {
		return invitation{}, err
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return invitation{}, bad("Choose a valid invitation.")
	}
	item, err := scanInvitation(s.db.QueryRow(r.Context(), `SELECT `+invitationColumns+invitationFrom+`WHERE i.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return invitation{}, newError(http.StatusNotFound, "not_found", "Invitation not found.")
	}
	if err != nil {
		return invitation{}, err
	}
	if item.Scope != "workspace" {
		return invitation{}, bad("Platform invitations last one hour; send a new one instead.")
	}
	if err := s.mayHandleInvitation(r, item.OrgID, item.InvitedBy); err != nil {
		return invitation{}, err
	}
	if item.Status != "pending" && item.Status != "expired" {
		return invitation{}, conflict("This invitation was " + item.Status + ". Send a new one instead.")
	}
	return item, nil
}

// resendInvitation emails a waiting invitation again: at most once an hour and three times in all (D175).
func (s *server) resendInvitation(w http.ResponseWriter, r *http.Request) error {
	item, err := s.agencyInvitation(r)
	if err != nil {
		return err
	}
	if item.Status == "expired" {
		return conflict("This invitation has ended. Extend it first, then resend it.")
	}
	if item.resent >= maxResends {
		return newError(http.StatusConflict, "resend_limit", "This invitation was resent three times already. Withdraw it and send a new one.")
	}
	if wait := item.lastSentAt + resendSpacing - now(); wait > 0 {
		return newError(http.StatusTooManyRequests, "resend_wait", fmt.Sprintf("It was sent less than an hour ago. Resend it in %d minutes.", (wait+59)/60))
	}
	if s.mail == nil {
		return newError(http.StatusConflict, "email_off", "Email sending is not set up yet, so it cannot be resent. Send the person its link another way.")
	}
	settings, err := s.invitationSettings(r.Context(), item.OrgID)
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), "UPDATE access_invitations SET resent_count=resent_count+1 WHERE id=$1 AND resent_count=$2 AND revoked_at IS NULL AND accepted_at IS NULL", item.ID, item.resent)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflict("This invitation just changed. Look again.")
	}
	state, err := s.emailInvitation(r.Context(), item.ID, item.InvitedBy, item.Email, item.OrgName, item.Role, item.Scope, settings.ValidDays)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "delivery_state": state, "resends_left": maxResends - item.resent - 1})
	return nil
}

// extendInvitation gives a waiting or ended invitation the agency's full validity again, from now, twice at most (D175).
func (s *server) extendInvitation(w http.ResponseWriter, r *http.Request) error {
	item, err := s.agencyInvitation(r)
	if err != nil {
		return err
	}
	if item.extended >= maxExtends {
		return newError(http.StatusConflict, "extend_limit", "This invitation was extended twice already. Withdraw it and send a new one.")
	}
	settings, err := s.invitationSettings(r.Context(), item.OrgID)
	if err != nil {
		return err
	}
	expires := invitationDeadline("workspace", now(), settings.ValidDays)
	tag, err := s.db.Exec(r.Context(), "UPDATE access_invitations SET expires_at=$1, extended_count=extended_count+1 WHERE id=$2 AND extended_count=$3 AND revoked_at IS NULL AND accepted_at IS NULL", expires, item.ID, item.extended)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflict("This invitation just changed. Look again.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "expires_at": expires, "extends_left": maxExtends - item.extended - 1})
	return nil
}

// declineInvitation is the invited person saying no (D68). The sender sees "Declined" and the seat it held is free at once.
func (s *server) declineInvitation(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	item, err := s.readMyInvitation(r, tx, c, r.PathValue("id"), true)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), "UPDATE access_invitations SET revoked_at=$1, revoked_reason='declined' WHERE id=$2", now(), item.ID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// blockAgency stops an agency from ever inviting this address again (D93), starting from one of its invitations. Every invitation
// it has waiting for the person is declined. Reporting it is separate (POST /v1/me/invitations/{id}/report).
func (s *server) blockAgency(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if !c.EmailVerified {
		return newError(http.StatusForbidden, "email_unverified", "Confirm your email first.")
	}
	var body struct {
		InvitationID string `json:"invitation_id"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if _, err := uuid.Parse(body.InvitationID); err != nil {
		return bad("Choose one of the agency's invitations.")
	}
	email := strings.ToLower(c.Email)
	var org, orgName, scope string
	err = s.db.QueryRow(r.Context(), "SELECT org_id, org_name, scope FROM access_invitations WHERE id=$1 AND email=$2", body.InvitationID, email).Scan(&org, &orgName, &scope)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && scope != "workspace") {
		return newError(http.StatusNotFound, "not_found", "Invitation not found.")
	}
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), "INSERT INTO invitation_blocks (email,org_id,org_name,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (email,org_id) DO NOTHING", email, org, orgName, now()); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), "UPDATE access_invitations SET revoked_at=$1, revoked_reason='blocked_agency' WHERE scope='workspace' AND org_id=$2 AND email=$3 AND accepted_at IS NULL AND revoked_at IS NULL", now(), org, email); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "org_id": org, "org_name": orgName})
	return nil
}

// blockedAgencies lists the agencies the person blocked, so they can undo it.
func (s *server) blockedAgencies(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), "SELECT org_id, org_name, created_at FROM invitation_blocks WHERE email=$1 ORDER BY created_at DESC LIMIT 200", strings.ToLower(c.Email))
	if err != nil {
		return err
	}
	defer rows.Close()
	type blocked struct {
		OrgID     string `json:"org_id"`
		OrgName   string `json:"org_name"`
		BlockedAt int64  `json:"blocked_at"`
	}
	items := []blocked{}
	for rows.Next() {
		var item blocked
		if err := rows.Scan(&item.OrgID, &item.OrgName, &item.BlockedAt); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"agencies": items})
	return nil
}

func (s *server) unblockAgency(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), "DELETE FROM invitation_blocks WHERE email=$1 AND org_id=$2", strings.ToLower(c.Email), r.PathValue("org")); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// workspaceInvitationSettings is how long this agency's invitations last and how many it may send a day.
func (s *server) workspaceInvitationSettings(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceActor(r, org); err != nil {
		return err
	}
	settings, err := s.invitationSettings(r.Context(), org)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, settings)
	return nil
}

// putWorkspaceInvitationSettings: the owner sets how long invitations last (1 to 30 days, D41); only Caller Whale staff change the
// daily number (D176).
func (s *server) putWorkspaceInvitationSettings(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	seat, err := s.workspaceSeat(r, org)
	if err != nil {
		return err
	}
	if !seat.owner && !seat.staff {
		return forbidden("Only this workspace's owner can do this.")
	}
	var body struct {
		ValidDays *int `json:"valid_days"`
		DailyCap  *int `json:"daily_cap"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	settings, err := s.invitationSettings(r.Context(), org)
	if err != nil {
		return err
	}
	if body.ValidDays != nil {
		if *body.ValidDays < 1 || *body.ValidDays > 30 {
			return bad("Invitations last between 1 and 30 days.")
		}
		settings.ValidDays = *body.ValidDays
	}
	if body.DailyCap != nil {
		if !seat.staff {
			return forbidden("Ask Caller Whale to change the daily number of invitations.")
		}
		if *body.DailyCap < 1 || *body.DailyCap > 5000 {
			return bad("Choose a daily number between 1 and 5000.")
		}
		settings.DailyCap = *body.DailyCap
	}
	if _, err := s.db.Exec(r.Context(), `INSERT INTO workspace_invitation_settings (org_id,valid_days,daily_cap,updated_at) VALUES ($1,$2,$3,$4)
		ON CONFLICT (org_id) DO UPDATE SET valid_days=EXCLUDED.valid_days, daily_cap=EXCLUDED.daily_cap, updated_at=EXCLUDED.updated_at`, org, settings.ValidDays, settings.DailyCap, now()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, settings)
	return nil
}

func nonNilStrings(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

// askForSeat records that someone who is not the owner (a team lead) could not invite for want of a seat (D71). It answers false
// when the asker is the owner or an admin, who add seats themselves.
func (s *server) askForSeat(r *http.Request, org, asker, email string) (bool, error) {
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, asker)
	if err != nil {
		return false, err
	}
	for _, space := range profile.Workspaces {
		if space.OrgID == org && (space.BusinessOwner || slices.Contains(space.Roles, "admin")) {
			return false, nil
		}
	}
	// One open request per lead and address is enough.
	_, err = s.db.Exec(r.Context(), `INSERT INTO seat_requests (id, org_id, requested_by, for_email, created_at)
		SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM seat_requests WHERE org_id=$2 AND requested_by=$3 AND for_email=$4 AND handled_at IS NULL)`,
		uuid.NewString(), org, asker, email, now())
	return err == nil, err
}

// seatRequests lists the open requests for seats, for the owner and admins.
func (s *server) seatRequests(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceActor(r, org); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT q.id, q.requested_by, coalesce(u.display_name,''), q.for_email, q.created_at FROM seat_requests q
		LEFT JOIN users u ON u.id = q.requested_by WHERE q.org_id=$1 AND q.handled_at IS NULL ORDER BY q.created_at DESC LIMIT 100`, org)
	if err != nil {
		return err
	}
	defer rows.Close()
	type request struct {
		ID          string `json:"id"`
		RequestedBy string `json:"requested_by"`
		Name        string `json:"name"`
		ForEmail    string `json:"for_email"`
		CreatedAt   int64  `json:"created_at"`
	}
	items := []request{}
	for rows.Next() {
		var item request
		if err := rows.Scan(&item.ID, &item.RequestedBy, &item.Name, &item.ForEmail, &item.CreatedAt); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": items})
	return nil
}

// closeSeatRequest marks a request handled (a seat added, or the owner said no).
func (s *server) closeSeatRequest(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceActor(r, org); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE seat_requests SET handled_at=$1 WHERE id=$2 AND org_id=$3 AND handled_at IS NULL", now(), r.PathValue("id"), org); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// leaveWorkspace is a person leaving an agency at once (D25). Their access ends now; they stop leading or deputising any team;
// invitations they sent and that still wait are cancelled. Their leads stay with their teams, where the team's leads (or the
// owner) see them, until the owner hands them on (build step 12). The owner cannot leave.
func (s *server) leaveWorkspace(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if _, err := s.authzCall(r, http.MethodDelete, "/v1/orgs/"+org+"/members/"+c.Sub, map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA}, nil); err != nil {
		return err
	}
	s.cancelInvitationsBy(r.Context(), org, c.Sub)
	log.Printf("INFO workspace %s: a member left", org)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// cancelInvitationsInto cancels what a former lead of a team sent into that team and still waits (D7). Their invitations into
// teams they still lead stay. The owner's and admins' invitations are never theirs to lose this way: they are not team leads by
// position.
func (s *server) cancelInvitationsInto(ctx context.Context, org, team, lead string) {
	if _, err := s.db.Exec(ctx, `UPDATE access_invitations SET revoked_at=$1, revoked_reason='inviter_removed' WHERE scope='workspace' AND org_id=$2 AND invited_by=$3
		AND ($4 = ANY(team_ids) OR team_id=$4) AND accepted_at IS NULL AND revoked_at IS NULL`, now(), org, lead, team); err != nil {
		log.Printf("ERROR could not cancel a former lead's invitations into a team in %s: %v", org, err)
	}
}

// peopleLog answers GET /v1/orgs/{org}/people-log: the record of people changes as the person may see it (D58): everything for the
// owner and admins, their teams' part for a team lead, what was done to them for anyone else. Names are filled in here.
func (s *server) peopleLog(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return err
	}
	days := r.URL.Query().Get("days")
	if days == "" {
		days = "90"
	}
	var listed struct {
		Entries []map[string]any `json:"entries"`
		View    string           `json:"view"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/people-log?viewer="+c.Sub+"&days="+url.QueryEscape(days), nil, &listed); err != nil {
		return err
	}
	ids := []string{}
	for _, e := range listed.Entries {
		for _, k := range []string{"actor_id", "target_id"} {
			if id, _ := e[k].(string); id != "" && !slices.Contains(ids, id) {
				ids = append(ids, id)
			}
		}
	}
	names := map[string]string{}
	if len(ids) > 0 {
		rows, err := s.db.Query(r.Context(), `SELECT id, display_name FROM users WHERE id = ANY($1)`, ids)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return err
			}
			names[id] = name
		}
		rows.Close()
	}
	for _, e := range listed.Entries {
		if id, _ := e["actor_id"].(string); id != "" {
			e["actor_name"] = names[id]
		}
		if id, _ := e["target_id"].(string); id != "" {
			e["target_name"] = names[id]
		}
	}
	if listed.Entries == nil {
		listed.Entries = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": listed.Entries, "view": listed.View})
	return nil
}
