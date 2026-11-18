package main

// Firebase Authentication as the account store, through Firebase's documented REST API (Identity Toolkit and Secure Token). This
// service is the only part of Caller Whale that talks to Firebase: passwords, email confirmation and provider sign-in live
// there; this service keeps a row per person and per session and hands every other part its own signed tokens.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type firebase struct {
	apiKey   string
	identity string // https://identitytoolkit.googleapis.com (a stand-in in tests)
	token    string // https://securetoken.googleapis.com
	http     *http.Client
}

func newFirebase(apiKey, identity, token string) *firebase {
	return &firebase{apiKey: apiKey, identity: identity, token: token, http: &http.Client{Timeout: 15 * time.Second}}
}

// fbLogin is what a successful Firebase sign-in or sign-up hands back.
type fbLogin struct {
	idToken      string
	refreshToken string
	uid          string
}

// fbProfile is a person as Firebase describes them.
type fbProfile struct {
	uid           string
	email         string
	name          string
	photo         string // the picture address Google gave (empty for Apple and for passwords)
	providers     []string
	emailVerified bool
	disabled      bool
}

// refusal is why Firebase refused, in terms this service acts on.
type refusal int

const (
	refusedWrongPassword refusal = iota + 1
	refusedEmailTaken
	refusedWeakPassword
	refusedWrongCode
	refusedTooMany
	refusedDisabled
	refusedFirebaseAuthenticator // an old Firebase authenticator on the account: Caller Whale's own second step replaced it
	refusedRecentLogin
	refusedBadLink
	refusedSetup // our configuration is wrong, not the person's input
	refusedOther
)

type firebaseError struct {
	kind    refusal
	message string
}

func (e *firebaseError) Error() string { return "firebase: " + e.message }

func classify(message string) *firebaseError {
	head := message
	if i := strings.IndexAny(message, " :"); i >= 0 {
		head = message[:i]
	}
	kind := refusedOther
	switch head {
	case "INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_LOGIN_CREDENTIALS", "INVALID_EMAIL", "MISSING_PASSWORD":
		kind = refusedWrongPassword
	case "EMAIL_EXISTS":
		kind = refusedEmailTaken
	case "WEAK_PASSWORD", "PASSWORD_DOES_NOT_MEET_REQUIREMENTS":
		kind = refusedWeakPassword
	case "INVALID_CODE", "INVALID_MFA_PENDING_CREDENTIAL", "INVALID_VERIFICATION_CODE", "CODE_EXPIRED":
		kind = refusedWrongCode
	case "TOO_MANY_ATTEMPTS_TRY_LATER":
		kind = refusedTooMany
	case "USER_DISABLED":
		kind = refusedDisabled
	case "CREDENTIAL_TOO_OLD_LOGIN_AGAIN", "TOKEN_EXPIRED", "INVALID_ID_TOKEN", "INVALID_REFRESH_TOKEN":
		kind = refusedRecentLogin
	case "INVALID_OOB_CODE", "EXPIRED_OOB_CODE":
		kind = refusedBadLink
	case "API_KEY_INVALID", "OPERATION_NOT_ALLOWED", "CONFIGURATION_NOT_FOUND", "ADMIN_ONLY_OPERATION", "UNAUTHORIZED_DOMAIN":
		kind = refusedSetup
	}
	return &firebaseError{kind: kind, message: message}
}

// asRefusal is the Firebase refusal inside an error, if it is one.
func asRefusal(err error) (refusal, bool) {
	var fe *firebaseError
	if errors.As(err, &fe) {
		return fe.kind, true
	}
	return 0, false
}

// apiErr is what a person is told about a Firebase failure.
func (e *firebaseError) apiErr() error {
	switch e.kind {
	case refusedWrongPassword, refusedDisabled:
		return errWrongCredentials
	case refusedEmailTaken:
		return conflict("An account with this email already exists. Sign in instead.")
	case refusedWeakPassword:
		return bad("Use 8–4096 characters with an uppercase letter, a lowercase letter, a number and a special character. If signing in, use Forgot password to upgrade it.")
	case refusedWrongCode:
		return errWrongCode
	case refusedTooMany:
		return errTooMany
	case refusedRecentLogin:
		return errUnauthenticated
	case refusedBadLink:
		return forbidden("This link is not valid or has expired.")
	case refusedFirebaseAuthenticator:
		return forbidden("This account has an old authenticator in Firebase. Ask Caller Whale to reset it, then sign in again.")
	}
	return e // an internal fault: logged, never shown
}

// asAPI turns any error from this file into one serve() can show.
func asAPI(err error) error {
	var fe *firebaseError
	if errors.As(err, &fe) {
		return fe.apiErr()
	}
	return err
}

type fbReply struct {
	IDToken              string `json:"idToken"`
	RefreshToken         string `json:"refreshToken"`
	LocalID              string `json:"localId"`
	MFAPendingCredential string `json:"mfaPendingCredential"`
	Email                string `json:"email"`
	// securetoken.googleapis.com answers in snake_case.
	UserID            string `json:"user_id"`
	IDTokenSnake      string `json:"id_token"`
	RefreshTokenSnake string `json:"refresh_token"`
}

