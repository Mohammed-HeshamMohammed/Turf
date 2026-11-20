package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// connectorToken connects an outside AI for the signed-in person with the given scope and answers its access token.
func (w *world) connectorToken(access, scope string) string {
	w.t.Helper()
	registered := w.call("POST", "/v1/connectors/register", map[string]any{"client_name": "Claude", "redirect_uris": []string{"https://claude.ai/cb"}}, "")
	verifier := strings.Repeat("v", 64)
	sum := sha256.Sum256([]byte(verifier))
	consent := w.call("POST", "/v1/connectors/consent", map[string]any{"client_id": registered.str("client_id"), "redirect_uri": "https://claude.ai/cb",
		"scope": scope, "state": "s", "code_challenge": base64.RawURLEncoding.EncodeToString(sum[:])}, access)
	if consent.status != 200 {
		w.t.Fatalf("consent: %d %v", consent.status, consent.body)
	}
	back, _ := url.Parse(consent.str("redirect"))
	form := url.Values{"grant_type": {"authorization_code"}, "code": {back.Query().Get("code")}, "redirect_uri": {"https://claude.ai/cb"}, "code_verifier": {verifier}}
	req := httptest.NewRequest("POST", "/v1/connectors/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	w.h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	token, _ := out["access_token"].(string)
	if token == "" {
		w.t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
	}
	return token
}

// Step 24: an outside AI reads the agency's people with team:manage, asks for changes that wait for the person, and can never ask for
// anything that spends money (D130, D131).
func TestAnAIAsksAndThePersonConfirms(t *testing.T) {
	w, fake, _ := lifecycleWorld(t)
	mcp := strings.Repeat("m", 40)
	w.s.cfg.mcpToken = mcp
	w.h = w.s.handler()
	boss := w.stepped("boss@example.com").access()
	fake.mu.Lock()
	fake.owner = w.idOf("boss@example.com")
	fake.mu.Unlock()

	readOnly := w.connectorToken(boss, "account:read")
	if a := w.call("POST", "/v1/connectors/people", map[string]any{"token": readOnly, "org": flowOrg}, mcp); a.status != http.StatusUnauthorized {
		t.Fatalf("people without team:manage: %d", a.status)
	}
	ai := w.connectorToken(boss, "account:read team:manage")
	if a := w.call("POST", "/v1/connectors/people", map[string]any{"token": ai, "org": flowOrg}, mcp); a.status != 200 || len(a.body["people"].([]any)) == 0 {
		t.Fatalf("people: %d %v", a.status, a.body)
	}
	if a := w.call("POST", "/v1/connectors/requests", map[string]any{"token": ai, "org": flowOrg, "kind": "invite", "args": map[string]any{"email": "x@example.com", "roles": []string{"caller"}}}, boss); a.status == 200 {
		t.Fatal("a person's own sign-in is not the MCP service")
	}
	for _, kind := range []string{"pay", "raise_budget", "change_plan", "add_seats"} {
		if a := w.call("POST", "/v1/connectors/requests", map[string]any{"token": ai, "org": flowOrg, "kind": kind}, mcp); a.status != 403 {
			t.Fatalf("an AI asked to %s: %d", kind, a.status)
		}
	}
	asked := w.call("POST", "/v1/connectors/requests", map[string]any{"token": ai, "org": flowOrg, "kind": "invite",
		"args": map[string]any{"email": "new@example.com", "roles": []string{"caller"}, "team_ids": []string{flowTeam}}}, mcp)
	if asked.status != 200 || asked.str("status") != "waiting" {
		t.Fatalf("ask: %d %v", asked.status, asked.body)
	}
	if n := w.count("SELECT count(*) FROM access_invitations WHERE email = 'new@example.com'"); n != 0 {
		t.Fatal("the invitation was sent before the person confirmed")
	}
	waiting := w.call("GET", "/v1/me/ai-requests", nil, boss)
	if list := waiting.body["requests"].([]any); len(list) != 1 || list[0].(map[string]any)["summary"] != "Invite new@example.com as caller" {
		t.Fatalf("the person sees the request: %v", waiting.body)
	}
	done := w.call("POST", "/v1/me/ai-requests/"+asked.str("id")+"/approve", nil, boss)
	if done.status != 200 || done.body["ok"] != true || done.body["status"] != float64(201) {
		t.Fatalf("approve: %d %v", done.status, done.body)
	}
	if n := w.count("SELECT count(*) FROM access_invitations WHERE email = 'new@example.com'"); n != 1 {
		t.Fatal("approving did not send the invitation")
	}
	if a := w.call("POST", "/v1/me/ai-requests/"+asked.str("id")+"/approve", nil, boss); a.status != 404 {
		t.Fatalf("approving twice: %d", a.status)
	}
	// Rejected: nothing changes.
	again := w.call("POST", "/v1/connectors/requests", map[string]any{"token": ai, "org": flowOrg, "kind": "invite", "args": map[string]any{"email": "no@example.com", "roles": []string{"caller"}, "team_ids": []string{flowTeam}}}, mcp)
	if a := w.call("POST", "/v1/me/ai-requests/"+again.str("id")+"/reject", nil, boss); a.status != 200 {
		t.Fatalf("reject: %d", a.status)
	}
	if n := w.count("SELECT count(*) FROM access_invitations WHERE email = 'no@example.com'"); n != 0 {
		t.Fatal("a rejected request changed something")
	}
}
