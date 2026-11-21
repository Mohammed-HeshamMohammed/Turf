package crm

import (
	"context"
	"testing"
)

// Step 27: commission tracking, off until the owner switches it on; a fixed amount per appointment for callers, a percentage of a won
// deal for its closer, split with the caller who set it up; each person sees their own, the owner everyone's, and the owner's override
// replaces a figure (D144, D149).
func TestCommissions(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const dave = "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	g := e.rules.grants[alice+"|"+orgA]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	closer := owner()
	closer.Roles = []string{"closer"}
	e.rules.grants[dave+"|"+orgA] = closer
	e.rules.people_[dave] = peopleReply{UserID: dave, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"closer"}}}}
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}}, {UserID: dave, Roles: []string{"closer"}}}
	e.rules.mu.Unlock()

	if status, _ := e.call(alice, orgA, "GET", "/api/v1/commissions", nil); status != 409 {
		t.Fatalf("commissions while off: %d", status)
	}
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/commissions/settings", map[string]any{"on": true}); status != 403 {
		t.Fatalf("someone else switches commissions on: %d", status)
	}
	e.call(alice, orgA, "PUT", "/api/v1/commissions/settings", map[string]any{"on": true, "split": 20})
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/commissions/rules", map[string]any{"role": "caller", "per_appointment": 25}); status != 200 {
		t.Fatalf("role rule: %d", status)
	}
	e.call(alice, orgA, "PUT", "/api/v1/commissions/rules", map[string]any{"user_id": dave, "deal_percent": 10})

	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat", "phone": "512-555-0501"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2 WHERE id = $1`, lead, bob); err != nil {
		t.Fatal(err)
	}
	e.want(e.op(bob, orgA, "call.record", map[string]any{"lead_id": lead, "outcome": "Transfer"}), "applied")
	deal := newID(t)
	e.want(e.op(alice, orgA, "deal.create", map[string]any{"id": deal, "lead_id": lead, "amount": 250000, "fee": 10000}), "applied")
	e.want(e.op(dave, orgA, "deal.update", map[string]any{"id": deal, "changes": map[string]any{"stage": "Closed won"}}), "applied")

	_, mine := e.call(bob, orgA, "GET", "/api/v1/commissions", nil)
	if items := mine["items"].([]any); len(items) != 2 {
		t.Fatalf("the caller's own items: %v", mine)
	}
	if total := mine["totals"].(map[string]any)[bob].(map[string]any)["USD"]; total != float64(225) {
		t.Fatalf("the caller earns 25 for the appointment and 20%% of the 1,000 deal commission: %v", total)
	}
	_, all := e.call(alice, orgA, "GET", "/api/v1/commissions", nil)
	if total := all["totals"].(map[string]any)[dave].(map[string]any)["USD"]; total != float64(800) {
		t.Fatalf("the closer earns the rest: %v", all)
	}
	if status, _ := e.call(dave, orgA, "PUT", "/api/v1/commissions/overrides", map[string]any{"source": "deal", "source_id": deal, "user_id": dave, "amount": 2000, "reason": "Me"}); status != 403 {
		t.Fatalf("a closer overrides their own figure: %d", status)
	}
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/commissions/overrides", map[string]any{"source": "deal", "source_id": deal, "user_id": dave, "amount": 900, "reason": "Closed it alone at the end"}); status != 200 {
		t.Fatalf("override: %d", status)
	}
	_, all = e.call(alice, orgA, "GET", "/api/v1/commissions", nil)
	if total := all["totals"].(map[string]any)[dave].(map[string]any)["USD"]; total != float64(900) {
		t.Fatalf("the override replaces the figure: %v", all)
	}
	// A deal moved out of "Closed won" earns nothing.
	e.want(e.op(alice, orgA, "deal.update", map[string]any{"id": deal, "changes": map[string]any{"stage": "Negotiation"}}), "applied")
	if _, all = e.call(alice, orgA, "GET", "/api/v1/commissions", nil); all["totals"].(map[string]any)[dave] != nil {
		t.Fatalf("a reopened deal still earns: %v", all)
	}
}
