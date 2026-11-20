package main

// The second step at sign-in (phase 3; docs/plans/second-factor.md): an authenticator app (up to three devices), a code by email, a
// code by Telegram, or an approval on a device that is already signed in, plus ten recovery codes for a lost device. This service
// owns it, and the `mfa` claim in a token means one of these passed.
//
// A sign-in whose person has set something up answers `mfa_required` with a one-time challenge and the ways to answer it. Email and
// Telegram codes are six digits, good for ten minutes, used once. Five tries end a challenge, counted before the answer is looked at
// so parallel guesses cannot get more. A step-up (after a Google sign-in, or for a person who has set nothing up yet but must) is
// the same challenge on an open session.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	maxTOTP             = 3 // an authenticator app may be on this many devices; another removes the one set up longest ago
	challengeSeconds    = 600
	codeSeconds         = 600
	pushSeconds         = 300
	maxTries            = 5
	mfaResendSeconds    = 30
	telegramLinkSeconds = 600
	recoveryCodeCount   = 10
)

func (s *server) mfaRoutes(mux *http.ServeMux) {
	mux.Handle("GET /v1/mfa/factors", serve(s.factors))
	mux.Handle("DELETE /v1/mfa/factors/{id}", serve(s.removeFactor))
	mux.Handle("POST /v1/mfa/setup", serve(s.totpSetup))
	mux.Handle("POST /v1/mfa/totp/setup", serve(s.totpSetup))
	mux.Handle("POST /v1/mfa/confirm", serve(s.totpConfirm))
	mux.Handle("POST /v1/mfa/totp/confirm", serve(s.totpConfirm))
	mux.Handle("POST /v1/mfa/verify", serve(s.verifySession))
	mux.Handle("POST /v1/mfa/challenge/start", serve(s.challengeStart))
	mux.Handle("POST /v1/mfa/challenge/send", serve(s.challengeSend))
	mux.Handle("POST /v1/mfa/challenge/status", serve(s.challengeStatus))
	mux.Handle("POST /v1/mfa/challenge/answer", serve(s.challengeAnswer))
	mux.Handle("GET /v1/mfa/approvals", serve(s.approvals))
	mux.Handle("POST /v1/mfa/approvals/{id}", serve(s.decide))
	mux.Handle("POST /v1/mfa/email", serve(s.setEmailCodes))
	mux.Handle("POST /v1/mfa/telegram/link", serve(s.telegramLink))
	mux.Handle("POST /v1/mfa/telegram/webhook/{secret}", serve(s.telegramWebhook))
}

// mustHavePassed: an approval, a removal or a link from a session that has not passed a second step itself would be no second step.
func mustHavePassed(c claims) error {
	if !c.MFA {
		return forbidden("Confirm a second step on this device first.")
	}
	return nil
}

// ---- what a person has, and what a sign-in may use ----

type factor struct{ id, secret string }

