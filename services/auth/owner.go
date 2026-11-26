package main

// What the platform dashboard shows beyond the staff list: the members who are not staff, an overview of people, plans and usage, and
// (for the owner and cofounders only) money: revenue from billing, the costs they enter, and the profit and return that follow.
// Billing is asked for totals only; this service never holds card or payment-provider details.

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ---- Costs the owner enters -------------------------------------------------------------------------------------------------

type costItem struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Category    string `json:"category"` // hosting, tools, marketing, staff_pay, other
	AmountMinor int64  `json:"amount_minor"`
	Currency    string `json:"currency"`
	Interval    string `json:"interval"` // monthly, yearly, once
	Note        string `json:"note"`
	CreatedAt   int64  `json:"created_at"`
}

var (
	costCategories = map[string]bool{"hosting": true, "tools": true, "marketing": true, "staff_pay": true, "other": true}
	costIntervals  = map[string]bool{"monthly": true, "yearly": true, "once": true}
	currencyCode   = regexp.MustCompile(`^[A-Z]{3}$`)
)

const maxCosts = 200

func (s *server) listCosts(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, true); err != nil {
		return err
	}
	costs, err := s.readCosts(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": costs})
	return nil
}

func (s *server) readCosts(ctx context.Context) ([]costItem, error) {
	rows, err := s.db.Query(ctx, "SELECT id, label, category, amount_minor, currency, repeats, note, created_at FROM platform_costs ORDER BY created_at, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	costs := []costItem{}
	for rows.Next() {
		var c costItem
		if err := rows.Scan(&c.ID, &c.Label, &c.Category, &c.AmountMinor, &c.Currency, &c.Interval, &c.Note, &c.CreatedAt); err != nil {
			return nil, err
		}
		costs = append(costs, c)
	}
	return costs, rows.Err()
}

func (s *server) addCost(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.ownerActor(r); err != nil {
		return err
	}
	var body costItem
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.Label = strings.TrimSpace(body.Label)
	body.Note = strings.TrimSpace(body.Note)
	body.Currency = strings.ToUpper(strings.TrimSpace(body.Currency))
	switch {
	case body.Label == "" || len(body.Label) > 80:
		return bad("Give the cost a name of up to 80 characters.")
	case !costCategories[body.Category]:
		return bad("Choose a category: hosting, tools, marketing, staff pay or other.")
	case body.AmountMinor <= 0 || body.AmountMinor > 1_000_000_000_000:
		return bad("The amount must be more than zero.")
	case !currencyCode.MatchString(body.Currency):
		return bad("Use a three-letter currency code, like USD.")
	case !costIntervals[body.Interval]:
		return bad("Choose how often it is paid: monthly, yearly or once.")
	case len(body.Note) > 200:
		return bad("The note can be up to 200 characters.")
	}
	var count int
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM platform_costs").Scan(&count); err != nil {
		return err
	}
	if count >= maxCosts {
		return bad("That is the most costs that can be kept. Remove one you no longer need.")
	}
	body.ID = uuid.NewString()
	body.CreatedAt = now()
	if _, err := s.db.Exec(r.Context(), "INSERT INTO platform_costs (id, label, category, amount_minor, currency, repeats, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
		body.ID, body.Label, body.Category, body.AmountMinor, body.Currency, body.Interval, body.Note, body.CreatedAt); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, body)
	return nil
}

func (s *server) deleteCost(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.ownerActor(r); err != nil {
		return err
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return bad("That cost is not valid.")
	}
	if _, err := s.db.Exec(r.Context(), "DELETE FROM platform_costs WHERE id = $1", id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": true})
	return nil
}

// ---- Members who are not staff ----------------------------------------------------------------------------------------------

type memberRow struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Email      string   `json:"email"`
	JoinedAt   int64    `json:"joined_at"`
	LastActive int64    `json:"last_active"`
	Verified   bool     `json:"email_verified"`
	TwoStep    bool     `json:"two_step"`
	Disabled   bool     `json:"disabled"`
	Workspaces int      `json:"workspaces"`
	Roles      []string `json:"roles"`
}

const maxMembers = 500

