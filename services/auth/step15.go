package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Build step 15: sign-up inside the invitation link (D47, D368), "this is my device" or "shared device" at sign-in (D38, D188),
// the My access page's list of agencies (D91), and a copy of the person's own data (D99).

const (
	sharedSessionSeconds = 12 * 3600  // a sign-in on a shared device lasts at most this long (and only while its tab is open)
	secondStepSeconds    = 7 * 86_400 // owners, admins and team leads give their code again after this (D188)
	invitationKeyParam   = "key"      // the emailed link's one-time key
)

// keyedInvitationLink is the link an invitation email carries: the invitation, with a new one-time key that proves whoever opens
// it reads that mailbox. Sending again replaces the key, so only the newest email's link signs up.
func (s *server) keyedInvitationLink(ctx context.Context, id string) (string, error) {
	key, hash := newSecret()
	if _, err := s.db.Exec(ctx, "UPDATE access_invitations SET link_key_hash = $2 WHERE id = $1", id, hash); err != nil {
		return "", err
	}
	return s.invitationLink(id) + "&" + invitationKeyParam + "=" + url.QueryEscape(key), nil
}

// openInvitation is a waiting workspace invitation whose emailed key matches: the address it was sent to, and who it is from.
type openInvitation struct {
	email, orgName, ownerName, inviter string
}

func (s *server) invitationByKey(ctx context.Context, id, key string) (*openInvitation, error) {
	key = strings.TrimSpace(key)
	if id == "" || key == "" || len(key) > 200 {
		return nil, nil
	}
	var inv openInvitation
	err := s.db.QueryRow(ctx, `SELECT i.email, i.org_name, i.owner_name, coalesce(u.display_name, '') FROM access_invitations i LEFT JOIN users u ON u.id = i.invited_by
		WHERE i.id = $1 AND i.scope = 'workspace' AND i.link_key_hash = $2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $3`,
		id, sha256Hex(key), now()).Scan(&inv.email, &inv.orgName, &inv.ownerName, &inv.inviter)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &inv, err
}

// invitationPreview answers GET /v1/invitations/{id}/preview?key=, before anyone is signed in: the address the sign-up form fills in
// and locks, where the invitation comes from, and whether that address already has an account (then the person signs in instead).
func (s *server) invitationPreview(w http.ResponseWriter, r *http.Request) error {
	inv, err := s.invitationByKey(r.Context(), r.PathValue("id"), r.URL.Query().Get(invitationKeyParam))
	if err != nil {
		return err
	}
	if inv == nil {
		return forbidden("This invitation link has ended or was already used. Ask for a new invitation.")
	}
	existing, err := s.userBy(r.Context(), "email", inv.email)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": inv.email, "org_name": inv.orgName, "owner_name": inv.ownerName, "inviter_name": inv.inviter, "account_exists": existing != nil})
	return nil
}

// secondStepStale is true when a session's second step is older than 7 days and the person is an agency's owner, admin or team
// lead, or Caller Whale staff: they give their code again (D188). When authz cannot answer, they are asked: the safe side.
func (s *server) secondStepStale(ctx context.Context, userID string, mfaAt int64) bool {
	if mfaAt == 0 || now()-mfaAt <= secondStepSeconds {
		return false
	}
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return false // no roles on this server: nobody is a lead
	}
	profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, userID)
	if err != nil {
		return true
	}
	if profile.PlatformRole != "" && profile.PlatformRole != "tester" {
		return true
	}
	for _, ws := range profile.Workspaces {
		if slices.ContainsFunc(ws.Roles, func(r string) bool { return r == "owner" || r == "solo" || r == "admin" || r == "manager" }) {
			return true
		}
	}
	return false
}