func (s *server) totpSecrets(ctx context.Context, userID string) ([]factor, error) {
	rows, err := s.db.Query(ctx, "SELECT id, secret FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' ORDER BY n", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []factor
	for rows.Next() {
		var f factor
		if err := rows.Scan(&f.id, &f.secret); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *server) telegramChat(ctx context.Context, userID string) (string, error) {
	var chat string
	err := s.db.QueryRow(ctx, "SELECT secret FROM mfa_factors WHERE user_id = $1 AND kind = 'telegram' ORDER BY n DESC LIMIT 1", userID).Scan(&chat)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return chat, err
}

// approverExists: another session of this person that has passed a second step, which can approve a sign-in.
func (s *server) approverExists(ctx context.Context, userID, exceptSession string) (bool, error) {
	var one int
	err := s.db.QueryRow(ctx, "SELECT 1 FROM sessions WHERE user_id = $1 AND mfa_passed = 1 AND revoked_at IS NULL AND expires_at > $2 AND id <> $3 LIMIT 1", userID, now(), exceptSession).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// methods are the ways this person can answer a challenge right now. Never nil, so it is always a JSON list.
func (s *server) methods(ctx context.Context, u *user, session string) ([]string, error) {
	found := []string{}
	secrets, err := s.totpSecrets(ctx, u.id)
	if err != nil {
		return nil, err
	}
	if len(secrets) > 0 {
		found = append(found, "totp")
	}
	if s.mail != nil && u.emailVerified {
		if on, err := s.emailCodesOn(ctx, u.id); err != nil {
			return nil, err
		} else if on {
			found = append(found, "email")
		}
	}
	if s.tg != nil {
		if chat, err := s.telegramChat(ctx, u.id); err != nil {
			return nil, err
		} else if chat != "" {
			found = append(found, "telegram")
		}
	}
	if ok, err := s.approverExists(ctx, u.id, session); err != nil {
		return nil, err
	} else if ok {
		found = append(found, "push")
	}
	return found, nil
}

var totpOpts = totp.ValidateOpts{Period: 30, Skew: 1, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1}

func onlyDigits(code string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, code)
}

// totpMatch is the time step a six-digit code belongs to (this one, the one before or the one after, for clock drift).
func totpMatch(secret, code string, at time.Time) (int64, bool) {
	digits := onlyDigits(code)
	if len(digits) != 6 {
		return 0, false
	}
	for _, drift := range []int64{0, -1, 1} {
		step := at.Unix()/30 + drift
		want, err := totp.GenerateCodeCustom(secret, time.Unix(step*30, 0), totpOpts)
		if err != nil {
			return 0, false // not a usable secret
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(digits)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// verifyTOTP checks a code from an authenticator device, or an unused recovery code. A code from a device works once: the same code
// in the same clock window again is refused (RFC 6238 section 5.2).
func (s *server) verifyTOTP(ctx context.Context, u *user, code string) (bool, error) {
	code = strings.TrimSpace(code)
	secrets, err := s.totpSecrets(ctx, u.id)
	if err != nil {
		return false, err
	}
	for _, f := range secrets {
		step, ok := totpMatch(f.secret, code, time.Now())
		if !ok {
			continue
		}
		done, err := s.db.Exec(ctx, "UPDATE mfa_factors SET last_used_at = $1, last_step = $2 WHERE id = $3 AND (last_step IS NULL OR last_step < $2)", now(), step, f.id)
		if err != nil {
			return false, err
		}
		if done.RowsAffected() == 1 {
			return true, nil
		}
	}
	return s.useRecoveryCode(ctx, u.id, code)
}

// A recovery code is 20 hex digits in four groups. It is looked up without dashes, spaces or capitals, and only its hash is kept.
func recoveryNormal(code string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
			return r
		case r >= 'A' && r <= 'F':
			return r + 32
		}
		return -1
	}, code)
}

func recoveryHash(code string) string { return sha256Hex(recoveryNormal(code)) }

func newRecoveryCodes() []string {
	codes := make([]string, recoveryCodeCount)
	for i := range codes {
		b := make([]byte, 10)
		if _, err := rand.Read(b); err != nil {
			panic("no randomness: " + err.Error())
		}
		h := hex.EncodeToString(b)
		codes[i] = h[0:5] + "-" + h[5:10] + "-" + h[10:15] + "-" + h[15:20]
	}
	return codes
}

// useRecoveryCode marks a recovery code used. True when it was one of the person's unused codes.
func (s *server) useRecoveryCode(ctx context.Context, userID, code string) (bool, error) {
	if len(recoveryNormal(code)) != 20 {
		return false, nil
	}
	done, err := s.db.Exec(ctx, "UPDATE recovery_codes SET used_at = $1 WHERE user_id = $2 AND code_hash = $3 AND used_at IS NULL", now(), userID, recoveryHash(code))
	if err != nil {
		return false, err
	}
	return done.RowsAffected() == 1, nil
}

// ---- challenges ----

type challenge struct {
	id, userID, kind, provider string
	sessionID, fbRefresh       string // empty for a sign-in with no session yet / no Firebase refresh token
	codeHash, codeMethod       string
	codeSentAt, codeExpiresAt  int64
	tries                      int64
	pushState                  string
}

// challengeError makes a new challenge for a sign-in (no session yet) or for an open session, and the error that hands it to the client.
func (s *server) challengeError(ctx context.Context, u *user, session, kind, provider, fbRefresh string) (*apiError, error) {
	t := now()
	token, hash := newSecret()
	if _, err := s.db.Exec(ctx, "DELETE FROM mfa_challenges WHERE expires_at < $1", t); err != nil {
		return nil, err
	}
	var sess, fb *string
	if session != "" {
		sess = &session
	}
	if fbRefresh != "" {
		fb = &fbRefresh
	}
	if _, err := s.db.Exec(ctx, "INSERT INTO mfa_challenges (id, token_hash, user_id, session_id, session_kind, provider, fb_refresh, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		uuid.NewString(), hash, u.id, sess, kind, provider, fb, t, t+challengeSeconds); err != nil {
		return nil, err
	}
	methods, err := s.methods(ctx, u, session)
	if err != nil {
		return nil, err
	}
	e := newError(http.StatusUnauthorized, "mfa_required", "Confirm it is you with a second step.")
	e.extra = map[string]any{"challenge": token, "methods": methods}
	return e, nil
}

var errExpiredSignIn = forbidden("This sign-in has expired. Start again.")

func (s *server) loadChallenge(ctx context.Context, token string) (*challenge, error) {
	var c challenge
	var sess, fb, hash, method *string
	var sent, expires *int64
	err := s.db.QueryRow(ctx, "SELECT id, user_id, session_id, session_kind, provider, fb_refresh, code_hash, code_method, code_sent_at, code_expires_at, tries, push_state FROM mfa_challenges WHERE token_hash = $1 AND expires_at > $2",
		sha256Hex(strings.TrimSpace(token)), now()).Scan(&c.id, &c.userID, &sess, &c.kind, &c.provider, &fb, &hash, &method, &sent, &expires, &c.tries, &c.pushState)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errExpiredSignIn
	}
	if err != nil {
		return nil, err
	}
	c.sessionID, c.fbRefresh, c.codeHash, c.codeMethod = deref(sess), deref(fb), deref(hash), deref(method)
	if sent != nil {
		c.codeSentAt = *sent
	}
	if expires != nil {
		c.codeExpiresAt = *expires
	}
	return &c, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (s *server) challengeUser(ctx context.Context, c *challenge) (*user, error) {
	u, err := s.userBy(ctx, "id", c.userID)
	if err != nil {
		return nil, err
	}
	if u == nil || u.disabled {
		return nil, forbidden("This account is disabled.")
	}
	return u, nil
}

func sixDigits() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return leftPad(n.String(), 6), nil
}

func leftPad(s string, width int) string {
	for len(s) < width {
		s = "0" + s
	}
	return s
}

// challengeStart starts a step-up on the open session: for a Google sign-in, or for staff who have not set anything up.
func (s *server) challengeStart(w http.ResponseWriter, r *http.Request) error {
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
	e, err := s.challengeError(r.Context(), u, c.SID, "browser", c.Provider, "")
	if err != nil {
		return err
	}
	methods := e.extra["methods"].([]string)
	if len(methods) == 0 {
		return bad("No second step is available yet. Set up an authenticator app, or ask Caller Whale to turn on email codes.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"challenge": e.extra["challenge"], "methods": methods})
	return nil
}

type sendBody struct {
	Challenge string `json:"challenge"`
	Method    string `json:"method"`
	Device    string `json:"device"` // what to call this device in the approval prompt on the other one
}

// challengeSend sends the code (email or Telegram), or puts the sign-in in front of the person's other device.
func (s *server) challengeSend(w http.ResponseWriter, r *http.Request) error {
	var body sendBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	ch, err := s.loadChallenge(ctx, body.Challenge)
	if err != nil {
		return err
	}
	u, err := s.challengeUser(ctx, ch)
	if err != nil {
		return err
	}
	t := now()
	allowed, err := s.methods(ctx, u, ch.sessionID)
	if err != nil {
		return err
	}
	if !contains(allowed, body.Method) {
		return bad("That way is not available for this account.")
	}
	switch body.Method {
	case "email", "telegram":
		if ch.codeSentAt != 0 && t-ch.codeSentAt < mfaResendSeconds {
			return bad("A code was just sent. Wait a few seconds before asking for another.")
		}
		code, err := sixDigits()
		if err != nil {
			return err
		}
		if body.Method == "email" {
			if s.mail == nil {
				return bad("Email codes are not set up.")
			}
			if err := s.mail.sendCode(ctx, u.email, code); err != nil {
				return err
			}
		} else {
			if s.tg == nil {
				return bad("Telegram is not set up.")
			}
			chat, err := s.telegramChat(ctx, u.id)
			if err != nil {
				return err
			}
			if chat == "" {
				return bad("Telegram is not linked.")
			}
			text := code + " is your Caller Whale code. It works for 10 minutes. If you did not just try to sign in, ignore this and change your password."
			if err := s.tg.send(ctx, chat, text); err != nil {
				return err
			}
		}
		if _, err := s.db.Exec(ctx, "UPDATE mfa_challenges SET code_hash = $1, code_method = $2, code_sent_at = $3, code_expires_at = $4 WHERE id = $5", sha256Hex(code), body.Method, t, t+codeSeconds, ch.id); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"sent": true, "method": body.Method, "expires_in": codeSeconds})
		return nil
	case "push":
		label := strings.TrimSpace(body.Device)
		if label == "" {
			label = "A new device"
		}
		if utf8.RuneCountInString(label) > 80 {
			label = string([]rune(label)[:80])
		}
		if _, err := s.db.Exec(ctx, "UPDATE mfa_challenges SET push_state = 'pending', push_label = $1, code_sent_at = $2 WHERE id = $3", label, t, ch.id); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"sent": true, "method": "push", "expires_in": pushSeconds})
		return nil
	}
	return bad("Open your authenticator app and enter the code it shows.")
}

