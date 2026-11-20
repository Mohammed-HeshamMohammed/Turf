package main

// Passwords and email confirmation (phase 2). Firebase checks and stores passwords and hosts its own reset and confirmation
// links; this service ends sessions when a password changes, and makes its own single-use confirmation link when a notification
// service is set.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// A new confirmation link at most once a minute per person.
const resendSeconds = 60

func (s *server) accountRoutes(mux *http.ServeMux) {
	mux.Handle("POST /v1/password", serve(s.changePassword))
	mux.Handle("POST /v1/password/forgot", serve(s.forgotPassword))
	mux.Handle("POST /v1/password/reset", serve(s.resetPassword))
	mux.Handle("POST /v1/email/verify", serve(s.verifyEmail))
	mux.Handle("POST /v1/email/resend", serve(s.resendEmail))
}

// sessionIDToken is a current Firebase ID token for a session, from the refresh token the session keeps.
func (s *server) sessionIDToken(ctx context.Context, sid string) (string, error) {
	var stored *string
	err := s.db.QueryRow(ctx, "SELECT fb_refresh FROM sessions WHERE id = $1 AND revoked_at IS NULL", sid).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (stored == nil || *stored == "")) {
		return "", errUnauthenticated
	}
	if err != nil {
		return "", err
	}
	login, err := s.fb.refresh(ctx, *stored)
	if err != nil {
		return "", asAPI(err)
	}
	if login.refreshToken != "" && login.refreshToken != *stored {
		if _, err := s.db.Exec(ctx, "UPDATE sessions SET fb_refresh = $1 WHERE id = $2", login.refreshToken, sid); err != nil {
			return "", err
		}
	}
	return login.idToken, nil
}

type passwordChange struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

