package main

// Sign-in security (database_setup/0032_sign_in_security.sql).
//
//   - Devices: each session keeps its device (from the browser's description), rough place (Cloudflare's country) and network (the
//     address cut to its first parts). A sign-in from a device the person never used emails them, with a "This wasn't me" link that
//     signs that session out and sends a password reset (D242).
//   - The owner or an admin signs out every session of a member of their agency (D240).
//   - The owner requires the authenticator of everyone (authz's mfa_everyone, D238) and sets how long people may stay idle, 8 hours by
//     default; a person in several agencies has the shortest limit; a call in progress never times out (D244).
//   - A password reset needs the email link and, for someone who has an authenticator or recovery codes, one of them. Someone who lost
//     both asks support, who may approve only after 7 days; approving removes the lost factors so the link alone works (D239).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	defaultIdleMinutes = 480
	notMeSeconds       = 7 * 86400
	resetWaitSeconds   = 7 * 86400
)

// ---- where a request comes from ----

type deviceInfo struct{ label, key, country, network string }

type deviceKey struct{}

// withDevice keeps the request's device and place on its context, for openSession.
func withDevice(r *http.Request) *http.Request {
	ua := r.Header.Get("User-Agent")
	ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if ip == "" {
		ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	d := deviceInfo{label: deviceLabel(ua), key: sha256Hex(deviceLabel(ua)), country: strings.ToUpper(strings.TrimSpace(r.Header.Get("CF-IPCountry"))), network: networkOf(ip)}
	if len(d.country) != 2 {
		d.country = ""
	}
	return r.WithContext(context.WithValue(r.Context(), deviceKey{}, d))
}

func deviceFrom(ctx context.Context) deviceInfo {
	d, _ := ctx.Value(deviceKey{}).(deviceInfo)
	if d.label == "" {
		d.label = "Unknown device"
		d.key = sha256Hex(d.label)
	}
	return d
}

// deviceLabel is a browser and system in words ("Chrome on Windows"); the same browser on the same system is the same device.
func deviceLabel(ua string) string {
	browser, system := "", ""
	for _, b := range []struct{ mark, name string }{{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Firefox/", "Firefox"}, {"Chrome/", "Chrome"}, {"Safari/", "Safari"}, {"Tauri", "Caller Whale app"}} {
		if strings.Contains(ua, b.mark) {
			browser = b.name
			break
		}
	}
	for _, o := range []struct{ mark, name string }{{"Windows", "Windows"}, {"iPhone", "iPhone"}, {"iPad", "iPad"}, {"Android", "Android"}, {"Mac OS X", "Mac"}, {"Linux", "Linux"}} {
		if strings.Contains(ua, o.mark) {
			system = o.name
			break
		}
	}
	switch {
	case browser != "" && system != "":
		return browser + " on " + system
	case browser != "":
		return browser
	case system != "":
		return system
	}
	return ""
}

// networkOf keeps an address's first parts only: 203.0.113.x, or the first four groups of IPv6.
func networkOf(ip string) string {
	parsed := net.ParseIP(ip)
	switch {
	case parsed == nil:
		return ""
	case parsed.To4() != nil:
		p := strings.Split(parsed.To4().String(), ".")
		return strings.Join(p[:3], ".") + ".x"
	}
	p := strings.Split(parsed.String(), ":")
	if len(p) > 4 {
		p = p[:4]
	}
	return strings.Join(p, ":") + "::"
}

// noteDevice records where a new session came from and, for a device the person never used before, emails them (D242).
func (s *server) noteDevice(ctx context.Context, u *user, sid string) {
	d := deviceFrom(ctx)
	var seen, before bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sessions WHERE user_id = $1 AND device_key = $2 AND id <> $3),
		EXISTS (SELECT 1 FROM sessions WHERE user_id = $1 AND id <> $3)`, u.id, d.key, sid).Scan(&seen, &before); err != nil {
		log.Printf("WARN device of session: %v", err)
		return
	}
	if _, err := s.db.Exec(ctx, `UPDATE sessions SET device = $2, device_key = $3, country = $4, network = $5 WHERE id = $1`, sid, d.label, d.key, d.country, d.network); err != nil {
		log.Printf("WARN device of session: %v", err)
		return
	}
	if seen || !before || s.mail == nil || u.email == "" {
		return
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	token := hex.EncodeToString(b)
	if _, err := s.db.Exec(ctx, `INSERT INTO not_me_tokens (token_hash, session_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`, sha256Hex(token), sid, u.id, now()+notMeSeconds); err != nil {
		log.Printf("WARN not-me token: %v", err)
		return
	}
	place := d.country
	if place == "" {
		place = "an unknown place"
	}
	if err := s.mail.sendTemplate(ctx, "new_sign_in", u.email, map[string]any{"device": d.label, "place": place, "at": time.Unix(now(), 0).UTC().Format("2 January 2006, 15:04 UTC"),
		"link": strings.TrimRight(s.cfg.landingURL, "/") + "/account/not-me?token=" + token}); err != nil {
		log.Printf("WARN new sign-in email: %v", err)
	}
}

// notMe is POST /v1/sessions/not-me {token}: the link in the new-device email signs that session out and sends a password reset.
func (s *server) notMe(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Token string `json:"token"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	var sid, userID string
	err := s.db.QueryRow(ctx, `UPDATE not_me_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING session_id, user_id`,
		sha256Hex(strings.TrimSpace(body.Token)), now()).Scan(&sid, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return newError(http.StatusNotFound, "not_found", "This link was used or has expired. Sign in and end the session from your account's devices.")
	}
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, now(), sid); err != nil {
		return err
	}
	if u, err := s.userBy(ctx, "id", userID); err == nil && u != nil && u.email != "" {
		if err := s.fb.sendPasswordReset(ctx, u.email); err != nil {
			log.Printf("WARN reset after not-me: %v", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "That device is signed out. We emailed you a link to choose a new password."})
	return nil
}

// ---- an agency signing out a member (D240) ----

func (s *server) signOutMember(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if !c.MFA {
		return newError(http.StatusForbidden, "mfa_required", "Confirm your identity with a second step first.")
	}
	org, target := r.PathValue("org"), r.PathValue("user")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	mine, err := s.memberRoles(r, org, c.Sub)
	if err != nil {
		return err
	}
	owner := slices.Contains(mine, "owner") || slices.Contains(mine, "solo")
	if !owner && !slices.Contains(mine, "admin") {
		return forbidden("Only the owner or an admin signs out a member.")
	}
	theirs, err := s.memberRoles(r, org, target)
	if err != nil {
		return err
	}
	if len(theirs) == 0 {
		return newError(http.StatusNotFound, "not_found", "That person is not in this agency.")
	}
	if !owner && (slices.Contains(theirs, "owner") || slices.Contains(theirs, "solo")) {
		return forbidden("An admin cannot sign out the owner.")
	}
	done, err := s.db.Exec(r.Context(), `UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, now(), target)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"signed_out": done.RowsAffected()})
	return nil
}

// ---- the agency's sign-in rules (D238, D244) ----

// orgSecurity is GET (the owner and admins) and PUT {idle_minutes, mfa_everyone} (the owner) /v1/orgs/{org}/security.
func (s *server) orgSecurity(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	org := r.PathValue("org")
	if _, err := uuid.Parse(org); err != nil {
		return bad("Choose a valid workspace.")
	}
	roles, err := s.memberRoles(r, org, c.Sub)
	if err != nil {
		return err
	}
	owner := slices.Contains(roles, "owner") || slices.Contains(roles, "solo")
	if !owner && !slices.Contains(roles, "admin") {
		return forbidden("The owner and admins see the agency's sign-in rules.")
	}
	ctx := r.Context()
	if r.Method == http.MethodPut {
		if !owner {
			return forbidden("Only the owner changes the agency's sign-in rules.")
		}
		if !c.MFA {
			return newError(http.StatusForbidden, "mfa_required", "Confirm your identity with a second step first.")
		}
		var body struct {
			IdleMinutes *int      `json:"idle_minutes"`
			MFAEveryone *bool     `json:"mfa_everyone"`
			Countries   *[]string `json:"countries"` // where members may work from (D243); kept in authz, checked by the gateway
			Networks    *[]string `json:"networks"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		if body.IdleMinutes != nil {
			if *body.IdleMinutes < 15 || *body.IdleMinutes > 10080 {
				return bad("Choose 15 minutes to 7 days of idle time before people are signed out.")
			}
			if _, err := s.db.Exec(ctx, `INSERT INTO org_security (org_id, idle_minutes, set_by, set_at) VALUES ($1, $2, $3, $4)
				ON CONFLICT (org_id) DO UPDATE SET idle_minutes = EXCLUDED.idle_minutes, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`, org, *body.IdleMinutes, c.Sub, now()); err != nil {
				return err
			}
		}
		if body.MFAEveryone != nil || body.Countries != nil || body.Networks != nil {
			change := map[string]any{"actor_id": c.Sub, "actor_second_step": c.MFA}
			if body.MFAEveryone != nil {
				change["mfa_everyone"] = *body.MFAEveryone
			}
			if body.Countries != nil {
				change["countries"] = *body.Countries
			}
			if body.Networks != nil {
				change["networks"] = *body.Networks
			}
			if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/security", change, nil); err != nil {
				return err
			}
		}
	}
	idle := defaultIdleMinutes
	_ = s.db.QueryRow(ctx, `SELECT idle_minutes FROM org_security WHERE org_id = $1`, org).Scan(&idle)
	authzView := struct {
		MFAEveryone bool     `json:"mfa_everyone"`
		Countries   []string `json:"countries"`
		Networks    []string `json:"networks"`
	}{Countries: []string{}, Networks: []string{}}
	_, _ = s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/security", nil, &authzView)
	writeJSON(w, http.StatusOK, map[string]any{"idle_minutes": idle, "mfa_everyone": authzView.MFAEveryone, "countries": authzView.Countries, "networks": authzView.Networks})
	return nil
}

// idleLimit is the shortest idle time of the agencies a person works in, in seconds; 0 when they are in none or it cannot be read.
func (s *server) idleLimit(ctx context.Context, userID string) int64 {
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return 0
	}
	profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, userID)
	if err != nil || len(profile.Workspaces) == 0 {
		return 0
	}
	shortest := 0
	for _, ws := range profile.Workspaces {
		minutes := defaultIdleMinutes
		_ = s.db.QueryRow(ctx, `SELECT idle_minutes FROM org_security WHERE org_id = $1`, ws.OrgID).Scan(&minutes)
		if shortest == 0 || minutes < shortest {
			shortest = minutes
		}
	}
	return int64(shortest) * 60
}

