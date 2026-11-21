package crm

// Build step 32 (migrations/0040_overviews_reports.sql): the owner's overview opens with what needs them today (D225), a team lead's with
// their team right now (D226), the owner's view of members' activity (D267), and weekly or monthly report emails with totals only
// (D227), every day counted in the agency's time zone (D228). Who is available or on a call, and unanswered texts, come from the dialer
// (GET /api/v1/status, GET /api/v1/sms/waiting); budgets, seats and invitations from the dashboard's own cards.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) overviewRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/overview", s.member(s.ownerOverview))
	mux.Handle("GET /api/v1/overview/teams/{id}", s.member(s.teamOverview))
	mux.Handle("GET /api/v1/overview/members", s.member(s.membersActivity))
	mux.Handle("GET /api/v1/reports/schedules", s.member(s.listReportSchedules))
	mux.Handle("POST /api/v1/reports/schedules", s.member(s.addReportSchedule))
	mux.Handle("DELETE /api/v1/reports/schedules/{id}", s.member(s.deleteReportSchedule))
}

// totals are a period's results, counted in the agency's time zone, for the agency, one team or one client.
func totals(ctx context.Context, tx pgx.Tx, from, to time.Time, team, client string) (map[string]any, error) {
	var calls, reached, appointments, won int
	var value float64
	err := tx.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM call_events c JOIN leads l ON l.id = c.lead_id WHERE c.occurred_at >= $1 AND c.occurred_at < $2
				AND ($3::uuid IS NULL OR l.team_id = $3) AND ($4::uuid IS NULL OR l.client_id = $4)),
			(SELECT count(*) FROM call_events c JOIN leads l ON l.id = c.lead_id WHERE c.meaning = 'reached' AND c.occurred_at >= $1 AND c.occurred_at < $2
				AND ($3::uuid IS NULL OR l.team_id = $3) AND ($4::uuid IS NULL OR l.client_id = $4)),
			(SELECT count(*) FROM appointments a WHERE a.status <> 'cancelled' AND a.created_at >= $1 AND a.created_at < $2
				AND ($3::uuid IS NULL OR a.team_id = $3) AND ($4::uuid IS NULL OR a.client_id = $4)),
			(SELECT count(*) FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.stage = 'Closed won' AND d.closed_at >= $1 AND d.closed_at < $2
				AND ($3::uuid IS NULL OR l.team_id = $3) AND ($4::uuid IS NULL OR l.client_id = $4)),
			(SELECT coalesce(sum(coalesce(d.amount, 0)), 0)::float8 FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.stage = 'Closed won' AND d.closed_at >= $1 AND d.closed_at < $2
				AND ($3::uuid IS NULL OR l.team_id = $3) AND ($4::uuid IS NULL OR l.client_id = $4))`,
		from, to, nullID(team), nullID(client)).Scan(&calls, &reached, &appointments, &won, &value)
	return map[string]any{"calls": calls, "reached": reached, "appointments": appointments, "deals_won": won, "deals_value": value}, err
}

// agencyDay is today's start and end in the agency's time zone.
func agencyDay(ctx context.Context, tx pgx.Tx, now time.Time) (time.Time, time.Time, *time.Location) {
	var name string
	_ = tx.QueryRow(ctx, `SELECT timezone FROM orgs WHERE id = cw_org()`).Scan(&name)
	zone, err := time.LoadLocation(name)
	if err != nil {
		zone = time.UTC
	}
	local := now.In(zone)
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, zone)
	return start, start.AddDate(0, 0, 1), zone
}

// ownerOverview is GET /api/v1/overview (the owner and admins): what needs them today, then today's results.
func (s *server) ownerOverview(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the agency's overview; a team lead sees their team's.")
	}
	ctx := q.r.Context()
	members, err := s.rules.members(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	working, held := []string{}, []string{}
	for _, m := range members {
		if m.SuspendedAt == nil {
			working = append(working, m.UserID)
		} else {
			held = append(held, m.UserID)
		}
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var waiting, emails, alerts, approvals int
	// Work waiting to be handed on: leads of people suspended or no longer in the agency (D225, step 12).
	if err := tx.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM leads WHERE deleted_at IS NULL AND assignee_id IS NOT NULL AND NOT (assignee_id = ANY($1::uuid[]))),
			(SELECT count(*) FROM lead_emails WHERE waiting),
			(SELECT count(*) FROM access_alerts WHERE at > now() - interval '1 day'),
			(SELECT count(*) FROM projects WHERE approval_status = 'changes')`,
		uuidArray(working)).Scan(&waiting, &emails, &alerts, &approvals); err != nil {
		return err
	}
	overdue, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('team_id', l.team_id, 'overdue', count(*)) FROM tasks t JOIN leads l ON l.id = t.lead_id
		WHERE t.type = 'Callback' AND t.done_at IS NULL AND t.due_at < now() AND l.deleted_at IS NULL GROUP BY l.team_id ORDER BY count(*) DESC`)
	if err != nil {
		return err
	}
	from, to, zone := agencyDay(ctx, tx, s.now())
	today, err := totals(ctx, tx, from, to, "", "")
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{
		"needs_you": map[string]any{"work_to_hand_on": waiting, "people_held": len(held), "overdue_callbacks_by_team": overdue,
			"emails_waiting": emails, "access_alerts_today": alerts, "lists_with_client_changes": approvals},
		"today": today, "time_zone": zone.String()})
	return nil
}

// teamOverview is GET /api/v1/overview/teams/{id}: the team right now (overdue callbacks, unassigned leads, emails waiting), then today's
// results; for the team's leads and deputies, admins and the owner.
func (s *server) teamOverview(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) || !reviews(q, team) {
		return forbidden("A team's leads and deputies, admins and the owner see its overview.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var overdue, unassigned, emails int
	if err := tx.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE l.team_id = $1 AND t.type = 'Callback' AND t.done_at IS NULL AND t.due_at < now()),
			(SELECT count(*) FROM leads WHERE team_id = $1 AND assignee_id IS NULL AND deleted_at IS NULL AND archived_at IS NULL),
			(SELECT count(*) FROM lead_emails e JOIN leads l ON l.id = e.lead_id WHERE l.team_id = $1 AND e.waiting)`, team).Scan(&overdue, &unassigned, &emails); err != nil {
		return err
	}
	from, to, zone := agencyDay(ctx, tx, s.now())
	today, err := totals(ctx, tx, from, to, team, "")
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"team_id": team, "now": map[string]any{"overdue_callbacks": overdue, "unassigned_leads": unassigned, "emails_waiting": emails},
		"today": today, "time_zone": zone.String()})
	return nil
}