// post sends JSON to Identity Toolkit and returns the answer, or the refusal Firebase gave.
func (f *firebase) post(ctx context.Context, path string, body any) (json.RawMessage, error) {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.identity+path+"?key="+url.QueryEscape(f.apiKey), bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return f.send(req)
}

func (f *firebase) send(req *http.Request) (json.RawMessage, error) {
	res, err := f.http.Do(req)
	if err != nil {
		return nil, &firebaseError{kind: refusedOther, message: "not reachable"}
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 == 2 {
		return data, nil
	}
	var failure struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &failure)
	if failure.Error.Message == "" {
		failure.Error.Message = "UNKNOWN"
	}
	return nil, classify(failure.Error.Message)
}

func (f *firebase) call(ctx context.Context, path string, body any) (fbReply, error) {
	data, err := f.post(ctx, path, body)
	if err != nil {
		return fbReply{}, err
	}
	var reply fbReply
	if err := json.Unmarshal(data, &reply); err != nil {
		return reply, &firebaseError{kind: refusedOther, message: "unexpected answer"}
	}
	return reply, nil
}

// outcome is a sign-in result: signed in, or (for an account that still has an authenticator in Firebase) refused.
func outcome(reply fbReply) (fbLogin, error) {
	if reply.MFAPendingCredential != "" {
		return fbLogin{}, &firebaseError{kind: refusedFirebaseAuthenticator, message: "authenticator pending"}
	}
	if reply.IDToken == "" {
		return fbLogin{}, &firebaseError{kind: refusedOther, message: "no token in the answer"}
	}
	return fbLogin{idToken: reply.IDToken, refreshToken: reply.RefreshToken, uid: reply.LocalID}, nil
}

func (f *firebase) signUp(ctx context.Context, email, password string) (fbLogin, error) {
	reply, err := f.call(ctx, "/v1/accounts:signUp", map[string]any{"email": email, "password": password, "returnSecureToken": true})
	if err != nil {
		return fbLogin{}, err
	}
	return fbLogin{idToken: reply.IDToken, refreshToken: reply.RefreshToken, uid: reply.LocalID}, nil
}

func (f *firebase) signIn(ctx context.Context, email, password string) (fbLogin, error) {
	reply, err := f.call(ctx, "/v1/accounts:signInWithPassword", map[string]any{"email": email, "password": password, "returnSecureToken": true})
	if err != nil {
		return fbLogin{}, err
	}
	return outcome(reply)
}

