package telnyx

import (
	"context"
	"net/http"
	"sync"
	"testing"
)

// fakeBudgets keeps budgets and use the way billing does: a use is refused when it would pass a budget it falls under.
type fakeBudgets struct {
	mu       sync.Mutex
	monthly  map[string]int // scope|subject|kind
	used     map[string]int
	charged  map[string]int // request id -> amount
	requests []raiseAsk
}

func (f *fakeBudgets) use(_ context.Context, a usageAsk) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, done := f.charged[a.RequestID]; done && !a.CheckOnly {
		return nil
	}
	keys := []string{}
	if a.TeamID != nil {
		keys = append(keys, "team|"+*a.TeamID+"|"+a.Kind)
	}
	if a.UserID != nil {
		keys = append(keys, "person|"+*a.UserID+"|"+a.Kind)
	}
	for _, k := range keys {
		if limit, ok := f.monthly[k]; ok && f.used[k]+a.Amount > limit {
			return &apiError{http.StatusPaymentRequired, "budget_reached", "The budget for this month is used up. Ask your team lead or the owner to raise it."}
		}
	}
	if a.CheckOnly {
		return nil
	}
	for _, k := range keys {
		f.used[k] += a.Amount
	}
	f.charged[a.RequestID] = a.Amount
	return nil
}
func (f *fakeBudgets) setBudget(_ context.Context, _ string, b budgetSet) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.monthly[b.Scope+"|"+b.SubjectID+"|"+b.Kind] = *b.Monthly
	return nil
}
func (f *fakeBudgets) list(_ context.Context, _ string) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return map[string]any{"budgets": len(f.monthly), "raise_requests": len(f.requests)}, nil
}
func (f *fakeBudgets) askRaise(_ context.Context, _ string, r raiseAsk) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r)
	return newUUID(), nil
}

// Step 22: budgets set by the right people; a text past the team's budget is refused and its sender can ask for more; a call's talk
// time is charged to the lead's team once (D120-D123).
func TestBudgetsStopPaidUseAndChargeTheLeadsTeam(t *testing.T) {
	e := newEnv(t)
	fake := &fakeBudgets{monthly: map[string]int{}, used: map[string]int{}, charged: map[string]int{}}
	e.s.budget = fake
	owner, agent, teamLead, stranger := e.user, newUUID(), newUUID(), newUUID()
	team := newUUID()
	rules := e.s.rules.(*fakeRules)
	g := rules.grants[owner+"|"+e.org]
	g.Roles = []string{"owner"}
	rules.grants[owner+"|"+e.org] = g
	rules.grants[agent+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"call", "message"}, TeamIDs: []string{team}}
	rules.grants[teamLead+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"team"}, Capabilities: []string{"call", "message"}, ManagedTeamIDs: []string{team}}
	rules.grants[stranger+"|"+e.org] = grantReply{Allowed: true, Scopes: []string{"own"}, Capabilities: []string{"call", "message"}, TeamIDs: []string{newUUID()}}
	lead := e.addLead("+15125550001")
	e.crm.mu.Lock()
	e.crm.leads[lead].AssigneeID, e.crm.leads[lead].TeamID = agent, team
	e.crm.mu.Unlock()
	one := 1
	set := func(user, scope, subject string) int {
		status, _ := e.callAs(user, "PUT", "/api/v1/budgets", map[string]any{"scope": scope, "subject_id": subject, "kind": "texts", "monthly": one})
		return status
	}
	if set(agent, "team", team) != 403 || set(teamLead, "team", team) != 403 || set(teamLead, "person", stranger) != 403 {
		t.Fatal("who sets budgets")
	}
	if set(owner, "team", team) != 200 || set(teamLead, "person", agent) != 200 {
		t.Fatal("the owner sets the team's, its lead the agent's")
	}

	e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125550001", "to": e.number, "text": "Hi"})
	e.sim.drain()
	if status, out := e.callAs(agent, "POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Hello"}); status != 200 {
		t.Fatalf("the first text: %d %v", status, out)
	}
	status, out := e.callAs(agent, "POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Again"})
	if status != http.StatusPaymentRequired || out["error"].(map[string]any)["code"] != "budget_reached" {
		t.Fatalf("past the budget: %d %v", status, out)
	}
	if status, _ := e.callAs(agent, "POST", "/api/v1/budgets/raise", map[string]any{"scope": "team", "subject_id": team, "kind": "texts", "note": "Busy week"}); status != 200 {
		t.Fatalf("asking for more: %d", status)
	}
	if _, listed := e.call("GET", "/api/v1/budgets", nil); listed["raise_requests"] != float64(1) {
		t.Fatalf("the owner sees the request: %v", listed)
	}
	if status, _ := e.callAs(agent, "GET", "/api/v1/budgets", nil); status != 403 {
		t.Fatalf("an agent lists the budgets: %d", status)
	}

	// A call's talk time is charged to the lead's team, once.
	status, call := e.callAs(agent, "POST", "/api/v1/calls", map[string]any{"lead_id": lead})
	if status != 200 {
		t.Fatalf("call: %d %v", status, call)
	}
	e.sim.drain()
	e.settle()
	e.advance(e.s.cfg.wrapup) // the agent's wrap-up time passes
	e.settle()
	e.settle()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.charged[call["id"].(string)] < 1 || fake.used["team|"+team+"|minutes"] != fake.charged[call["id"].(string)] {
		t.Fatalf("the call's minutes: %v %v", fake.charged, fake.used)
	}
}
