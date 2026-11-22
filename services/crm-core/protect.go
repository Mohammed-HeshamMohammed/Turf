package crm

// Protecting an agency's leads (migrations/0038_protect_leads.sql, D162-D165, D264).

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"
)

var (
	// accessFloor is the least opening and paging in 10 minutes that can count as far more than usual; accessTimes is how many times a
	// person's usual 10 minutes it must be (D164).
	accessFloor = 60
	accessTimes = 5
	// slowFor is how long a person is slowed after that, and slowDelay how much each lead they open waits meanwhile.
	slowFor   = 30 * time.Minute
	slowDelay = 2 * time.Second
)

func (s *server) protectRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/protection", s.member(s.protection))
	mux.Handle("PUT /api/v1/protection", s.member(s.protection))
	mux.Handle("PUT /api/v1/teams/{id}/full-numbers", s.member(s.teamFullNumbers))
	mux.Handle("GET /api/v1/leads/export", s.member(s.exportLeads))
	mux.Handle("GET /api/v1/exports", s.member(s.listExports))
	mux.Handle("GET /api/v1/leads/{id}/views", s.member(s.leadViews))
	mux.Handle("GET /api/v1/people/{user}/views", s.member(s.personViews))
	mux.Handle("GET /api/v1/protection/alerts", s.member(s.accessAlerts))
}

// ---- masked numbers (D163) ----

// seesFullNumbers is whether someone always sees full numbers: team leads, deputies, admins and the owner.
func seesFullNumbers(sc scope, g grantReply) bool {
	return manages(sc) || len(g.ManagedTeamIDs) > 0 || len(g.DeputyTeamIDs) > 0
}

