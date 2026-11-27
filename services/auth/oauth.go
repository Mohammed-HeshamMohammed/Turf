package main

// Sign-in and sign-up with Google or Apple (OpenID Connect, authorization code flow), phase 4. The browser goes to the provider with a
// single-use state, a nonce and (Google) a PKCE challenge, kept for ten minutes. The provider sends it back with a code; this service
// exchanges the code itself (golang.org/x/oauth2), checks the ID token against the provider's published keys (go-oidc: issuer,
// audience, expiry, signature) and the nonce, requires a confirmed email, and hands the token to Firebase, which finds or opens the
// person. A provider this service has no client for is left to Firebase's own authorization flow.
//
// Every way back gets a one-time code (two minutes) that the website, the app or the desktop app trades for tokens at
// POST /v1/oauth/exchange. Tokens never travel in an address. The desktop app's code only ever goes to 127.0.0.1.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
)

const (
	stateSeconds   = 10 * 60
	handoffSeconds = 2 * 60
)

// provider is one outside sign-in. Not set up until it has a client id and a secret (or, for Apple, a key).
type provider struct {
	clientID, clientSecret             string // Google: the client secret. Apple: empty; the secret is a JWT signed with the key below
	teamID, keyID, privateKey          string // Apple's .p8 key (PEM)
	authURL, tokenURL, jwksURL, issuer string
}

func (p provider) configured() bool {
	return p.clientID != "" && (p.clientSecret != "" || (p.privateKey != "" && p.teamID != "" && p.keyID != ""))
}

func (s *server) oauthRoutes(mux *http.ServeMux) {
	mux.Handle("GET /v1/providers", serve(s.providers))
	mux.Handle("GET /v1/me/providers", serve(s.myProviders))
	mux.Handle("POST /v1/me/providers/{provider}/start", serve(s.startLink))
	mux.Handle("GET /v1/oauth/{provider}/start", serve(s.startGet))
	mux.Handle("POST /v1/oauth/{provider}/start", serve(s.startPost))
	// Google returns with a GET; Apple posts a form back (response_mode=form_post) once it asked for a name.
	mux.HandleFunc("GET /v1/oauth/{provider}/callback", s.callback)
	mux.HandleFunc("POST /v1/oauth/{provider}/callback", s.callback)
	mux.Handle("POST /v1/oauth/exchange", serve(s.exchange))
	mux.Handle("POST /v1/handoffs", serve(s.desktopHandoff))
}

