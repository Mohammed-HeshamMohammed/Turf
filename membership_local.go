package main

// Memberships without a billing service. Until a payment provider is connected, the platform owner or cofounder gives plans here:
// auth keeps the membership (workspace_memberships) and tells authorization the workspace's seats, client places and whether its
// period has ended, so the limits are enforced the same way they will be once billing runs. When AUTH_BILLING_URL and
// AUTH_BILLING_TOKEN are set, billing is used instead (membership.go) and nothing here runs.
//
// The ready-made plans are the same as billing's (services/billing/database_setup/0002_plans_and_limits.sql): change both together.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func limit(v int64) *int64 { return &v }

// builtInPlans are the plans staff can give while no billing service is connected. Prices are monthly, in cents.
var builtInPlans = []offeredPlan{
	{Key: "trial", Name: "Free trial", Seats: 1, Minutes: 30, PriceMinor: 0, Currency: "USD",
		Limits: map[string]*int64{"seats": limit(1), "clients": nil, "active_leads": limit(25000), "imports_monthly": limit(5), "monthly_minutes": limit(30), "skiptrace_credits": limit(25000), "file_storage_mb": limit(100)}},
	{Key: "solo", Name: "Solo", Seats: 1, Minutes: 3000, PriceMinor: 17900, Currency: "USD",
		Limits: map[string]*int64{"seats": limit(1), "clients": nil, "active_leads": limit(1000000), "imports_monthly": nil, "monthly_minutes": limit(3000), "skiptrace_credits": limit(1000000), "file_storage_mb": limit(2048)}},
	{Key: "duo", Name: "Duo", Seats: 2, Minutes: 6000, PriceMinor: 28800, Currency: "USD",
		Limits: map[string]*int64{"seats": limit(2), "clients": nil, "active_leads": limit(2000000), "imports_monthly": nil, "monthly_minutes": limit(6000), "skiptrace_credits": limit(2000000), "file_storage_mb": limit(4096)}},
	{Key: "team", Name: "Team", Seats: 3, Minutes: 9000, PriceMinor: 43800, Currency: "USD",
		Limits: map[string]*int64{"seats": limit(3), "clients": nil, "active_leads": limit(3000000), "imports_monthly": nil, "monthly_minutes": limit(9000), "skiptrace_credits": limit(3000000), "file_storage_mb": limit(6144)}},
	{Key: "pro", Name: "Pro", Seats: 3, Minutes: 24000, PriceMinor: 90000, Currency: "USD",
		Limits: map[string]*int64{"seats": limit(3), "clients": nil, "active_leads": limit(7500000), "imports_monthly": nil, "monthly_minutes": limit(24000), "skiptrace_credits": limit(9000000), "file_storage_mb": limit(15360)}},
	{Key: "custom", Name: "Custom", Seats: 1, Minutes: 0, PriceMinor: 0, Currency: "USD",
		Limits: map[string]*int64{"seats": limit(1), "clients": nil, "active_leads": limit(0), "imports_monthly": limit(0), "monthly_minutes": limit(0), "skiptrace_credits": limit(0), "file_storage_mb": limit(0)}},
}

func builtInPlan(key string) (offeredPlan, bool) {
	for _, p := range builtInPlans {
		if p.Key == key {
			return p, true
		}
	}
	return offeredPlan{}, false
}

// billingConnected is true when a billing service holds the plans and memberships.
func (s *server) billingConnected() bool { return s.cfg.billingURL != "" && s.cfg.billingToken != "" }

// plansHere lists the built-in plans with their display price.
func plansHere() []offeredPlan {
	out := make([]offeredPlan, 0, len(builtInPlans))
	for _, p := range builtInPlans {
		p.DisplayPrice = fmt.Sprintf("%d.%02d", p.PriceMinor/100, p.PriceMinor%100)
		out = append(out, p)
	}
	return out
}

// assignHere gives the workspace its plan and limits without billing, and tells authorization the seats, client places and that
// the plan is in good standing. Asking again replaces the membership.
func (s *server) assignHere(ctx context.Context, org, user string, body membershipBody, givenBy string) (map[string]any, error) {
	plan, ok := builtInPlan(body.Plan)
	if !ok {
		return nil, bad(body.Plan + " is not a plan.")
	}
	limits := map[string]*int64{}
	for k, v := range plan.Limits {
		limits[k] = v
	}
	overrides := map[string]*int64{}
	for k, v := range body.Limits {
		base := plan.Limits[k]
		if (v == nil) != (base == nil) || (v != nil && *v != *base) {
			overrides[k] = v
		}
		limits[k] = v
	}
	at := now()
	status, ends := "active", time.Unix(at, 0).UTC().AddDate(0, body.Months, 0).Unix()
	if body.Payment == "trial" {
		status, ends = "trialing", at+int64(body.Days)*86400
	}
	var paid int64
	if body.Payment == "manual" {
		paid = plan.PriceMinor * int64(body.Months)
		if body.AmountMinor != nil {
			paid = *body.AmountMinor
		}
	}
	saved, _ := json.Marshal(limits)
	if _, err := s.db.Exec(ctx, `INSERT INTO workspace_memberships (org_id, user_id, plan, payment, status, period_start, period_end, paid_minor, currency, limits, given_by, given_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6)
		ON CONFLICT (org_id) DO UPDATE SET user_id=EXCLUDED.user_id, plan=EXCLUDED.plan, payment=EXCLUDED.payment, status=EXCLUDED.status,
			period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, paid_minor=EXCLUDED.paid_minor, currency=EXCLUDED.currency,
			limits=EXCLUDED.limits, given_by=EXCLUDED.given_by, given_at=EXCLUDED.given_at, expired_told=NULL`,
		org, user, plan.Key, body.Payment, status, at, ends, paid, plan.Currency, string(saved), givenBy); err != nil {
		return nil, err
	}
	if err := s.tellStanding(ctx, org, map[string]any{"payment_required": false, "seats": limits["seats"], "clients": limits["clients"]}); err != nil {
		return nil, newError(http.StatusServiceUnavailable, "access_unavailable", "The plan is saved, but the seats could not be set yet. Give the membership again in a moment.")
	}
	return map[string]any{"org_id": org, "plan": plan.Key, "plan_name": plan.Name, "payment": body.Payment, "status": status,
		"period_end": time.Unix(ends, 0).UTC().Format(time.RFC3339), "paid_minor": paid, "currency": plan.Currency, "limits": limits, "overrides": overrides}, nil
}

