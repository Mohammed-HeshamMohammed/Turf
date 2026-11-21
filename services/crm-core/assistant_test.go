package crm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Step 26, part C: the in-app assistant summarises a lead and drafts for the agent, without the lead's phone or email; it never drafts
// a text to a blocked number; what is asked is not kept, only what the person saves; each use is charged, and a cap or budget stops it.
func TestTheInAppAssistant(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	var mu sync.Mutex
	var asked []map[string]any
	var charged []map[string]any
	capped := false
	assistant := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		asked = append(asked, body)
		mu.Unlock()
		writeJSON(w, 200, map[string]any{"text": "Pat wants an offer; call back Friday."})
	}))
	defer assistant.Close()
	billing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		defer mu.Unlock()
		if capped {
			writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "daily_cap", "message": "You have used the assistant 200 times today."}})
			return
		}
		charged = append(charged, body)
		writeJSON(w, 200, map[string]any{"ok": true})
	}))
	defer billing.Close()
	e.s.cfg.assistantURL, e.s.cfg.assistantToken = assistant.URL, strings.Repeat("a", 40)
	e.s.cfg.billingURL, e.s.cfg.billingToken = billing.URL, strings.Repeat("b", 40)

	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat Seller", "phone": "512-555-0401", "email": "pat@example.com"}), "applied")
	e.want(e.op(alice, orgA, "note.add", map[string]any{"lead_id": lead, "body": "Wants a cash offer"}), "applied")
	status, out := e.call(alice, orgA, "POST", "/api/v1/assistant/leads/"+lead+"/summary", nil)
	if status != 200 || out["text"] == "" || out["saved"] != false {
		t.Fatalf("summary: %d %v", status, out)
	}
	mu.Lock()
	facts, _ := asked[0]["facts"].(string)
	team := charged[0]["team_id"]
	mu.Unlock()
	if !strings.Contains(facts, "Wants a cash offer") || strings.Contains(facts, "555") || strings.Contains(facts, "example.com") {
		t.Fatalf("the facts sent: %q", facts)
	}
	if team != nil || charged[0]["kind"] != "ai" || charged[0]["user_id"] != alice {
		t.Fatalf("the charge: %v", charged[0])
	}

	// Drafts; never a text to a blocked number.
	if status, out := e.call(alice, orgA, "POST", "/api/v1/assistant/leads/"+lead+"/draft", map[string]any{"kind": "email", "request": "Ask for a time"}); status != 200 || out["task"] != "draft_email" {
		t.Fatalf("email draft: %d %v", status, out)
	}
	blocked := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": blocked, "name": "No Thanks", "phone": "512-555-0402"}), "applied")
	e.want(e.op(alice, orgA, "lead.update", map[string]any{"id": blocked, "changes": map[string]any{"do_not_call": true}}), "applied")
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/assistant/leads/"+blocked+"/draft", map[string]any{"kind": "text"}); status != 409 {
		t.Fatalf("a text drafted to a blocked number: %d", status)
	}

	// A "how do I" question: not about a lead, nothing kept.
	if status, out := e.call(bob, orgA, "POST", "/api/v1/assistant/ask", map[string]any{"question": "How do I log a callback?"}); status != 200 || out["text"] == "" {
		t.Fatalf("ask: %d %v", status, out)
	}
	var notes int
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1`, lead).Scan(&notes); err != nil || notes != 1 {
		t.Fatalf("something was kept without saving: %d %v", notes, err)
	}
	// Saving: the person's own text becomes a note.
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/assistant/leads/"+lead+"/save", map[string]any{"kind": "summary", "text": "Pat wants an offer; call back Friday."}); status != 200 {
		t.Fatalf("save: %d", status)
	}
	if err := e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1 AND body LIKE 'Assistant summary:%'`, lead).Scan(&notes); err != nil || notes != 1 {
		t.Fatalf("the saved summary: %d %v", notes, err)
	}

	// The daily cap (or a budget) stops it with its reason.
	mu.Lock()
	capped = true
	mu.Unlock()
	if status, out := e.call(alice, orgA, "POST", "/api/v1/assistant/leads/"+lead+"/summary", nil); status != 429 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "200 times") {
		t.Fatalf("capped: %d %v", status, out)
	}
}
