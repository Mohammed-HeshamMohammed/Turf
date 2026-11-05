package main

// Costs that follow the customers, as opposed to the fixed running costs in owner.go: what the provider charges for each call minute,
// for storage, and the payment provider's cut of every payment. The owner enters the rates; billing's usage and payments supply
// the quantities, so the profit shown is worked out from what really happened this month.

import (
	"context"
	"math"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// A rate is stored in millionths of the currency unit (so 0.0085 a minute is 8500), because per-minute prices are fractions of a cent.
type rateItem struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Kind        string `json:"kind"`         // minute, gb or payment_fee
	RateMicros  int64  `json:"rate_micros"`  // minute and gb: the price of one minute or one GB
	Quantity    int64  `json:"quantity"`     // gb: gigabytes used each month (nothing measures storage yet, so the owner enters it)
	PercentBP   int    `json:"percent_bp"`   // payment_fee: the percentage of each payment, in hundredths of a percent (290 is 2.9%)
	FixedMicros int64  `json:"fixed_micros"` // payment_fee: the fixed amount taken from each payment
	Currency    string `json:"currency"`
	Note        string `json:"note"`
	CreatedAt   int64  `json:"created_at"`
}

const (
	maxRates     = 50
	maxMicros    = 1_000_000_000_000 // a million currency units
	maxQuantity  = 1_000_000_000
	maxPercentBP = 5000 // 50%
)

var rateKinds = map[string]bool{"minute": true, "gb": true, "payment_fee": true}

// zeroDecimal lists currencies with no minor unit, so their amounts are whole units.
var zeroDecimal = map[string]bool{"JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true, "UGX": true, "XAF": true, "XOF": true, "PYG": true}

// minorOf turns an amount in millionths of the currency unit into its minor unit (cents), rounding to the nearest.
func minorOf(micros int64, currency string) int64 {
	unit := int64(math.Pow10(6 - digits(currency))) // millionths in one minor unit: 10,000 for cents, 1,000,000 for yen
	return (micros + unit/2) / unit
}

func (s *server) readRates(ctx context.Context) ([]rateItem, error) {
	rows, err := s.db.Query(ctx, "SELECT id, label, kind, rate_micros, quantity, percent_bp, fixed_micros, currency, note, created_at FROM platform_rates ORDER BY created_at, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rates := []rateItem{}
	for rows.Next() {
		var r rateItem
		if err := rows.Scan(&r.ID, &r.Label, &r.Kind, &r.RateMicros, &r.Quantity, &r.PercentBP, &r.FixedMicros, &r.Currency, &r.Note, &r.CreatedAt); err != nil {
			return nil, err
		}
		rates = append(rates, r)
	}
	return rates, rows.Err()
}

func (s *server) listRates(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, true); err != nil {
		return err
	}
	rates, err := s.readRates(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"rates": rates})
	return nil
}

// checkRate says what is wrong with a rate, or nothing.
func checkRate(r *rateItem) *apiError {
	r.Label = strings.TrimSpace(r.Label)
	r.Note = strings.TrimSpace(r.Note)
	r.Currency = strings.ToUpper(strings.TrimSpace(r.Currency))
	switch {
	case r.Label == "" || len(r.Label) > 80:
		return bad("Give the rate a name of up to 80 characters.")
	case !rateKinds[r.Kind]:
		return bad("Choose what it is for: call minutes, storage, or the payment fee.")
	case !currencyCode.MatchString(r.Currency):
		return bad("Use a three-letter currency code, like USD.")
	case len(r.Note) > 200:
		return bad("The note can be up to 200 characters.")
	}
	switch r.Kind {
	case "minute":
		if r.RateMicros <= 0 || r.RateMicros > maxMicros {
			return bad("Enter the price of one call minute, above zero.")
		}
		r.Quantity, r.PercentBP, r.FixedMicros = 0, 0, 0
	case "gb":
		if r.RateMicros <= 0 || r.RateMicros > maxMicros {
			return bad("Enter the price of one gigabyte, above zero.")
		}
		if r.Quantity < 0 || r.Quantity > maxQuantity {
			return bad("Enter how many gigabytes are used each month.")
		}
		r.PercentBP, r.FixedMicros = 0, 0
	case "payment_fee":
		if r.PercentBP < 0 || r.PercentBP > maxPercentBP || r.FixedMicros < 0 || r.FixedMicros > maxMicros || (r.PercentBP == 0 && r.FixedMicros == 0) {
			return bad("Enter the fee: a percentage (up to 50), a fixed amount per payment, or both.")
		}
		r.RateMicros, r.Quantity = 0, 0
	}
	return nil
}