// fullNumberTeams are the person's teams whose numbers the owner shows in full.
func (s *server) fullNumberTeams(ctx context.Context, sc scope) ([]string, error) {
	if len(sc.teamIDs) == 0 {
		return nil, nil
	}
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT team_id::text FROM team_settings WHERE full_numbers AND team_id = ANY($1::uuid[])`, uuidArray(sc.teamIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// maskPhone keeps a number's last four digits.
func maskPhone(phone string) string {
	d := nonDigits.ReplaceAllString(phone, "")
	if d == "" {
		return phone
	}
	if len(d) > 4 {
		d = d[len(d)-4:]
	}
	return "••• " + d
}

// masksFor is whether this person sees a lead's numbers masked.
func masksFor(sc scope, team string) bool {
	return sc.maskPhones && !(team != "" && slices.Contains(sc.fullTeams, team))
}

// maskNumbers masks every phone number in a value (a lead's other contacts included).
func maskNumbers(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			if s, ok := val.(string); ok && (k == "phone" || strings.HasSuffix(k, "_phone")) {
				x[k] = maskPhone(s)
			} else if list, ok := val.([]any); ok && (k == "phones") {
				for i, p := range list {
					if s, ok := p.(string); ok {
						list[i] = maskPhone(s)
					} else {
						list[i] = maskNumbers(p)
					}
				}
			} else {
				x[k] = maskNumbers(val)
			}
		}
	case []any:
		for i := range x {
			x[i] = maskNumbers(x[i])
		}
	}
	return v
}

// teamFullNumbers is PUT /api/v1/teams/{id}/full-numbers {on}: the owner shows a team's agents full numbers.
func (s *server) teamFullNumbers(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner chooses which teams see full numbers.")
	}
	team := q.r.PathValue("id")
	var body struct {
		On bool `json:"on"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	if listed, err := s.rules.teams(ctx, q.sc.orgID); err == nil {
		if err := s.copyTeams(ctx, q.sc, listed); err != nil {
			return err
		}
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `INSERT INTO team_settings (team_id, org_id, full_numbers, updated_by) SELECT $1, cw_org(), $2, $3 WHERE EXISTS (SELECT 1 FROM teams WHERE id = $1)
		ON CONFLICT (team_id) DO UPDATE SET full_numbers = EXCLUDED.full_numbers, updated_by = EXCLUDED.updated_by, updated_at = now()`, nullID(team), body.On, q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("That team is not in this workspace.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"team_id": team, "full_numbers": body.On})
	return nil
}

// protection is GET (the owner and admins) and PUT {managers_export, view_keep_days} (the owner).
func (s *server) protection(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see how leads are protected.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPut {
		if !isOwner(q.sc) {
			return forbidden("The owner changes these.")
		}
		var body struct {
			ManagersExport *bool `json:"managers_export"`
			ViewKeepDays   *int  `json:"view_keep_days"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if body.ViewKeepDays != nil && (*body.ViewKeepDays < 7 || *body.ViewKeepDays > 730) {
			return bad("Keep the record of who opened leads from 7 to 730 days.")
		}
		if _, err := tx.Exec(ctx, `UPDATE orgs SET managers_export = coalesce($1, managers_export), view_keep_days = coalesce($2, view_keep_days) WHERE id = cw_org()`,
			body.ManagersExport, body.ViewKeepDays); err != nil {
			return err
		}
	}
	var managers bool
	var keep int
	if err := tx.QueryRow(ctx, `SELECT managers_export, view_keep_days FROM orgs WHERE id = cw_org()`).Scan(&managers, &keep); err != nil {
		return err
	}
	full, err := queryJSON(ctx, tx, `SELECT to_jsonb(team_id) FROM team_settings WHERE full_numbers`)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"managers_export": managers, "view_keep_days": keep, "full_number_teams": full})
	return nil
}

// ---- exports (D162) ----

// exportLeads is GET /api/v1/leads/export?team_id=: a CSV of the leads the person may export, recorded with who, what and when.
func (s *server) exportLeads(q *req) error {
	team := q.r.URL.Query().Get("team_id")
	if team != "" && !validID(team) {
		return bad("team_id is an id.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !manages(q.sc) {
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT managers_export FROM orgs WHERE id = cw_org()`).Scan(&allowed); err != nil {
			return err
		}
		switch {
		case len(q.grant.ManagedTeamIDs) == 0:
			return forbidden("Only the owner and admins export leads (and team leads, when the owner allows it).")
		case !allowed:
			return forbidden("The owner has not allowed team leads to export.")
		case team == "" || !slices.Contains(q.grant.ManagedTeamIDs, team):
			return forbidden("Team leads export only a team they lead (team_id).")
		}
	}
	where, args := "l.org_id = cw_org() AND l.deleted_at IS NULL AND cw_visible_lead(l.id)", []any{}
	if team != "" {
		where, args = where+" AND l.team_id = $1", append(args, team)
	}
	rows, err := tx.Query(ctx, `SELECT l.name, l.phone, l.email, l.stage, l.verdict, coalesce(p.address, ''), coalesce(p.city, ''), coalesce(p.region, ''),
		coalesce(p.postal_code, ''), l.do_not_call, l.created_at FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE `+where+` ORDER BY l.created_at LIMIT 200000`, args...)
	if err != nil {
		return err
	}
	var buf strings.Builder
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"name", "phone", "email", "stage", "verdict", "address", "city", "region", "zip", "do_not_call", "created_at"})
	n := 0
	for rows.Next() {
		var name, phone, email, stage, verdict, addr, city, region, zip string
		var dnc bool
		var created time.Time
		if err := rows.Scan(&name, &phone, &email, &stage, &verdict, &addr, &city, &region, &zip, &dnc, &created); err != nil {
			rows.Close()
			return err
		}
		// A cell that starts like a formula is kept as text in spreadsheets.
		cells := []string{name, phone, email, stage, verdict, addr, city, region, zip, fmt.Sprint(dnc), created.UTC().Format(time.RFC3339)}
		for i, c := range cells {
			if c != "" && strings.ContainsRune("=+-@", rune(c[0])) && i != 1 {
				cells[i] = "'" + c
			}
		}
		_ = w.Write(cells)
		n++
	}
	rows.Close()
	w.Flush()
	filters, _ := json.Marshal(map[string]any{"team_id": nullID(team)})
	if _, err := tx.Exec(ctx, `INSERT INTO lead_exports (org_id, user_id, team_id, rows, filters) VALUES (cw_org(), $1, $2, $3, $4)`, q.sc.userID, nullID(team), n, filters); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	q.w.Header().Set("Content-Disposition", `attachment; filename="leads.csv"`)
	_, _ = q.w.Write([]byte(buf.String()))
	return nil
}

