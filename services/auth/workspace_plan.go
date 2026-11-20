package main

// What a workspace's own members may see about its plan: the plan, whether it is in good standing, when the period ends, and the
// minutes used against the minutes the plan includes. Billing answers; auth only checks the person belongs to that workspace and
// passes on the fields below (never a payment detail: billing does not hold any).

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// workspacePlan is the part of billing's answer a member sees.
type workspacePlan struct {
	OrgID           string `json:"org_id"`
	Plan            string `json:"plan"`
	PlanName        string `json:"plan_name,omitempty"`
	Status          string `json:"status,omitempty"`
	PeriodEnd       string `json:"period_end,omitempty"`
	Seats           int    `json:"seats,omitempty"`
	MinutesAllowed  int64  `json:"minutes_allowed,omitempty"`
	MinutesUsed     int64  `json:"minutes_used,omitempty"`
	Limited         bool   `json:"limited"`
	PaymentRequired bool   `json:"payment_required"`
	// Percent of the plan's minutes used, 0 to 100 and beyond when over; nil when the plan has no minutes limit.
	PercentUsed *float64 `json:"percent_used,omitempty"`
}

// planView keeps only the fields a member may see and works out the percent of minutes used.
func planView(raw map[string]any, names map[string]string) workspacePlan {
	str := func(key string) string { v, _ := raw[key].(string); return v }
	num := func(key string) int64 { v, _ := raw[key].(float64); return int64(v) }
	flag := func(key string) bool { v, _ := raw[key].(bool); return v }
	p := workspacePlan{
		OrgID: str("org_id"), Plan: str("plan"), Status: str("status"), PeriodEnd: str("period_end"), Seats: int(num("seats")),
		MinutesAllowed: num("minutes_allowed"), MinutesUsed: num("minutes_used"), Limited: flag("limited"), PaymentRequired: flag("payment_required"),
	}
	p.PlanName = names[p.Plan]
	if p.PlanName == "" {
		p.PlanName = p.Plan
	}
	if p.MinutesAllowed > 0 {
		percent := float64(p.MinutesUsed) / float64(p.MinutesAllowed) * 100
		p.PercentUsed = &percent
	}
	return p
}

// workspaceMember is a person who belongs to the workspace in any role (reading its plan needs no second step).
func (s *server) workspaceMember(r *http.Request, org string) (claims, error) {
	if _, err := uuid.Parse(org); err != nil {
		return claims{}, bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return claims{}, err
	}
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, c.Sub)
	if err != nil {
		return claims{}, errAccessUnavailable
	}
	for _, space := range profile.Workspaces {
		if space.OrgID == org {
			return c, nil
		}
	}
	return claims{}, forbidden("This is not your workspace.")
}

// planNames reads the plans' names from billing's public list; a failure just means the plan key is shown.
func (s *server) planNames(ctx context.Context) map[string]string {
	names := map[string]string{}
	if !s.billingConnected() {
		for _, p := range builtInPlans {
			names[p.Key] = p.Name
		}
		return names
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.billingURL+"/api/v1/plans", nil)
	if err != nil {
		return names
	}
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return names
	}
	defer res.Body.Close()
	var listed struct {
		Plans []struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		} `json:"plans"`
	}
	if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&listed) == nil {
		for _, p := range listed.Plans {
			names[p.Key] = p.Name
		}
	}
	return names
}

// standingFor asks billing for a workspace's standing and keeps only what a member may see.
func (s *server) standingFor(ctx context.Context, org string) (workspacePlan, error) {
	unavailable := newError(http.StatusServiceUnavailable, "billing_unavailable", "Plan details are not available right now.")
	if !s.billingConnected() {
		return s.standingHere(ctx, org)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.billingURL+"/v1/orgs/"+org+"/standing", nil)
	if err != nil {
		return workspacePlan{}, errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.billingToken)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return workspacePlan{}, unavailable
	}
	defer res.Body.Close()
	var raw map[string]any
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&raw) != nil {
		return workspacePlan{}, unavailable
	}
	return planView(raw, s.planNames(ctx)), nil
}

func (s *server) workspaceStanding(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	if _, err := s.workspaceMember(r, org); err != nil {
		return err
	}
	plan, err := s.standingFor(r.Context(), org)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, plan)
	return nil
}