// staffIDs asks authorization who is staff, so they are left out of the members.
func (s *server) staffIDs(ctx context.Context) (map[string]bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.authzURL+"/v1/staff", nil)
	if err != nil {
		return nil, errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.authzToken)
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return nil, errAccessUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errAccessUnavailable
	}
	var listed struct {
		Staff []adminStaffMember `json:"staff"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&listed); err != nil {
		return nil, errAccessUnavailable
	}
	ids := map[string]bool{}
	for _, member := range listed.Staff {
		ids[member.UserID] = true
	}
	return ids, nil
}

// members reads every account that is not staff, newest first, with what their workspaces say (best effort: a slow answer leaves
// that person's workspaces blank rather than failing the list).
func (s *server) members(ctx context.Context) ([]memberRow, int, error) {
	staff, err := s.staffIDs(ctx)
	if err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx, "SELECT u.id, u.email, u.display_name, u.created_at, (u.email_verified_at IS NOT NULL), (u.disabled_at IS NOT NULL), (u.totp_secret IS NOT NULL), "+
		"COALESCE((SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id), 0) FROM users u ORDER BY u.created_at DESC, u.id")
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []memberRow{}
	total := 0
	for rows.Next() {
		var m memberRow
		if err := rows.Scan(&m.ID, &m.Email, &m.Name, &m.JoinedAt, &m.Verified, &m.Disabled, &m.TwoStep, &m.LastActive); err != nil {
			return nil, 0, err
		}
		if staff[m.ID] {
			continue
		}
		total++
		if len(out) < maxMembers {
			m.Roles = []string{}
			out = append(out, m)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	// Workspace memberships, a few at a time.
	var wg sync.WaitGroup
	gate := make(chan struct{}, 8)
	for i := range out {
		wg.Add(1)
		gate <- struct{}{}
		go func(m *memberRow) {
			defer wg.Done()
			defer func() { <-gate }()
			profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, m.ID)
			if err != nil {
				return
			}
			m.Workspaces = len(profile.Workspaces)
			seen := map[string]bool{}
			for _, space := range profile.Workspaces {
				for _, role := range space.Roles {
					if !seen[role] {
						seen[role] = true
						m.Roles = append(m.Roles, role)
					}
				}
			}
			sort.Strings(m.Roles)
		}(&out[i])
	}
	wg.Wait()
	return out, total, nil
}

func (s *server) adminMembers(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	list, total, err := s.members(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": list, "total": total, "shown": len(list)})
	return nil
}

// ---- What billing says ------------------------------------------------------------------------------------------------------

type billingSummary struct {
	Subscriptions []struct {
		PlanKey    string `json:"plan_key"`
		Name       string `json:"name"`
		Currency   string `json:"currency"`
		PriceMinor int64  `json:"price_minor"`
		Status     string `json:"status"`
		Workspaces int    `json:"workspaces"`
	} `json:"subscriptions"`
	RevenueByMonth []struct {
		Month       string `json:"month"`
		Currency    string `json:"currency"`
		AmountMinor int64  `json:"amount_minor"`
		Payments    int    `json:"payments"`
	} `json:"revenue_by_month"`
	// What each workspace's plan includes this period, and what it has used, nearest the limit first.
	Allowances []struct {
		OrgID   string `json:"org_id"`
		PlanKey string `json:"plan_key"`
		Allowed int64  `json:"allowed"`
		Status  string `json:"status"`
		Used    int64  `json:"used"`
	} `json:"allowances"`
	UsageThisMonth map[string]int64 `json:"usage_this_month"`
	TopUsage       []struct {
		AccountID string `json:"account_id"`
		Kind      string `json:"kind"`
		Total     int64  `json:"total"`
	} `json:"top_usage"`
}

// billing is nil when the billing service is not connected or does not answer: the overview then says so and shows what it has.
func (s *server) billing(ctx context.Context) *billingSummary {
	if s.cfg.billingURL == "" || s.cfg.billingToken == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.billingURL+"/v1/admin/summary", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.billingToken)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var out billingSummary
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&out); err != nil {
		return nil
	}
	return &out
}

// ---- The overview -----------------------------------------------------------------------------------------------------------

type planRow struct {
	Plan       string `json:"plan"`
	Name       string `json:"name"`
	Workspaces int    `json:"workspaces"`
	Paying     int    `json:"paying"`
	Trialing   int    `json:"trialing"`
	MRRMinor   int64  `json:"mrr_minor"`
	Currency   string `json:"currency"`
}

// plansFrom adds up the subscriptions by plan, the most requested first. Canceled ones are not requests any more.
func plansFrom(b *billingSummary) []planRow {
	if b == nil {
		return []planRow{}
	}
	byPlan := map[string]*planRow{}
	for _, sub := range b.Subscriptions {
		row := byPlan[sub.PlanKey]
		if row == nil {
			row = &planRow{Plan: sub.PlanKey, Name: sub.Name, Currency: sub.Currency}
			byPlan[sub.PlanKey] = row
		}
		switch sub.Status {
		case "active", "past_due":
			row.Paying += sub.Workspaces
			row.Workspaces += sub.Workspaces
			row.MRRMinor += sub.PriceMinor * int64(sub.Workspaces)
		case "trialing":
			row.Trialing += sub.Workspaces
			row.Workspaces += sub.Workspaces
		}
	}
	out := make([]planRow, 0, len(byPlan))
	for _, row := range byPlan {
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Workspaces != out[j].Workspaces {
			return out[i].Workspaces > out[j].Workspaces
		}
		return out[i].Plan < out[j].Plan
	})
	return out
}

type monthRevenue struct {
	Month       string `json:"month"`
	AmountMinor int64  `json:"amount_minor"`
}

type finance struct {
	Currency          string   `json:"currency"`
	MRRMinor          int64    `json:"mrr_minor"`
	RevenueThisMonth  int64    `json:"revenue_this_month_minor"`
	RevenueLastMonth  int64    `json:"revenue_last_month_minor"`
	Revenue12Months   int64    `json:"revenue_12_months_minor"`
	MonthlyCostsMinor int64    `json:"monthly_costs_minor"`
	OneOffCostsMinor  int64    `json:"one_off_costs_minor"`
	ProfitMonthMinor  int64    `json:"profit_month_minor"` // monthly recurring revenue minus all monthly costs (fixed and customer-driven)
	ROIPercent        *float64 `json:"roi_percent"`        // profit divided by all monthly costs; nil until there are costs
	// Costs that follow customers, worked out from this month's usage and payments with the owner's rates.
	Variable           variableCosts    `json:"variable_costs"`
	GrossProfitMinor   int64            `json:"gross_profit_month_minor"` // revenue so far this month minus the customer-driven costs so far
	GrossMarginPercent *float64         `json:"gross_margin_percent"`     // gross profit as a share of revenue so far; nil until there is revenue
	VariableMonthly    int64            `json:"variable_costs_estimate_month_minor"`
	TotalMonthlyCosts  int64            `json:"total_monthly_costs_minor"`
	Quota              quota            `json:"quota"`
	RatesEntered       int              `json:"rates_entered"`
	Converted          int              `json:"converted_entries"` // costs and rates entered in another currency, counted here at the day's exchange rate
	FXAsOf             string           `json:"fx_as_of,omitempty"`
	RequestedCurrency  string           `json:"requested_currency,omitempty"` // the main currency that could not be used (no rate), when the figures fell back to US dollars
	ByMonth            []monthRevenue   `json:"revenue_by_month"`
	CostsByCategory    map[string]int64 `json:"costs_by_category"`
	OtherCurrency      int              `json:"other_currency_costs"` // costs in a different currency, left out of the figures above
}

// financeFrom works out the money figures in the currency that earns the most. Costs in another currency are counted, not converted.
// financeFrom works the money figures out in `reporting` (the owner's main currency) when they chose one and there is a rate for it, and
// otherwise in the currency that earns the most. Revenue, plan prices, costs and rates in any other currency are converted at the day's rate.
func financeFrom(b *billingSummary, costs []costItem, rates []rateItem, fx *fxTable, reporting string, at time.Time) finance {
	var paymentsThisMonth int64
	f := finance{Currency: "USD", ByMonth: []monthRevenue{}, CostsByCategory: map[string]int64{}}
	if b != nil {
		totals := map[string]int64{}
		for _, row := range b.RevenueByMonth {
			totals[row.Currency] += row.AmountMinor
		}
		for _, sub := range b.Subscriptions {
			if sub.Status == "active" || sub.Status == "past_due" {
				totals[sub.Currency] += 1
			}
		}
		best := int64(-1)
		for currency, total := range totals {
			if total > best || (total == best && currency < f.Currency) {
				best, f.Currency = total, currency
			}
		}
		if reporting != "" {
			switch {
			case reporting == f.Currency || (fx != nil && fx.Rates[reporting] > 0):
				f.Currency = reporting
			case f.Currency == "USD" || (fx != nil && fx.Rates[f.Currency] > 0):
				// No exchange rate for the main currency right now (or the source is down): fall back to the main price, in US dollars,
				// and say so, instead of guessing or going blank.
				f.RequestedCurrency, f.Currency = reporting, "USD"
			}
		}
		thisMonth, lastMonth := at.UTC().Format("2006-01"), at.UTC().AddDate(0, -1, 0).Format("2006-01")
		months := map[string]int{} // a month paid in two currencies is one month once converted
		for _, row := range b.RevenueByMonth {
			amount, ok := fx.convert(row.AmountMinor, row.Currency, f.Currency)
			if !ok {
				continue
			}
			if at, seen := months[row.Month]; seen {
				f.ByMonth[at].AmountMinor += amount
			} else {
				months[row.Month] = len(f.ByMonth)
				f.ByMonth = append(f.ByMonth, monthRevenue{Month: row.Month, AmountMinor: amount})
			}
			f.Revenue12Months += amount
			switch row.Month {
			case thisMonth:
				f.RevenueThisMonth += amount
				paymentsThisMonth += int64(row.Payments)
			case lastMonth:
				f.RevenueLastMonth += amount
			}
		}
		for _, sub := range b.Subscriptions {
			if price, ok := fx.convert(sub.PriceMinor, sub.Currency, f.Currency); ok && (sub.Status == "active" || sub.Status == "past_due") {
				f.MRRMinor += price * int64(sub.Workspaces)
			}
		}
	}
	// Costs and rates entered in another currency are counted in this one at the day's exchange rate; with no rates they are left out.
	costs, rates, f.Converted, f.OtherCurrency = inCurrency(costs, rates, f.Currency, fx)
	if fx != nil {
		f.FXAsOf = fx.AsOf
	}
	for _, c := range costs {
		if c.Currency != f.Currency {
			continue
		}
		switch c.Interval {
		case "monthly":
			f.MonthlyCostsMinor += c.AmountMinor
			f.CostsByCategory[c.Category] += c.AmountMinor
		case "yearly":
			f.MonthlyCostsMinor += c.AmountMinor / 12
			f.CostsByCategory[c.Category] += c.AmountMinor / 12
		case "once":
			f.OneOffCostsMinor += c.AmountMinor
		}
	}
	for _, r := range rates {
		if r.Currency == f.Currency {
			f.RatesEntered++
		}
	}
	f.Variable, f.Quota = variableFrom(b, rates, f.Currency, f.RevenueThisMonth, paymentsThisMonth)
	f.GrossProfitMinor = f.RevenueThisMonth - f.Variable.TotalMinor
	// The margin on what has been taken so far is applied to a whole month of recurring revenue, so an early-month figure is not
	// a half-month of income set against a whole month of costs.
	if f.RevenueThisMonth > 0 {
		margin := float64(f.GrossProfitMinor) / float64(f.RevenueThisMonth)
		pct := margin * 100
		f.GrossMarginPercent = &pct
		f.VariableMonthly = int64(float64(f.MRRMinor) * (1 - margin))
	}
	f.TotalMonthlyCosts = f.MonthlyCostsMinor + f.VariableMonthly
	f.ProfitMonthMinor = f.MRRMinor - f.TotalMonthlyCosts
	if f.TotalMonthlyCosts > 0 {
		roi := float64(f.ProfitMonthMinor) / float64(f.TotalMonthlyCosts) * 100
		f.ROIPercent = &roi
	}
	return f
}

type dayCount struct {
	Day   string `json:"day"`
	Count int    `json:"count"`
}

func (s *server) adminOverview(w http.ResponseWriter, r *http.Request) error {
	c, err := s.staffActor(r, false)
	if err != nil {
		return err
	}
	ctx := r.Context()
	profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return errAccessUnavailable
	}
	owner := platformStaff(profile.PlatformRole)
	staff, err := s.staffIDs(ctx)
	if err != nil {
		return err
	}
	at := time.Unix(now(), 0).UTC()
	week, month := at.AddDate(0, 0, -7).Unix(), at.AddDate(0, 0, -30).Unix()

	type who struct {
		id                         string
		name                       string
		joined, seen               int64
		verified, twoStep, enabled bool
	}
	rows, err := s.db.Query(ctx, "SELECT u.id, u.display_name, u.created_at, (u.email_verified_at IS NOT NULL), (u.totp_secret IS NOT NULL), (u.disabled_at IS NULL), "+
		"COALESCE((SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id), 0) FROM users u")
	if err != nil {
		return err
	}
	defer rows.Close()
	people := map[string]string{}
	var all, members, new7, new30, verified, twoStep, active7, active30 int
	days := map[string]int{}
	for rows.Next() {
		var p who
		if err := rows.Scan(&p.id, &p.name, &p.joined, &p.verified, &p.twoStep, &p.enabled, &p.seen); err != nil {
			return err
		}
		people[p.id] = p.name
		all++
		if staff[p.id] {
			continue
		}
		members++
		if p.joined >= week {
			new7++
		}
		if p.joined >= month {
			new30++
			days[time.Unix(p.joined, 0).UTC().Format("2006-01-02")]++
		}
		if p.verified {
			verified++
		}
		if p.twoStep {
			twoStep++
		}
		if p.seen >= week {
			active7++
		}
		if p.seen >= month {
			active30++
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	signups := make([]dayCount, 0, 30)
	for d := 29; d >= 0; d-- {
		day := at.AddDate(0, 0, -d).Format("2006-01-02")
		signups = append(signups, dayCount{Day: day, Count: days[day]})
	}

	b := s.billing(ctx)
	usage := map[string]any{"connected": b != nil, "minutes_this_month": int64(0), "credits_this_month": int64(0), "top": []map[string]any{}}
	if b != nil {
		usage["minutes_this_month"] = b.UsageThisMonth["minutes"]
		usage["credits_this_month"] = b.UsageThisMonth["credits"]
		top := []map[string]any{}
		for _, row := range b.TopUsage {
			label := "Workspace " + shortID(row.AccountID)
			if row.Kind == "credits" {
				label = people[row.AccountID]
				if label == "" {
					label = "Person " + shortID(row.AccountID)
				}
			}
			top = append(top, map[string]any{"kind": row.Kind, "label": label, "total": row.Total})
		}
		usage["top"] = top
	}
	summary := b
	if summary == nil && !s.billingConnected() {
		summary = s.summaryHere(ctx) // memberships given while no billing service runs
	}
	plans := plansFrom(summary)
	body := map[string]any{
		"people": map[string]any{
			"accounts": all, "staff": all - members, "members": members, "new_7_days": new7, "new_30_days": new30,
			"email_verified": verified, "two_step": twoStep, "active_7_days": active7, "active_30_days": active30, "signups_by_day": signups,
		},
		"plans": plans, "usage": usage, "billing_connected": b != nil, "memberships_kept_here": !s.billingConnected(),
	}
	if len(plans) > 0 {
		body["most_requested_plan"] = plans[0]
	}
	if owner {
		costs, err := s.readCosts(ctx)
		if err != nil {
			return err
		}
		rates, err := s.readRates(ctx)
		if err != nil {
			return err
		}
		// The owner's main currency (set in their profile) is what the money is shown in; empty means the currency that earns the most.
		var main string
		_ = s.db.QueryRow(ctx, "SELECT currency FROM users WHERE id = $1", c.Sub).Scan(&main)
		body["finance"] = financeFrom(b, costs, rates, s.fx.rates(ctx), main, at)
	}
	writeJSON(w, http.StatusOK, body)
	return nil
}

// inCurrency counts every cost and rate in one currency. Those already in it stay as they are; the others are converted at the day's
// rate when there is one (and counted as converted), or left as they were (and counted as left out).
func inCurrency(costs []costItem, rates []rateItem, to string, fx *fxTable) ([]costItem, []rateItem, int, int) {
	converted, left := 0, 0
	outCosts := make([]costItem, 0, len(costs))
	for _, c := range costs {
		if c.Currency != to {
			if minor, ok := fx.convert(c.AmountMinor, c.Currency, to); ok {
				c.AmountMinor, c.Currency = minor, to
				converted++
			} else {
				left++
			}
		}
		outCosts = append(outCosts, c)
	}
	outRates := make([]rateItem, 0, len(rates))
	for _, r := range rates {
		if r.Currency != to {
			if factor, ok := fx.factor(r.Currency, to); ok {
				r.RateMicros = int64(math.Round(float64(r.RateMicros) * factor))
				r.FixedMicros = int64(math.Round(float64(r.FixedMicros) * factor))
				r.Currency = to
				converted++
			} else {
				left++
			}
		}
		outRates = append(outRates, r)
	}
	return outCosts, outRates, converted, left
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
