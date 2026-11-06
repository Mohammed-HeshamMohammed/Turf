package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const goodToken = "good-access-token"

// fakeAuth answers the two private questions the way the auth service does.
func fakeAuth(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 40) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/v1/connectors/introspect":
			if body["token"] != goodToken {
				_ = json.NewEncoder(w).Encode(map[string]any{"active": false})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"active": true, "grant_id": "g1", "sub": "u1", "name": "Mohammed Hesham", "email": "m@example.com", "scope": "account:read", "client_name": "Claude",
				"workspaces": []map[string]any{{"org_id": "11111111-1111-1111-1111-111111111111", "roles": []string{}, "business_owner": true}}})
		case "/v1/connectors/standing":
			_ = json.NewEncoder(w).Encode(map[string]any{"org_id": body["org"], "plan": "starter", "plan_name": "Starter", "status": "active", "minutes_allowed": 5000, "minutes_used": 1250, "percent_used": 25.0})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func newTestServer(t *testing.T) (*server, http.Handler, func()) {
	auth := fakeAuth(t)
	s := newServer(config{port: "0", publicURL: "https://mcp.example.com", authPublic: "https://auth.example.com", authURL: auth.URL, authToken: strings.Repeat("s", 40)}, auth.Client())
	return s, s.handler(), auth.Close
}

func rpc(t *testing.T, h http.Handler, token string, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/mcp", bytes.NewBufferString(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not JSON: %s", rec.Body.String())
	}
	return out
}

func resultOf(out map[string]any) map[string]any {
	result, _ := out["result"].(map[string]any)
	return result
}

func textOf(out map[string]any) string {
	content, _ := resultOf(out)["content"].([]any)
	if len(content) == 0 {
		return ""
	}
	text, _ := content[0].(map[string]any)["text"].(string)
	return text
}

func TestWithoutATokenTheAssistantIsSentToSignIn(t *testing.T) {
	_, h, done := newTestServer(t)
	defer done()
	rec := rpc(t, h, "", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if rec.Code != 401 || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "https://mcp.example.com/.well-known/oauth-protected-resource") {
		t.Fatalf("expected 401 with the resource pointer, got %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	if rec := rpc(t, h, "ended-token", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); rec.Code != 401 {
		t.Fatalf("an unknown or ended token is refused: %d", rec.Code)
	}
}

func TestDiscoveryNamesTheAuthServer(t *testing.T) {
	_, h, done := newTestServer(t)
	defer done()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/.well-known/oauth-protected-resource", nil))
	meta := decode(t, rec)
	servers, _ := meta["authorization_servers"].([]any)
	if rec.Code != 200 || meta["resource"] != "https://mcp.example.com" || len(servers) != 1 || servers[0] != "https://auth.example.com" {
		t.Fatalf("discovery: %d %s", rec.Code, rec.Body.String())
	}
}

func TestInitializeListAndCallTools(t *testing.T) {
	_, h, done := newTestServer(t)
	defer done()
	initialized := decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`))
	if resultOf(initialized)["protocolVersion"] != "2025-03-26" {
		t.Fatalf("the asked version is answered: %v", initialized)
	}
	if rec := rpc(t, h, goodToken, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); rec.Code != 202 {
		t.Fatalf("a notification is accepted without an answer: %d", rec.Code)
	}
	list := decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	if tools, _ := resultOf(list)["tools"].([]any); len(tools) != 2 {
		t.Fatalf("two tools: %v", list)
	}
	who := textOf(decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`)))
	if !strings.Contains(who, "Mohammed Hesham") || !strings.Contains(who, "agency owner") {
		t.Fatalf("whoami: %s", who)
	}
	plan := textOf(decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"plan_and_usage","arguments":{}}}`)))
	if !strings.Contains(plan, "Starter plan") || !strings.Contains(plan, "1250 of 5000") {
		t.Fatalf("plan: %s", plan)
	}
	other := decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"plan_and_usage","arguments":{"workspace_id":"someone-elses"}}}`))
	if resultOf(other)["isError"] != true {
		t.Fatalf("a workspace that is not theirs is refused: %v", other)
	}
	unknown := decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"delete_everything"}}`))
	if resultOf(unknown)["isError"] != true {
		t.Fatalf("an unknown tool is an error: %v", unknown)
	}
	if bad := decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":7,"method":"resources/list"}`)); bad["error"] == nil {
		t.Fatalf("an unsupported method is an error: %v", bad)
	}
}

func TestEachConnectionIsLimited(t *testing.T) {
	s, h, done := newTestServer(t)
	defer done()
	base := time.Now()
	s.now = func() time.Time { return base }
	limited := false
	for i := 0; i < callsPerMinute+5; i++ {
		if resultOf(decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami"}}`)))["isError"] == true {
			limited = true
		}
	}
	if !limited {
		t.Fatal("more than the limit in a minute must be refused")
	}
	s.now = func() time.Time { return base.Add(2 * time.Minute) }
	if resultOf(decode(t, rpc(t, h, goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami"}}`)))["isError"] == true {
		t.Fatal("a new minute starts fresh")
	}
}

func TestConfigNeedsItsSettings(t *testing.T) {
	get := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if _, err := loadConfig(get(map[string]string{})); err == nil {
		t.Fatal("no settings is an error")
	}
	if _, err := loadConfig(get(map[string]string{"MCP_PUBLIC_URL": "https://m", "MCP_AUTH_PUBLIC_URL": "https://a", "MCP_AUTH_URL": "http://auth:8101", "MCP_AUTH_TOKEN": "short"})); err == nil {
		t.Fatal("a short secret is an error")
	}
	c, err := loadConfig(get(map[string]string{"MCP_PUBLIC_URL": "https://m/", "MCP_AUTH_PUBLIC_URL": "https://a", "MCP_AUTH_URL": "http://auth:8101", "MCP_AUTH_TOKEN": strings.Repeat("s", 40)}))
	if err != nil || c.port != "8106" || c.publicURL != "https://m" {
		t.Fatalf("a full set loads with defaults: %v %v", c, err)
	}
}
