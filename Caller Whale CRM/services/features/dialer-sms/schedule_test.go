package main

import (
	"context"
	"testing"
	"time"
)

func (e *env) setClock(t time.Time) {
	e.clockM.Lock()
	e.clock = t
	e.clockM.Unlock()
}

// Step 10, part B: the wait counts only working hours (D79); templates filled in for a lead (D210); scheduled texts sent at their time
// and cancelled once the number is blocked (D211); one message to many leads, each in their own conversation (D212).
func TestHoursTemplatesScheduledAndBulk(t *testing.T) {
	e := newEnv(t)
	owner, agent, teamLead := e.user, newUUID(), newUUID()
	rules := e.s.rules.(*fakeRules)
	g := rules.grants[owner+"|"+e.org]
	g.Roles = []string{"owner"}
	rules.grants[owner+"|"+e.org] = g
	rules.grants[agent+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"call", "message"}, Roles: []string{"caller"}}
	rules.grants[teamLead+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"team"}, Capabilities: []string{"call", "message"}, Roles: []string{"manager"}}
	lead, cold := e.addLead("+15125554444"), e.addLead("+15125555555")
	e.crm.mu.Lock()
	e.crm.leads[lead].AssigneeID, e.crm.leads[lead].TeamLeads = agent, []string{teamLead}
	e.crm.leads[cold].AssigneeID = agent
	e.crm.mu.Unlock()
	chicago, _ := time.LoadLocation("America/Chicago")

	// Working hours: Monday to Friday, 9 to 5 in Chicago. A text on Saturday is not told until Monday's wait has passed.
	if status, _ := e.callAs(agent, "PUT", "/api/v1/sms/hours", map[string]any{"time_zone": "America/Chicago", "days": map[string]any{"mon": []string{"09:00", "17:00"}}}); status != 403 {
		t.Fatalf("an agent sets the hours: %d", status)
	}
	days := map[string]any{}
	for _, d := range []string{"mon", "tue", "wed", "thu", "fri"} {
		days[d] = []string{"09:00", "17:00"}
	}
	if status, out := e.call("PUT", "/api/v1/sms/hours", map[string]any{"time_zone": "America/Chicago", "days": days}); status != 200 {
		t.Fatalf("hours: %d %v", status, out)
	}
	e.setClock(time.Date(2026, 11, 21, 12, 0, 0, 0, chicago)) // a Saturday
	e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125554444", "to": e.number, "text": "Weekend question"})
	e.sim.drain()
	told := func() int {
		if err := e.s.checkWaiting(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, a := e.callAs(teamLead, "GET", "/api/v1/sms/alerts", nil)
		return len(a["alerts"].([]any))
	}
	e.advance(2 * time.Hour)
	if told() != 0 {
		t.Fatal("told on a Saturday")
	}
	e.setClock(time.Date(2026, 11, 23, 9, 10, 0, 0, chicago))
	if told() != 0 {
		t.Fatal("told ten minutes into Monday")
	}
	e.setClock(time.Date(2026, 11, 23, 9, 16, 0, 0, chicago))
	if n := told(); n != 1 {
		var since, alerted *time.Time
		_ = e.s.st.db.QueryRow(context.Background(), `SELECT waiting_since, alerted_at FROM sms_threads WHERE lead_id = $1`, lead).Scan(&since, &alerted)
		t.Fatalf("not told once Monday's wait passed: %d, waiting since %v, told %v, now %v", n, since, alerted, e.now())
	}

	// Templates.
	if status, _ := e.callAs(agent, "POST", "/api/v1/sms/templates", map[string]any{"name": "Hello", "body": "Hi {first_name}"}); status != 403 {
		t.Fatalf("an agent writes a template: %d", status)
	}
	if status, out := e.call("POST", "/api/v1/sms/templates", map[string]any{"name": "Hello", "body": "Hi {first_name}, it's about {name}."}); status != 200 {
		t.Fatalf("template: %d %v", status, out)
	}
	_, list := e.callAs(agent, "GET", "/api/v1/sms/templates?lead_id="+lead, nil)
	if items := list["templates"].([]any); len(items) != 1 || items[0].(map[string]any)["text"] != "Hi Lead, it's about Lead +15125554444." {
		t.Fatalf("filled in: %v", list)
	}

	// A scheduled text waits for its time; one whose number said STOP meanwhile is cancelled.
	later := e.now().Add(time.Hour)
	status, scheduled := e.callAs(agent, "POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Following up", "send_at": later})
	if status != 200 || scheduled["status"] != "scheduled" {
		t.Fatalf("schedule: %d %v", status, scheduled)
	}
	due := func() {
		if err := e.s.sendDue(context.Background()); err != nil {
			t.Fatal(err)
		}
		e.sim.drain()
	}
	statusOf := func(id string) string {
		var s string
		_ = e.s.st.db.QueryRow(context.Background(), `SELECT status FROM sms_messages WHERE id = $1`, id).Scan(&s)
		return s
	}
	due()
	if statusOf(scheduled["id"].(string)) != "scheduled" {
		t.Fatal("sent before its time")
	}
	e.advance(61 * time.Minute)
	due()
	if s := statusOf(scheduled["id"].(string)); s == "scheduled" || s == "cancelled" {
		t.Fatalf("not sent at its time: %s", s)
	}
	_, again := e.callAs(agent, "POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "One more", "send_at": e.now().Add(time.Hour)})
	e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125554444", "to": e.number, "text": "STOP"})
	e.sim.drain()
	e.advance(61 * time.Minute)
	due()
	if statusOf(again["id"].(string)) != "cancelled" {
		t.Fatalf("a scheduled text to a number that said STOP: %s", statusOf(again["id"].(string)))
	}

	// One message to many leads: only the owner, admins and team leads; each lead its own text; who cannot be texted is listed.
	if status, _ := e.callAs(agent, "POST", "/api/v1/sms/bulk", map[string]any{"lead_ids": []string{lead}, "text": "Hi"}); status != 403 {
		t.Fatalf("an agent texts many: %d", status)
	}
	e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125554444", "to": e.number, "text": "start"})
	e.sim.drain()
	status, bulk := e.call("POST", "/api/v1/sms/bulk", map[string]any{"lead_ids": []string{lead, cold}, "text": "Hi {first_name}"})
	if status != 200 || bulk["scheduled"] != float64(1) || len(bulk["refused"].([]any)) != 1 {
		t.Fatalf("bulk: %d %v", status, bulk)
	}
}