// ---- members' activity (D267) ----

// noteMemberDay keeps that a person worked in an agency today (once a day per person and agency).
func (s *server) noteMemberDay(ctx context.Context, org, user string) {
	day := s.now().UTC().Format("2006-01-02")
	key := org + "|" + user + "|" + day
	if _, ok := s.seenDays.Load(key); ok {
		return
	}
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO member_days (org_id, user_id, day) VALUES (cw_org(), $1, $2) ON CONFLICT DO NOTHING`, user, day); err == nil && tx.Commit(ctx) == nil {
		s.seenDays.Store(key, true)
	}
}

// membersActivity is GET /api/v1/overview/members (the owner and admins): each member's last active day and days active this month.
func (s *server) membersActivity(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see members' activity.")
	}
	ctx := q.r.Context()
	members, err := s.rules.members(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	out := []map[string]any{}
	month := time.Date(s.now().Year(), s.now().Month(), 1, 0, 0, 0, 0, time.UTC)
	for _, m := range members {
		var last *time.Time
		var days int
		if err := tx.QueryRow(ctx, `SELECT max(day)::timestamptz, count(*) FILTER (WHERE day >= $2) FROM member_days WHERE user_id = $1`, m.UserID, month).Scan(&last, &days); err != nil {
			return err
		}
		out = append(out, map[string]any{"user_id": m.UserID, "roles": nonNil(m.Roles), "suspended": m.SuspendedAt != nil, "last_active_day": last, "days_active_this_month": days})
	}
	writeJSON(q.w, 200, map[string]any{"members": out})
	return nil
}

// ---- scheduled reports (D227) ----

// nextReport is the start of the next period after t in the zone: next Monday, or the first of next month.
func nextReport(t time.Time, zone *time.Location, frequency string) time.Time {
	local := t.In(zone)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, zone)
	if frequency == "monthly" {
		return time.Date(local.Year(), local.Month()+1, 1, 0, 0, 0, 0, zone)
	}
	ahead := (8 - int(day.Weekday())) % 7
	if ahead == 0 {
		ahead = 7
	}
	return day.AddDate(0, 0, ahead)
}

func (s *server) listReportSchedules(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(r) FROM report_schedules r WHERE $1 OR r.created_by = $2 ORDER BY r.created_at`, manages(q.sc), q.sc.userID)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"schedules": rows})
	return nil
}