// listExports is GET /api/v1/exports?user_id=: the record of exports, for the owner and admins.
func (s *server) listExports(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the record of exports.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	user := q.r.URL.Query().Get("user_id")
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(x) FROM lead_exports x WHERE ($1::uuid IS NULL OR x.user_id = $1) ORDER BY x.at DESC LIMIT 500`, nullID(user))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"exports": rows})
	return nil
}

// ---- who opened what (D165, D264), and far more than usual (D164) ----

// noteAccess records opening a lead (lead set) or paging through leads (units), and slows the person when it is far more than usual.
func (s *server) noteAccess(q *req, lead string, units int) {
	if units <= 0 || q.sc.external() {
		return
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if lead != "" {
		// Views past the agency's keeping time go as the lead is opened again; the lists never show them either way.
		if _, err := tx.Exec(ctx, `DELETE FROM lead_views WHERE lead_id = $1 AND at < now() - make_interval(days => (SELECT view_keep_days FROM orgs WHERE id = cw_org()))`, lead); err != nil {
			log.Printf("WARN lead view: %v", err)
			return
		}
		if _, err := tx.Exec(ctx, `INSERT INTO lead_views (org_id, lead_id, user_id) VALUES (cw_org(), $1, $2)`, lead, q.sc.userID); err != nil {
			log.Printf("WARN lead view: %v", err)
			return
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM access_counts WHERE user_id = $1 AND bucket < now() - interval '8 days'`, q.sc.userID); err != nil {
		return
	}
	now := s.now()
	bucket := now.Truncate(10 * time.Minute)
	var recent int
	if err := tx.QueryRow(ctx, `INSERT INTO access_counts (org_id, user_id, bucket, units) VALUES (cw_org(), $1, $2, $3)
		ON CONFLICT (org_id, user_id, bucket) DO UPDATE SET units = access_counts.units + EXCLUDED.units RETURNING units`, q.sc.userID, bucket, units).Scan(&recent); err != nil {
		log.Printf("WARN access count: %v", err)
		return
	}
	var usual float64
	var slowed bool
	_ = tx.QueryRow(ctx, `SELECT coalesce(avg(units), 0)::float8 FROM access_counts WHERE user_id = $1 AND bucket < $2 AND bucket >= $2 - interval '7 days'`, q.sc.userID, bucket).Scan(&usual)
	_ = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM access_alerts WHERE user_id = $1 AND slowed_until > $2)`, q.sc.userID, now).Scan(&slowed)
	limit := max(accessFloor, int(usual)*accessTimes)
	if !slowed && recent > limit {
		if _, err := tx.Exec(ctx, `INSERT INTO access_alerts (org_id, user_id, units, usual, slowed_until) VALUES (cw_org(), $1, $2, $3, $4)`,
			q.sc.userID, recent, int(usual), now.Add(slowFor)); err != nil {
			log.Printf("WARN access alert: %v", err)
			return
		}
		slowed = true
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	if slowed && slowDelay > 0 {
		select {
		case <-time.After(slowDelay):
		case <-ctx.Done():
		}
	}
}

// leadViews is GET /api/v1/leads/{id}/views: who opened the lead and when, for the owner and admins.
func (s *server) leadViews(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see who opened a lead.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('user_id', v.user_id, 'at', v.at) FROM lead_views v
		WHERE v.lead_id = $1 AND v.at > now() - make_interval(days => (SELECT view_keep_days FROM orgs WHERE id = cw_org())) ORDER BY v.at DESC LIMIT 500`, nullID(q.r.PathValue("id")))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"views": rows})
	return nil
}

// personViews is GET /api/v1/people/{user}/views?days=: what a person opened and exported recently, for the owner and admins (D264).
func (s *server) personViews(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see what a person opened.")
	}
	days := atoiOr(q.r.URL.Query().Get("days"), 30)
	if days < 1 || days > 730 {
		days = 30
	}
	user := nullID(q.r.PathValue("user"))
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	views, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('lead_id', v.lead_id, 'name', l.name, 'opened', count(*), 'last_at', max(v.at))
		FROM lead_views v LEFT JOIN leads l ON l.id = v.lead_id WHERE v.user_id = $1 AND v.at > now() - make_interval(days => least($2, (SELECT view_keep_days FROM orgs WHERE id = cw_org())))
		GROUP BY v.lead_id, l.name ORDER BY max(v.at) DESC LIMIT 1000`, user, days)
	if err != nil {
		return err
	}
	exports, err := queryJSON(ctx, tx, `SELECT to_jsonb(x) FROM lead_exports x WHERE x.user_id = $1 AND x.at > now() - make_interval(days => $2) ORDER BY x.at DESC`, user, days)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"user_id": user, "days": days, "views": views, "exports": exports})
	return nil
}

// accessAlerts is GET /api/v1/protection/alerts: people who opened or paged far more than usual, for the owner and admins.
func (s *server) accessAlerts(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see access alerts.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(a) FROM access_alerts a ORDER BY a.at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"alerts": rows})
	return nil
}
