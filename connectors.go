package main

// Connectors: how an AI assistant (Claude, ChatGPT, Gemini) is allowed to act for a person. The assistant registers itself, sends the
// person to Caller Whale's consent page, and trades the one-time code it gets back for tokens (OAuth 2.1: authorization code with
// PKCE, no client secrets). The tokens are opaque and only their hashes are stored, so ending a grant ends the assistant's access at
// once. The `mcp` service never sees a password: it asks this service who a token belongs to (docs/plans/ai-connectors.md).

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	connectorCodeSeconds    = 60
	connectorAccessSeconds  = 60 * 60
	connectorRefreshSeconds = 30 * 24 * 60 * 60
	connectorClientsPerDay  = 500
)

// connectorScopes are what an assistant can be given. Phase 1 has one: reading the person's own account and plan.
var connectorScopes = []string{"account:read"}

func (s *server) connectorRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.connectorMetadata)
	mux.Handle("POST /v1/connectors/register", serve(s.connectorRegister))
	mux.Handle("GET /v1/connectors/authorize", serve(s.connectorAuthorize))
	mux.Handle("GET /v1/connectors/clients/{id}", serve(s.connectorClient))
	mux.Handle("POST /v1/connectors/consent", serve(s.connectorConsent))
	mux.Handle("POST /v1/connectors/token", serve(s.connectorToken))
	mux.Handle("POST /v1/connectors/introspect", serve(s.connectorIntrospect))
	mux.Handle("POST /v1/connectors/standing", serve(s.connectorStanding))
	mux.Handle("GET /v1/me/connections", serve(s.myConnections))
	mux.Handle("DELETE /v1/me/connections/{id}", serve(s.revokeConnection))
}

// oauthError is the error shape OAuth clients expect from the token and registration endpoints.
func oauthError(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, map[string]any{"error": code, "error_description": description})
}

func (s *server) connectorMetadata(w http.ResponseWriter, r *http.Request) {
	base := s.cfg.publicURL
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/v1/connectors/authorize",
		"token_endpoint":                        base + "/v1/connectors/token",
		"registration_endpoint":                 base + "/v1/connectors/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      connectorScopes,
	})
}

// ---- registering an assistant ----

// validRedirect accepts an https address, or http to this computer (for a desktop assistant), with no fragment and no login.
func validRedirect(raw string) bool {
	if len(raw) > 300 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.User != nil || u.Host == "" {
		return false
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "[::1]" || u.Hostname() == "::1"
	return u.Scheme == "https" || (u.Scheme == "http" && local)
}

func (s *server) connectorRegister(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Name         string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := readJSON(w, r, &body); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "The registration could not be read.")
		return nil
	}
	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" || utf8.RuneCountInString(name) > 80 {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "client_name is required (up to 80 characters).")
		return nil
	}
	if !plainName(name) {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "client_name may use letters, numbers, spaces and . , - _ ( ) & ' + only.")
		return nil
	}
	if len(body.RedirectURIs) == 0 || len(body.RedirectURIs) > 5 {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "Give between one and five redirect_uris.")
		return nil
	}
	for _, uri := range body.RedirectURIs {
		if !validRedirect(uri) {
			oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "Each redirect_uri must be https (or http to this computer).")
			return nil
		}
	}
	var recent int
	if err := s.db.QueryRow(r.Context(), "SELECT COUNT(*) FROM connector_clients WHERE created_at > $1", now()-24*60*60).Scan(&recent); err != nil {
		return err
	}
	if recent >= connectorClientsPerDay {
		return errTooMany
	}
	uris, _ := json.Marshal(body.RedirectURIs)
	id := uuid.NewString()
	if _, err := s.db.Exec(r.Context(), "INSERT INTO connector_clients (id, name, redirect_uris, created_at) VALUES ($1, $2, $3, $4)", id, name, string(uris), now()); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id": id, "client_name": name, "redirect_uris": body.RedirectURIs,
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none",
	})
	return nil
}

// plainName keeps an assistant's name to letters, numbers, spaces and a little punctuation. The name is shown on the consent page and in
// Settings; markup or control characters in it would only ever be an attack, even where the page escapes it.
func plainName(name string) bool {
	for _, r := range name {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == ' ':
		case strings.ContainsRune(".,-_()&'+", r):
		default:
			return false
		}
	}
	return true
}

type connectorClientRow struct {
	ID, Name string
	URIs     []string
}

func (s *server) loadClient(r *http.Request, id string) (*connectorClientRow, error) {
	if _, err := uuid.Parse(id); err != nil {
		return nil, nil
	}
	var name, uris string
	err := s.db.QueryRow(r.Context(), "SELECT name, redirect_uris FROM connector_clients WHERE id = $1", id).Scan(&name, &uris)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c := &connectorClientRow{ID: id, Name: name}
	_ = json.Unmarshal([]byte(uris), &c.URIs)
	return c, nil
}

