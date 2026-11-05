package main

// Giving a person a membership: an owner or cofounder arranges a plan with someone (a private invitation, or a person who signed up)
// and gives it to them as a trial, free, or paid outside the payment provider. That opens the person's own workspace with the role
// they will hold in it, and gives the workspace its plan in billing, so the usage, the costs and the revenue start from there.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

type offeredPlan struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	Seats        int    `json:"seats"`
	Minutes      int64  `json:"monthly_minutes"`
	PriceMinor   int64  `json:"price_minor"`
	Currency     string `json:"currency"`
	DisplayPrice string `json:"price"`
}

// adminPlans lists the plans an owner can give, from billing.
func (s *server) adminPlans(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, true); err != nil {
		return err
	}
	if s.cfg.billingURL == "" {
		return newError(http.StatusServiceUnavailable, "billing_unavailable", "Billing is not connected to this dashboard yet.")
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.cfg.billingURL+"/api/v1/plans", nil)
	if err != nil {
		return errAccessUnavailable
	}
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return newError(http.StatusServiceUnavailable, "billing_unavailable", "Billing did not answer. Try again in a moment.")
	}
	defer res.Body.Close()
	var listed struct {
		Plans []offeredPlan `json:"plans"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&listed) != nil {
		return newError(http.StatusServiceUnavailable, "billing_unavailable", "Billing did not answer. Try again in a moment.")
	}
	if listed.Plans == nil {
		listed.Plans = []offeredPlan{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"plans": listed.Plans})
	return nil
}

// openingRoles are the roles that open a workspace: the agency owner, or a solo operator (the same two the authorization service holds back).
var openingRoles = []string{"owner", "solo"}

// ownerActor is an owner or cofounder who has also confirmed themselves with a second step in the last five minutes: the rule for
// everything that moves money or access (staff roles and invitations, costs and rates, memberships). Reading stays with staffActor.
func (s *server) ownerActor(r *http.Request) (claims, error) {
	c, err := s.staffActor(r, true)
	if err != nil {
		return claims{}, err
	}
	if problem := requireFreshSecondStep(c, now()); problem != nil {
		return claims{}, problem
	}
	return c, nil
}

// freshSecondStepWindow is how long a second step counts for the actions that need one done just now.
const freshSecondStepWindow = 5 * 60

// requireFreshSecondStep is nothing when the person confirmed themselves with a second step within the last five minutes. Otherwise
// the answer is "step_up_required", which the dashboard turns into a code box on the spot, then asks again.
func requireFreshSecondStep(c claims, at int64) *apiError {
	if !c.MFA || c.AuthTime <= 0 || at-c.AuthTime > freshSecondStepWindow || c.AuthTime > at+60 {
		return newError(http.StatusForbidden, "step_up_required", "Confirm it's you with your authenticator code to do this.")
	}
	return nil
}

type membershipBody struct {
	UserID      string `json:"user_id"`
	Plan        string `json:"plan"`
	Payment     string `json:"payment"` // trial, free or manual
	Role        string `json:"role"`    // the role they hold in their own workspace: owner (agency owner) or solo
	Days        int    `json:"days"`
	Months      int    `json:"months"`
	AmountMinor *int64 `json:"amount_minor"`
}

// checkMembership says what is wrong with a request, or nothing. Time and money are limited to sensible amounts.
func checkMembership(b *membershipBody) *apiError {
	b.Plan = strings.TrimSpace(b.Plan)
	if _, err := uuid.Parse(b.UserID); err != nil {
		return bad("Choose a person.")
	}
	if b.Plan == "" || len(b.Plan) > 40 {
		return bad("Choose a plan.")
	}
	if b.Payment != "trial" && b.Payment != "free" && b.Payment != "manual" {
		return bad("Choose trial, free or paid manually.")
	}
	if b.Role == "" {
		b.Role = "owner"
	}
	// Only the roles that open a workspace can be given here; every other role is given by inviting someone into a workspace.
	if !slices.Contains(openingRoles, b.Role) {
		return bad("A membership gives the agency owner or solo operator role. Other roles are given by inviting the person into the workspace.")
	}
	if b.Days == 0 {
		b.Days = 14
	}
	if b.Months == 0 {
		b.Months = 12
	}
	if b.Days < 1 || b.Days > 90 {
		return bad("A trial lasts from 1 to 90 days.")
	}
	if b.Months < 1 || b.Months > 36 {
		return bad("A plan can be given for 1 to 36 months.")
	}
	if b.AmountMinor != nil && (*b.AmountMinor < 0 || *b.AmountMinor > 1_000_000_000_000) {
		return bad("The amount paid is not valid.")
	}
	if b.Payment != "manual" {
		b.AmountMinor = nil
	}
	return nil
}

// giveMembership opens the person's workspace (once: a person who already runs one keeps it and gets the new plan there) and tells
// billing the plan. Asking again is safe: the same workspace is found and the plan is set again.
func (s *server) giveMembership(w http.ResponseWriter, r *http.Request) error {
	// Giving someone a workspace and a plan moves money and access: it needs a second step done just now (ownerActor).
	if _, err := s.ownerActor(r); err != nil {
		return err
	}
	var body membershipBody
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	if problem := checkMembership(&body); problem != nil {
		return problem
	}
	if s.cfg.billingURL == "" || s.cfg.billingToken == "" {
		return newError(http.StatusServiceUnavailable, "billing_unavailable", "Billing is not connected to this dashboard yet.")
	}
	ctx := r.Context()
	var email, name string
	var disabled bool
	if err := s.db.QueryRow(ctx, "SELECT email, display_name, (disabled_at IS NOT NULL) FROM users WHERE id = $1", body.UserID).Scan(&email, &name, &disabled); err != nil {
		return newError(http.StatusNotFound, "not_found", "That person has no account.")
	}
	if disabled {
		return forbidden("That account is disabled.")
	}
	profile, err := readAccess(ctx, s.cfg.authzURL, s.cfg.authzToken, body.UserID)
	if err != nil {
		return errAccessUnavailable
	}
	org, created := "", false
	for _, space := range profile.Workspaces {
		if space.BusinessOwner {
			org = space.OrgID
			break
		}
	}
	if org == "" {
		org, created = uuid.NewString(), true
		if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/owner", map[string]any{"user_id": body.UserID, "role": body.Role}, nil); err != nil {
			return err
		}
	}
	given, err := s.billingAssign(ctx, org, body)
	if err != nil {
		return err
	}
	given["workspace_created"] = created
	given["role"] = body.Role
	given["person"] = map[string]string{"id": body.UserID, "name": name, "email": email}
	writeJSON(w, http.StatusOK, given)
	return nil
}

// billingAssign sets the workspace's plan in billing and returns what billing says. Billing's own refusals keep their words.
func (s *server) billingAssign(ctx context.Context, org string, body membershipBody) (map[string]any, error) {
	payload := map[string]any{"plan": body.Plan, "payment": body.Payment, "days": body.Days, "months": body.Months}
	if body.AmountMinor != nil {
		payload["amount_minor"] = *body.AmountMinor
	}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.cfg.billingURL+"/v1/admin/orgs/"+org+"/membership", bytes.NewReader(raw))
	if err != nil {
		return nil, errAccessUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.billingToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return nil, newError(http.StatusServiceUnavailable, "billing_unavailable", "Billing did not answer. The workspace is ready; try giving the plan again.")
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	if res.StatusCode != http.StatusOK {
		message, _ := out["error"].(string)
		switch {
		case res.StatusCode == http.StatusBadRequest && message != "":
			return nil, bad(message)
		case res.StatusCode == http.StatusConflict && message != "":
			return nil, newError(http.StatusConflict, "conflict", message)
		}
		return nil, newError(http.StatusServiceUnavailable, "billing_unavailable", "Billing could not give that plan. The workspace is ready; try again in a moment.")
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}