func contains(list []string, item string) bool {
	for _, x := range list {
		if x == item {
			return true
		}
	}
	return false
}

type challengeRef struct {
	Challenge string `json:"challenge"`
}

// challengeStatus says where an approval request stands, for the device waiting for it.
func (s *server) challengeStatus(w http.ResponseWriter, r *http.Request) error {
	var body challengeRef
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ch, err := s.loadChallenge(r.Context(), body.Challenge)
	if err != nil {
		return err
	}
	state := ch.pushState
	if state == "pending" && ch.codeSentAt != 0 && now()-ch.codeSentAt > pushSeconds {
		state = "expired"
	}
	writeJSON(w, http.StatusOK, map[string]any{"push": state})
	return nil
}

type answerBody struct {
	Challenge string `json:"challenge"`
	Method    string `json:"method"`
	Code      string `json:"code"`
}

func (s *server) challengeAnswer(w http.ResponseWriter, r *http.Request) error {
	var body answerBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	ch, err := s.loadChallenge(ctx, body.Challenge)
	if err != nil {
		return err
	}
	u, err := s.challengeUser(ctx, ch)
	if err != nil {
		return err
	}
	if body.Method != "totp" && body.Method != "email" && body.Method != "telegram" && body.Method != "push" {
		return bad("That way is not available for this account.")
	}
	// Every answer is counted first, in one statement: parallel guesses cannot get more than five tries between them.
	counted, err := s.db.Exec(ctx, "UPDATE mfa_challenges SET tries = tries + 1 WHERE id = $1 AND tries < $2", ch.id, maxTries)
	if err != nil {
		return err
	}
	if counted.RowsAffected() != 1 {
		if _, err := s.db.Exec(ctx, "DELETE FROM mfa_challenges WHERE id = $1", ch.id); err != nil {
			return err
		}
		return errTooMany
	}
	t := now()
	code := strings.TrimSpace(body.Code)
	passed := false
	switch body.Method {
	case "totp":
		passed, err = s.verifyTOTP(ctx, u, code)
		if err != nil {
			return err
		}
	case "email", "telegram":
		right := ch.codeMethod == body.Method && ch.codeExpiresAt > t && code != "" && ch.codeHash != "" &&
			subtle.ConstantTimeCompare([]byte(ch.codeHash), []byte(sha256Hex(code))) == 1
		if right {
			// A code works once, even if two answers with it arrive together.
			used, err := s.db.Exec(ctx, "UPDATE mfa_challenges SET code_hash = NULL WHERE id = $1 AND code_hash = $2", ch.id, ch.codeHash)
			if err != nil {
				return err
			}
			right = used.RowsAffected() == 1
		}
		passed = right
	case "push":
		passed = ch.pushState == "approved" && ch.codeSentAt != 0 && t-ch.codeSentAt <= pushSeconds
	}
	if !passed {
		if err := s.recordFailure(ctx, u.email); err != nil {
			return err
		}
		if body.Method == "push" && ch.pushState == "denied" {
			return forbidden("The sign-in was denied on your other device.")
		}
		return errWrongCode
	}
	return s.complete(ctx, w, ch, u)
}

