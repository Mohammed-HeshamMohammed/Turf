package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	f := financeFrom(sample(t), costs, nil, nil, "", at)
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
	f := financeFrom(sample(t), nil, nil, nil, "", at)
	if f.ROIPercent != nil || f.ProfitMonthMinor != f.MRRMinor {
		t.Fatalf("with no costs: %+v", f)
	}
	none := financeFrom(nil, nil, nil, nil, "", at)
	if none.Currency != "USD" || none.MRRMinor != 0 || none.ROIPercent != nil || len(none.ByMonth) != 0 {
		t.Fatalf("with nothing: %+v", none)
	}
}

func TestCostsThatFollowCustomersAreWorkedOutFromThisMonthsUsage(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	b := sample(t)
	if err := json.Unmarshal([]byte(`{"allowances": [
	  {"org_id": "aaaaaaaa-0000-0000-0000-000000000001", "plan_key": "starter", "allowed": 5000, "status": "active", "used": 4800},
	  {"org_id": "bbbbbbbb-0000-0000-0000-000000000002", "plan_key": "starter", "allowed": 5000, "status": "active", "used": 5300},
	  {"org_id": "cccccccc-0000-0000-0000-000000000003", "plan_key": "team", "allowed": 5000, "status": "active", "used": 100}]}`), b); err != nil {
		t.Fatal(err)
	}
	rates := []rateItem{
		{Kind: "minute", RateMicros: 8500, Currency: "USD"},                         // 0.0085 a minute
		{Kind: "gb", RateMicros: 20000, Quantity: 50, Currency: "USD"},              // 50 GB at 0.02
		{Kind: "payment_fee", PercentBP: 290, FixedMicros: 300000, Currency: "USD"}, // 2.9% + 0.30 a payment
		{Kind: "minute", RateMicros: 99999, Currency: "EUR"},                        // another currency: not used
	}
	f := financeFrom(b, nil, rates, nil, "", at)
	// 1,200 minutes at 0.0085 = 10.20; 50 GB at 0.02 = 1.00; 2.9% of 200.00 = 5.80 plus 3 payments at 0.30 = 0.90.
	if f.Variable.VoipMinor != 1020 || f.Variable.StorageMinor != 100 || f.Variable.FeesMinor != 670 || f.Variable.TotalMinor != 1790 {
		t.Fatalf("variable costs %+v", f.Variable)
	}
	if f.GrossProfitMinor != 20000-1790 || f.GrossMarginPercent == nil || int(*f.GrossMarginPercent*100) != 9105 {
		t.Fatalf("gross %d, %v", f.GrossProfitMinor, f.GrossMarginPercent)
	}
	if f.RatesEntered != 3 {
		t.Fatalf("rates entered %d", f.RatesEntered)
	}
	// The margin on this month's revenue is applied to a whole month of recurring revenue (296.00): about 26.49 a month.
	if d := f.VariableMonthly - 2649; d < -1 || d > 1 {
		t.Fatalf("estimated monthly variable costs %d", f.VariableMonthly)
	}
	if f.ProfitMonthMinor != f.MRRMinor-f.TotalMonthlyCosts || f.ROIPercent == nil || *f.ROIPercent < 900 {
		t.Fatalf("profit %d, roi %v", f.ProfitMonthMinor, f.ROIPercent)
	}
	// Two workspaces are at 90% or more; one is 300 minutes past its allowance, which costs 300 x 0.0085 = 2.55.
	if len(f.Quota.NearLimit) != 2 || f.Quota.NearLimit[0].Used != 4800 || f.Quota.WorkspacesOver != 1 || f.Quota.OverMinutes != 300 || f.Quota.OverCostMinor != 255 {
		t.Fatalf("quota %+v", f.Quota)
	}
}

