package main

import "testing"

func TestAMemberSeesThePlanAndUsageAndNothingElse(t *testing.T) {
	raw := map[string]any{
		"org_id": "11111111-1111-1111-1111-111111111111", "plan": "starter", "status": "active", "period_end": "2026-12-05T00:00:00+00:00",
		"seats": float64(3), "minutes_allowed": float64(5000), "minutes_used": float64(1250), "limited": true, "payment_required": false,
		"provider_subscription_id": "sub_secret", "internal": "x",
	}
	p := planView(raw, map[string]string{"starter": "Starter"})
	if p.PlanName != "Starter" || p.Status != "active" || p.Seats != 3 || p.MinutesUsed != 1250 || p.MinutesAllowed != 5000 || !p.Limited || p.PaymentRequired {
		t.Fatalf("%+v", p)
	}
	if p.PercentUsed == nil || *p.PercentUsed != 25 {
		t.Fatalf("percent used %v", p.PercentUsed)
	}
	// With no names, the plan key is shown; with no minutes limit there is no percentage to show.
	bare := planView(map[string]any{"plan": "solo", "limited": false}, nil)
	if bare.PlanName != "solo" || bare.PercentUsed != nil {
		t.Fatalf("%+v", bare)
	}
	// A workspace with no subscription yet says so by having no plan.
	none := planView(map[string]any{"org_id": "x", "plan": nil, "limited": false, "payment_required": false}, nil)
	if none.Plan != "" || none.PlanName != "" {
		t.Fatalf("%+v", none)
	}
}