// complete: a challenge answered. The sign-in opens its session, or the open session passes its step-up. The challenge is deleted
// in the same breath, so it can complete only once.
func (s *server) complete(ctx context.Context, w http.ResponseWriter, ch *challenge, u *user) error {
	done, err := s.db.Exec(ctx, "DELETE FROM mfa_challenges WHERE id = $1", ch.id)
	if err != nil {
		return err
	}
	if done.RowsAffected() != 1 {
		return errExpiredSignIn
	}
	if _, err := s.db.Exec(ctx, "DELETE FROM failed_sign_ins WHERE email = $1", u.email); err != nil {
		return err
	}
	if ch.sessionID == "" {
		reply, err := s.openSession(ctx, u, ch.kind, true, ch.provider, ch.fbRefresh)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, reply)
		return nil
	}
	return s.stepUpToken(ctx, w, u, ch.sessionID, ch.provider)
}

// stepUpToken: the open session has passed a second step, so it says so from now on, and this is a token that says so.
func (s *server) stepUpToken(ctx context.Context, w http.ResponseWriter, u *user, sid, provider string) error {
	var started int64
	err := s.db.QueryRow(ctx, "UPDATE sessions SET mfa_passed = 1, mfa_at = extract(epoch FROM now())::bigint WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING created_at", sid, u.id).Scan(&started)
	if errors.Is(err, pgx.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return err
	}
	// The person has just proved themselves with the second step, so this is a fresh authentication: auth_time is now, not when the
	// session began. Admin mode (Grafana) asks for a recent one, and a code entered in the dashboard must satisfy it.
	_ = started
	access, expiresIn, err := s.keys.sign(person{id: u.id, email: u.email, name: u.name, tag: u.tag, emailVerified: u.emailVerified}, sid, true, provider, now(), now(), s.cfg.accessMinutes)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": expiresIn})
	return nil
}

