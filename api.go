package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/rs/cors"
)

// version is shown by /version, which is for the private network only (the gateway does not pass it on).
const version = "0.1.0"

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "auth"})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": "auth", "version": version})
	})
	mux.HandleFunc("GET /.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_, _ = w.Write(s.keys.jwks)
	})
	// This service never checks reCAPTCHA (the gateway does and edits this answer on its way out).
	mux.HandleFunc("GET /v1/security", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"bot_protection":  map[string]any{"enabled": false, "site_key": ""},
			"password_policy": map[string]any{"minimum": 8, "maximum": 4096, "uppercase": true, "lowercase": true, "number": true, "special": true},
		})
	})
	mux.Handle("POST /v1/accounts", serve(s.signUp))
	mux.Handle("POST /v1/sessions", serve(s.signIn))
	mux.Handle("GET /v1/sessions", serve(s.listSessions))
	mux.Handle("POST /v1/sessions/refresh", serve(s.refresh))
	mux.Handle("POST /v1/sessions/sign-out", serve(s.signOut))
	mux.Handle("POST /v1/sessions/revoke", serve(s.revoke))
	mux.Handle("GET /v1/me", serve(s.me))
	mux.Handle("POST /v1/me/profile", serve(s.updateProfile))
	mux.Handle("POST /v1/me/username", serve(s.updateUsername))
	mux.Handle("POST /v1/me/birth-date", serve(s.setBirthDate))
	mux.Handle("POST /v1/me/terms", serve(s.acceptTerms))
	mux.Handle("POST /v1/me/work", serve(s.setWorkProfile))
	mux.Handle("GET /v1/me/access", serve(s.meAccess))
	mux.Handle("GET /v1/admin/staff", serve(s.adminStaff))
	mux.Handle("POST /v1/admin/staff", serve(s.assignStaff))
	mux.Handle("GET /v1/admin/invitations", serve(s.listPlatformInvitations))
	mux.Handle("GET /v1/admin/members", serve(s.adminMembers))
	mux.Handle("GET /v1/admin/overview", serve(s.adminOverview))
	mux.Handle("GET /v1/announcement", serve(s.getAnnouncement))
	mux.Handle("PUT /v1/admin/announcement", serve(s.setAnnouncement))
	mux.Handle("GET /v1/admin/costs", serve(s.listCosts))
	mux.Handle("POST /v1/admin/costs", serve(s.addCost))
	mux.Handle("DELETE /v1/admin/costs/{id}", serve(s.deleteCost))
	mux.Handle("GET /v1/admin/rates", serve(s.listRates))
	mux.Handle("GET /v1/admin/plans", serve(s.adminPlans))
	mux.Handle("POST /v1/admin/memberships", serve(s.giveMembership))
	mux.Handle("POST /v1/admin/rates", serve(s.addRate))
	mux.Handle("DELETE /v1/admin/rates/{id}", serve(s.deleteRate))
	mux.Handle("POST /v1/admin/invitations", serve(s.invitePlatform))
	mux.Handle("GET /v1/orgs/{org}/members", serve(s.workspaceMembers))
	mux.Handle("GET /v1/fx", serve(s.publicFX))
	mux.Handle("POST /v1/me/currency", serve(s.setCurrency))
	mux.Handle("GET /v1/roles", serve(s.roleCatalog))
	mux.Handle("GET /v1/orgs/{org}/standing", serve(s.workspaceStanding))
	mux.Handle("GET /v1/orgs/{org}/roles", serve(s.workspaceRoles))
	mux.Handle("PUT /v1/orgs/{org}/members/{user}", serve(s.changeWorkspaceMember))
	mux.Handle("DELETE /v1/orgs/{org}/members/{user}", serve(s.removeWorkspaceMember))
	mux.Handle("POST /v1/orgs/{org}/members/{user}/suspend", serve(s.suspendWorkspaceMember(false)))
	mux.Handle("POST /v1/orgs/{org}/members/{user}/restore", serve(s.suspendWorkspaceMember(true)))
	mux.Handle("GET /v1/orgs/{org}/teams", serve(s.workspaceTeams))
	mux.Handle("PUT /v1/orgs/{org}/teams/{team}", serve(s.putWorkspaceTeam))
	mux.Handle("DELETE /v1/orgs/{org}/teams/{team}", serve(s.deleteWorkspaceTeam))
	mux.Handle("GET /v1/orgs/{org}/invitations", serve(s.listWorkspaceInvitations))
	mux.Handle("POST /v1/orgs/{org}/invitations", serve(s.inviteWorkspace))
	mux.Handle("DELETE /v1/invitations/{id}", serve(s.revokeInvitation))
	mux.Handle("GET /v1/me/invitations", serve(s.myInvitations))
	mux.Handle("POST /v1/me/invitations/{id}/accept", serve(s.acceptInvitation))
	mux.Handle("GET /v1/me/invitations/{id}", serve(s.myInvitation))
	mux.Handle("POST /v1/me/invitations/{id}/report", serve(s.reportInvitation))
	mux.Handle("GET /v1/admin/invitation-reports", serve(s.invitationReports))
	mux.Handle("POST /v1/invitations/{id}/resend", serve(s.resendInvitation))
	mux.Handle("POST /v1/invitations/{id}/extend", serve(s.extendInvitation))
	mux.Handle("POST /v1/me/invitations/{id}/decline", serve(s.declineInvitation))
	mux.Handle("GET /v1/me/blocked-agencies", serve(s.blockedAgencies))
	mux.Handle("POST /v1/me/blocked-agencies", serve(s.blockAgency))
	mux.Handle("DELETE /v1/me/blocked-agencies/{org}", serve(s.unblockAgency))
	mux.Handle("GET /v1/orgs/{org}/invitation-settings", serve(s.workspaceInvitationSettings))
	mux.Handle("PUT /v1/orgs/{org}/invitation-settings", serve(s.putWorkspaceInvitationSettings))
	s.accountRoutes(mux)
	s.mfaRoutes(mux)
	s.oauthRoutes(mux)
	s.connectorRoutes(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found."})
	})

	// Browsers call this service directly with a bearer token (no cookies), from the origins listed in AUTH_ALLOWED_ORIGINS.
	policy := cors.New(cors.Options{
		AllowedOrigins: s.cfg.allowedOrigins,
		AllowedMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
		AllowedHeaders: []string{"Content-Type", "Authorization"},
	})
	return logHTTP(policy.Handler(mux))
}