// myAgencies answers GET /v1/me/agencies for the My access page (D91): each agency the person is in, by name, with their roles and
// teams, and whether they own it (an owner cannot leave). Their invitations and devices have their own requests.
func (s *server) myAgencies(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return newError(http.StatusServiceUnavailable, "access_unavailable", "Membership information is unavailable right now.")
	}
	out := []map[string]any{}
	for _, ws := range profile.Workspaces {
		var about struct {
			Name string `json:"name"`
		}
		if status, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+ws.OrgID, nil, &about); err != nil && status != http.StatusNotFound {
			return err
		}
		var listed struct {
			Members []member `json:"members"`
			Teams   []team   `json:"teams"`
		}
		if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+ws.OrgID+"/members", nil, &listed); err != nil {
			return err
		}
		mine := []string{}
		for _, m := range listed.Members {
			if m.UserID == c.Sub {
				mine = m.TeamIDs
			}
		}
		teams := []map[string]any{}
		for _, t := range listed.Teams {
			leads := slices.Contains(t.ManagerIDs, c.Sub) || t.ManagerID == c.Sub
			if slices.Contains(mine, t.TeamID) || leads || slices.Contains(t.DeputyIDs, c.Sub) {
				teams = append(teams, map[string]any{"id": t.TeamID, "name": t.Name, "lead": leads, "deputy": slices.Contains(t.DeputyIDs, c.Sub)})
			}
		}
		name := strings.TrimSpace(about.Name)
		if name == "" {
			name = "Workspace"
		}
		out = append(out, map[string]any{"org_id": ws.OrgID, "name": name, "roles": nonNilStrings(ws.Roles), "teams": teams, "owner": ws.BusinessOwner})
	}
	writeJSON(w, http.StatusOK, map[string]any{"agencies": out})
	return nil
}

// exportMe answers GET /v1/me/export: a copy of what Caller Whale keeps about the person themselves, as a file to save (D99). An
// agency's data is the agency's, exported by its owner; personal chats join this copy when they are built.
func (s *server) exportMe(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var email, name, tag, phone, currency, first, middle, last, username, phoneVisible, findMe, messageMe, birth, terms string
	var created int64
	if err := s.db.QueryRow(ctx, `SELECT email, display_name, tag, phone, currency, first_name, middle_name, last_name, coalesce(username, ''),
		phone_visible, find_me, message_me, birth_date, terms_version, created_at FROM users WHERE id = $1`, c.Sub).
		Scan(&email, &name, &tag, &phone, &currency, &first, &middle, &last, &username, &phoneVisible, &findMe, &messageMe, &birth, &terms, &created); err != nil {
		return err
	}
	list := func(sql string, cols int) ([][]any, error) {
		rows, err := s.db.Query(ctx, sql, c.Sub)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := [][]any{}
		for rows.Next() {
			values, err := rows.Values()
			if err != nil {
				return nil, err
			}
			out = append(out, values[:cols])
		}
		return out, rows.Err()
	}
	sessions, err := list("SELECT kind, provider, created_at, last_seen_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500", 4)
	if err != nil {
		return err
	}
	changes, err := list("SELECT what, at FROM name_changes WHERE user_id = $1 ORDER BY at", 2)
	if err != nil {
		return err
	}
	blocked, err := list("SELECT b.org_id, b.org_name, b.created_at FROM invitation_blocks b JOIN users u ON u.email = b.email WHERE u.id = $1 ORDER BY b.created_at", 3)
	if err != nil {
		return err
	}
	keyed := func(rows [][]any, names ...string) []map[string]any {
		out := []map[string]any{}
		for _, row := range rows {
			item := map[string]any{}
			for i, n := range names {
				item[n] = row[i]
			}
			out = append(out, item)
		}
		return out
	}
	agencies := []workspaceAccess{}
	if profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, c.Sub); err == nil {
		agencies = profile.Workspaces
	}
	w.Header().Set("Content-Disposition", `attachment; filename="caller-whale-my-data.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"exported_at": now(),
		"profile": map[string]any{"id": c.Sub, "email": email, "name": name, "tag": tag, "first_name": first, "middle_name": middle, "last_name": last,
			"phone": phone, "username": username, "currency": currency, "birth_date": birth, "terms_version": terms, "created_at": created},
		"settings":          map[string]any{"phone_visible": phoneVisible, "find_me": findMe, "message_me": messageMe},
		"name_changes":      keyed(changes, "what", "at"),
		"sign_ins":          keyed(sessions, "kind", "provider", "created_at", "last_seen_at"),
		"blocked_agencies":  keyed(blocked, "org_id", "org_name", "blocked_at"),
		"agencies":          agencies,
		"not_included_here": "Each agency's leads, calls and chats belong to that agency; its owner exports them. Personal chats will be added here when they exist.",
	})
	return nil
}
