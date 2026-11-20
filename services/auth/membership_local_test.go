package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// Without a billing service, a membership is kept here: its plan and limits are saved, authorization is told the seats and that
// the plan is in good standing, members read the plan, and an ended period locks the workspace once.
func TestAMembershipIsKeptHereWhileNoBillingRuns(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	var mu sync.Mutex
	told := map[string][]map[string]any{}
	authz := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		told[r.URL.Path] = append(told[r.URL.Path], body)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer authz.Close()
	s := &server{cfg: config{authzURL: authz.URL, authzToken: "token"}, db: db}
	const org, user = "12121212-1212-4212-8212-121212121212", "7b0f8f0e-1f0a-4e0b-9d57-0a8d1c0a0001"
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, 'agency@example.com', 'Agency', '', 1)`, user); err != nil {
		t.Fatal(err)
	}
	eight := int64(8)
	body := membershipBody{UserID: user, Plan: "team", Payment: "free", Limits: map[string]*int64{"seats": &eight, "monthly_minutes": nil}}
	if problem := checkMembership(&body); problem != nil {
		t.Fatal(problem)
	}
	given, err := s.assignHere(ctx, org, user, body, "cofounder@example.com")
	if err != nil {
		t.Fatal(err)
	}
	overrides := given["overrides"].(map[string]*int64)
	if given["plan_name"] != "Team" || given["status"] != "active" || len(overrides) != 2 || *overrides["seats"] != 8 {
		t.Fatalf("given: %v (overrides %v)", given, overrides)
	}
	standing := told["/v1/orgs/"+org+"/standing"]
	if len(standing) != 1 || standing[0]["seats"] != 8.0 || standing[0]["payment_required"] != false || standing[0]["clients"] != nil {
		t.Fatalf("authorization was told: %v", standing)
	}
	plan, err := s.standingHere(ctx, org)
	if err != nil || plan.PlanName != "Team" || plan.Seats != 8 || plan.PaymentRequired || plan.MinutesAllowed != 0 {
		t.Fatalf("members read: %+v %v", plan, err)
	}
	if empty, _ := s.standingHere(ctx, "34343434-3434-4434-8434-343434343434"); empty.Plan != "" || empty.Limited {
		t.Errorf("a workspace without a membership has no plan: %+v", empty)
	}
	if sum := s.summaryHere(ctx); sum == nil || len(sum.Subscriptions) != 1 || sum.Subscriptions[0].Workspaces != 1 {
		t.Errorf("the overview counts the membership: %+v", sum)
	}
	if _, err := s.assignHere(ctx, org, user, membershipBody{UserID: user, Plan: "rocket", Payment: "free", Months: 1}, "x"); err == nil {
		t.Error("an unknown plan is refused")
	}

	// The period ends: authorization hears it once.
	if _, err := db.Exec(ctx, `UPDATE workspace_memberships SET period_end = 1 WHERE org_id = $1`, org); err != nil {
		t.Fatal(err)
	}
	s.tellEndedPeriods(ctx)
	s.tellEndedPeriods(ctx)
	standing = told["/v1/orgs/"+org+"/standing"]
	if len(standing) != 2 || standing[1]["payment_required"] != true {
		t.Fatalf("an ended plan is told once: %v", standing)
	}
	if plan, _ := s.standingHere(ctx, org); !plan.PaymentRequired {
		t.Error("members see that the plan needs paying")
	}
	// Giving the membership again opens a new period and clears the ended mark.
	body.Payment, body.Months = "manual", 3
	if again, err := s.assignHere(ctx, org, user, body, "cofounder@example.com"); err != nil || again["paid_minor"] != int64(43800*3) {
		t.Fatalf("given again: %v %v", again, err)
	}
	if plan, _ := s.standingHere(ctx, org); plan.PaymentRequired {
		t.Error("a new period is in good standing")
	}
}

func TestTheBuiltInPlansMatchWhatTheDashboardOffers(t *testing.T) {
	plans := plansHere()
	if len(plans) != 6 || plans[1].Key != "solo" || plans[1].DisplayPrice != "179.00" || *plans[1].Limits["active_leads"] != 1000000 || plans[1].Limits["clients"] != nil {
		t.Fatalf("plans: %+v", plans)
	}
	for _, p := range plans {
		for _, key := range limitKeys {
			if _, ok := p.Limits[key]; !ok {
				t.Errorf("%s does not say its %s", p.Key, key)
			}
		}
	}
}