// ---- the signed-in person ----

// person is the claims of a request's `Authorization: Bearer <access token>`, with a session that is still open.
func (s *server) person(r *http.Request) (claims, error) {
	header := r.Header.Get("Authorization")
	if len(header) < 8 || !strings.EqualFold(header[:7], "bearer ") {
		return claims{}, errUnauthenticated
	}
	c, err := s.keys.verify(strings.TrimSpace(header[7:]), time.Now())
	if err != nil {
		return claims{}, errUnauthenticated
	}
	// Other services trust the token until it expires; this service also refuses one whose session was closed.
	var one int
	err = s.db.QueryRow(r.Context(), "SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3", c.SID, c.Sub, now()).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return claims{}, errUnauthenticated
	}
	if err != nil {
		return claims{}, err
	}
	return c, nil
}

func kindOf(kind string) (string, error) {
	switch kind {
	case "", "browser":
		return "browser", nil
	case "desktop":
		return "desktop", nil
	}
	return "", bad("kind is browser or desktop.")
}

// ---- sign-up and sign-in ----

type signUpBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	// The date of birth (YYYY-MM-DD): the age check. Optional here; an account without one is asked for it before anything else.
	BirthDate string `json:"birth_date"`
	// The version of the terms and privacy notice they ticked. Required, and must be the current one.
	TermsVersion string `json:"terms_version"`
}

