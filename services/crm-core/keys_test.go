package crm

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type hookCatcher struct {
	mu     sync.Mutex
	status int
	got    []*http.Request
	bodies [][]byte
}

func (h *hookCatcher) RoundTrip(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.got, h.bodies = append(h.got, r), append(h.bodies, b)
	return &http.Response{StatusCode: h.status, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
}

func TestEventAddressesArePublicOnly(t *testing.T) {
	for _, a := range []string{"127.0.0.1:443", "10.0.0.5:443", "169.254.169.254:80", "[::1]:443"} {
		if publicOnly("tcp", a, nil) == nil {
			t.Errorf("%s was allowed", a)
		}
	}
	if err := publicOnly("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("a public address: %v", err)
	}
}

// Step 33: a key for one outside tool, limited to its team and what it was given, switchable, recorded, and stopped when its maker
// loses the right (D233); events carry only the event, ids and the time, signed, retried when the address fails (D234).
func TestKeysAndEvents(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT = "aaaaaaaa-0000-4000-8000-000000000401"
	e.rules.mu.Lock()
	g := e.rules.grants[alice+"|"+orgA]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T"}}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)

	if code, _ := e.call(bob, orgA, "POST", "/api/v1/keys", map[string]any{"name": "Mine", "scopes": []string{"leads:read"}}); code != 403 {
		t.Fatalf("a caller makes a key: %d", code)
	}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/keys", map[string]any{"name": "Dialer", "scopes": []string{"calls:make"}}); code != 400 {
		t.Fatalf("a key that spends: %d", code)
	}
	code, made := e.call(alice, orgA, "POST", "/api/v1/keys", map[string]any{"name": "Web form", "scopes": []string{"leads:add", "leads:read"}, "team_id": teamT})
	if code != 200 || !strings.HasPrefix(made["key"].(string), "cwk_") {
		t.Fatalf("key: %d %v", code, made)
	}
	key := made["key"].(string)
	tool := func(method, path, k string, body any) (int, map[string]any) {
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, r)
		req.Header.Set("Authorization", "Bearer "+k)
		rec := httptest.NewRecorder()
		e.s.handler().ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, added := tool("POST", "/api/v1/tools/leads", key, map[string]any{"leads": []map[string]any{{"name": "Form Lead", "phone": "512-555-1201", "note": "From the site"}}})
	if code != 200 || len(added["ids"].([]any)) != 1 {
		t.Fatalf("add: %d %v", code, added)
	}
	newLead := added["ids"].([]any)[0].(string)
	var team, assignee *string
	if err := e.admin.QueryRow(ctx, `SELECT team_id::text, assignee_id::text FROM crm.leads WHERE id = $1`, newLead).Scan(&team, &assignee); err != nil || team == nil || *team != teamT || assignee != nil {
		t.Fatalf("the new lead waits unassigned in the key's team: %v %v %v", team, assignee, err)
	}
	if code, out := tool("GET", "/api/v1/tools/leads/"+newLead, key, nil); code != 200 || out["name"] != "Form Lead" {
		t.Fatalf("read: %d %v", code, out)
	}
	other := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": other, "name": "Elsewhere", "phone": "512-555-1202"}), "applied")
	if code, _ := tool("GET", "/api/v1/tools/leads/"+other, key, nil); code != 404 {
		t.Fatalf("a lead outside the key's team: %d", code)
	}
	if code, _ := tool("GET", "/api/v1/tools/deals/"+newID(t), key, nil); code != 403 {
		t.Fatalf("a scope the key lacks: %d", code)
	}
	if code, _ := tool("GET", "/api/v1/tools/leads/"+newLead, "cwk_"+strings.Repeat("0", 32)+"."+strings.Repeat("1", 20), nil); code != 401 {
		t.Fatalf("a made-up key: %d", code)
	}
	e.call(alice, orgA, "POST", "/api/v1/keys/"+made["id"].(string)+"/off", nil)
	if code, _ := tool("GET", "/api/v1/tools/leads/"+newLead, key, nil); code != 403 {
		t.Fatalf("a key switched off: %d", code)
	}
	e.call(alice, orgA, "POST", "/api/v1/keys/"+made["id"].(string)+"/on", nil)
	e.rules.mu.Lock()
	e.rules.grants[alice+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"edit"}, Roles: []string{"caller"}}
	e.rules.mu.Unlock()
	if code, _ := tool("GET", "/api/v1/tools/leads/"+newLead, key, nil); code != 403 {
		t.Fatalf("a key whose maker lost the right: %d", code)
	}
	e.rules.mu.Lock()
	e.rules.grants[alice+"|"+orgA] = g
	e.rules.mu.Unlock()
	if _, uses := e.call(alice, orgA, "GET", "/api/v1/keys/"+made["id"].(string)+"/uses", nil); len(uses["uses"].([]any)) < 6 {
		t.Fatalf("the record of uses: %v", uses)
	}

	// Events.
	catcher := &hookCatcher{status: 500}
	e.s.hookHTTP = &http.Client{Transport: catcher}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/hooks", map[string]any{"url": "http://hooks.test/x", "events": []string{"deal.won"}}); code != 400 {
		t.Fatalf("an address without https: %d", code)
	}
	code, hook := e.call(alice, orgA, "POST", "/api/v1/hooks", map[string]any{"url": "https://hooks.test/caller-whale", "events": []string{"deal.won"}})
	if code != 200 {
		t.Fatalf("hook: %d %v", code, hook)
	}
	deal := newID(t)
	e.want(e.op(alice, orgA, "deal.create", map[string]any{"id": deal, "lead_id": other, "fee": 9000}), "applied")
	e.want(e.op(alice, orgA, "deal.update", map[string]any{"id": deal, "changes": map[string]any{"stage": "Closed won"}}), "applied")
	if err := e.s.sendDueEvents(ctx); err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err := e.admin.QueryRow(ctx, `SELECT attempts FROM crm.event_deliveries`).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("the failed delivery: %d %v", attempts, err)
	}
	catcher.mu.Lock()
	catcher.status = 200
	catcher.mu.Unlock()
	if _, err := e.admin.Exec(ctx, `UPDATE crm.event_due SET next_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err := e.s.sendDueEvents(ctx); err != nil {
		t.Fatal(err)
	}
	catcher.mu.Lock()
	defer catcher.mu.Unlock()
	if len(catcher.got) != 2 {
		t.Fatalf("deliveries: %d", len(catcher.got))
	}
	body, req := catcher.bodies[1], catcher.got[1]
	var msg map[string]any
	_ = json.Unmarshal(body, &msg)
	if msg["event"] != "deal.won" || msg["id"] != deal || msg["lead_id"] != other || len(msg) != 4 || strings.Contains(string(body), "Elsewhere") {
		t.Fatalf("the message: %s", body)
	}
	mac := hmac.New(sha256.New, []byte(hook["secret"].(string)))
	mac.Write([]byte(req.Header.Get("X-CallerWhale-Timestamp") + "." + string(body)))
	if req.Header.Get("X-CallerWhale-Signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("the signature does not check")
	}
}