// tooIdle is whether a refresh comes after the person's idle limit: the device was away that long, or the app says nobody touched it
// for that long. A call in progress never times out.
func (s *server) tooIdle(ctx context.Context, userID string, lastSeen, idleSeconds int64, onCall bool) bool {
	if onCall {
		return false
	}
	limit := s.idleLimit(ctx, userID)
	return limit > 0 && (now()-lastSeen > limit || idleSeconds > limit)
}

// ---- a reset needs a second proof (D239) ----

// hasSecondProof is whether the person has an authenticator app or unused recovery codes.
func (s *server) hasSecondProof(ctx context.Context, userID string) (bool, error) {
	var has bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mfa_factors WHERE user_id = $1 AND kind = 'totp') OR EXISTS (SELECT 1 FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL)`, userID).Scan(&has)
	return has, err
}

// secondProofOK checks a code from the authenticator app or a recovery code.
func (s *server) secondProofOK(ctx context.Context, u *user, code string) (bool, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return false, nil
	}
	if ok, err := s.verifyTOTP(ctx, u, code); err != nil || ok {
		return ok, err
	}
	return s.useRecoveryCode(ctx, u.id, code)
}

// askResetSupport is POST /v1/password/reset/support {token, reason}: someone with the email link who lost both their authenticator and
// their recovery codes asks support to check them; support may approve after 7 days.
func (s *server) askResetSupport(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Token  string `json:"token"`
		Reason string `json:"reason"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) < 10 || len(reason) > 2000 {
		return bad("Tell support what happened (10 to 2,000 characters).")
	}
	ctx := r.Context()
	email, err := s.fb.resetPassword(ctx, strings.TrimSpace(body.Token), "")
	if err != nil {
		return asAPI(err)
	}
	u, err := s.userBy(ctx, "email", email)
	if err != nil || u == nil {
		return errUnauthenticated
	}
	t := now()
	id := uuid.NewString()
	if _, err := s.db.Exec(ctx, `INSERT INTO reset_support_requests (id, user_id, reason, created_at, ready_at) VALUES ($1, $2, $3, $4, $5)`, id, u.id, reason, t, t+resetWaitSeconds); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "ready_at": t + resetWaitSeconds,
		"message": "Support will check it's you. For your safety nothing changes for 7 days; then you can reset with the email link alone."})
	return nil
}