func (s *server) signUp(w http.ResponseWriter, r *http.Request) error {
	var body signUpBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if !s.cfg.publicSignup {
		return forbidden("New accounts are by invitation on this server.")
	}
	email, err := normalEmail(body.Email)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if n := utf8.RuneCountInString(name); n == 0 || n > 200 {
		return bad("Enter your name.")
	}
	var birth time.Time
	if strings.TrimSpace(body.BirthDate) != "" {
		var err error
		if birth, err = parseBirthDate(body.BirthDate, time.Now()); err != nil {
			return err
		}
	}
	if body.TermsVersion != termsVersion && !previousTermsVersions[body.TermsVersion] {
		return bad("Accept the Terms and the Privacy Policy to create an account.")
	}
	kind, err := kindOf(body.Kind)
	if err != nil {
		return err
	}
	if err := validateNewPassword(body.Password); err != nil {
		return err
	}
	ctx := r.Context()
	login, err := s.fb.signUp(ctx, email, body.Password)
	if err != nil {
		return asAPI(err)
	}
	// The name and the confirmation email are nice to have; the account exists either way.
	_ = s.fb.setName(ctx, login.idToken, name)
	profile, err := s.fb.profile(ctx, login.idToken)
	if err != nil {
		return asAPI(err)
	}
	profile.name = name
	u, err := s.upsertFirebaseUser(ctx, profile)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, "UPDATE users SET terms_version = $1, terms_accepted_at = $2 WHERE id = $3", body.TermsVersion, now(), u.id); err != nil {
		return err
	}
	if !birth.IsZero() {
		if _, err := s.db.Exec(ctx, "UPDATE users SET birth_date = $1, age_confirmed_at = $2 WHERE id = $3", birth.Format("2006-01-02"), now(), u.id); err != nil {
			return err
		}
	}
	if s.mail != nil {
		// The notification service sends the confirmation email, with a link this service makes and checks itself.
		if !u.emailVerified {
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return err
			}
			token, err := newVerification(ctx, tx, u.id)
			if err != nil {
				_ = tx.Rollback(ctx)
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			s.sendConfirmation(ctx, u.email, u.name, token)
		}
	} else {
		_ = s.fb.sendVerification(ctx, login.idToken)
	}
	reply, err := s.openSession(ctx, u, kind, false, "password", login.refreshToken)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, reply)
	return nil
}

type signInBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Code     string `json:"code"` // a code from the authenticator app, or a recovery code
	Kind     string `json:"kind"`
}

func (s *server) signIn(w http.ResponseWriter, r *http.Request) error {
	var body signInBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	email := strings.ToLower(strings.TrimSpace(body.Email))
	kind, err := kindOf(body.Kind)
	if err != nil {
		return err
	}
	failures, err := s.recentFailures(ctx, email)
	if err != nil {
		return err
	}
	if failures >= lockoutFailures {
		return errTooMany
	}
	login, err := s.fb.signIn(ctx, email, body.Password)
	if err != nil {
		if kind, ok := asRefusal(err); ok && (kind == refusedWrongPassword || kind == refusedDisabled) {
			if err := s.recordFailure(ctx, email); err != nil {
				return err
			}
		}
		return asAPI(err)
	}
	profile, err := s.fb.profile(ctx, login.idToken)
	if err != nil {
		return asAPI(err)
	}
	u, err := s.upsertFirebaseUser(ctx, profile)
	if err != nil {
		return err
	}
	if u.disabled {
		return errWrongCredentials
	}
	return s.finishSignIn(ctx, w, u, kind, "password", login.refreshToken, email, body.Code)
}