// changePassword changes the password and closes every other session.
func (s *server) changePassword(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body passwordChange
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	u, err := s.userBy(ctx, "id", c.Sub)
	if err != nil {
		return err
	}
	if u == nil {
		return errUnauthenticated
	}
	if err := validateNewPassword(body.New); err != nil {
		return err
	}
	// Firebase checks the current password. An account with an old authenticator answers "needs a code", which also means the
	// password was right.
	if _, err := s.fb.signIn(ctx, u.email, body.Current); err != nil {
		kind, isRefusal := asRefusal(err)
		switch {
		case isRefusal && kind == refusedFirebaseAuthenticator:
		case isRefusal && (kind == refusedWrongPassword || kind == refusedDisabled):
			return errWrongCredentials
		default:
			return asAPI(err) // Firebase unreachable or misconfigured: not the person's mistake
		}
	}
	id, err := s.sessionIDToken(ctx, c.SID)
	if err != nil {
		return err
	}
	if err := s.fb.setPassword(ctx, id, body.New); err != nil {
		return asAPI(err)
	}
	if _, err := s.db.Exec(ctx, "UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL", now(), u.id, c.SID); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

type forgotBody struct {
	Email string `json:"email"`
}

// forgotPassword emails a reset link (Firebase sends it). The answer is the same for any address, and one address is asked for
// at most three times an hour, so this cannot be used to fill someone's inbox.
func (s *server) forgotPassword(w http.ResponseWriter, r *http.Request) error {
	var body forgotBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	email, err := normalEmail(body.Email)
	if err != nil {
		return err
	}
	if s.resets.allow(email, time.Now()) {
		if err := s.fb.sendPasswordReset(r.Context(), email); err != nil {
			return asAPI(err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

type resetBody struct {
	Token string `json:"token"`
	New   string `json:"new"`
	// A code from the authenticator app, or a recovery code, for someone who has either (step 35, D239).
	Code string `json:"code"`
}

// resetPassword sets a new password with the code from the reset link, and ends every session of that person.
func (s *server) resetPassword(w http.ResponseWriter, r *http.Request) error {
	var body resetBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if err := validateNewPassword(body.New); err != nil {
		return err
	}
	ctx := r.Context()
	// The link alone is not enough for someone with an authenticator or recovery codes: one of them too (step 35, D239). Firebase
	// checks the link's code without using it first.
	who, err := s.fb.resetPassword(ctx, strings.TrimSpace(body.Token), "")
	if err != nil {
		return asAPI(err)
	}
	if u, err := s.userBy(ctx, "email", who); err == nil && u != nil {
		has, err := s.hasSecondProof(ctx, u.id)
		if err != nil {
			return err
		}
		if has {
			ok, err := s.secondProofOK(ctx, u, body.Code)
			if err != nil {
				return err
			}
			if !ok {
				return newError(http.StatusForbidden, "second_proof_required", "Enter a code from your authenticator app, or one of your recovery codes. Lost both? Ask support to check it's you.")
			}
		}
	}
	email, err := s.fb.resetPassword(ctx, strings.TrimSpace(body.Token), body.New)
	if err != nil {
		return asAPI(err)
	}
	if _, err := s.db.Exec(ctx, "UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE email = $2)", now(), email); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

type verifyBody struct {
	Token string `json:"token"`
}

// verifyEmail confirms an address with the link's token: one of ours, or (sent by Firebase before the notification service took
// over, or while none is set) one of Firebase's own.
func (s *server) verifyEmail(w http.ResponseWriter, r *http.Request) error {
	var body verifyBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	token := strings.TrimSpace(body.Token)
	if token == "" || len(token) > 2048 {
		return forbidden("This link is not valid or has expired.")
	}
	t := now()
	// One statement uses the link: of two requests with the same token only one finds it unused.
	var userID string
	err := s.db.QueryRow(ctx, "UPDATE email_verifications SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1 RETURNING user_id", t, sha256Hex(token)).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		email, err := s.fb.confirmEmail(ctx, token)
		if err != nil {
			// Firebase not knowing the code is the person's problem; Firebase being unreachable or misconfigured is ours.
			if kind, ok := asRefusal(err); ok && kind != refusedSetup && kind != refusedOther && kind != refusedTooMany {
				return forbidden("This link is not valid or has expired.")
			}
			return asAPI(err)
		}
		if _, err := s.db.Exec(ctx, "UPDATE users SET email_verified_at = $1 WHERE email = $2 AND email_verified_at IS NULL", t, email); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"email_verified": true})
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, "UPDATE users SET email_verified_at = $1 WHERE id = $2 AND email_verified_at IS NULL", t, userID); err != nil {
		return err
	}
	// Tokens issued before this still say "not confirmed" until they are refreshed, at most 15 minutes.
	writeJSON(w, http.StatusOK, map[string]any{"email_verified": true})
	return nil
}

// resendEmail sends a new confirmation link.
func (s *server) resendEmail(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	u, err := s.userBy(ctx, "id", c.Sub)
	if err != nil {
		return err
	}
	if u == nil {
		return errUnauthenticated
	}
	if u.emailVerified {
		writeJSON(w, http.StatusOK, map[string]any{"email_verified": true})
		return nil
	}
	// With no notification service set, Firebase sends its own email.
	if s.mail == nil {
		id, err := s.sessionIDToken(ctx, c.SID)
		if err != nil {
			return err
		}
		if err := s.fb.sendVerification(ctx, id); err != nil {
			return asAPI(err)
		}
		writeJSON(w, http.StatusOK, map[string]any{"email_verified": false, "sent": true})
		return nil
	}
	var latest *int64
	if err := s.db.QueryRow(ctx, "SELECT MAX(created_at) FROM email_verifications WHERE user_id = $1", u.id).Scan(&latest); err != nil {
		return err
	}
	if latest != nil && now()-*latest < resendSeconds {
		return bad("A link was just sent. Wait a minute before asking for another.")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	token, err := newVerification(ctx, tx, u.id)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.sendConfirmation(ctx, u.email, u.name, token)
	reply := map[string]any{"email_verified": false, "sent": true}
	if s.cfg.devTokens {
		reply["verification_token"] = token
	}
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// resetThrottle allows one address a few reset emails an hour. In memory, per copy of the service; the gateway limits by caller.
type resetThrottle struct {
	mu    sync.Mutex
	times map[string][]time.Time
}

const (
	resetsPerHour = 3
	resetKeep     = 50_000 // addresses remembered at most
)

func (t *resetThrottle) allow(email string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.times == nil || len(t.times) > resetKeep {
		t.times = map[string][]time.Time{}
	}
	recent := t.times[email][:0]
	for _, at := range t.times[email] {
		if now.Sub(at) < time.Hour {
			recent = append(recent, at)
		}
	}
	if len(recent) >= resetsPerHour {
		t.times[email] = recent
		return false
	}
	t.times[email] = append(recent, now)
	return true
}
