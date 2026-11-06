package main

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestConnectorPKCE(t *testing.T) {
	verifier := strings.Repeat("v", 43)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	if !pkceMatches(verifier, challenge) {
		t.Fatal("the right verifier must match its challenge")
	}
	if pkceMatches(strings.Repeat("w", 43), challenge) || pkceMatches("short", challenge) || pkceMatches(verifier, "") {
		t.Fatal("a wrong, short or unmatched verifier must be refused")
	}
}

func TestConnectorRedirectsAndScopes(t *testing.T) {
	for uri, ok := range map[string]bool{
		"https://claude.ai/api/mcp/auth_callback": true,
		"http://localhost:6274/callback":          true,
		"http://127.0.0.1:3000/cb":                true,
		"http://example.com/cb":                   false, // http is for this computer only
		"https://example.com/cb#frag":             false,
		"https://user:pw@example.com/cb":          false,
		"javascript:alert(1)":                     false,
		"":                                        false,
	} {
		if validRedirect(uri) != ok {
			t.Errorf("validRedirect(%q) should be %v", uri, ok)
		}
	}
	if cleanScope("") != "account:read" || cleanScope("leads:write account:read account:read") != "account:read" {
		t.Fatal("only scopes that exist are kept, once, and the default fills in")
	}
}

func TestConnectorFlow(t *testing.T) {
	w := newWorld(t, func(c *config) { c.mcpToken = strings.Repeat("m", 40) })
	account := w.signUp("assistant@example.com")
	registered := w.call("POST", "/v1/connectors/register", map[string]any{"client_name": "Claude", "redirect_uris": []string{"https://claude.ai/cb"}}, "")
	if registered.status != 201 {
		t.Fatalf("register: %d %v", registered.status, registered.body)
	}
	clientID := registered.str("client_id")
	verifier := strings.Repeat("a", 64)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	consent := w.call("POST", "/v1/connectors/consent", map[string]any{"client_id": clientID, "redirect_uri": "https://claude.ai/cb", "scope": "account:read", "state": "xyz", "code_challenge": challenge}, account.access())
	if consent.status != 200 {
		t.Fatalf("consent: %d %v", consent.status, consent.body)
	}
	redirect := consent.str("redirect")
	if !strings.HasPrefix(redirect, "https://claude.ai/cb?") || !strings.Contains(redirect, "state=xyz") || !strings.Contains(redirect, "code=") {
		t.Fatalf("the person returns to the assistant with a code and the state: %s", redirect)
	}
	if bad := w.call("POST", "/v1/connectors/consent", map[string]any{"client_id": clientID, "redirect_uri": "https://evil.example/cb", "code_challenge": challenge}, account.access()); bad.status != 400 {
		t.Fatalf("an unregistered return address is refused: %d", bad.status)
	}
	if anonymous := w.call("POST", "/v1/connectors/consent", map[string]any{"client_id": clientID}, ""); anonymous.status != 401 {
		t.Fatalf("consent needs a signed-in person: %d", anonymous.status)
	}
	if list := w.call("GET", "/v1/me/connections", nil, account.access()); list.status != 200 {
		t.Fatalf("list connections: %d", list.status)
	}
}
