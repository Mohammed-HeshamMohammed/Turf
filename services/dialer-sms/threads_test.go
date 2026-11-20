package main

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// callAs is call for another person of the workspace.
func (e *env) callAs(user, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	saved := e.user
	e.user = user
	defer func() { e.user = saved }()
	return e.call(method, path, body)
}

// Step 10: one sender per lead conversation, takeover by rank and handing back, notes, and the unanswered-text wait (D16-D21, D48,
// D76, D77, D96).
func TestLeadThreads(t *testing.T) {
	e := newEnv(t)
	owner, agent, teamLead, deputy := e.user, newUUID(), newUUID(), newUUID()
	rules := e.s.rules.(*fakeRules)
	for _, u := range []string{agent, teamLead, deputy} {
		rules.grants[u+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"team"}, Capabilities: []string{"call", "message"}}
	}
	lead := e.addLead("+15125553333")
	e.crm.mu.Lock()
	e.crm.leads[lead].AssigneeID, e.crm.leads[lead].TeamID = agent, newUUID()
	e.crm.leads[lead].TeamLeads, e.crm.leads[lead].TeamDeputies = []string{teamLead}, []string{deputy}
	e.crm.ranks = map[string]string{owner + "|" + lead: "owner", teamLead + "|" + lead: "lead", deputy + "|" + lead: "deputy", agent + "|" + lead: "agent"}
	e.crm.mu.Unlock()
	text := func(user string) (int, map[string]any) {
		return e.callAs(user, "POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Hello"})
	}
	thread := func(user string) map[string]any {
		_, out := e.callAs(user, "GET", "/api/v1/sms/threads/"+lead, nil)
		return out
	}
	act := func(user, action string) int {
		status, _ := e.callAs(user, "POST", "/api/v1/sms/threads/"+lead+"/"+action, nil)
		return status
	}
	inbound := func() {
		e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125553333", "to": e.number, "text": "Are you there?"})
		e.sim.drain()
	}
	inbound()

	// Only the agent sends; the owner reads.
	if status, out := text(owner); status != http.StatusConflict || out["error"].(map[string]any)["code"] != "not_holder" {
		t.Fatalf("the owner texts over the agent: %d %v", status, out)
	}
	if status, out := text(agent); status != 200 {
		t.Fatalf("the agent texts: %d %v", status, out)
	}
	if view := thread(owner); view["sender_id"] != agent || view["may_send"] != false || view["may_take_over"] != true || len(view["messages"].([]any)) != 2 {
		t.Fatalf("the owner's view: %v", view)
	}

	// A text that waits too long tells the team's leads and deputies.
	inbound()
	e.advance(16 * time.Minute)
	if err := e.s.checkWaiting(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, alerts := e.callAs(teamLead, "GET", "/api/v1/sms/alerts", nil)
	if list := alerts["alerts"].([]any); len(list) != 1 || list[0].(map[string]any)["kind"] != "unanswered" {
		t.Fatalf("the lead is told: %v", alerts)
	}
	if _, a := e.callAs(agent, "GET", "/api/v1/sms/alerts", nil); len(a["alerts"].([]any)) != 0 {
		t.Fatalf("the agent is not told about their own wait: %v", a)
	}

	// Takeover follows rank; the agent can ask for it back but not take it.
	if act(agent, "takeover") != 403 || act(deputy, "takeover") != 200 || act(teamLead, "takeover") != 200 || act(deputy, "takeover") != 403 {
		t.Fatal("takeover by rank")
	}
	if status, _ := text(agent); status != http.StatusConflict {
		t.Fatalf("the agent texts a taken-over conversation: %d", status)
	}
	if act(agent, "ask-back") != 200 || thread(teamLead)["control"].(map[string]any)["back_asked_at"] == nil {
		t.Fatal("asking for it back")
	}
	if status, _ := text(teamLead); status != 200 {
		t.Fatalf("the holder texts: %d", status)
	}
	if act(owner, "handback") != 403 || act(teamLead, "handback") != 200 || thread(owner)["sender_id"] != agent {
		t.Fatal("handing back")
	}

	// A holder who does not answer in time: control returns to the agent, both are told.
	if act(owner, "takeover") != 200 {
		t.Fatal("the owner takes over")
	}
	inbound()
	e.advance(16 * time.Minute)
	if err := e.s.checkWaiting(context.Background()); err != nil {
		t.Fatal(err)
	}
	if view := thread(agent); view["sender_id"] != agent || view["may_send"] != true {
		t.Fatalf("back with the agent: %v", view)
	}
	for _, user := range []string{owner, agent} {
		_, a := e.callAs(user, "GET", "/api/v1/sms/alerts", nil)
		list := a["alerts"].([]any)
		if len(list) == 0 || list[0].(map[string]any)["kind"] != "returned" {
			t.Fatalf("%s is told it returned: %v", user[:4], a)
		}
	}

	// Notes are for everyone who sees the thread, and never sent.
	if status, _ := e.callAs(deputy, "POST", "/api/v1/sms/threads/"+lead+"/notes", map[string]any{"body": "Prefers mornings"}); status != 200 {
		t.Fatalf("note: %d", status)
	}
	if notes := thread(agent)["notes"].([]any); len(notes) != 1 || notes[0].(map[string]any)["body"] != "Prefers mornings" {
		t.Fatalf("the agent reads the note: %v", notes)
	}

	// The agency sets its wait.
	if status, _ := e.callAs(agent, "PUT", "/api/v1/sms/settings", map[string]any{"wait_minutes": 5}); status != 403 {
		t.Fatalf("an agent sets the wait: %d", status)
	}
	if status, _ := e.call("PUT", "/api/v1/sms/settings", map[string]any{"wait_minutes": 5}); status != 200 {
		t.Fatalf("the owner sets the wait: %d", status)
	}
}

// Step 32: a team's leads see its unanswered texts; an agent does not (D226).
func TestWaitingTextsForTheTeamLead(t *testing.T) {
	e := newEnv(t)
	team, teamLead, agent := newUUID(), newUUID(), newUUID()
	rules := e.s.rules.(*fakeRules)
	rules.grants[teamLead+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"team"}, Capabilities: []string{"call", "message"}, ManagedTeamIDs: []string{team}}
	rules.grants[agent+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"call", "message"}}
	if _, err := e.s.st.db.Exec(context.Background(), `INSERT INTO sms_threads (org_id, lead_id, team_id, waiting_since) VALUES ($1, $2, $3, now())`, e.org, newUUID(), team); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.callAs(agent, "GET", "/api/v1/sms/waiting?team_id="+team, nil); status != 403 {
		t.Fatalf("an agent: %d", status)
	}
	if status, out := e.callAs(teamLead, "GET", "/api/v1/sms/waiting?team_id="+team, nil); status != 200 || len(out["waiting"].([]any)) != 1 {
		t.Fatalf("the team's lead: %d %v", status, out)
	}
}
