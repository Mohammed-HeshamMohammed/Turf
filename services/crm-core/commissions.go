package crm

// Build step 27: commission tracking, optional per agency (migrations/0034_commissions.sql, D144, D149). Only the owner switches it on,
// sets the rules and overrides a figure; the owner and admins see everyone's earnings, each person their own. Nothing is paid here.

import (
	"context"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) commissionRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/commissions/settings", s.member(s.commissionSettings))
	mux.Handle("PUT /api/v1/commissions/settings", s.member(s.commissionSettings))
	mux.Handle("PUT /api/v1/commissions/rules", s.member(s.putCommissionRule))
	mux.Handle("DELETE /api/v1/commissions/rules/{id}", s.member(s.deleteCommissionRule))
	mux.Handle("PUT /api/v1/commissions/overrides", s.member(s.putCommissionOverride))
	mux.Handle("GET /api/v1/commissions", s.member(s.commissions))
}

// commissionSettings is GET (anyone in the agency: whether it is on, the split and the rules) and PUT {on, split} (the owner).
func (s *server) commissionSettings(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not see commissions.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPut {
		if !isOwner(q.sc) {
			return forbidden("The owner sets commissions.")
		}
		var body struct {
			On    *bool    `json:"on"`
			Split *float64 `json:"split"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if body.Split != nil && (*body.Split < 0 || *body.Split > 100) {
			return bad("The caller's share is from 0 to 100 percent.")
		}
		if _, err := tx.Exec(ctx, `UPDATE orgs SET commissions_on = coalesce($1, commissions_on), commission_split = coalesce($2, commission_split) WHERE id = cw_org()`,
			body.On, body.Split); err != nil {
			return err
		}
	}
	var on bool
	var split float64
	if err := tx.QueryRow(ctx, `SELECT commissions_on, commission_split::float8 FROM orgs WHERE id = cw_org()`).Scan(&on, &split); err != nil {
		return err
	}
	rules, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', id, 'role', role, 'user_id', user_id, 'per_appointment', per_appointment::float8,
		'deal_percent', deal_percent::float8) FROM commission_rules ORDER BY role NULLS LAST, user_id`)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"on": on, "split": split, "rules": rules})
	return nil
}

