package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// noPassword is what a row keeps as its password hash: Firebase holds the real one, and no input hashes to this.
const noPassword = "!external-sign-in"

// Five failed sign-ins for one email within this many seconds pauses that email.
const (
	lockoutWindow   = 15 * 60
	lockoutFailures = 5
)

type server struct {
	cfg  config
	db   *pgxpool.Pool
	keys *keys
	fb   *firebase
	mail mailer    // nil: no notification service, Firebase sends its own emails
	tg   *telegram // nil: Telegram is not offered

	resets resetThrottle // password reset emails per address
}

type user struct {
	id, email, name string
	disabled        bool
	emailVerified   bool
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// newSecret is a random secret for the client and the hash the server keeps. Only the hash is stored.
func newSecret() (secret, hash string) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("no randomness: " + err.Error()) // nothing safe can be done without it
	}
	secret = hex.EncodeToString(b)
	return secret, sha256Hex(secret)
}

// userBy finds a person by one of the columns that identify them.
func (s *server) userBy(ctx context.Context, column, value string) (*user, error) {
	if column != "id" && column != "email" && column != "firebase_uid" {
		return nil, fmt.Errorf("userBy: %q is not a lookup column", column)
	}
	var u user
	var disabled, verified *int64
	err := s.db.QueryRow(ctx, "SELECT id, email, display_name, disabled_at, email_verified_at FROM users WHERE "+column+" = $1", value).
		Scan(&u.id, &u.email, &u.name, &disabled, &verified)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.disabled, u.emailVerified = disabled != nil, verified != nil
	return &u, nil
}

// outbox records an event for the bus, in the same transaction as the change it reports.
func outbox(ctx context.Context, tx pgx.Tx, name string, payload any) error {
	raw, _ := json.Marshal(payload)
	_, err := tx.Exec(ctx, "INSERT INTO outbox (id, name, payload, created_at) VALUES ($1, $2, $3, $4)", uuid.NewString(), name, string(raw), now())
	return err
}

// A confirmation link lasts two days.
const linkSeconds = 2 * 86_400

// newVerification makes a confirmation link for this person and the request to email it, and returns the token.
func newVerification(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	token, hash := newSecret()
	t := now()
	if _, err := tx.Exec(ctx, "INSERT INTO email_verifications (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", hash, userID, t, t+linkSeconds); err != nil {
		return "", err
	}
	// The one place an event carries a secret: the single-use link the notification service must put in the email.
	err := outbox(ctx, tx, "notification.requested", map[string]any{"user_id": userID, "template": "confirm_email", "data": map[string]any{"token": token}, "version": 1})
	return token, err
}

// sendConfirmation emails the confirmation link through the notification service. False when none is set (the caller then falls
// back to Firebase's own email) or when it could not be sent (logged; the person can ask for another link).
func (s *server) sendConfirmation(ctx context.Context, to, name, token string) bool {
	if s.mail == nil {
		return false
	}
	if err := s.mail.sendConfirmation(ctx, to, name, s.cfg.landingURL+"/verify?token="+token); err != nil {
		fmt.Printf("WARN confirmation email not sent: %v\n", err)
		return false
	}
	return true
}

// upsertFirebaseUser makes or updates the person's row from what Firebase says. The row's id is its own UUID; Firebase's uid is
// kept beside it.
func (s *server) upsertFirebaseUser(ctx context.Context, p fbProfile) (*user, error) {
	t := now()
	email, err := normalEmail(p.email)
	if err != nil {
		return nil, err
	}
	var verified *int64
	if p.emailVerified {
		verified = &t
	}
	name := strings.TrimSpace(p.name)
	existing, err := s.userBy(ctx, "firebase_uid", p.uid)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if _, err := s.db.Exec(ctx, "UPDATE users SET email = $1, email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $3", email, verified, existing.id); err != nil {
			return nil, err
		}
		if name != "" {
			if _, err := s.db.Exec(ctx, "UPDATE users SET display_name = $1 WHERE id = $2", name, existing.id); err != nil {
				return nil, err
			}
		}
	} else {
		other, err := s.userBy(ctx, "email", email)
		if err != nil {
			return nil, err
		}
		if other != nil {
			return nil, conflict("An account with this email already exists. Sign in instead.")
		}
		if name == "" {
			name, _, _ = strings.Cut(email, "@")
			if name == "" {
				name = "Caller Whale user"
			}
		}
		id := uuid.NewString()
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, "INSERT INTO users (id, email, display_name, password_hash, created_at, email_verified_at, firebase_uid) VALUES ($1, $2, $3, $4, $5, $6, $7)",
			id, email, name, noPassword, t, verified, p.uid); err != nil {
			return nil, err
		}
		if err := outbox(ctx, tx, "user.signed_up", map[string]any{"user_id": id, "version": 1}); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	found, err := s.userBy(ctx, "firebase_uid", p.uid)
	if err != nil {
		return nil, err
	}
	if found == nil {
		return nil, errUnauthenticated
	}
	return found, nil
}

// openSession opens a session and returns the tokens for it. provider: how it began ("password", "google", "apple"). fbRefresh is
// the person's Firebase refresh token, kept so this service can ask Firebase for them later.
func (s *server) openSession(ctx context.Context, u *user, kind string, mfaPassed bool, provider, fbRefresh string) (map[string]any, error) {
	t := now()
	id := uuid.NewString()
	refresh, refreshHash := newSecret()
	var fb *string
	if fbRefresh != "" {
		fb = &fbRefresh
	}
	mfa := int64(0)
	if mfaPassed {
		mfa = 1
	}
	_, err := s.db.Exec(ctx, "INSERT INTO sessions (id, user_id, refresh_hash, kind, mfa_passed, created_at, last_seen_at, expires_at, provider, fb_refresh) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)",
		id, u.id, refreshHash, kind, mfa, t, t+int64(s.cfg.refreshDays)*86_400, provider, fb)
	if err != nil {
		return nil, err
	}
	return s.tokens(u, id, mfaPassed, provider, t, refresh)
}

func (s *server) tokens(u *user, sid string, mfa bool, provider string, authTime int64, refresh string) (map[string]any, error) {
	access, expiresIn, err := s.keys.sign(person{id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified}, sid, mfa, provider, authTime, now(), s.cfg.accessMinutes)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    expiresIn,
		"refresh_token": refresh,
		"user":          map[string]any{"id": u.id, "email": u.email, "name": u.name, "email_verified": u.emailVerified},
	}, nil
}

func (s *server) recentFailures(ctx context.Context, email string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, "SELECT COUNT(*) FROM failed_sign_ins WHERE email = $1 AND at > $2", email, now()-lockoutWindow).Scan(&n)
	return n, err
}

func (s *server) recordFailure(ctx context.Context, email string) error {
	_, err := s.db.Exec(ctx, "INSERT INTO failed_sign_ins (email, at) VALUES ($1, $2)", email, now())
	return err
}

// mfaEnrolled is true when the person has set up any second step.
func (s *server) mfaEnrolled(ctx context.Context, userID string) (bool, error) {
	var one int
	err := s.db.QueryRow(ctx, "SELECT 1 FROM mfa_factors WHERE user_id = $1 LIMIT 1", userID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
