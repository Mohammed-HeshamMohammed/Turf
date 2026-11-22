package main

import (
	"net/http"
	"slices"
	"time"
)

// What an unpaid plan, or an agency its owner closed, does to the people in it.
//
//	grace (7 days from the day the plan went unpaid): everything works; the owner and admins are warned (D80, D204).
//	read-only (the 30 days after): people read and export; nothing is called, texted, imported, and no one is invited (D205, D364).
//	closed (after those 30 days, or when the owner closes it): only the owner, who can pay or reopen it and export (D82, D206).
const (
	graceSeconds    = 7 * 86_400
	readOnlySeconds = 30 * 86_400
	closedSeconds   = 30 * 86_400 // a closed agency is kept this long before it is deleted (deleting is for later, with the lawyer)
)

// stage is where an agency stands with its plan: "" (paid), "grace", "read_only" or "closed".
func stage(paymentRequired bool, unpaidFor int64, closed bool) string {
	switch {
	case closed:
		return "closed"
	case !paymentRequired:
		return ""
	case unpaidFor <= graceSeconds:
		return "grace"
	case unpaidFor <= graceSeconds+readOnlySeconds:
		return "read_only"
	}
	return "closed"
}

// planStageRefusal is the refusal an unpaid or closed agency gives this request, or nil when it may go on.
func planStageRefusal(f facts, action string) *decision {
	reading := action == "read" || action == "export" || action == "pay"
	switch stage(f.paymentRequired, f.unpaidFor, f.closed) {
	case "closed":
		owner := slices.ContainsFunc(f.roles, func(r string) bool { return r == "owner" || r == "solo" })
		if !owner || !reading {
			d := refuse("closed", "This agency is closed. Its owner can pay or reopen it, and export its data.")
			return &d
		}
	case "read_only":
		if !reading {
			d := refuse("read_only", "This agency is read-only until its plan is paid. You can still read and export.")
			return &d
		}
	}
	return nil
}

// standingView is an agency's plan stage with its dates, for the screens that warn about it.
type standingView struct {
	UnpaidSince *int64 `json:"unpaid_since"`
	ClosedAt    *int64 `json:"closed_at"`
	Paused      bool   `json:"paused"`
}

func (v standingView) describe(now int64) map[string]any {
	out := map[string]any{"stage": "", "paused": v.Paused, "unpaid_since": v.UnpaidSince, "closed_at": v.ClosedAt}
	var unpaidFor int64
	if v.UnpaidSince != nil {
		unpaidFor = now - *v.UnpaidSince
		out["grace_ends"] = *v.UnpaidSince + graceSeconds
		out["read_only_ends"] = *v.UnpaidSince + graceSeconds + readOnlySeconds
	}
	out["stage"] = stage(v.UnpaidSince != nil, unpaidFor, v.ClosedAt != nil)
	switch {
	case v.ClosedAt != nil:
		out["delete_at"] = *v.ClosedAt + closedSeconds
	case v.UnpaidSince != nil:
		out["delete_at"] = *v.UnpaidSince + graceSeconds + readOnlySeconds + closedSeconds
	}
	return out
}

// planStage answers GET /v1/orgs/{org}/plan-stage: where the agency stands, for the warnings and the owner's close and reopen.
func (s *server) planStage(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	v, err := s.rules.standingOf(r.Context(), org)
	if err != nil {
		return store(err)
	}
	writeJSON(w, http.StatusOK, v.describe(time.Now().Unix()))
	return nil
}

// seatUse answers GET /v1/orgs/{org}/seats: the plan's seats and the people using one (everyone but clients and the suspended). When a
// lowered plan leaves more people than seats, the owner chooses who keeps one and the others are suspended (D81, D365).
func (s *server) seatUse(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	seats, _, err := s.rules.seatLimits(r.Context(), org)
	if err != nil {
		return store(err)
	}
	members, err := s.rules.members(r.Context(), org)
	if err != nil {
		return store(err)
	}
	using := []string{}
	for _, m := range members {
		if len(m.Roles) > 0 && !onlyClient(m.Roles) && m.SuspendedAt == nil {
			using = append(using, m.UserID)
		}
	}
	over := 0
	if seats != nil && len(using) > *seats {
		over = len(using) - *seats
	}
	writeJSON(w, http.StatusOK, map[string]any{"seats": seats, "used": len(using), "over": over, "using": using})
	return nil
}