// putCommissionRule is PUT /api/v1/commissions/rules {role | user_id, per_appointment, deal_percent}: the owner sets a rule.
func (s *server) putCommissionRule(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner sets commissions.")
	}
	var body struct {
		Role           string  `json:"role"`
		UserID         string  `json:"user_id"`
		PerAppointment float64 `json:"per_appointment"`
		DealPercent    float64 `json:"deal_percent"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	role := strings.TrimSpace(body.Role)
	if (role == "") == (body.UserID == "") || (body.UserID != "" && !validID(body.UserID)) || len(role) > 40 {
		return bad("A rule is for one role or one person (user_id).")
	}
	if body.PerAppointment < 0 || body.PerAppointment > 1e9 || body.DealPercent < 0 || body.DealPercent > 100 {
		return bad("per_appointment is an amount of 0 or more; deal_percent is from 0 to 100.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	conflict := "(org_id, role) WHERE role IS NOT NULL"
	if role == "" {
		conflict = "(org_id, user_id) WHERE user_id IS NOT NULL"
	}
	rows, err := queryJSON(ctx, tx, `INSERT INTO commission_rules (org_id, role, user_id, per_appointment, deal_percent, updated_by) VALUES (cw_org(), nullif($1, ''), $2, $3, $4, $5)
		ON CONFLICT `+conflict+` DO UPDATE SET per_appointment = EXCLUDED.per_appointment, deal_percent = EXCLUDED.deal_percent, updated_by = EXCLUDED.updated_by, updated_at = now()
		RETURNING jsonb_build_object('id', id, 'role', role, 'user_id', user_id, 'per_appointment', per_appointment::float8, 'deal_percent', deal_percent::float8)`,
		role, nullID(body.UserID), body.PerAppointment, body.DealPercent, q.sc.userID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

func (s *server) deleteCommissionRule(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner sets commissions.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM commission_rules WHERE id = $1`, nullID(q.r.PathValue("id"))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// putCommissionOverride is PUT /api/v1/commissions/overrides {source: appointment|deal, source_id, user_id, amount, reason} (the owner);
// amount null removes the override.
func (s *server) putCommissionOverride(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner overrides commissions.")
	}
	var body struct {
		Source   string   `json:"source"`
		SourceID string   `json:"source_id"`
		UserID   string   `json:"user_id"`
		Amount   *float64 `json:"amount"`
		Reason   string   `json:"reason"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	reason := strings.TrimSpace(body.Reason)
	if (body.Source != "appointment" && body.Source != "deal") || !validID(body.SourceID) || !validID(body.UserID) {
		return bad("Choose the item (source appointment or deal, source_id) and the person (user_id).")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if body.Amount == nil {
		_, err = tx.Exec(ctx, `DELETE FROM commission_overrides WHERE source = $1 AND source_id = $2 AND user_id = $3`, body.Source, body.SourceID, body.UserID)
	} else {
		if *body.Amount < 0 || len(reason) < 3 || len(reason) > 500 {
			return bad("An override is an amount of 0 or more, with a reason (3 to 500 characters).")
		}
		_, err = tx.Exec(ctx, `INSERT INTO commission_overrides (org_id, source, source_id, user_id, amount, reason, set_by) VALUES (cw_org(), $1, $2, $3, $4, $5, $6)
			ON CONFLICT (org_id, source, source_id, user_id) DO UPDATE SET amount = EXCLUDED.amount, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`,
			body.Source, body.SourceID, body.UserID, *body.Amount, reason, q.sc.userID)
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

type commissionRule struct{ perAppointment, dealPercent float64 }

type earning struct {
	UserID   string   `json:"user_id"`
	Source   string   `json:"source"` // appointment or deal
	SourceID string   `json:"source_id"`
	LeadID   string   `json:"lead_id"`
	At       string   `json:"at"`
	Role     string   `json:"role"` // caller (set the appointment) or closer (won the deal)
	Base     *float64 `json:"base,omitempty"`
	Currency string   `json:"currency"`
	Amount   float64  `json:"amount"`
	Override *string  `json:"override_reason,omitempty"`
}

// commissions is GET /api/v1/commissions?from=&to= (dates, the current month by default): each person's earnings item by item and in
// total per currency. The owner and admins see everyone; anyone else their own.
func (s *server) commissions(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not see commissions.")
	}
	from, to, err := monthRange(q.r.URL.Query().Get("from"), q.r.URL.Query().Get("to"), time.Now())
	if err != nil {
		return err
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var on bool
	var split float64
	if err := tx.QueryRow(ctx, `SELECT commissions_on, commission_split::float8 FROM orgs WHERE id = cw_org()`).Scan(&on, &split); err != nil {
		return err
	}
	if !on {
		return &apiError{http.StatusConflict, "off", "Commission tracking is off for this agency."}
	}
	rules, err := s.rulesFor(ctx, tx, q.sc.orgID)
	if err != nil {
		return err
	}
	var items []earning
	// Appointments: each one booked (step 28) for whoever booked it, and each call logged "Transfer" by someone who did not also book
	// an appointment for that lead within a day of it.
	rows, err := tx.Query(ctx, `SELECT id::text, lead_id::text, booked_by::text, created_at FROM appointments
			WHERE status <> 'cancelled' AND created_at >= $1 AND created_at < $2
		UNION ALL
		SELECT c.id::text, c.lead_id::text, c.agent_id::text, c.occurred_at FROM call_events c
			WHERE c.outcome = 'Transfer' AND c.agent_id IS NOT NULL AND c.occurred_at >= $1 AND c.occurred_at < $2
			AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = c.lead_id AND a.booked_by = c.agent_id AND a.status <> 'cancelled'
				AND a.created_at BETWEEN c.occurred_at - interval '1 day' AND c.occurred_at + interval '1 day')
		ORDER BY 4`, from, to)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, lead, agent string
		var at time.Time
		if err := rows.Scan(&id, &lead, &agent, &at); err != nil {
			rows.Close()
			return err
		}
		items = append(items, earning{UserID: agent, Source: "appointment", SourceID: id, LeadID: lead, At: at.Format(time.RFC3339), Role: "caller",
			Currency: "USD", Amount: rules(agent).perAppointment})
	}
	rows.Close()
	// Won deals: the closer's percentage of the fee (else the amount), part of it to the caller who set the lead's appointment.
	// Who is credited with each won deal comes from its credit records (step 28, D157).
	rows, err = tx.Query(ctx, `SELECT d.id::text, d.lead_id::text,
			coalesce((SELECT user_id FROM deal_credits WHERE deal_id = d.id AND role = 'closer'), d.closed_by, l.assignee_id)::text,
			d.closed_at, coalesce(d.fee, d.amount)::float8, d.currency,
			(SELECT user_id::text FROM deal_credits WHERE deal_id = d.id AND role = 'caller')
		FROM deals d JOIN leads l ON l.id = d.lead_id
		WHERE d.stage = 'Closed won' AND d.closed_at >= $1 AND d.closed_at < $2 ORDER BY d.closed_at`, from, to)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, lead string
		var closer, caller *string
		var at time.Time
		var base *float64
		var currency string
		if err := rows.Scan(&id, &lead, &closer, &at, &base, &currency, &caller); err != nil {
			rows.Close()
			return err
		}
		if closer == nil || base == nil {
			continue
		}
		pool := *base * rules(*closer).dealPercent / 100
		callerShare := 0.0
		if caller != nil && *caller != *closer && split > 0 {
			callerShare = pool * split / 100
			items = append(items, earning{UserID: *caller, Source: "deal", SourceID: id, LeadID: lead, At: at.Format(time.RFC3339), Role: "caller",
				Base: base, Currency: strings.TrimSpace(currency), Amount: cents(callerShare)})
		}
		items = append(items, earning{UserID: *closer, Source: "deal", SourceID: id, LeadID: lead, At: at.Format(time.RFC3339), Role: "closer",
			Base: base, Currency: strings.TrimSpace(currency), Amount: cents(pool - callerShare)})
	}
	rows.Close()
	// The owner's overrides replace the figure, with the reason shown.
	type key struct{ source, id, user string }
	overrides := map[key]struct {
		amount float64
		reason string
	}{}
	rows, err = tx.Query(ctx, `SELECT source, source_id::text, user_id::text, amount::float8, reason FROM commission_overrides`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k key
		var amount float64
		var reason string
		if err := rows.Scan(&k.source, &k.id, &k.user, &amount, &reason); err != nil {
			rows.Close()
			return err
		}
		overrides[k] = struct {
			amount float64
			reason string
		}{amount, reason}
	}
	rows.Close()
	everyone := manages(q.sc)
	shown := []earning{}
	totals := map[string]map[string]float64{} // user -> currency -> total
	for _, it := range items {
		if !everyone && it.UserID != q.sc.userID {
			continue
		}
		if o, ok := overrides[key{it.Source, it.SourceID, it.UserID}]; ok {
			it.Amount, it.Override = o.amount, &o.reason
		}
		shown = append(shown, it)
		if totals[it.UserID] == nil {
			totals[it.UserID] = map[string]float64{}
		}
		totals[it.UserID][it.Currency] = cents(totals[it.UserID][it.Currency] + it.Amount)
	}
	writeJSON(q.w, 200, map[string]any{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"), "items": shown, "totals": totals,
		"note": "What each person earned under the agency's rules. Caller Whale makes no payments."})
	return nil
}

// rulesFor answers each person's rule: their own, else that of the first of their roles that has one, else nothing.
func (s *server) rulesFor(ctx context.Context, tx pgx.Tx, org string) (func(string) commissionRule, error) {
	rows, err := tx.Query(ctx, `SELECT coalesce(role, ''), coalesce(user_id::text, ''), per_appointment::float8, deal_percent::float8 FROM commission_rules`)
	if err != nil {
		return nil, err
	}
	byRole, byUser := map[string]commissionRule{}, map[string]commissionRule{}
	for rows.Next() {
		var role, user string
		var r commissionRule
		if err := rows.Scan(&role, &user, &r.perAppointment, &r.dealPercent); err != nil {
			rows.Close()
			return nil, err
		}
		if user != "" {
			byUser[user] = r
		} else {
			byRole[role] = r
		}
	}
	rows.Close()
	roles := map[string][]string{}
	if members, err := s.rules.members(ctx, org); err == nil {
		for _, m := range members {
			roles[m.UserID] = m.Roles
		}
	}
	return func(user string) commissionRule {
		if r, ok := byUser[user]; ok {
			return r
		}
		for _, role := range roles[user] {
			if r, ok := byRole[role]; ok {
				return r
			}
		}
		return commissionRule{}
	}, nil
}

func cents(v float64) float64 { return math.Round(v*100) / 100 }

// monthRange reads from and to (YYYY-MM-DD, to exclusive); missing, the current month.
func monthRange(fromText, toText string, now time.Time) (time.Time, time.Time, error) {
	from := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 1, 0)
	var err error
	if fromText != "" {
		if from, err = time.Parse("2006-01-02", fromText); err != nil {
			return from, to, bad("from is a date like 2026-11-01.")
		}
	}
	if toText != "" {
		if to, err = time.Parse("2006-01-02", toText); err != nil {
			return from, to, bad("to is a date like 2026-12-01.")
		}
	}
	if !to.After(from) || to.Sub(from) > 370*24*time.Hour {
		return from, to, bad("Choose up to a year, from before to.")
	}
	return from, to, nil
}
