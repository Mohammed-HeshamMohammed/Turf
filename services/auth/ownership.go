package main

import (
	"context"
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

// Build step 13: handing an agency to a new owner, and an agency whose owner is gone.
//
//   - The owner offers the agency to a member, choosing their own next role (admin, team lead, or leaving), with their second step
//     (D28, D200). The member accepts with their second step; when the agency pays through the payment provider, only once they pay
//     for it themselves, so the old owner's card is never charged again (D70). Unanswered for 7 days it lapses; the owner can cancel
//     it until then (D199).
//   - Staff pause an agency whose owner cannot be reached: members read, nobody works (D27). After 14 days paused, an admin of the
//     agency may ask to take it over, and staff check and approve (D201).

const (
	handoverSeconds = 7 * 86_400 // an offer lapses after this (D199)
	unreachableDays = 14         // how long an agency is paused before an admin's takeover can be approved (D201)
)

type handover struct {
	ID        string   `json:"id"`
	OrgID     string   `json:"org_id"`
	OrgName   string   `json:"org_name"`
	Kind      string   `json:"kind"`
	FromID    string   `json:"from_id"`
	FromName  string   `json:"from_name"`
	ToID      string   `json:"to_id"`
	ToName    string   `json:"to_name"`
	OldRoles  []string `json:"old_roles"`
	CreatedAt int64    `json:"created_at"`
	ExpiresAt int64    `json:"expires_at"`
}

const handoverColumns = `h.id, h.org_id, h.org_name, h.kind, h.from_user, coalesce(f.display_name, ''), h.to_user, coalesce(t.display_name, ''), h.old_roles, h.created_at, h.expires_at`
const handoverFrom = ` FROM ownership_handovers h LEFT JOIN users f ON f.id = h.from_user LEFT JOIN users t ON t.id = h.to_user`

func scanHandovers(rows pgx.Rows) ([]handover, error) {
	defer rows.Close()
	out := []handover{}
	for rows.Next() {
		var h handover
		if err := rows.Scan(&h.ID, &h.OrgID, &h.OrgName, &h.Kind, &h.FromID, &h.FromName, &h.ToID, &h.ToName, &h.OldRoles, &h.CreatedAt, &h.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ownerOf is the agency's owner and name, from authz.
func (s *server) ownerOf(r *http.Request, org string) (owner, name string, err error) {
	var about struct {
		OwnerID string `json:"owner_id"`
		Name    string `json:"name"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org, nil, &about); err != nil {
		return "", "", err
	}
	return about.OwnerID, strings.TrimSpace(about.Name), nil
}

// memberRoles is a person's roles in the agency, or nil when they are not in it.
func (s *server) memberRoles(r *http.Request, org, user string) ([]string, error) {
	var listed struct {
		Members []member `json:"members"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/members", nil, &listed); err != nil {
		return nil, err
	}
	for _, m := range listed.Members {
		if m.UserID == user {
			return nonNilStrings(m.Roles), nil
		}
	}
	return nil, nil
}

// offerOwnership answers POST /v1/orgs/{org}/handover {to, old_role}: the owner, with their second step, offers the agency to a member.
func (s *server) offerOwnership(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		To      string `json:"to"`
		OldRole string `json:"old_role"` // admin, manager (team lead), or leave
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	owner, name, err := s.ownerOf(r, org)
	if err != nil {
		return err
	}
	if owner != c.Sub {
		return forbidden("Only the agency's owner can hand it over.")
	}
	if !c.MFA {
		return newError(http.StatusForbidden, "mfa_required", "Confirm it's you with your second step first.")
	}
	oldRoles := []string{}
	switch body.OldRole {
	case "admin", "manager":
		oldRoles = []string{body.OldRole}
	case "leave":
	default:
		return bad("Choose what you become: admin, team lead, or leave the agency.")
	}
	roles, err := s.memberRoles(r, org, body.To)
	if err != nil {
		return err
	}
	if body.To == c.Sub || !slices.ContainsFunc(roles, func(r string) bool { return r != "client" }) {
		return bad("Hand the agency to someone who is a member of it.")
	}
	ctx := r.Context()
	t := now()
	// Only one offer at a time; an ended one is out of the way.
	if err := s.endLapsed(ctx, org); err != nil {
		return err
	}
	id := uuid.NewString()
	_, err = s.db.Exec(ctx, `INSERT INTO ownership_handovers (id, org_id, org_name, kind, from_user, to_user, old_roles, created_at, expires_at)
		VALUES ($1, $2, $3, 'handover', $4, $5, $6, $7, $8)`, id, org, name, c.Sub, body.To, oldRoles, t, t+handoverSeconds)
	if err != nil {
		if strings.Contains(err.Error(), "one_open_handover") {
			return conflict("A handover of this agency is already waiting. Cancel it first.")
		}
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "expires_at": t + handoverSeconds})
	return nil
}

// endLapsed marks the agency's offers that ran out as ended, so a new offer or request can be made.
func (s *server) endLapsed(ctx context.Context, org string) error {
	_, err := s.db.Exec(ctx, `UPDATE ownership_handovers SET cancelled_at = $2, cancelled_reason = 'expired' WHERE org_id = $1 AND completed_at IS NULL AND cancelled_at IS NULL AND expires_at <= $2`, org, now())
	return err
}

// agencyHandover answers GET /v1/orgs/{org}/handover: the offer waiting, for the owner.
func (s *server) agencyHandover(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	c, err := s.person(r)
	if err != nil {
		return err
	}
	owner, _, err := s.ownerOf(r, org)
	if err != nil {
		return err
	}
	if owner != c.Sub {
		return forbidden("Only the agency's owner sees its handover.")
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+handoverColumns+handoverFrom+` WHERE h.org_id = $1 AND h.kind = 'handover' AND h.completed_at IS NULL AND h.cancelled_at IS NULL AND h.expires_at > $2`, org, now())
	if err != nil {
		return err
	}
	list, err := scanHandovers(rows)
	if err != nil {
		return err
	}
	var open any
	if len(list) > 0 {
		open = list[0]
	}
	writeJSON(w, http.StatusOK, map[string]any{"handover": open})
	return nil
}

// cancelOwnership answers DELETE /v1/orgs/{org}/handover: the owner takes the offer back; nothing changes (D199).
func (s *server) cancelOwnership(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	c, err := s.person(r)
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE ownership_handovers SET cancelled_at = $3, cancelled_reason = 'cancelled' WHERE org_id = $1 AND from_user = $2 AND kind = 'handover' AND completed_at IS NULL AND cancelled_at IS NULL`, org, c.Sub, now())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return newError(http.StatusNotFound, "not_found", "No handover of this agency is waiting.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// myHandovers answers GET /v1/me/handovers: agencies offered to the signed-in person.
func (s *server) myHandovers(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+handoverColumns+handoverFrom+` WHERE h.to_user = $1 AND h.kind = 'handover' AND h.completed_at IS NULL AND h.cancelled_at IS NULL AND h.expires_at > $2 ORDER BY h.created_at`, c.Sub, now())
	if err != nil {
		return err
	}
	list, err := scanHandovers(rows)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"handovers": list})
	return nil
}

// payer is who pays for the agency through the payment provider, if it pays that way (billing's standing).
func (s *server) payer(ctx context.Context, org string) (providerPaid bool, payerID string, err error) {
	if !s.billingConnected() {
		return false, "", nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.billingURL+"/v1/orgs/"+org+"/standing", nil)
	if err != nil {
		return false, "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.billingToken)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return false, "", newError(http.StatusServiceUnavailable, "billing_unavailable", "Payment details cannot be checked right now. Try again in a moment.")
	}
	defer res.Body.Close()
	var standing struct {
		ProviderPaid bool    `json:"provider_paid"`
		PayerID      *string `json:"payer_id"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&standing) != nil {
		return false, "", newError(http.StatusServiceUnavailable, "billing_unavailable", "Payment details cannot be checked right now. Try again in a moment.")
	}
	if standing.PayerID != nil {
		payerID = *standing.PayerID
	}
	return standing.ProviderPaid, payerID, nil
}

// completeHandover makes the handover in authz and marks it done.
func (s *server) completeHandover(r *http.Request, h handover, actor string) error {
	if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+h.OrgID+"/owner/handover", map[string]any{"from": h.FromID, "to": h.ToID, "old_roles": nonNilStrings(h.OldRoles), "actor_id": actor}, nil); err != nil {
		return err
	}
	_, err := s.db.Exec(r.Context(), `UPDATE ownership_handovers SET completed_at = $2 WHERE id = $1`, h.ID, now())
	if err == nil && len(h.OldRoles) == 0 {
		// The old owner left: what they had sent and is still waiting ends with them (as when anyone leaves).
		s.cancelInvitationsBy(r.Context(), h.OrgID, h.FromID)
	}
	return err
}

func (s *server) openHandover(r *http.Request, id, user, kind string) (handover, error) {
	rows, err := s.db.Query(r.Context(), `SELECT `+handoverColumns+handoverFrom+` WHERE h.id = $1 AND h.kind = $2 AND h.completed_at IS NULL AND h.cancelled_at IS NULL AND h.expires_at > $3 AND ($4 = '' OR h.to_user = $4)`, id, kind, now(), user)
	if err != nil {
		return handover{}, err
	}
	list, err := scanHandovers(rows)
	if err != nil {
		return handover{}, err
	}
	if len(list) == 0 {
		return handover{}, newError(http.StatusNotFound, "not_found", "This handover has ended or was cancelled.")
	}
	return list[0], nil
}

// acceptOwnership answers POST /v1/me/handovers/{id}/accept: the new owner, with their second step, takes the agency.
func (s *server) acceptOwnership(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if !c.MFA {
		return newError(http.StatusForbidden, "mfa_required", "Confirm it's you with your second step first.")
	}
	h, err := s.openHandover(r, r.PathValue("id"), c.Sub, "handover")
	if err != nil {
		return err
	}
	paid, payer, err := s.payer(r.Context(), h.OrgID)
	if err != nil {
		return err
	}
	if paid && payer != c.Sub {
		return newError(http.StatusConflict, "payment_needed", "Add your own payment method for this agency first. The previous owner's card is then never charged again.")
	}
	if err := s.completeHandover(r, h, c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "org_id": h.OrgID})
	return nil
}

