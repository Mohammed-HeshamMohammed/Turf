package main

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
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

// fakeAuthz answers the authorization service's person lookup: a person in one workspace, or in none.
func fakeAuthz(member *bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		spaces := `[]`
		if *member {
			spaces = `[{"org_id":"11111111-1111-1111-1111-111111111111","roles":["owner"],"business_owner":true}]`
		}
		w.Header().Set("Content-Type", "application/json")
		// The answer is about the person asked for (auth refuses an answer about someone else).
		user := strings.TrimPrefix(r.URL.Path, "/v1/people/")
		_, _ = w.Write([]byte(`{"user_id":"` + user + `","platform_role":"","workspaces":` + spaces + `}`))
	}))
}

func TestConnectorFlow(t *testing.T) {
	member := true
	authz := fakeAuthz(&member)
	defer authz.Close()
	w := newWorld(t, func(c *config) { c.mcpToken = strings.Repeat("m", 40); c.authzURL = authz.URL; c.authzToken = "token" })
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
	// Someone with no staff role and no workspace has nothing for an assistant to act on.
	member = false
	if refused := w.call("POST", "/v1/connectors/consent", map[string]any{"client_id": clientID, "redirect_uri": "https://claude.ai/cb", "scope": "account:read", "code_challenge": challenge}, account.access()); refused.status != 403 {
		t.Fatalf("a person with no role cannot connect an assistant: %d %v", refused.status, refused.body)
	}
}

func TestTheMCPSecretCanBeRotated(t *testing.T) {
	oldSecret, newSecret := strings.Repeat("o", 40), strings.Repeat("n", 40)
	s := &server{cfg: config{mcpToken: newSecret + "," + oldSecret}}
	call := func(token string) error {
		r := httptest.NewRequest("POST", "/v1/connectors/introspect", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return s.serviceCaller(r)
	}
	if call(newSecret) != nil || call(oldSecret) != nil {
		t.Fatal("both the new and the old secret work during a rotation")
	}
	if call(strings.Repeat("x", 40)) == nil || call("") == nil || call("short") == nil {
		t.Fatal("any other secret is refused")
	}
	if (&server{cfg: config{}}).serviceCaller(httptest.NewRequest("POST", "/", nil)) == nil {
		t.Fatal("with no secret configured nothing is accepted")
	}
	short := &server{cfg: config{mcpToken: "tooshort"}}
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set("Authorization", "Bearer tooshort")
	if short.serviceCaller(r) == nil {
		t.Fatal("a secret under 32 characters is never accepted")
	}
}

func TestAssistantNamesArePlainText(t *testing.T) {
	for name, ok := range map[string]bool{
		"Claude": true, "ChatGPT (work)": true, "Gemini-2 & co": true, "Café Bot": true, "O'Brien's helper": true,
		"<img src=x onerror=alert(1)>": false, "Claude‮": false, "Bot\x00": false, "a\"b": false, "{{7*7}}": false,
	} {
		if plainName(name) != ok {
			t.Errorf("plainName(%q) should be %v", name, ok)
		}
	}
}