// cleanScope keeps only the scopes that exist; none asked for means the default.
func cleanScope(asked string) string {
	var kept []string
	for _, item := range strings.Fields(asked) {
		if slices.Contains(connectorScopes, item) && !slices.Contains(kept, item) {
			kept = append(kept, item)
		}
	}
	if len(kept) == 0 {
		kept = []string{connectorScopes[0]}
	}
	return strings.Join(kept, " ")
}

// connectorAuthorize is where the assistant sends the person's browser. It checks the request, then hands the browser to the website's
// consent page with the same parameters (the website holds the person's sign-in; this service holds no cookies).
func (s *server) connectorAuthorize(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	client, err := s.loadClient(r, q.Get("client_id"))
	if err != nil {
		return err
	}
	if client == nil {
		return bad("This assistant is not registered with Caller Whale.")
	}
	if !slices.Contains(client.URIs, q.Get("redirect_uri")) {
		return bad("The return address is not one this assistant registered.")
	}
	if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || len(q.Get("code_challenge")) < 43 {
		return bad("The request is missing its response type or its S256 code challenge.")
	}
	next := url.Values{}
	for _, key := range []string{"client_id", "redirect_uri", "state", "code_challenge"} {
		next.Set(key, q.Get(key))
	}
	next.Set("scope", cleanScope(q.Get("scope")))
	http.Redirect(w, r, s.cfg.landingURL+"/connect?"+next.Encode(), http.StatusFound)
	return nil
}

// connectorClient tells the consent page what to show: the assistant's name and where it will return.
func (s *server) connectorClient(w http.ResponseWriter, r *http.Request) error {
	client, err := s.loadClient(r, r.PathValue("id"))
	if err != nil {
		return err
	}
	if client == nil {
		return newError(http.StatusNotFound, "not_found", "This assistant is not registered with Caller Whale.")
	}
	uri := r.URL.Query().Get("redirect_uri")
	if !slices.Contains(client.URIs, uri) {
		return bad("The return address is not one this assistant registered.")
	}
	host := ""
	if u, err := url.Parse(uri); err == nil {
		host = u.Host
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": client.Name, "return_host": host})
	return nil
}

// mayConnect is the rule for who can give an assistant access: Caller Whale staff, and people who belong to a workspace (a role there).
// Everyone else has nothing for an assistant to act on. It is checked when the person agrees and on every use of a token, so ending a
// person's access also ends what their assistants can do.
func (s *server) mayConnect(ctx context.Context, userID string) (bool, error) {
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return false, errAccessUnavailable
	}
	profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, userID)
	if err != nil {
		return false, errAccessUnavailable
	}
	return profile.PlatformRole != "" || len(profile.Workspaces) > 0, nil
}

// ---- the person says yes (or no) ----