// declineOwnership answers POST /v1/me/handovers/{id}/decline: nothing changes.
func (s *server) declineOwnership(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE ownership_handovers SET cancelled_at = $3, cancelled_reason = 'declined' WHERE id = $1 AND to_user = $2 AND kind = 'handover' AND completed_at IS NULL AND cancelled_at IS NULL`, r.PathValue("id"), c.Sub, now())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return newError(http.StatusNotFound, "not_found", "This handover has ended or was cancelled.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// pauseWorkspace answers PUT /v1/admin/workspaces/{org}/paused {on}: staff pause an agency whose owner cannot be reached (D27), or
// end the pause. The day it began is kept: an admin's takeover is approved only after 14 days of it.
func (s *server) pauseWorkspace(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, true); err != nil {
		return err
	}
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	var body struct {
		On bool `json:"on"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/standing", map[string]any{"paused": body.On}, nil); err != nil {
		return err
	}
	var err error
	if body.On {
		_, err = s.db.Exec(r.Context(), `INSERT INTO paused_workspaces (org_id, paused_at) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING`, org, now())
	} else {
		_, err = s.db.Exec(r.Context(), `DELETE FROM paused_workspaces WHERE org_id = $1`, org)
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paused": body.On})
	return nil
}

// askTakeover answers POST /v1/orgs/{org}/takeover: an admin of a paused agency asks to become its owner (D201).
func (s *server) askTakeover(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var pausedAt int64
	err = s.db.QueryRow(r.Context(), `SELECT paused_at FROM paused_workspaces WHERE org_id = $1`, org).Scan(&pausedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return conflict("Only an agency Caller Whale has paused because its owner cannot be reached can be taken over.")
	}
	if err != nil {
		return err
	}
	roles, err := s.memberRoles(r, org, c.Sub)
	if err != nil {
		return err
	}
	if !slices.Contains(roles, "admin") {
		return forbidden("Only an admin of the agency can ask to take it over.")
	}
	owner, name, err := s.ownerOf(r, org)
	if err != nil {
		return err
	}
	if err := s.endLapsed(r.Context(), org); err != nil {
		return err
	}
	t := now()
	id := uuid.NewString()
	// A takeover request stays open until staff decide; it does not lapse like an offer.
	_, err = s.db.Exec(r.Context(), `INSERT INTO ownership_handovers (id, org_id, org_name, kind, from_user, to_user, old_roles, created_at, expires_at)
		VALUES ($1, $2, $3, 'takeover', $4, $5, '{}', $6, $7)`, id, org, name, owner, c.Sub, t, t+365*86_400)
	if err != nil {
		if strings.Contains(err.Error(), "one_open_handover") {
			return conflict("Someone already asked to take this agency over; Caller Whale is checking it.")
		}
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "can_be_approved_at": pausedAt + unreachableDays*86_400})
	return nil
}