// addReportSchedule is POST /api/v1/reports/schedules {frequency, team_id, client_id, to_client}: the owner and admins for anything; a
// team's leads for their team, and to a client's people only for a client their team works for.
func (s *server) addReportSchedule(q *req) error {
	var body struct {
		Frequency string `json:"frequency"`
		TeamID    string `json:"team_id"`
		ClientID  string `json:"client_id"`
		ToClient  bool   `json:"to_client"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.Frequency != "weekly" && body.Frequency != "monthly" || (body.TeamID != "" && !validID(body.TeamID)) || (body.ClientID != "" && !validID(body.ClientID)) {
		return bad("frequency is weekly or monthly; team_id and client_id are ids.")
	}
	if body.ToClient && body.ClientID == "" {
		return bad("A report to a client's people names the client (client_id).")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !manages(q.sc) {
		if body.TeamID == "" || !slices.Contains(q.grant.ManagedTeamIDs, body.TeamID) {
			return forbidden("A team lead schedules reports for a team they lead (team_id).")
		}
		if body.ClientID != "" {
			var works bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM team_clients WHERE team_id = $1 AND client_id = $2)`, body.TeamID, body.ClientID).Scan(&works); err != nil || !works {
				return forbidden("That team does not work for this client.")
			}
		}
	}
	_, _, zone := agencyDay(ctx, tx, s.now())
	next := nextReport(s.now(), zone, body.Frequency)
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO report_schedules (org_id, created_by, frequency, team_id, client_id, to_client, next_at) VALUES (cw_org(), $1, $2, $3, $4, $5, $6) RETURNING id::text`,
		q.sc.userID, body.Frequency, nullID(body.TeamID), nullID(body.ClientID), body.ToClient, next).Scan(&id); err != nil {
		return err
	}
	if _, err := s.st.db.Exec(ctx, `INSERT INTO report_due (schedule_id, org_id, next_at) VALUES ($1, $2, $3)`, id, q.sc.orgID, next); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": id, "next_at": next})
	return nil
}

func (s *server) deleteReportSchedule(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM report_schedules WHERE id = $1 AND ($2 OR created_by = $3)`, nullID(q.r.PathValue("id")), manages(q.sc), q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("No such report of yours.")
	}
	if _, err := s.st.db.Exec(ctx, `DELETE FROM report_due WHERE schedule_id = $1`, q.r.PathValue("id")); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// reportMail sends one report email through the notification service (the only service that writes email).
type reportMail func(ctx context.Context, to string, data map[string]any) error

func (s *server) sendReportMail(ctx context.Context, to string, data map[string]any) error {
	if s.cfg.notifyMailURL == "" {
		return fmt.Errorf("NOTIFY_MAIL_URL is not set")
	}
	raw, _ := json.Marshal(map[string]any{"template": "report", "to": to, "data": data})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.notifyMailURL+"/v1/mail", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.notifyMailToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("the notification service answered %d", res.StatusCode)
	}
	return nil
}

// sendDueReports sends the reports whose time came: the last full week or month, in the agency's time zone.
func (s *server) sendDueReports(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `SELECT schedule_id::text, org_id::text FROM report_due WHERE next_at <= $1`, s.now())
	if err != nil {
		return err
	}
	type due struct{ id, org string }
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.org); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	rows.Close()
	for _, d := range list {
		if err := s.sendReport(ctx, d.org, d.id); err != nil {
			log.Printf("WARN report %s: %v", d.id, err)
		}
	}
	return nil
}

func (s *server) sendReport(ctx context.Context, org, id string) error {
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var frequency, by string
	var team, client *string
	var toClient bool
	var next time.Time
	err = tx.QueryRow(ctx, `SELECT frequency, created_by::text, team_id::text, client_id::text, to_client, next_at FROM report_schedules WHERE id = $1`, id).
		Scan(&frequency, &by, &team, &client, &toClient, &next)
	if err != nil {
		_, _ = s.st.db.Exec(ctx, `DELETE FROM report_due WHERE schedule_id = $1`, id)
		return nil
	}
	_, _, zone := agencyDay(ctx, tx, s.now())
	start := next.In(zone).AddDate(0, 0, -7)
	period := "Week of " + start.Format("2 January 2006")
	if frequency == "monthly" {
		start = next.In(zone).AddDate(0, -1, 0)
		period = start.Format("January 2006")
	}
	t, err := totals(ctx, tx, start, next, deref(team), deref(client))
	if err != nil {
		return err
	}
	var agency string
	_ = tx.QueryRow(ctx, `SELECT name FROM orgs WHERE id = cw_org()`).Scan(&agency)
	lines := []map[string]any{{"label": "Calls", "value": t["calls"]}, {"label": "Reached", "value": t["reached"]},
		{"label": "Appointments set", "value": t["appointments"]}, {"label": "Deals won", "value": t["deals_won"]},
		{"label": "Value of deals won", "value": t["deals_value"]}}
	// Who receives it: the one who made it, or the client's people; only their email address leaves here, with totals.
	var recipients []string
	if toClient && client != nil {
		rows, err := tx.Query(ctx, `SELECT user_id::text FROM client_members WHERE client_id = $1`, *client)
		if err != nil {
			return err
		}
		recipients, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
	} else {
		recipients = []string{by}
	}
	link := s.cfg.appURL + "/?org=" + org + "&view=reports"
	for _, user := range recipients {
		var email string
		if err := s.st.db.QueryRow(ctx, `SELECT email FROM people WHERE user_id = $1`, user).Scan(&email); err != nil || !strings.Contains(email, "@") {
			continue
		}
		send := s.reportMailer
		if send == nil {
			send = s.sendReportMail
		}
		if err := send(ctx, email, map[string]any{"agency": agency, "period": period, "lines": lines, "link": link}); err != nil {
			return err
		}
	}
	following := nextReport(next.Add(time.Hour), zone, frequency)
	if _, err := tx.Exec(ctx, `UPDATE report_schedules SET last_sent_at = now(), next_at = $2 WHERE id = $1`, id, following); err != nil {
		return err
	}
	if _, err := s.st.db.Exec(ctx, `UPDATE report_due SET next_at = $2 WHERE schedule_id = $1`, id, following); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