type codeBody struct {
	Code string `json:"code"`
}

// verifySession is the older step-up: a code from an authenticator device (or a recovery code) for the open session.
func (s *server) verifySession(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body codeBody
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
	if enrolled, err := s.mfaEnrolled(ctx, u.id); err != nil {
		return err
	} else if !enrolled {
		return bad("Two-step sign-in is not on for this account.")
	}
	if n, err := s.recentFailures(ctx, u.email); err != nil {
		return err
	} else if n >= lockoutFailures {
		return errTooMany
	}
	if ok, err := s.verifyTOTP(ctx, u, body.Code); err != nil {
		return err
	} else if !ok {
		if err := s.recordFailure(ctx, u.email); err != nil {
			return err
		}
		return errWrongCode
	}
	return s.stepUpToken(ctx, w, u, c.SID, c.Provider)
}

// ---- approvals on a device that is already signed in ----

func (s *server) approvals(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if err := mustHavePassed(c); err != nil {
		return err
	}
	t := now()
	rows, err := s.db.Query(r.Context(), "SELECT id, push_label, code_sent_at FROM mfa_challenges WHERE user_id = $1 AND push_state = 'pending' AND expires_at > $2 AND code_sent_at > $3 ORDER BY code_sent_at DESC", c.Sub, t, t-pushSeconds)
	if err != nil {
		return err
	}
	defer rows.Close()
	waiting := []map[string]any{}
	for rows.Next() {
		var id string
		var label *string
		var at *int64
		if err := rows.Scan(&id, &label, &at); err != nil {
			return err
		}
		waiting = append(waiting, map[string]any{"id": id, "device": label, "at": at})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": waiting})
	return nil
}

type decision struct {
	Approve bool `json:"approve"`
}

func (s *server) decide(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if err := mustHavePassed(c); err != nil {
		return err
	}
	var body decision
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	state := "denied"
	if body.Approve {
		state = "approved"
	}
	t := now()
	done, err := s.db.Exec(r.Context(), "UPDATE mfa_challenges SET push_state = $1 WHERE id = $2 AND user_id = $3 AND push_state = 'pending' AND expires_at > $4 AND code_sent_at > $5", state, r.PathValue("id"), c.Sub, t, t-pushSeconds)
	if err != nil {
		return err
	}
	if done.RowsAffected() != 1 {
		return forbidden("That request is no longer waiting.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// ---- what the person has set up ----

func (s *server) factors(w http.ResponseWriter, r *http.Request) error {
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
	rows, err := s.db.Query(ctx, "SELECT id, kind, label, created_at, last_used_at FROM mfa_factors WHERE user_id = $1 ORDER BY n", u.id)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id, kind, label string
		var created int64
		var used *int64
		if err := rows.Scan(&id, &kind, &label, &created, &used); err != nil {
			return err
		}
		list = append(list, map[string]any{"id": id, "kind": kind, "label": label, "created_at": created, "last_used_at": used})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	push, err := s.approverExists(ctx, u.id, c.SID)
	if err != nil {
		return err
	}
	emailOn, err := s.emailCodesOn(ctx, u.id)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"factors": list, "max_totp": maxTOTP, "email_enabled": emailOn,
		"available": map[string]any{"email": s.mail != nil && u.emailVerified, "telegram": s.tg != nil, "push": push},
	})
	return nil
}

// emailCodesOn says whether codes sent to the person's email are one of the ways they may answer the second step.
func (s *server) emailCodesOn(ctx context.Context, userID string) (bool, error) {
	var off int64
	if err := s.db.QueryRow(ctx, "SELECT mfa_email_off FROM users WHERE id = $1", userID).Scan(&off); err != nil {
		return false, err
	}
	return off == 0, nil
}

// setEmailCodes turns the email code on or off as a way to answer the second step. It needs a second step already set up (otherwise there
// is nothing to choose between) and done on this session, so a stolen session cannot switch a method off.
func (s *server) setEmailCodes(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if err := mustHavePassed(c); err != nil {
		return err
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if enrolled, err := s.mfaEnrolled(r.Context(), c.Sub); err != nil {
		return err
	} else if !enrolled {
		return bad("Set up two-step sign-in first.")
	}
	off := int64(1)
	if body.Enabled {
		off = 0
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET mfa_email_off = $1 WHERE id = $2", off, c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"email_enabled": body.Enabled})
	return nil
}

func (s *server) removeFactor(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if err := mustHavePassed(c); err != nil {
		return err
	}
	done, err := s.db.Exec(r.Context(), "DELETE FROM mfa_factors WHERE id = $1 AND user_id = $2", r.PathValue("id"), c.Sub)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": done.RowsAffected()})
	return nil
}

func (s *server) nextN(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID string) (int64, error) {
	var max *int64
	if err := q.QueryRow(ctx, "SELECT MAX(n) FROM mfa_factors WHERE user_id = $1", userID).Scan(&max); err != nil {
		return 0, err
	}
	if max == nil {
		return 1, nil
	}
	return *max + 1, nil
}

func (s *server) totpSetup(w http.ResponseWriter, r *http.Request) error {
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
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "Caller Whale", AccountName: u.email, Period: 30, SecretSize: 20, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, "UPDATE users SET totp_pending = $1 WHERE id = $2", key.Secret(), u.id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"secret": key.Secret(), "otpauth_url": otpauthURL(u.email, key.Secret())})
	return nil
}

type confirmBody struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}

// totpConfirm adds the authenticator device with its first code. A fourth device removes the one set up longest ago. The first way a
// person sets up also gives them recovery codes, once.
func (s *server) totpConfirm(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body confirmBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	var pending *string
	if err := s.db.QueryRow(ctx, "SELECT totp_pending FROM users WHERE id = $1", c.Sub).Scan(&pending); err != nil {
		return err
	}
	if pending == nil {
		return bad("Start setting up the authenticator first.")
	}
	if _, ok := totpMatch(*pending, body.Code, time.Now()); !ok {
		return errWrongCode
	}
	enrolled, err := s.mfaEnrolled(ctx, c.Sub)
	if err != nil {
		return err
	}
	// A session that has not passed a second step (a Google sign-in, say) must not be able to add its own authenticator to an account
	// that already has one: that would be a second step it picks itself. The session row says it, not the token: a token made before
	// this session passed one still says no.
	if enrolled {
		var passed int64
		if err := s.db.QueryRow(ctx, "SELECT mfa_passed FROM sessions WHERE id = $1", c.SID).Scan(&passed); err != nil {
			return err
		}
		if passed != 1 {
			return mustHavePassed(claims{})
		}
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = "Authenticator app"
	}
	if utf8.RuneCountInString(label) > 60 {
		label = string([]rune(label)[:60])
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// The pending secret is used once, even if two confirmations arrive together.
	used, err := tx.Exec(ctx, "UPDATE users SET totp_pending = NULL WHERE id = $1 AND totp_pending = $2", c.Sub, *pending)
	if err != nil {
		return err
	}
	if used.RowsAffected() != 1 {
		return bad("Start setting up the authenticator first.")
	}
	n, err := s.nextN(ctx, tx, c.Sub)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "INSERT INTO mfa_factors (id, user_id, kind, label, secret, created_at, n) VALUES ($1, $2, 'totp', $3, $4, $5, $6)", uuid.NewString(), c.Sub, label, *pending, now(), n); err != nil {
		return err
	}
	// The oldest devices beyond the limit go.
	rows, err := tx.Query(ctx, "SELECT id, label FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' ORDER BY n", c.Sub)
	if err != nil {
		return err
	}
	type device struct{ id, label string }
	var devices []device
	for rows.Next() {
		var d device
		if err := rows.Scan(&d.id, &d.label); err != nil {
			rows.Close()
			return err
		}
		devices = append(devices, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	removed := []string{}
	for i := 0; i < len(devices)-maxTOTP; i++ {
		if _, err := tx.Exec(ctx, "DELETE FROM mfa_factors WHERE id = $1", devices[i].id); err != nil {
			return err
		}
		removed = append(removed, devices[i].label)
	}
	codes := []string{}
	if !enrolled {
		codes = newRecoveryCodes()
		if _, err := tx.Exec(ctx, "DELETE FROM recovery_codes WHERE user_id = $1", c.Sub); err != nil {
			return err
		}
		for _, code := range codes {
			if _, err := tx.Exec(ctx, "INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)", c.Sub, recoveryHash(code)); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE sessions SET mfa_passed = 1, mfa_at = extract(epoch FROM now())::bigint WHERE id = $1", c.SID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"recovery_codes": codes, "removed": removed})
	return nil
}

// ---- Telegram ----

func (s *server) telegramLink(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if err := mustHavePassed(c); err != nil {
		return err
	}
	if s.tg == nil {
		return bad("Telegram is not set up on this server.")
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	code := hex.EncodeToString(b)
	ctx := r.Context()
	if _, err := s.db.Exec(ctx, "DELETE FROM telegram_links WHERE user_id = $1 OR expires_at < $2", c.Sub, now()); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, "INSERT INTO telegram_links (code_hash, user_id, expires_at) VALUES ($1, $2, $3)", sha256Hex(code), c.Sub, now()+telegramLinkSeconds); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": "https://t.me/" + s.tg.bot + "?start=" + code, "expires_in": telegramLinkSeconds})
	return nil
}

// telegramWebhook: Telegram posts here when someone writes to the bot. A `/start <code>` with a link code this service made links that
// chat. Anything but Telegram, with the secret in the address, finds nothing here.
func (s *server) telegramWebhook(w http.ResponseWriter, r *http.Request) error {
	expected := s.cfg.telegramSecret
	if expected == "" || subtle.ConstantTimeCompare([]byte(r.PathValue("secret")), []byte(expected)) != 1 {
		return forbidden("Not found.")
	}
	var update map[string]any
	if err := readJSON(w, r, &update); err != nil {
		return err
	}
	if s.tg == nil {
		writeJSON(w, http.StatusOK, map[string]any{})
		return nil
	}
	chat, text, ok := messageOf(update)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{})
		return nil
	}
	ctx := r.Context()
	reply := func(message string) {
		_ = s.tg.send(ctx, chat, message)
		writeJSON(w, http.StatusOK, map[string]any{})
	}
	code, isStart := strings.CutPrefix(strings.TrimSpace(text), "/start ")
	if !isStart {
		reply("To link Caller Whale, open the link from your account's security settings.")
		return nil
	}
	hash := sha256Hex(strings.TrimSpace(code))
	// The link works once: of two requests with it, one finds it.
	var userID string
	err := s.db.QueryRow(ctx, "DELETE FROM telegram_links WHERE code_hash = $1 AND expires_at > $2 RETURNING user_id", hash, now()).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		reply("That link has expired. Make a new one in your account's security settings.")
		return nil
	}
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	n, err := s.nextN(ctx, tx, userID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM mfa_factors WHERE user_id = $1 AND kind = 'telegram'", userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "INSERT INTO mfa_factors (id, user_id, kind, label, secret, created_at, n) VALUES ($1, $2, 'telegram', 'Telegram', $3, $4, $5)", uuid.NewString(), userID, chat, now(), n); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	reply("Linked. Caller Whale will send your sign-in codes here.")
	return nil
}

// otpauthURL is the address an authenticator app scans: the usual form, with the @ in the label escaped.
func otpauthURL(email, secret string) string {
	issuer := "Caller%20Whale"
	return "otpauth://totp/" + issuer + ":" + strings.ReplaceAll(email, "@", "%40") + "?secret=" + secret + "&issuer=" + issuer + "&algorithm=SHA1&digits=6&period=30"
}