// takeoverRequests answers GET /v1/admin/takeovers: the requests waiting for staff, with when each may be approved.
func (s *server) takeoverRequests(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+handoverColumns+`, coalesce(p.paused_at, 0)`+handoverFrom+` LEFT JOIN paused_workspaces p ON p.org_id = h.org_id
		WHERE h.kind = 'takeover' AND h.completed_at IS NULL AND h.cancelled_at IS NULL ORDER BY h.created_at`)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var h handover
		var pausedAt int64
		if err := rows.Scan(&h.ID, &h.OrgID, &h.OrgName, &h.Kind, &h.FromID, &h.FromName, &h.ToID, &h.ToName, &h.OldRoles, &h.CreatedAt, &h.ExpiresAt, &pausedAt); err != nil {
			return err
		}
		out = append(out, map[string]any{"request": h, "paused_at": pausedAt, "can_be_approved_at": pausedAt + unreachableDays*86_400})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
	return nil
}

// decideTakeover answers POST /v1/admin/takeovers/{id}/approve or /reject: the platform owner or cofounder decides. Approving needs the
// agency paused for 14 days; the old owner leaves, the admin owns it, and the pause ends.
func (s *server) decideTakeover(approve bool) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		c, err := s.staffActor(r, true)
		if err != nil {
			return err
		}
		h, err := s.openHandover(r, r.PathValue("id"), "", "takeover")
		if err != nil {
			return err
		}
		if !approve {
			if _, err := s.db.Exec(r.Context(), `UPDATE ownership_handovers SET cancelled_at = $2, cancelled_reason = 'rejected' WHERE id = $1`, h.ID, now()); err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return nil
		}
		var pausedAt int64
		if err := s.db.QueryRow(r.Context(), `SELECT paused_at FROM paused_workspaces WHERE org_id = $1`, h.OrgID).Scan(&pausedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return conflict("The agency is no longer paused: its owner is back.")
			}
			return err
		}
		if now() < pausedAt+unreachableDays*86_400 {
			return conflict("The owner must have been unreachable for 14 days before the agency is handed over.")
		}
		if err := s.completeHandover(r, h, c.Sub); err != nil {
			return err
		}
		if _, err := s.db.Exec(r.Context(), `DELETE FROM paused_workspaces WHERE org_id = $1`, h.OrgID); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "org_id": h.OrgID})
		return nil
	}
}