func TestRatesAreCheckedBeforeTheyAreKept(t *testing.T) {
	good := rateItem{Label: "VOIP", Kind: "minute", RateMicros: 8500, Currency: "usd"}
	if problem := checkRate(&good); problem != nil || good.Currency != "USD" {
		t.Fatalf("a good rate was refused: %v", problem)
	}
	for name, bad := range map[string]rateItem{
		"no name":         {Kind: "minute", RateMicros: 1, Currency: "USD"},
		"unknown kind":    {Label: "x", Kind: "sms", RateMicros: 1, Currency: "USD"},
		"zero minute":     {Label: "x", Kind: "minute", Currency: "USD"},
		"bad currency":    {Label: "x", Kind: "minute", RateMicros: 1, Currency: "DOLLARS"},
		"fee of nothing":  {Label: "x", Kind: "payment_fee", Currency: "USD"},
		"fee over half":   {Label: "x", Kind: "payment_fee", PercentBP: 6000, Currency: "USD"},
		"negative gb use": {Label: "x", Kind: "gb", RateMicros: 1, Quantity: -1, Currency: "USD"},
	} {
		bad := bad
		if checkRate(&bad) == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestAMembershipRequestIsCheckedBeforeAnythingIsOpened(t *testing.T) {
	person := "7b0f8f0e-1f0a-4e0b-9d57-0a8d1c0a0001"
	good := membershipBody{UserID: person, Plan: " starter ", Payment: "manual"}
	if problem := checkMembership(&good); problem != nil || good.Plan != "starter" || good.Role != "owner" || good.Days != 14 || good.Months != 12 {
		t.Fatalf("a good request was refused or not filled in: %v %+v", problem, good)
	}
	solo := membershipBody{UserID: person, Plan: "solo", Payment: "free", Role: "solo", Months: 6}
	if checkMembership(&solo) != nil || solo.Months != 6 {
		t.Fatalf("a solo membership: %+v", solo)
	}
	paid := int64(14700)
	trial := membershipBody{UserID: person, Plan: "starter", Payment: "trial", AmountMinor: &paid}
	if checkMembership(&trial) != nil || trial.AmountMinor != nil {
		t.Fatalf("an amount only means something for a manual payment: %+v", trial)
	}
	negative := int64(-1)
	for name, bad := range map[string]membershipBody{
		"no person":       {Plan: "starter", Payment: "trial"},
		"not a uuid":      {UserID: "someone", Plan: "starter", Payment: "trial"},
		"no plan":         {UserID: person, Payment: "trial"},
		"unknown payment": {UserID: person, Plan: "starter", Payment: "gift"},
		"a caller role":   {UserID: person, Plan: "starter", Payment: "trial", Role: "caller"},
		"a platform role": {UserID: person, Plan: "starter", Payment: "trial", Role: "cofounder"},
		"a long trial":    {UserID: person, Plan: "starter", Payment: "trial", Days: 91},
		"years of free":   {UserID: person, Plan: "starter", Payment: "free", Months: 37},
		"negative amount": {UserID: person, Plan: "starter", Payment: "manual", AmountMinor: &negative},
	} {
		bad := bad
		if checkMembership(&bad) == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestAMembershipNeedsASecondStepDoneJustNow(t *testing.T) {
	const at = 1_800_000_000
	for name, c := range map[string]claims{
		"two-step passed a minute ago":     {MFA: true, AuthTime: at - 60},
		"two-step passed four minutes ago": {MFA: true, AuthTime: at - 240},
	} {
		if problem := requireFreshSecondStep(c, at); problem != nil {
			t.Errorf("%s was refused: %v", name, problem)
		}
	}
	for name, c := range map[string]claims{
		"never passed two-step":        {MFA: false, AuthTime: at - 10},
		"passed it ten minutes ago":    {MFA: true, AuthTime: at - 600},
		"passed it an hour ago":        {MFA: true, AuthTime: at - 3600},
		"no sign-in time in the token": {MFA: true},
		"a time in the future":         {MFA: true, AuthTime: at + 3600},
	} {
		problem := requireFreshSecondStep(c, at)
		if problem == nil || problem.code != "step_up_required" {
			t.Errorf("%s was accepted: %v", name, problem)
		}
	}
}

// Everything that moves money or access for the platform goes through ownerActor (an owner or cofounder with a second step done just
// now). This reads the source, so a new owner action added without it, or one of these changed back, fails here.
func TestEveryOwnerActionAsksForAFreshSecondStep(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	var text strings.Builder
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		text.Write(raw)
		text.WriteByte('\n')
	}
	source := text.String()
	for _, name := range []string{"assignStaff", "invitePlatform", "revokeInvitation", "addCost", "deleteCost", "addRate", "deleteRate", "giveMembership"} {
		start := strings.Index(source, "func (s *server) "+name+"(")
		if start < 0 {
			t.Fatalf("%s is not in the source any more: update this list", name)
		}
		body := source[start:]
		if next := strings.Index(body[1:], "\nfunc "); next > 0 {
			body = body[:next+1]
		}
		if !strings.Contains(body, "ownerActor(r)") {
			t.Errorf("%s does not ask for a fresh second step (ownerActor)", name)
		}
	}
}