func (s *server) myProviders(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	idToken, err := s.sessionIDToken(r.Context(), c.SID)
	if err != nil {
		return err
	}
	providers, err := s.fb.linkedProviders(r.Context(), idToken)
	if err != nil {
		return asAPI(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": providers})
	return nil
}

func (s *server) startLink(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if c.AuthTime == 0 || now()-c.AuthTime > 15*60 {
		return forbidden("Sign in again before linking a sign-in method.")
	}
	if _, err := s.sessionIDToken(r.Context(), c.SID); err != nil {
		return err
	}
	name := r.PathValue("provider")
	to, err := s.startURL(r.Context(), name, "landing", 0)
	if err != nil {
		return err
	}
	parsed, err := url.Parse(to)
	if err != nil {
		return err
	}
	state := parsed.Query().Get("state")
	if state == "" {
		return forbidden("The provider could not start a secure link.")
	}
	updated, err := s.db.Exec(r.Context(), "UPDATE oauth_states SET link_user_id = $1, link_session_id = $2 WHERE state_hash = $3", c.Sub, c.SID, sha256Hex(state))
	if err != nil {
		return err
	}
	if updated.RowsAffected() != 1 {
		return forbidden("The provider could not start a secure link.")
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": to})
	return nil
}

func (s *server) providerFor(name string) (*provider, error) {
	switch name {
	case "google":
		return &s.cfg.google, nil
	case "apple":
		return &s.cfg.apple, nil
	case "microsoft":
		// No client of its own here (D237); Firebase's authorization flow runs it, once turned on in Firebase.
		return &provider{}, nil
	}
	return nil, bad("That sign-in provider does not exist.")
}

func label(name string) string {
	switch name {
	case "apple":
		return "Apple"
	case "microsoft":
		return "Microsoft"
	}
	return "Google"
}

func (s *server) redirectURI(name string) string {
	return s.cfg.publicURL + "/v1/oauth/" + name + "/callback"
}

// ---- which providers are on ----

type seenAnswer struct {
	ok bool
	at time.Time
}

// firebaseOffers: a provider with no client of its own is on when Firebase answers for it; asked at most once a minute.
func (s *server) firebaseOffers(ctx context.Context, name string) bool {
	key := name + ":" + s.redirectURI(name)
	if v, found := s.seen.Load(key); found && time.Since(v.(seenAnswer).at) < time.Minute {
		return v.(seenAnswer).ok
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	_, _, _, err := s.fb.oauthURI(ctx, name, s.redirectURI(name))
	s.seen.Store(key, seenAnswer{ok: err == nil, at: time.Now()})
	return err == nil
}

func (s *server) providers(w http.ResponseWriter, r *http.Request) error {
	var wg sync.WaitGroup
	var google, apple, microsoft bool
	for _, p := range []struct {
		name string
		cfg  provider
		out  *bool
	}{{"google", s.cfg.google, &google}, {"apple", s.cfg.apple, &apple}, {"microsoft", provider{}, &microsoft}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			*p.out = p.cfg.configured() || s.firebaseOffers(r.Context(), p.name)
		}()
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"google": google, "apple": apple, "microsoft": microsoft})
	return nil
}

// ---- starting ----

func random() string {
	secret, _ := newSecret()
	return secret
}

// startURL is where to send the browser for a provider's sign-in. target is "website" (default), "app" (the CRM in a browser tab),
// "landing" (the public site) or "desktop" (the desktop app, with the port it listens on at 127.0.0.1 for the result).
func (s *server) startURL(ctx context.Context, name, target string, port int64) (string, error) {
	p, err := s.providerFor(name)
	if err != nil {
		return "", err
	}
	switch target {
	case "app", "landing", "desktop":
	default:
		target = "website"
	}
	// The desktop app's result only ever goes back to this computer (127.0.0.1), on an unprivileged port.
	var returnPort *int64
	if target == "desktop" {
		if port < 1024 || port > 65535 {
			return "", bad("The app did not say where to return.")
		}
		returnPort = &port
	}
	t := now()
	if !p.configured() {
		fctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		uri, session, token, err := s.fb.oauthURI(fctx, name, s.redirectURI(name))
		if err != nil {
			return "", bad(label(name) + " sign-in is unavailable. Ask the administrator to enable its Firebase authorization code flow and configure its client and callback URL.")
		}
		if _, err := s.db.Exec(ctx, "INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, target, return_port, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
			sha256Hex(token), name, session, "firebase", target, returnPort, t+stateSeconds); err != nil {
			return "", err
		}
		_, _ = s.db.Exec(ctx, "DELETE FROM oauth_states WHERE expires_at < $1", t)
		return uri, nil
	}
	stateToken, nonce := random(), random()
	// PKCE for Google; Apple's flow does not take it (the client secret already proves this server).
	var verifier *string
	if name == "google" {
		v := random()
		verifier = &v
	}
	if _, err := s.db.Exec(ctx, "INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, target, return_port, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
		sha256Hex(stateToken), name, nonce, verifier, target, returnPort, t+stateSeconds); err != nil {
		return "", err
	}
	// Sign-ins that were started and never finished are cleared as new ones begin.
	_, _ = s.db.Exec(ctx, "DELETE FROM oauth_states WHERE expires_at < $1", t)
	conf := s.oauthConfig(name, p, "")
	options := []oauth2.AuthCodeOption{}
	if name == "apple" {
		// Apple puts the nonce in the token as sent; this service sends its hash and keeps the raw one for Firebase.
		options = append(options, oauth2.SetAuthURLParam("nonce", sha256Hex(nonce)), oauth2.SetAuthURLParam("response_mode", "form_post"))
	} else {
		options = append(options, oauth2.SetAuthURLParam("nonce", nonce), oauth2.S256ChallengeOption(*verifier), oauth2.SetAuthURLParam("prompt", "select_account"))
	}
	return conf.AuthCodeURL(stateToken, options...), nil
}

func (s *server) oauthConfig(name string, p *provider, secret string) *oauth2.Config {
	scopes := []string{"openid", "email", "profile"}
	if name == "apple" {
		scopes = []string{"name", "email"}
	}
	return &oauth2.Config{
		ClientID: p.clientID, ClientSecret: secret, RedirectURL: s.redirectURI(name), Scopes: scopes,
		Endpoint: oauth2.Endpoint{AuthURL: p.authURL, TokenURL: p.tokenURL, AuthStyle: oauth2.AuthStyleInParams},
	}
}

// startGet sends the browser to the provider (a page link that is followed straight away).
func (s *server) startGet(w http.ResponseWriter, r *http.Request) error {
	var port int64
	if v := r.URL.Query().Get("port"); v != "" {
		port, _ = strconv.ParseInt(v, 10, 64)
	}
	to, err := s.startURL(r.Context(), r.PathValue("provider"), r.URL.Query().Get("target"), port)
	if err != nil {
		return err
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
	return nil
}

type startBody struct {
	Target string `json:"target"`
	Port   int64  `json:"port"`
	Action string `json:"action"` // signin (default) or signup; the human check at the gateway reads it
}

// startPost answers with the address instead of redirecting, so a page can go there itself.
func (s *server) startPost(w http.ResponseWriter, r *http.Request) error {
	var body startBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if body.Action != "" && body.Action != "signin" && body.Action != "signup" {
		return bad("Choose sign-in or sign-up.")
	}
	to, err := s.startURL(r.Context(), r.PathValue("provider"), body.Target, body.Port)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": to})
	return nil
}

// ---- coming back ----

// back is where the person goes back to: with the one-time code, or with a message when the sign-in did not work.
func (s *server) back(target string, port *int64, code, failure string) string {
	found := url.Values{"callerwhale_code": {code}}.Encode()
	if code == "" {
		if failure == "" {
			failure = "Sign-in did not finish."
		}
		found = url.Values{"oauth_error": {failure}}.Encode()
	}
	switch target {
	case "desktop":
		// The desktop app's own page: it reads `code` or `error`.
		pairs := url.Values{"code": {code}}.Encode()
		if code == "" {
			pairs = url.Values{"error": {failure}}.Encode()
		}
		p := int64(0)
		if port != nil {
			p = *port
		}
		return fmt.Sprintf("http://127.0.0.1:%d/callerwhale-sign-in?%s", p, pairs)
	case "app":
		return s.cfg.appURL + "/?" + found
	case "landing": // the public site: back to its sign-in page, which finishes the sign-in with the code
		return s.cfg.landingURL + "/signin?" + found
	}
	page := "signin"
	if code != "" {
		page = "account"
	}
	return s.cfg.websiteURL + "/?" + found + "#/" + page
}

func (s *server) backLink(provider, failure string) string {
	values := url.Values{}
	if failure != "" {
		values.Set("link_error", failure)
	} else {
		values.Set("linked", provider)
	}
	return s.cfg.landingURL + "/account?" + values.Encode()
}

func (s *server) callback(w http.ResponseWriter, r *http.Request) {
	// A GET carries the answer in the address, a POST (Apple) in a form.
	_ = r.ParseForm()
	returned := returned{code: r.FormValue("code"), state: r.FormValue("state"), failure: r.FormValue("error"), user: r.FormValue("user")}
	to := s.finish(r.Context(), r.PathValue("provider"), returned)
	http.Redirect(w, r, to, http.StatusSeeOther)
}

type returned struct{ code, state, failure, user string }

// finish uses up the state, signs the person in and answers where the browser goes next.
func (s *server) finish(ctx context.Context, name string, got returned) string {
	t := now()
	// The state is used up first, in one statement: without a valid one nothing else is trusted, not even the target.
	var stored, nonce, target string
	var verifier *string
	var port *int64
	var linkUser, linkSession *string
	err := s.db.QueryRow(ctx, "DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > $2 RETURNING provider, nonce, code_verifier, target, return_port, link_user_id, link_session_id", sha256Hex(got.state), t).
		Scan(&stored, &nonce, &verifier, &target, &port, &linkUser, &linkSession)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && stored != name) {
		return s.back("website", nil, "", "That sign-in link has expired. Try again.")
	}
	if err != nil {
		log.Printf("ERROR provider %s: state: %v", name, err)
		return s.back("website", nil, "", label(name)+" sign-in did not work. Try again in a moment.")
	}
	if got.failure != "" || got.code == "" {
		if linkUser != nil {
			return s.backLink(name, "Linking was cancelled.")
		}
		return s.back(target, port, "", "Sign-in was cancelled.")
	}
	linkToken := ""
	if linkUser != nil {
		var actualUser string
		var started int64
		if linkSession == nil {
			return s.backLink(name, "Sign in again to link this method.")
		}
		if err := s.db.QueryRow(ctx, "SELECT user_id, created_at FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2", *linkSession, t).Scan(&actualUser, &started); err != nil || actualUser != *linkUser || t-started > 15*60 {
			return s.backLink(name, "Sign in again before linking a sign-in method.")
		}
		var err error
		linkToken, err = s.sessionIDToken(ctx, *linkSession)
		if err != nil {
			return s.backLink(name, "Sign in again to link this method.")
		}
	}
	kind := "browser"
	if target == "desktop" {
		kind = "desktop"
	}
	userID, fbRefresh, err := s.providerSignIn(ctx, name, got, nonce, deref(verifier), linkToken, deref(linkUser))
	var code string
	if err == nil && linkUser == nil {
		code, err = s.handoff(ctx, userID, kind, name, false, fbRefresh, "")
	}
	if err == nil && linkUser != nil {
		if fbRefresh != "" {
			_, err = s.db.Exec(ctx, "UPDATE sessions SET fb_refresh = $1 WHERE id = $2", fbRefresh, *linkSession)
		}
		if err == nil {
			return s.backLink(name, "")
		}
	}
	if err != nil {
		var api *apiError
		message := label(name) + " sign-in did not work. Try again in a moment."
		if errors.As(err, &api) {
			message = api.message
		} else {
			log.Printf("ERROR provider %s: %v", name, err)
		}
		if linkUser != nil {
			return s.backLink(name, message)
		}
		return s.back(target, port, "", message)
	}
	return s.back(target, port, code, "")
}

// idClaims are the ID token's claims Caller Whale reads. Apple sends email_verified as a string.
type idClaims struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified any    `json:"email_verified"`
	Nonce         string `json:"nonce"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

func (c idClaims) verifiedEmail() string {
	verified := c.EmailVerified == true
	if v, ok := c.EmailVerified.(string); ok && v == "true" {
		verified = true
	}
	if !verified {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(c.Email))
}

func (s *server) verifier(name string, p *provider) *oidc.IDTokenVerifier {
	if v, ok := s.verifiers.Load(name); ok {
		return v.(*oidc.IDTokenVerifier)
	}
	// Each provider's signing keys are fetched by the library, cached, and fetched again when a token names a key not seen yet.
	v := oidc.NewVerifier(p.issuer, oidc.NewRemoteKeySet(context.Background(), p.jwksURL), &oidc.Config{ClientID: p.clientID, SupportedSigningAlgs: []string{oidc.RS256}})
	actual, _ := s.verifiers.LoadOrStore(name, v)
	return actual.(*oidc.IDTokenVerifier)
}

// appleSecret is Apple's client secret: a short-lived ES256 JWT signed with the team's key.
func appleSecret(p *provider) (string, error) {
	key, err := jwt.ParseECPrivateKeyFromPEM([]byte(p.privateKey))
	if err != nil {
		return "", fmt.Errorf("apple key: %w", err)
	}
	t := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": p.teamID, "iat": t.Unix(), "exp": t.Add(5 * time.Minute).Unix(), "aud": "https://appleid.apple.com", "sub": p.clientID})
	token.Header["kid"] = p.keyID
	return token.SignedString(key)
}

// providerSignIn exchanges the provider's code, checks who it says the person is, and returns their account's id.
func (s *server) providerSignIn(ctx context.Context, name string, got returned, nonce, verifier, linkToken, linkUser string) (userID, fbRefresh string, err error) {
	if verifier == "firebase" {
		login, err := s.fb.finishOAuth(ctx, s.redirectURI(name), nonce, name, got.code, got.state, linkToken)
		if err != nil {
			return "", "", asAPI(err)
		}
		if linkUser != "" {
			return s.linkedFirebaseAccount(ctx, login, linkUser)
		}
		return s.firebaseAccount(ctx, login, "", "")
	}
	p, err := s.providerFor(name)
	if err != nil {
		return "", "", err
	}
	secret := p.clientSecret
	if name == "apple" {
		if secret, err = appleSecret(p); err != nil {
			return "", "", err
		}
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: 15 * time.Second})
	opts := []oauth2.AuthCodeOption{}
	if verifier != "" {
		opts = append(opts, oauth2.VerifierOption(verifier))
	}
	token, err := s.oauthConfig(name, p, secret).Exchange(ctx, got.code, opts...)
	if err != nil {
		// The error text can hold what the provider said; the log keeps the kind, the person gets a plain sentence.
		var rerr *oauth2.RetrieveError
		if errors.As(err, &rerr) {
			return "", "", fmt.Errorf("token exchange refused (%d)", rerr.Response.StatusCode)
		}
		return "", "", fmt.Errorf("token exchange: not reachable")
	}
	rawID, _ := token.Extra("id_token").(string)
	if rawID == "" {
		return "", "", forbidden("The sign-in token did not check out.")
	}
	idToken, err := s.verifier(name, p).Verify(ctx, rawID)
	if err != nil {
		return "", "", forbidden("The sign-in token did not check out.")
	}
	var claims idClaims
	if err := idToken.Claims(&claims); err != nil {
		return "", "", forbidden("The sign-in token did not check out.")
	}
	// The token must be for this sign-in: Apple's carries the hash of the nonce, Google's the nonce itself.
	want := nonce
	if name == "apple" {
		want = sha256Hex(nonce)
	}
	if claims.Nonce == "" || claims.Nonce != want {
		return "", "", forbidden("The sign-in token was not for this sign-in.")
	}
	email := claims.verifiedEmail()
	if email == "" {
		return "", "", forbidden("Your " + label(name) + " account has no confirmed email address.")
	}
	display := strings.TrimSpace(claims.Name)
	if display == "" {
		display = appleName(got.user)
	}
	// With no name from the provider, display stays empty: a new person is named from their address, and a returning one keeps the name they
	// have (Apple tells the name only once).
	login, err := s.fb.providerCredential(ctx, name, rawID, nonce, linkToken)
	if err != nil {
		return "", "", asAPI(err)
	}
	if linkUser != "" {
		return s.linkedFirebaseAccount(ctx, login, linkUser)
	}
	return s.firebaseAccount(ctx, login, display, claims.Picture)
}

func (s *server) linkedFirebaseAccount(ctx context.Context, login fbLogin, userID string) (string, string, error) {
	profile, err := s.fb.profile(ctx, login.idToken)
	if err != nil {
		return "", "", asAPI(err)
	}
	u, err := s.userBy(ctx, "firebase_uid", profile.uid)
	if err != nil {
		return "", "", err
	}
	if u == nil || u.id != userID {
		return "", "", forbidden("That provider belongs to a different account.")
	}
	return userID, login.refreshToken, nil
}

func (s *server) firebaseAccount(ctx context.Context, login fbLogin, display, picture string) (string, string, error) {
	profile, err := s.fb.profile(ctx, login.idToken)
	if err != nil {
		return "", "", asAPI(err)
	}
	if profile.disabled || !profile.emailVerified || strings.TrimSpace(profile.email) == "" {
		return "", "", forbidden("Sign-in requires an enabled account with a confirmed email address.")
	}
	if strings.TrimSpace(profile.name) == "" {
		profile.name = display
	}
	u, err := s.upsertFirebaseUser(ctx, profile)
	if err != nil {
		return "", "", err
	}
	if u.disabled {
		return "", "", forbidden("This account is disabled.")
	}
	// Google people start with their Google picture (only when they have none).
	if picture == "" {
		picture = profile.photo
	}
	if picture != "" && contains(profile.providers, "google") {
		s.takeProviderPicture(ctx, u.id, picture)
	}
	return u.id, login.refreshToken, nil
}

// appleName is the name Apple sends once, on the first sign-in, as JSON: {"name": {"firstName", "lastName"}, "email"}.
func appleName(user string) string {
	var v struct {
		Name struct {
			First string `json:"firstName"`
			Last  string `json:"lastName"`
		} `json:"name"`
	}
	if json.Unmarshal([]byte(user), &v) != nil {
		return ""
	}
	full := strings.TrimSpace(strings.TrimSpace(v.Name.First) + " " + strings.TrimSpace(v.Name.Last))
	if r := []rune(full); len(r) > 120 {
		full = string(r[:120])
	}
	return full
}

// ---- the one-time code ----

// handoff records a finished sign-in to collect, once, within two minutes. Only the hash is kept.
func (s *server) handoff(ctx context.Context, userID, kind, provider string, mfaPassed bool, fbRefresh, parentSID string) (string, error) {
	code, hash := newSecret()
	t := now()
	var fb *string
	if fbRefresh != "" {
		fb = &fbRefresh
	}
	mfa := int64(0)
	if mfaPassed {
		mfa = 1
	}
	if _, err := s.db.Exec(ctx, "INSERT INTO oauth_handoffs (code_hash, user_id, kind, expires_at, provider, fb_refresh, mfa_passed, parent_sid) VALUES ($1, $2, $3, $4, $5, $6, $7, nullif($8, ''))", hash, userID, kind, t+handoffSeconds, provider, fb, mfa, parentSID); err != nil {
		return "", err
	}
	_, _ = s.db.Exec(ctx, "DELETE FROM oauth_handoffs WHERE expires_at < $1", t)
	return code, nil
}

type exchangeBody struct {
	Code   string `json:"code"`
	Device string `json:"device"` // "shared": a browser on a shared device (D38)
}

// exchange trades the one-time code from a provider sign-in for tokens. One statement uses it up, so it works once.
func (s *server) exchange(w http.ResponseWriter, r *http.Request) error {
	var body exchangeBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	var userID, kind, provider string
	var fb, parent *string
	var mfa int64
	err := s.db.QueryRow(ctx, "DELETE FROM oauth_handoffs WHERE code_hash = $1 AND expires_at > $2 RETURNING user_id, kind, provider, fb_refresh, mfa_passed, parent_sid", sha256Hex(strings.TrimSpace(body.Code)), now()).
		Scan(&userID, &kind, &provider, &fb, &mfa, &parent)
	if errors.Is(err, pgx.ErrNoRows) {
		return forbidden("This sign-in has expired. Try again.")
	}
	if err != nil {
		return err
	}
	u, err := s.userBy(ctx, "id", userID)
	if err != nil {
		return err
	}
	if u == nil || u.disabled {
		return forbidden("This account is disabled.")
	}
	// A provider sign-in does not pass two-step sign-in: the token says so, and services that need it will ask. A sign-in handed over
	// from the browser (POST /v1/handoffs) keeps what that session passed.
	if kind == "browser" && body.Device == "shared" {
		kind = "shared"
	}
	reply, err := s.openSessionFrom(ctx, u, kind, mfa == 1, provider, deref(fb), deref(parent))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// desktopHandoff: the signed-in person's browser hands its sign-in to the desktop app.
// The desktop window never shows a password form or a reCAPTCHA: the person signs in at callerwhale.com, and the page asks for this
// code, which it sends only to 127.0.0.1 on the person's computer. The code works once, for two minutes, and becomes a separate
// "desktop" session with the same second-step result; the browser's own session is left as it is.
func (s *server) desktopHandoff(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	u, err := s.userBy(ctx, "id", c.Sub)
	if err != nil {
		return err
	}
	if u == nil || u.disabled {
		return errUnauthenticated
	}
	// What the session passed is read from the session, not from the token, which can be older.
	var fb *string
	var passed int64
	if err := s.db.QueryRow(ctx, "SELECT fb_refresh, mfa_passed FROM sessions WHERE id = $1", c.SID).Scan(&fb, &passed); err != nil {
		return err
	}
	// The desktop app (the default) or the CRM web app, which has its own address and so its own session. Nothing else is handed to.
	var body struct {
		Kind string `json:"kind"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&body) // an empty body means the desktop app
	// The CRM web app runs in the same browser as the website, so its session follows the website's: signing out of one website
	// session signs its CRM out too. The desktop app is its own sign-in and is left as it is.
	kind, parent := "desktop", ""
	if body.Kind == "browser" {
		kind, parent = "browser", c.SID
	}
	code, err := s.handoff(ctx, u.id, kind, c.Provider, passed == 1, deref(fb), parent)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code})
	return nil
}