func randomText(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("no randomness: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func (s *server) connectorConsent(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		ClientID      string `json:"client_id"`
		RedirectURI   string `json:"redirect_uri"`
		Scope         string `json:"scope"`
		State         string `json:"state"`
		CodeChallenge string `json:"code_challenge"`
		Deny          bool   `json:"deny"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	client, err := s.loadClient(r, body.ClientID)
	if err != nil {
		return err
	}
	if client == nil || !slices.Contains(client.URIs, body.RedirectURI) {
		return bad("This request is not valid. Start again from the assistant.")
	}
	back, err := url.Parse(body.RedirectURI)
	if err != nil {
		return bad("This request is not valid. Start again from the assistant.")
	}
	query := back.Query()
	if body.State != "" {
		query.Set("state", body.State)
	}
	if body.Deny {
		query.Set("error", "access_denied")
		back.RawQuery = query.Encode()
		writeJSON(w, http.StatusOK, map[string]any{"redirect": back.String()})
		return nil
	}
	if len(body.CodeChallenge) < 43 || len(body.CodeChallenge) > 128 {
		return bad("This request is not valid. Start again from the assistant.")
	}
	allowed, err := s.mayConnect(r.Context(), c.Sub)
	if err != nil {
		return err
	}
	if !allowed {
		return forbidden("Connecting an assistant is for Caller Whale staff and people who belong to a workspace.")
	}
	scope := cleanScope(body.Scope)
	// One grant per person and assistant: connecting again renews it instead of piling up copies.
	var grantID string
	err = s.db.QueryRow(r.Context(), "SELECT id FROM connector_grants WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL", c.Sub, client.ID).Scan(&grantID)
	if errors.Is(err, pgx.ErrNoRows) {
		grantID = uuid.NewString()
		_, err = s.db.Exec(r.Context(), "INSERT INTO connector_grants (id, user_id, client_id, client_name, scope, created_at) VALUES ($1, $2, $3, $4, $5, $6)", grantID, c.Sub, client.ID, client.Name, scope, now())
	} else if err == nil {
		_, err = s.db.Exec(r.Context(), "UPDATE connector_grants SET scope = $1 WHERE id = $2", scope, grantID)
	}
	if err != nil {
		return err
	}
	code := randomText(24)
	if _, err := s.db.Exec(r.Context(), "INSERT INTO connector_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5)", sha256Hex(code), grantID, body.RedirectURI, body.CodeChallenge, now()+connectorCodeSeconds); err != nil {
		return err
	}
	query.Set("code", code)
	back.RawQuery = query.Encode()
	writeJSON(w, http.StatusOK, map[string]any{"redirect": back.String()})
	return nil
}

// ---- tokens ----

// pkceMatches checks the code verifier against the challenge the assistant gave at the start (S256).
func pkceMatches(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(want), []byte(challenge)) == 1
}

func (s *server) issueConnectorTokens(r *http.Request, grantID, scope string) (map[string]any, error) {
	access, refresh := randomText(32), randomText(32)
	t := now()
	if _, err := s.db.Exec(r.Context(), "INSERT INTO connector_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $2, 'access', $3), ($4, $2, 'refresh', $5)",
		sha256Hex(access), grantID, t+connectorAccessSeconds, sha256Hex(refresh), t+connectorRefreshSeconds); err != nil {
		return nil, err
	}
	return map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": connectorAccessSeconds, "refresh_token": refresh, "scope": scope}, nil
}

func (s *server) connectorToken(w http.ResponseWriter, r *http.Request) error {
	if err := r.ParseForm(); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", "The request could not be read.")
		return nil
	}
	ctx := r.Context()
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		var grantID, redirect, challenge string
		err := s.db.QueryRow(ctx, "DELETE FROM connector_codes WHERE code_hash = $1 AND expires_at > $2 RETURNING grant_id, redirect_uri, code_challenge", sha256Hex(r.PostForm.Get("code")), now()).Scan(&grantID, &redirect, &challenge)
		if errors.Is(err, pgx.ErrNoRows) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "The code is wrong, used or expired.")
			return nil
		}
		if err != nil {
			return err
		}
		if r.PostForm.Get("redirect_uri") != redirect || !pkceMatches(r.PostForm.Get("code_verifier"), challenge) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "The return address or the code verifier does not match.")
			return nil
		}
		var scope, client string
		var revoked *int64
		if err := s.db.QueryRow(ctx, "SELECT scope, client_id, revoked_at FROM connector_grants WHERE id = $1", grantID).Scan(&scope, &client, &revoked); err != nil {
			return err
		}
		if revoked != nil || (r.PostForm.Get("client_id") != "" && r.PostForm.Get("client_id") != client) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "This connection was ended.")
			return nil
		}
		reply, err := s.issueConnectorTokens(r, grantID, scope)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, reply)
		return nil
	case "refresh_token":
		var grantID, scope string
		var revoked *int64
		// One statement uses the refresh token up, so it works once; the new pair replaces it.
		err := s.db.QueryRow(ctx, "DELETE FROM connector_tokens WHERE token_hash = $1 AND kind = 'refresh' AND expires_at > $2 RETURNING grant_id", sha256Hex(r.PostForm.Get("refresh_token")), now()).Scan(&grantID)
		if errors.Is(err, pgx.ErrNoRows) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "The refresh token is wrong, used or expired.")
			return nil
		}
		if err != nil {
			return err
		}
		if err := s.db.QueryRow(ctx, "SELECT scope, revoked_at FROM connector_grants WHERE id = $1", grantID).Scan(&scope, &revoked); err != nil {
			return err
		}
		if revoked != nil {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "This connection was ended.")
			return nil
		}
		reply, err := s.issueConnectorTokens(r, grantID, scope)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, reply)
		return nil
	}
	oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "Use authorization_code or refresh_token.")
	return nil
}

// ---- the mcp service asks who a token belongs to ----

// serviceCaller checks the shared secret the mcp service sends. AUTH_MCP_TOKEN may list two (new,old) while the secret is being
// changed. Without one configured, nothing is accepted.
func (s *server) serviceCaller(r *http.Request) error {
	header := r.Header.Get("Authorization")
	if s.cfg.mcpToken == "" || len(header) < 8 || !strings.EqualFold(header[:7], "bearer ") {
		return errUnauthenticated
	}
	given := []byte(strings.TrimSpace(header[7:]))
	accepted := false
	for _, secret := range strings.Split(s.cfg.mcpToken, ",") {
		if secret = strings.TrimSpace(secret); len(secret) >= 32 && subtle.ConstantTimeCompare(given, []byte(secret)) == 1 {
			accepted = true // keep going: every listed secret is compared, so the time does not say which one matched
		}
	}
	if !accepted {
		return errUnauthenticated
	}
	return nil
}

type connectorWho struct {
	GrantID, UserID, Scope, ClientName string
}

// connectorWhoIs reads an access token's grant; nil when the token is unknown, expired, or its grant was ended.
func (s *server) connectorWhoIs(r *http.Request, token string) (*connectorWho, error) {
	var who connectorWho
	err := s.db.QueryRow(r.Context(), `SELECT g.id, g.user_id, g.scope, g.client_name FROM connector_tokens t JOIN connector_grants g ON g.id = t.grant_id
		WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > $2 AND g.revoked_at IS NULL`, sha256Hex(token), now()).Scan(&who.GrantID, &who.UserID, &who.Scope, &who.ClientName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &who, nil
}

func (s *server) connectorIntrospect(w http.ResponseWriter, r *http.Request) error {
	if err := s.serviceCaller(r); err != nil {
		return err
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	who, err := s.connectorWhoIs(r, body.Token)
	if err != nil {
		return err
	}
	if who == nil {
		writeJSON(w, http.StatusOK, map[string]any{"active": false})
		return nil
	}
	u, err := s.userBy(r.Context(), "id", who.UserID)
	if err != nil {
		return err
	}
	if u == nil || u.disabled {
		writeJSON(w, http.StatusOK, map[string]any{"active": false})
		return nil
	}
	if allowed, err := s.mayConnect(r.Context(), u.id); err != nil || !allowed {
		writeJSON(w, http.StatusOK, map[string]any{"active": false})
		return nil
	}
	_, _ = s.db.Exec(r.Context(), "UPDATE connector_grants SET last_used_at = $1 WHERE id = $2", now(), who.GrantID)
	reply := map[string]any{"active": true, "grant_id": who.GrantID, "sub": u.id, "name": u.name, "email": u.email, "scope": who.Scope, "client_name": who.ClientName}
	if s.cfg.authzURL != "" && s.cfg.authzToken != "" {
		if profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, u.id); err == nil {
			reply["platform_role"] = profile.PlatformRole
			reply["workspaces"] = profile.Workspaces
		}
	}
	writeJSON(w, http.StatusOK, reply)
	return nil
}

// connectorStanding is a workspace's plan and usage for an assistant acting for a member of that workspace.
func (s *server) connectorStanding(w http.ResponseWriter, r *http.Request) error {
	if err := s.serviceCaller(r); err != nil {
		return err
	}
	var body struct {
		Token string `json:"token"`
		Org   string `json:"org"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	who, err := s.connectorWhoIs(r, body.Token)
	if err != nil {
		return err
	}
	if who == nil || !strings.Contains(" "+who.Scope+" ", " account:read ") {
		return errUnauthenticated
	}
	if _, err := uuid.Parse(body.Org); err != nil {
		return bad("Choose a valid workspace.")
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, who.UserID)
	if err != nil {
		return errAccessUnavailable
	}
	member := false
	for _, space := range profile.Workspaces {
		member = member || space.OrgID == body.Org
	}
	if !member {
		return forbidden("This is not your workspace.")
	}
	plan, err := s.standingFor(r.Context(), body.Org)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, plan)
	return nil
}

// ---- the person sees and ends what they connected ----

func (s *server) myConnections(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), "SELECT id, client_name, scope, created_at, last_used_at FROM connector_grants WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC", c.Sub)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id, name, scope string
		var created int64
		var used *int64
		if err := rows.Scan(&id, &name, &scope, &created, &used); err != nil {
			return err
		}
		list = append(list, map[string]any{"id": id, "name": name, "scope": scope, "created_at": created, "last_used_at": used})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": list})
	return nil
}

func (s *server) revokeConnection(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return bad("That connection does not exist.")
	}
	done, err := s.db.Exec(r.Context(), "UPDATE connector_grants SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL", now(), id, c.Sub)
	if err != nil {
		return err
	}
	if done.RowsAffected() > 0 {
		_, _ = s.db.Exec(r.Context(), "DELETE FROM connector_tokens WHERE grant_id = $1", id)
		_, _ = s.db.Exec(r.Context(), "DELETE FROM connector_codes WHERE grant_id = $1", id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revoked": done.RowsAffected()})
	return nil
}