// tellStanding sends a workspace's standing to authorization (only the fields given change there).
func (s *server) tellStanding(ctx context.Context, org string, standing map[string]any) error {
	if s.cfg.authzURL == "" || s.cfg.authzToken == "" {
		return errAccessUnavailable
	}
	raw, _ := json.Marshal(standing)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.cfg.authzURL+"/v1/orgs/"+org+"/standing", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.authzToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("authorization answered %d", res.StatusCode)
	}
	return nil
}

// standingHere is a workspace's plan as its members see it, from the membership kept here.
func (s *server) standingHere(ctx context.Context, org string) (workspacePlan, error) {
	var plan, status, limitsText string
	var ends int64
	err := s.db.QueryRow(ctx, `SELECT plan, status, period_end, limits FROM workspace_memberships WHERE org_id=$1`, org).Scan(&plan, &status, &ends, &limitsText)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspacePlan{OrgID: org}, nil
	}
	if err != nil {
		return workspacePlan{}, err
	}
	limits := map[string]*int64{}
	_ = json.Unmarshal([]byte(limitsText), &limits)
	p := workspacePlan{OrgID: org, Plan: plan, PlanName: plan, Status: status, PeriodEnd: time.Unix(ends, 0).UTC().Format(time.RFC3339), Limited: true, PaymentRequired: ends <= now()}
	if known, ok := builtInPlan(plan); ok {
		p.PlanName = known.Name
	}
	if v := limits["seats"]; v != nil {
		p.Seats = int(*v)
	}
	if v := limits["monthly_minutes"]; v != nil {
		p.MinutesAllowed = *v
	}
	return p, nil
}

// summaryHere is the overview's plans and revenue from the memberships kept here, in billing's shape.
func (s *server) summaryHere(ctx context.Context) *billingSummary {
	out := &billingSummary{}
	rows, err := s.db.Query(ctx, `SELECT plan, status, count(*) FROM workspace_memberships WHERE period_end > $1 GROUP BY plan, status`, now())
	if err != nil {
		log.Printf("WARN reading memberships for the overview: %v", err)
		return nil
	}
	for rows.Next() {
		var plan, status string
		var count int
		if err := rows.Scan(&plan, &status, &count); err != nil {
			rows.Close()
			return nil
		}
		known, _ := builtInPlan(plan)
		out.Subscriptions = append(out.Subscriptions, struct {
			PlanKey    string `json:"plan_key"`
			Name       string `json:"name"`
			Currency   string `json:"currency"`
			PriceMinor int64  `json:"price_minor"`
			Status     string `json:"status"`
			Workspaces int    `json:"workspaces"`
		}{plan, known.Name, "USD", known.PriceMinor, status, count})
	}
	rows.Close()
	return out
}

// watchMembershipPeriods tells authorization when a membership's period has ended, so the workspace asks for payment instead of
// working on. It checks every few minutes until ctx ends.
func (s *server) watchMembershipPeriods(ctx context.Context) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	for {
		s.tellEndedPeriods(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (s *server) tellEndedPeriods(ctx context.Context) {
	if s.billingConnected() {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT org_id FROM workspace_memberships WHERE period_end <= $1 AND expired_told IS NULL LIMIT 200`, now())
	if err != nil {
		log.Printf("WARN looking for ended memberships: %v", err)
		return
	}
	var ended []string
	for rows.Next() {
		var org string
		if rows.Scan(&org) == nil {
			ended = append(ended, org)
		}
	}
	rows.Close()
	for _, org := range ended {
		if err := s.tellStanding(ctx, org, map[string]any{"payment_required": true}); err != nil {
			log.Printf("WARN telling authorization that workspace %s's plan ended: %v", org, err)
			continue
		}
		if _, err := s.db.Exec(ctx, `UPDATE workspace_memberships SET expired_told=$2 WHERE org_id=$1`, org, now()); err != nil {
			log.Printf("WARN marking workspace %s's ended plan: %v", org, err)
		}
	}
}