// refresh is a fresh ID token from a refresh token (Firebase may rotate the refresh token too).
func (f *firebase) refresh(ctx context.Context, refreshToken string) (fbLogin, error) {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.token+"/v1/token?key="+url.QueryEscape(f.apiKey), strings.NewReader(form.Encode()))
	if err != nil {
		return fbLogin{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	data, err := f.send(req)
	if err != nil {
		return fbLogin{}, err
	}
	var reply fbReply
	if err := json.Unmarshal(data, &reply); err != nil {
		return fbLogin{}, &firebaseError{kind: refusedOther, message: "unexpected answer"}
	}
	return fbLogin{idToken: reply.IDTokenSnake, refreshToken: reply.RefreshTokenSnake, uid: reply.UserID}, nil
}

func (f *firebase) profile(ctx context.Context, idToken string) (fbProfile, error) {
	data, err := f.post(ctx, "/v1/accounts:lookup", map[string]any{"idToken": idToken})
	if err != nil {
		return fbProfile{}, err
	}
	var out struct {
		Users []struct {
			LocalID          string `json:"localId"`
			Email            string `json:"email"`
			DisplayName      string `json:"displayName"`
			PhotoURL         string `json:"photoUrl"`
			EmailVerified    bool   `json:"emailVerified"`
			Disabled         bool   `json:"disabled"`
			ProviderUserInfo []struct {
				ProviderID string `json:"providerId"`
			} `json:"providerUserInfo"`
		} `json:"users"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Users) == 0 {
		return fbProfile{}, &firebaseError{kind: refusedOther, message: "no user in the answer"}
	}
	u := out.Users[0]
	providers := []string{}
	for _, provider := range u.ProviderUserInfo {
		if provider.ProviderID == "google.com" || provider.ProviderID == "apple.com" {
			providers = append(providers, strings.TrimSuffix(provider.ProviderID, ".com"))
		}
	}
	return fbProfile{uid: u.LocalID, email: strings.ToLower(u.Email), name: u.DisplayName, photo: u.PhotoURL, emailVerified: u.EmailVerified, disabled: u.Disabled, providers: providers}, nil
}

func (f *firebase) linkedProviders(ctx context.Context, idToken string) ([]string, error) {
	profile, err := f.profile(ctx, idToken)
	return profile.providers, err
}

func (f *firebase) setName(ctx context.Context, idToken, name string) error {
	_, err := f.call(ctx, "/v1/accounts:update", map[string]any{"idToken": idToken, "displayName": name, "returnSecureToken": false})
	return err
}

func (f *firebase) setPassword(ctx context.Context, idToken, password string) error {
	_, err := f.call(ctx, "/v1/accounts:update", map[string]any{"idToken": idToken, "password": password, "returnSecureToken": false})
	return err
}

// sendVerification: Firebase emails the confirmation link itself.
func (f *firebase) sendVerification(ctx context.Context, idToken string) error {
	_, err := f.call(ctx, "/v1/accounts:sendOobCode", map[string]any{"requestType": "VERIFY_EMAIL", "idToken": idToken})
	return err
}

// sendPasswordReset: Firebase emails a reset link itself. It says the same whether or not the address has an account.
func (f *firebase) sendPasswordReset(ctx context.Context, email string) error {
	_, err := f.call(ctx, "/v1/accounts:sendOobCode", map[string]any{"requestType": "PASSWORD_RESET", "email": email})
	if kind, ok := asRefusal(err); ok && kind == refusedWrongPassword {
		return nil // EMAIL_NOT_FOUND: say nothing about who has an account
	}
	return err
}

// resetPassword sets a new password with the code from the reset link and returns the address it belongs to.
// With no password it only checks the code, without using it.
func (f *firebase) resetPassword(ctx context.Context, oobCode, password string) (string, error) {
	body := map[string]any{"oobCode": oobCode}
	if password != "" {
		body["newPassword"] = password
	}
	reply, err := f.call(ctx, "/v1/accounts:resetPassword", body)
	return strings.ToLower(reply.Email), err
}

// confirmEmail uses the code from a confirmation link and returns the address it confirmed.
func (f *firebase) confirmEmail(ctx context.Context, oobCode string) (string, error) {
	reply, err := f.call(ctx, "/v1/accounts:update", map[string]any{"oobCode": oobCode})
	return strings.ToLower(reply.Email), err
}

var _ = fmt.Sprintf

// ---- Google and Apple through Firebase ----

// signInProvider: only this service hands verified provider tokens (and Apple's raw nonce) to Firebase, which finds or opens the person.
func (f *firebase) signInProvider(ctx context.Context, provider, idToken, nonce string) (fbLogin, error) {
	return f.providerCredential(ctx, provider, idToken, nonce, "")
}

func (f *firebase) providerCredential(ctx context.Context, provider, providerToken, nonce, accountToken string) (fbLogin, error) {
	form := url.Values{"id_token": {providerToken}, "providerId": {provider + ".com"}}
	if provider == "apple" {
		form.Set("nonce", nonce)
	}
	body := map[string]any{"postBody": form.Encode(), "requestUri": "http://localhost", "returnSecureToken": true, "returnIdpCredential": false}
	if accountToken != "" {
		body["idToken"] = accountToken
	}
	reply, err := f.call(ctx, "/v1/accounts:signInWithIdp", body)
	if err != nil {
		return fbLogin{}, err
	}
	return outcome(reply)
}

// oauthURI: when this service has no client of its own for a provider, Firebase owns the provider's credentials; its session binds
// the callback to this initiation. Returns the address to send the browser to, Firebase's session id and the state in the address.
func (f *firebase) oauthURI(ctx context.Context, provider, callback string) (uri, session, state string, err error) {
	data, err := f.post(ctx, "/v1/accounts:createAuthUri", map[string]any{"providerId": provider + ".com", "authFlowType": "CODE_FLOW", "continueUri": callback})
	if err != nil {
		return "", "", "", err
	}
	var out struct {
		AuthURI   string `json:"authUri"`
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(data, &out) != nil {
		return "", "", "", &firebaseError{kind: refusedOther, message: "unexpected answer"}
	}
	parsed, perr := url.Parse(out.AuthURI)
	if perr != nil {
		return "", "", "", &firebaseError{kind: refusedOther, message: "invalid authorization URL"}
	}
	state = parsed.Query().Get("state")
	if parsed.Scheme != "https" || state == "" || out.SessionID == "" {
		return "", "", "", &firebaseError{kind: refusedOther, message: "incomplete authorization response"}
	}
	return out.AuthURI, out.SessionID, state, nil
}

// finishOAuth completes a Firebase-owned provider flow with the code the provider sent back.
func (f *firebase) finishOAuth(ctx context.Context, callback, session, provider, code, state, accountToken string) (fbLogin, error) {
	requestURI, err := url.Parse(callback)
	if err != nil {
		return fbLogin{}, &firebaseError{kind: refusedOther, message: "invalid callback"}
	}
	q := requestURI.Query()
	q.Set("code", code)
	q.Set("state", state)
	requestURI.RawQuery = q.Encode()
	form := url.Values{"providerId": {provider + ".com"}, "code": {code}}
	body := map[string]any{"requestUri": requestURI.String(), "sessionId": session, "postBody": form.Encode(), "returnSecureToken": true, "returnIdpCredential": false}
	if accountToken != "" {
		body["idToken"] = accountToken
	}
	reply, err := f.call(ctx, "/v1/accounts:signInWithIdp", body)
	if err != nil {
		return fbLogin{}, err
	}
	return outcome(reply)
}
