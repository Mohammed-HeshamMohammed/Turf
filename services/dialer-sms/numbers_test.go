package main

import (
	"context"
	"testing"
	"time"
)

// Step 21, part A: team numbers and the agency's default (D116); a lead keeps the number it knows (D117); calls and texts only in the
// allowed hours, which the agency can shorten (D151); agents' status (D152); who an incoming call rings (D150).
func TestTeamNumbersHoursStatusAndInboundRinging(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	teamA, teamB := newUUID(), newUUID()
	agent, other, teamLead := newUUID(), newUUID(), newUUID()
	rules := e.s.rules.(*fakeRules)
	g := rules.grants[e.user+"|"+e.org]
	g.Roles = []string{"owner"}
	rules.grants[e.user+"|"+e.org] = g
	for _, u := range []string{agent, other, teamLead} {
		rules.grants[u+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"team"}, Capabilities: []string{"call", "message"}}
	}
	// The agency's default number and team A's own.
	if status, out := e.call("PUT", "/api/v1/numbers/+15125550200", map[string]any{"user_id": e.user, "default": true}); status != 200 {
		t.Fatalf("default number: %d %v", status, out)
	}
	if status, out := e.call("PUT", "/api/v1/numbers/+15125550300", map[string]any{"user_id": teamLead, "team_id": teamA}); status != 200 {
		t.Fatalf("team number: %d %v", status, out)
	}
	lead := e.addLead("+15125556666")
	e.crm.mu.Lock()
	e.crm.leads[lead].TeamID = teamA
	e.crm.mu.Unlock()
	info, _ := e.crm.lead(ctx, e.org, e.user, lead)
	sc := scope{userID: e.user, orgID: e.org}
	if from, _ := e.s.numberFor(ctx, sc, info, "", "texts"); from != "+15125550300" {
		t.Fatalf("a team's lead is texted from the team's number: %s", from)
	}
	info.TeamID = teamB
	if from, _ := e.s.numberFor(ctx, sc, info, "", "texts"); from != "+15125550200" {
		t.Fatalf("a team without a number uses the agency's default: %s", from)
	}
	// The lead texted team A's number before moving to team B: it keeps that number.
	e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125556666", "to": "+15125550300", "text": "Hi"})
	e.sim.drain()
	if from, _ := e.s.numberFor(ctx, sc, info, "", "texts"); from != "+15125550300" {
		t.Fatalf("a moved lead keeps the number it knows: %s", from)
	}

	// Hours: not at 22:00; the agency may shorten them, never lengthen.
	day := e.now()
	e.setClock(time.Date(day.Year(), day.Month(), day.Day(), 22, 0, 0, 0, time.UTC))
	if status, out := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Late"}); status != 409 || out["error"].(map[string]any)["code"] != "outside_hours" {
		t.Fatalf("a text at 22:00: %d %v", status, out)
	}
	if status, _ := e.call("PUT", "/api/v1/sms/settings", map[string]any{"contact_from": 7, "contact_until": 21}); status != 400 {
		t.Fatalf("hours longer than allowed: %d", status)
	}
	if status, _ := e.call("PUT", "/api/v1/sms/settings", map[string]any{"contact_from": 9, "contact_until": 17}); status != 200 {
		t.Fatalf("shorter hours: %d", status)
	}
	e.setClock(time.Date(day.Year(), day.Month(), day.Day(), 18, 0, 0, 0, time.UTC))
	if status, _ := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Evening"}); status != 409 {
		t.Fatalf("a text after the agency's own hours: %d", status)
	}
	e.setClock(time.Date(day.Year(), day.Month(), day.Day(), 12, 0, 0, 0, time.UTC))

	// Status, and who an incoming call from the lead rings: its agent, else the team's available agents, then its leads.
	e.crm.mu.Lock()
	e.crm.leads[lead].AssigneeID, e.crm.leads[lead].TeamAgents, e.crm.leads[lead].TeamLeads = agent, []string{other}, []string{teamLead}
	e.crm.mu.Unlock()
	for _, u := range []string{agent, other, teamLead} {
		if _, err := e.s.st.db.Exec(ctx, `INSERT INTO agent_credentials (user_id, credential_id, sip_username) VALUES ($1, $2, $3)`, u, "cred-"+u[:4], "agent"+u[:4]); err != nil {
			t.Fatal(err)
		}
	}
	if status, _ := e.callAs(agent, "PUT", "/api/v1/status", map[string]any{"status": "on_call"}); status != 400 {
		t.Fatalf("setting on a call by hand: %d", status)
	}
	ring := func() string {
		target, err := e.s.inboundTarget(ctx, e.org, e.user, "+15125556666")
		if err != nil {
			t.Fatal(err)
		}
		return target
	}
	if ring() != "" {
		t.Fatal("nobody available: voicemail")
	}
	e.callAs(teamLead, "PUT", "/api/v1/status", map[string]any{"status": "available"})
	if ring() != teamLead {
		t.Fatal("only the team's lead is available")
	}
	e.callAs(other, "PUT", "/api/v1/status", map[string]any{"status": "available"})
	if ring() != other {
		t.Fatal("the team's other agent before its lead")
	}
	e.callAs(agent, "PUT", "/api/v1/status", map[string]any{"status": "available"})
	if ring() != agent {
		t.Fatal("the lead's own agent first")
	}
	_, statuses := e.call("GET", "/api/v1/status", nil)
	if len(statuses["people"].([]any)) != 3 {
		t.Fatalf("the owner sees everyone's status: %v", statuses)
	}
	if _, mine := e.callAs(agent, "GET", "/api/v1/status", nil); len(mine["people"].([]any)) != 1 {
		t.Fatalf("an agent sees their own: %v", mine)
	}
}