// resetRequests is GET /v1/admin/reset-requests (staff).
func (s *server) resetRequests(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT q.id, q.user_id, u.email, q.reason, q.created_at, q.ready_at, q.decided_at, q.decision
		FROM reset_support_requests q JOIN users u ON u.id = q.user_id ORDER BY q.created_at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, user, email, reason, decision string
		var created, ready int64
		var decided *int64
		if err := rows.Scan(&id, &user, &email, &reason, &created, &ready, &decided, &decision); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "user_id": user, "email": email, "reason": reason, "created_at": created, "ready_at": ready, "decided_at": decided, "decision": decision})
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
	return rows.Err()
}

// decideResetRequest is POST /v1/admin/reset-requests/{id}/{decision} (staff, approve only after the wait): approving removes the
// person's authenticator apps and recovery codes, signs them out everywhere and emails them a reset link.
func (s *server) decideResetRequest(w http.ResponseWriter, r *http.Request) error {
	c, err := s.staffActor(r, true)
	if err != nil {
		return err
	}
	decision := r.PathValue("decision")
	if decision != "approve" && decision != "refuse" {
		return bad("approve or refuse.")
	}
	ctx := r.Context()
	var userID string
	var ready int64
	err = s.db.QueryRow(ctx, `SELECT user_id, ready_at FROM reset_support_requests WHERE id = $1 AND decided_at IS NULL`, r.PathValue("id")).Scan(&userID, &ready)
	if errors.Is(err, pgx.ErrNoRows) {
		return newError(http.StatusNotFound, "not_found", "No open request under that id.")
	}
	if err != nil {
		return err
	}
	if decision == "approve" && now() < ready {
		return newError(http.StatusConflict, "waiting", "The 7-day wait is not over yet.")
	}
	if decision == "approve" {
		for _, q := range []string{`DELETE FROM mfa_factors WHERE user_id = $1 AND kind = 'totp'`, `DELETE FROM recovery_codes WHERE user_id = $1`,
			`UPDATE sessions SET revoked_at = extract(epoch FROM now())::bigint WHERE user_id = $1 AND revoked_at IS NULL`} {
			if _, err := s.db.Exec(ctx, q, userID); err != nil {
				return err
			}
		}
		if u, err := s.userBy(ctx, "id", userID); err == nil && u != nil {
			if err := s.fb.sendPasswordReset(ctx, u.email); err != nil {
				log.Printf("WARN reset after support: %v", err)
			}
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE reset_support_requests SET decided_at = $2, decided_by = $3, decision = $4 WHERE id = $1`, r.PathValue("id"), now(), c.Sub, decision); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "decision": decision})
	return nil
}
