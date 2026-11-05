package main

import (
	"encoding/json"
	"testing"
	"time"
)

const sampleBilling = `{
  "subscriptions": [
    {"plan_key": "starter", "name": "Starter", "currency": "USD", "price_minor": 4900, "status": "active", "workspaces": 3},
    {"plan_key": "starter", "name": "Starter", "currency": "USD", "price_minor": 4900, "status": "trialing", "workspaces": 2},
    {"plan_key": "team", "name": "Team", "currency": "USD", "price_minor": 14900, "status": "active", "workspaces": 1},
    {"plan_key": "team", "name": "Team", "currency": "USD", "price_minor": 14900, "status": "canceled", "workspaces": 4}
  ],
  "revenue_by_month": [
    {"month": "2026-09", "currency": "USD", "amount_minor": 30000, "payments": 6},
    {"month": "2026-10", "currency": "USD", "amount_minor": 50000, "payments": 9},
    {"month": "2026-11", "currency": "USD", "amount_minor": 20000, "payments": 3},
    {"month": "2026-11", "currency": "EUR", "amount_minor": 1000, "payments": 1}
  ],
  "usage_this_month": {"minutes": 1200, "credits": 90},
  "top_usage": []
}`

func sample(t *testing.T) *billingSummary {
	t.Helper()
	var b billingSummary
	if err := json.Unmarshal([]byte(sampleBilling), &b); err != nil {
		t.Fatal(err)
	}
	return &b
}

func TestPlansAreRankedByWhatWorkspacesAskedFor(t *testing.T) {
	plans := plansFrom(sample(t))
	if len(plans) != 2 || plans[0].Plan != "starter" {
		t.Fatalf("the most requested plan is not first: %+v", plans)
	}
	starter, team := plans[0], plans[1]
	if starter.Workspaces != 5 || starter.Paying != 3 || starter.Trialing != 2 || starter.MRRMinor != 3*4900 {
		t.Fatalf("starter: %+v", starter)
	}
	// Canceled workspaces are not requests any more.
	if team.Workspaces != 1 || team.MRRMinor != 14900 {
		t.Fatalf("team: %+v", team)
	}
	if got := plansFrom(nil); len(got) != 0 {
		t.Fatalf("no billing should mean no plans, got %+v", got)
	}
}

func TestFinanceIsWorkedOutInTheCurrencyThatEarnsTheMost(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	costs := []costItem{
		{Label: "Server", Category: "hosting", AmountMinor: 4000, Currency: "USD", Interval: "monthly"},
		{Label: "Domain", Category: "tools", AmountMinor: 12000, Currency: "USD", Interval: "yearly"},
		{Label: "Laptop", Category: "other", AmountMinor: 90000, Currency: "USD", Interval: "once"},
		{Label: "Tool in euros", Category: "tools", AmountMinor: 500, Currency: "EUR", Interval: "monthly"},
	}
	f := financeFrom(sample(t), costs, at)
	if f.Currency != "USD" {
		t.Fatalf("currency %s", f.Currency)
	}
	// 3 paying starters and 1 team: 3 x 49 + 149 = 296 dollars a month.
	if f.MRRMinor != 3*4900+14900 {
		t.Fatalf("mrr %d", f.MRRMinor)
	}
	if f.RevenueThisMonth != 20000 || f.RevenueLastMonth != 50000 || f.Revenue12Months != 100000 {
		t.Fatalf("revenue %+v", f)
	}
	if f.MonthlyCostsMinor != 4000+1000 || f.OneOffCostsMinor != 90000 || f.OtherCurrency != 1 {
		t.Fatalf("costs %+v", f)
	}
	if f.ProfitMonthMinor != f.MRRMinor-5000 {
		t.Fatalf("profit %d", f.ProfitMonthMinor)
	}
	if f.ROIPercent == nil || int(*f.ROIPercent) != int(float64(f.ProfitMonthMinor)/5000*100) {
		t.Fatalf("roi %v", f.ROIPercent)
	}
	if f.CostsByCategory["hosting"] != 4000 || f.CostsByCategory["tools"] != 1000 {
		t.Fatalf("by category %+v", f.CostsByCategory)
	}
}

func TestReturnNeedsCostsAndBillingMayBeAbsent(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	f := financeFrom(sample(t), nil, at)
	if f.ROIPercent != nil || f.ProfitMonthMinor != f.MRRMinor {
		t.Fatalf("with no costs: %+v", f)
	}
	none := financeFrom(nil, nil, at)
	if none.Currency != "USD" || none.MRRMinor != 0 || none.ROIPercent != nil || len(none.ByMonth) != 0 {
		t.Fatalf("with nothing: %+v", none)
	}
}