// finishSignIn runs after the password is right: a person who has set up a second step passes it (a code sent along with the sign-in,
// or a challenge to answer) before a session opens; anyone else gets a session that has not passed one yet.
func (s *server) finishSignIn(ctx context.Context, w http.ResponseWriter, u *user, kind, provider, fbRefresh, email, code string) error {
	passed := false
	enrolled, err := s.mfaEnrolled(ctx, u.id)
	if err != nil {
		return err
	}
	if enrolled {
		code = strings.TrimSpace(code)
		if code == "" {
			challenge, err := s.challengeError(ctx, u, "", kind, provider, fbRefresh)
			if err != nil {
				return err
			}
			return challenge
		}
		ok, err := s.verifyTOTP(ctx, u, code)
		if err != nil {
			return err
		}
		if !ok {
			if err := s.recordFailure(ctx, email); err != nil {
				return err
			}
			return errWrongCode
		}
		passed = true
	}
	if _, err := s.db.Exec(ctx, "DELETE FROM failed_sign_ins WHERE email = $1", email); err != nil {
		return err
	}
	reply, err := s.openSession(ctx, u, kind, passed, provider, fbRefresh)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// ---- sessions ----

type refreshBody struct {
	RefreshToken string `json:"refresh_token"`
}

// refresh swaps a refresh token for a new pair. The token changes every time it is used, and one that was already used ends its
// session, because someone copied it.
func (s *server) refresh(w http.ResponseWriter, r *http.Request) error {
	var body refreshBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	presented := sha256Hex(strings.TrimSpace(body.RefreshToken))
	t := now()
	var sid, userID, provider string
	var mfa, started int64
	err := s.db.QueryRow(ctx, "SELECT id, user_id, mfa_passed, provider, created_at FROM sessions WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > $2", presented, t).
		Scan(&sid, &userID, &mfa, &provider, &started)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.reused(ctx, presented)
	}
	if err != nil {
		return err
	}
	u, err := s.userBy(ctx, "id", userID)
	if err != nil {
		return err
	}
	if u == nil || u.disabled {
		return errUnauthenticated
	}
	// Firebase hosts its own confirmation link, so ask it whether the address is confirmed now.
	if !u.emailVerified {
		if updated := s.freshFirebaseUser(ctx, sid); updated != nil {
			u = updated
		}
	}
	next, nextHash := newSecret()
	// One statement decides it: only the holder of the current token moves the session on. A second request with the same token
	// finds it already moved and is treated as a copied token.
	done, err := s.db.Exec(ctx, "UPDATE sessions SET refresh_hash = $1, prev_refresh_hash = $2, last_seen_at = $3 WHERE id = $4 AND refresh_hash = $2 AND revoked_at IS NULL", nextHash, presented, t, sid)
	if err != nil {
		return err
	}
	if done.RowsAffected() != 1 {
		return s.reused(ctx, presented)
	}
	reply, err := s.tokens(u, sid, mfa == 1, provider, started, next)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// reused is a refresh token that is not the current one: if it was the one before, someone else has it. End that session.
func (s *server) reused(ctx context.Context, presented string) error {
	if _, err := s.db.Exec(ctx, "UPDATE sessions SET revoked_at = $1 WHERE prev_refresh_hash = $2 AND revoked_at IS NULL", now(), presented); err != nil {
		return err
	}
	return errUnauthenticated
}

// freshFirebaseUser asks Firebase about the person of a session and updates their row; nil when it cannot (that is not an error
// here: the refresh goes on with what is known).
func (s *server) freshFirebaseUser(ctx context.Context, sid string) *user {
	var fbRefresh *string
	if err := s.db.QueryRow(ctx, "SELECT fb_refresh FROM sessions WHERE id = $1 AND revoked_at IS NULL", sid).Scan(&fbRefresh); err != nil || fbRefresh == nil || *fbRefresh == "" {
		return nil
	}
	login, err := s.fb.refresh(ctx, *fbRefresh)
	if err != nil {
		return nil
	}
	if login.refreshToken != "" && login.refreshToken != *fbRefresh {
		if _, err := s.db.Exec(ctx, "UPDATE sessions SET fb_refresh = $1 WHERE id = $2", login.refreshToken, sid); err != nil {
			log.Printf("WARN could not save the renewed sign-in token for session %s: %v", sid, err) // the next renewal would fail and sign the person out
		}
	}
	profile, err := s.fb.profile(ctx, login.idToken)
	if err != nil {
		return nil
	}
	updated, err := s.upsertFirebaseUser(ctx, profile)
	if err != nil {
		return nil
	}
	return updated
}

// signOut ends the session of the access token, or of the refresh token in the body.
func (s *server) signOut(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	t := now()
	if c, err := s.person(r); err == nil {
		if _, err := s.db.Exec(ctx, "UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL", t, c.SID); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	}
	var body refreshBody
	if r.Body != nil {
		_ = readJSON(w, r, &body)
	}
	if strings.TrimSpace(body.RefreshToken) == "" {
		return errUnauthenticated
	}
	if _, err := s.db.Exec(ctx, "UPDATE sessions SET revoked_at = $1 WHERE refresh_hash = $2 AND revoked_at IS NULL", t, sha256Hex(strings.TrimSpace(body.RefreshToken))); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (s *server) listSessions(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), "SELECT id, kind, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_seen_at DESC", c.Sub, now())
	if err != nil {
		return err
	}
	defer rows.Close()
	sessions := []map[string]any{}
	for rows.Next() {
		var id, kind string
		var created, seen int64
		if err := rows.Scan(&id, &kind, &created, &seen); err != nil {
			return err
		}
		sessions = append(sessions, map[string]any{"id": id, "kind": kind, "created_at": created, "last_seen_at": seen, "current": id == c.SID})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
	return nil
}

type revokeBody struct {
	SessionID string `json:"session_id"`
	Others    bool   `json:"others"` // close every other session of this person
}

func (s *server) revoke(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body revokeBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	var closed int64
	if body.Others {
		done, err := s.db.Exec(r.Context(), "UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL", now(), c.Sub, c.SID)
		if err != nil {
			return err
		}
		closed = done.RowsAffected()
	} else {
		if body.SessionID == "" {
			return bad("Say which session to close.")
		}
		done, err := s.db.Exec(r.Context(), "UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id = $3 AND revoked_at IS NULL", now(), c.Sub, body.SessionID)
		if err != nil {
			return err
		}
		closed = done.RowsAffected()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": closed})
	return nil
}

func (s *server) me(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	u, err := s.userBy(r.Context(), "id", c.Sub)
	if err != nil {
		return err
	}
	if u == nil {
		return errUnauthenticated
	}
	enrolled, err := s.mfaEnrolled(r.Context(), u.id)
	if err != nil {
		return err
	}
	var phone, avatar, currency, first, middle, last, username string
	var ageConfirmed int64
	if err := s.db.QueryRow(r.Context(), "SELECT phone, avatar, currency, first_name, middle_name, last_name, age_confirmed_at, COALESCE(username, '') FROM users WHERE id = $1", u.id).Scan(&phone, &avatar, &currency, &first, &middle, &last, &ageConfirmed, &username); err != nil {
		return err
	}
	termsAccepted, workAnswers, err := s.onboarding(r, u.id)
	if err != nil {
		return err
	}
	exempt := false
	if ageConfirmed == 0 || !termsAccepted || workAnswers == nil {
		exempt = s.setupExempt(r.Context(), u.id)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": u.id, "email": u.email, "name": u.name, "mfa_enrolled": enrolled, "email_verified": u.emailVerified,
		"mfa_passed": c.MFA, "session_id": c.SID,
		"phone": phone, "avatar": avatar, "currency": currency,
		"first_name": first, "middle_name": middle, "last_name": last, "username": username,
		"age_confirmed":  ageConfirmed > 0,
		"terms_accepted": termsAccepted, "terms_version": termsVersion, "work_profile": workAnswers, "setup_exempt": exempt,
	})
	return nil
}