func (s *server) addRate(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.ownerActor(r); err != nil {
		return err
	}
	var body rateItem
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if problem := checkRate(&body); problem != nil {
		return problem
	}
	var count, same int
	if err := s.db.QueryRow(r.Context(), "SELECT count(*), COALESCE(sum(CASE WHEN kind = $1 AND currency = $2 THEN 1 ELSE 0 END), 0) FROM platform_rates", body.Kind, body.Currency).Scan(&count, &same); err != nil {
		return err
	}
	if count >= maxRates {
		return bad("That is the most rates that can be kept. Remove one you no longer need.")
	}
	if same > 0 {
		return bad("There is already a rate of that kind in that currency. Remove it first to change it.")
	}
	body.ID = uuid.NewString()
	body.CreatedAt = now()
	if _, err := s.db.Exec(r.Context(), "INSERT INTO platform_rates (id, label, kind, rate_micros, quantity, percent_bp, fixed_micros, currency, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
		body.ID, body.Label, body.Kind, body.RateMicros, body.Quantity, body.PercentBP, body.FixedMicros, body.Currency, body.Note, body.CreatedAt); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, body)
	return nil
}

func (s *server) deleteRate(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.ownerActor(r); err != nil {
		return err
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return bad("That rate is not valid.")
	}
	if _, err := s.db.Exec(r.Context(), "DELETE FROM platform_rates WHERE id = $1", id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": true})
	return nil
}

// ---- What the rates make of this month's usage ----

type variableCosts struct {
	VoipMinor    int64 `json:"voip_minor"`
	StorageMinor int64 `json:"storage_minor"`
	FeesMinor    int64 `json:"fees_minor"`
	TotalMinor   int64 `json:"total_minor"`
}

type nearLimit struct {
	Workspace string  `json:"workspace"`
	Plan      string  `json:"plan"`
	Used      int64   `json:"used"`
	Allowed   int64   `json:"allowed"`
	Percent   float64 `json:"percent"`
}

// quota is the picture of the minutes plans include against the minutes used: the workspaces near or past their allowance, and the
// minutes used beyond it, which are the ones bought from the provider on top (the "quota bank").
type quota struct {
	NearLimit      []nearLimit `json:"near_limit"`
	OverMinutes    int64       `json:"over_allowance_minutes"`
	OverCostMinor  int64       `json:"over_allowance_cost_minor"`
	WorkspacesOver int         `json:"workspaces_over_allowance"`
}

// nearPercent is how full a workspace's minutes are when it is listed: the point where the minutes bank starts to be used.
const nearPercent = 90.0

func rateOf(rates []rateItem, kind, currency string) *rateItem {
	for i := range rates {
		if rates[i].Kind == kind && rates[i].Currency == currency {
			return &rates[i]
		}
	}
	return nil
}

// variableFrom prices this month's usage and payments with the owner's rates, in one currency.
func variableFrom(b *billingSummary, rates []rateItem, currency string, revenueMinor, payments int64) (variableCosts, quota) {
	var v variableCosts
	q := quota{NearLimit: []nearLimit{}}
	minute := rateOf(rates, "minute", currency)
	if b != nil && minute != nil {
		v.VoipMinor = minorOf(b.UsageThisMonth["minutes"]*minute.RateMicros, currency)
	}
	if gb := rateOf(rates, "gb", currency); gb != nil {
		v.StorageMinor = minorOf(gb.Quantity*gb.RateMicros, currency)
	}
	if fee := rateOf(rates, "payment_fee", currency); fee != nil {
		v.FeesMinor = revenueMinor*int64(fee.PercentBP)/10000 + minorOf(payments*fee.FixedMicros, currency)
	}
	v.TotalMinor = v.VoipMinor + v.StorageMinor + v.FeesMinor
	if b != nil {
		for _, w := range b.Allowances {
			if w.Allowed <= 0 {
				continue
			}
			percent := float64(w.Used) / float64(w.Allowed) * 100
			if w.Used > w.Allowed {
				q.OverMinutes += w.Used - w.Allowed
				q.WorkspacesOver++
			}
			if percent >= nearPercent && len(q.NearLimit) < 10 {
				q.NearLimit = append(q.NearLimit, nearLimit{Workspace: shortID(w.OrgID), Plan: w.PlanKey, Used: w.Used, Allowed: w.Allowed, Percent: percent})
			}
		}
		if minute != nil {
			q.OverCostMinor = minorOf(q.OverMinutes*minute.RateMicros, currency)
		}
	}
	return v, q
}
