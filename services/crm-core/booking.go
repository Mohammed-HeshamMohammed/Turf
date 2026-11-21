package crm

// Build step 28, part A (migrations/0035_pipeline_booking_credit.sql): the agency's and a client's deal stages (D154), closers' hours
// and the range their managers allow (D156), free slots and booking by the team's callers (D155), and who is credited with a won deal
// (D157, with ops.go's dealUpdate).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) bookingRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/pipeline", s.member(s.pipeline))
	mux.Handle("PUT /api/v1/pipeline", s.member(s.pipeline))
	mux.Handle("GET /api/v1/closers/{user}/hours", s.member(s.closerHours))
	mux.Handle("PUT /api/v1/closers/{user}/hours", s.member(s.closerHours))
	mux.Handle("PUT /api/v1/closers/{user}/limit", s.member(s.closerLimit))
	mux.Handle("GET /api/v1/teams/{id}/slots", s.member(s.teamSlots))
	mux.Handle("POST /api/v1/appointments", s.member(s.bookAppointment))
	mux.Handle("POST /api/v1/appointments/{id}/cancel", s.member(s.cancelAppointment))
	mux.Handle("GET /api/v1/appointments", s.member(s.listAppointments))
}

// ---- stages (D154) ----

var defaultOpenStages = []string{"Qualified", "Appointment", "Offer preparation", "Offer sent", "Negotiation", "Under contract"}

// stagesFor is a deal's stages for a client's work: the client's own, else the agency's, else the defaults; always ending in the two
// closed stages.
func stagesFor(ctx context.Context, tx pgx.Tx, client string) ([]string, error) {
	var open []string
	err := tx.QueryRow(ctx, `SELECT stages FROM deal_stages WHERE org_id = cw_org() AND (client_id = $1::uuid OR client_id IS NULL)
		ORDER BY client_id NULLS LAST LIMIT 1`, nullID(client)).Scan(&open)
	if errors.Is(err, pgx.ErrNoRows) {
		open, err = defaultOpenStages, nil
	}
	return append(slices.Clone(open), "Closed won", "Closed lost"), err
}

// pipeline is GET /api/v1/pipeline?client_id= (anyone in the agency) and PUT {client_id, stages} (the owner or an admin; stages null for
// a client goes back to the agency's).
func (s *server) pipeline(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	client := q.r.URL.Query().Get("client_id")
	if q.r.Method == http.MethodPut {
		if !manages(q.sc) {
			return forbidden("The owner or an admin sets the pipeline's stages.")
		}
		var body struct {
			ClientID string   `json:"client_id"`
			Stages   []string `json:"stages"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		client = body.ClientID
		if client != "" && !validID(client) {
			return bad("client_id is an id.")
		}
		if body.Stages == nil {
			if _, err := tx.Exec(ctx, `DELETE FROM deal_stages WHERE client_id IS NOT DISTINCT FROM $1::uuid`, nullID(client)); err != nil {
				return err
			}
		} else {
			seen := map[string]bool{}
			for i, st := range body.Stages {
				st = strings.TrimSpace(st)
				if st == "" || len(st) > 40 || strings.HasPrefix(strings.ToLower(st), "closed") || seen[strings.ToLower(st)] {
					return bad("Name each open stage once, up to 40 characters; \"Closed won\" and \"Closed lost\" are always last.")
				}
				seen[strings.ToLower(st)], body.Stages[i] = true, st
			}
			if len(body.Stages) == 0 || len(body.Stages) > 15 {
				return bad("A pipeline has 1 to 15 open stages.")
			}
			if _, err := tx.Exec(ctx, `DELETE FROM deal_stages WHERE client_id IS NOT DISTINCT FROM $1::uuid`, nullID(client)); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO deal_stages (org_id, client_id, stages, updated_by) VALUES (cw_org(), $1, $2, $3)`, nullID(client), body.Stages, q.sc.userID); err != nil {
				return err
			}
		}
	}
	stages, err := stagesFor(ctx, tx, client)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"client_id": nullID(client), "stages": stages})
	return nil
}

// ---- closers' hours (D156) ----

// setsHoursFor is whether the person sets a closer's hours: the closer, a lead of one of their teams, an admin or the owner. limits is
// the same without the closer.
func (s *server) closerManagers(ctx context.Context, q *req, closer string) (sets, limits bool, err error) {
	if manages(q.sc) {
		return true, true, nil
	}
	members, err := s.rules.members(ctx, q.sc.orgID)
	if err != nil {
		return false, false, err
	}
	for _, m := range members {
		if m.UserID == closer {
			for _, team := range m.TeamIDs {
				if slices.Contains(q.grant.ManagedTeamIDs, team) {
					return true, true, nil
				}
			}
		}
	}
	return q.sc.userID == closer, false, nil
}

func parseClock(v string) (int, bool) {
	t, err := time.Parse("15:04", v)
	if v == "24:00" {
		return 1440, true
	}
	if err != nil {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

func clock(m int) string { return fmt.Sprintf("%02d:%02d", m/60, m%60) }

// closerHours is GET /api/v1/closers/{user}/hours (anyone in the agency) and PUT {days: [{weekday, from, until}]}: the closer or their
// managers set the week; each day must stay inside the range the managers set.
func (s *server) closerHours(q *req) error {
	closer := q.r.PathValue("user")
	if !validID(closer) || q.sc.external() {
		return notFound("No such closer.")
	}
	ctx := q.r.Context()
	if q.r.Method == http.MethodPut {
		sets, _, err := s.closerManagers(ctx, q, closer)
		if err != nil {
			return err
		}
		if !sets {
			return forbidden("A closer sets their own hours, or their team's leads, an admin or the owner.")
		}
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	limitFrom, limitUntil := 0, 1440
	_ = tx.QueryRow(ctx, `SELECT from_minute, until_minute FROM closer_limits WHERE user_id = $1`, closer).Scan(&limitFrom, &limitUntil)
	if q.r.Method == http.MethodPut {
		var body struct {
			Days []struct {
				Weekday int    `json:"weekday"`
				From    string `json:"from"`
				Until   string `json:"until"`
			} `json:"days"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM closer_hours WHERE user_id = $1`, closer); err != nil {
			return err
		}
		for _, d := range body.Days {
			from, ok1 := parseClock(d.From)
			until, ok2 := parseClock(d.Until)
			if d.Weekday < 0 || d.Weekday > 6 || !ok1 || !ok2 || until <= from {
				return bad("Each day is a weekday (0 Sunday to 6 Saturday) with from and until like 09:00 and 17:00.")
			}
			if from < limitFrom || until > limitUntil {
				return bad("Keep hours between " + clock(limitFrom) + " and " + clock(limitUntil) + ", the range your managers set.")
			}
			if _, err := tx.Exec(ctx, `INSERT INTO closer_hours (org_id, user_id, weekday, from_minute, until_minute, set_by) VALUES (cw_org(), $1, $2, $3, $4, $5)
				ON CONFLICT (org_id, user_id, weekday) DO UPDATE SET from_minute = EXCLUDED.from_minute, until_minute = EXCLUDED.until_minute, set_by = EXCLUDED.set_by`,
				closer, d.Weekday, from, until, q.sc.userID); err != nil {
				return err
			}
		}
	}
	days, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('weekday', weekday, 'from', to_char(make_time(from_minute / 60, from_minute % 60, 0), 'HH24:MI'),
		'until', CASE WHEN until_minute = 1440 THEN '24:00' ELSE to_char(make_time(until_minute / 60, until_minute % 60, 0), 'HH24:MI') END)
		FROM closer_hours WHERE user_id = $1 ORDER BY weekday`, closer)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"user_id": closer, "days": days, "limit": map[string]any{"from": clock(limitFrom), "until": clock(limitUntil)}})
	return nil
}

// closerLimit is PUT /api/v1/closers/{user}/limit {from, until}: the closer's managers limit the range of their hours; hours outside it
// are cut to it. from and until empty remove the limit.
func (s *server) closerLimit(q *req) error {
	closer := q.r.PathValue("user")
	if !validID(closer) {
		return notFound("No such closer.")
	}
	ctx := q.r.Context()
	_, limits, err := s.closerManagers(ctx, q, closer)
	if err != nil {
		return err
	}
	if !limits {
		return forbidden("A closer's team leads, an admin or the owner limit their hours.")
	}
	var body struct {
		From  string `json:"from"`
		Until string `json:"until"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if body.From == "" && body.Until == "" {
		_, err = tx.Exec(ctx, `DELETE FROM closer_limits WHERE user_id = $1`, closer)
	} else {
		from, ok1 := parseClock(body.From)
		until, ok2 := parseClock(body.Until)
		if !ok1 || !ok2 || until <= from {
			return bad("from and until are times like 09:00 and 18:00.")
		}
		if _, err = tx.Exec(ctx, `INSERT INTO closer_limits (org_id, user_id, from_minute, until_minute, set_by) VALUES (cw_org(), $1, $2, $3, $4)
			ON CONFLICT (org_id, user_id) DO UPDATE SET from_minute = EXCLUDED.from_minute, until_minute = EXCLUDED.until_minute, set_by = EXCLUDED.set_by, set_at = now()`,
			closer, from, until, q.sc.userID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM closer_hours WHERE user_id = $1 AND (until_minute <= $2 OR from_minute >= $3)`, closer, from, until); err == nil {
			_, err = tx.Exec(ctx, `UPDATE closer_hours SET from_minute = greatest(from_minute, $2), until_minute = least(until_minute, $3) WHERE user_id = $1`, closer, from, until)
		}
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

// ---- slots and booking (D155) ----

type slot struct {
	CloserID string    `json:"closer_id"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
}

// closersOf is the team's closers (members with the closer role in it).
func (s *server) closersOf(ctx context.Context, org, team string) ([]string, error) {
	members, err := s.rules.members(ctx, org)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range members {
		if slices.Contains(m.TeamIDs, team) && slices.Contains(m.Roles, "closer") && m.SuspendedAt == nil {
			out = append(out, m.UserID)
		}
	}
	return out, nil
}

// freeSlots is each closer's free slots from now for some days: their hours in the agency's time zone, cut into the agency's slot
// length, without what is booked or past.
func freeSlots(ctx context.Context, tx pgx.Tx, closers []string, now time.Time, days int, elsewhere map[string][][2]time.Time) ([]slot, error) {
	var zoneName string
	var length int
	if err := tx.QueryRow(ctx, `SELECT timezone, slot_minutes FROM orgs WHERE id = cw_org()`).Scan(&zoneName, &length); err != nil {
		return nil, err
	}
	zone, err := time.LoadLocation(zoneName)
	if err != nil {
		zone = time.UTC
	}
	out := []slot{}
	for _, closer := range closers {
		hours := map[int][2]int{}
		rows, err := tx.Query(ctx, `SELECT weekday, from_minute, until_minute FROM closer_hours WHERE user_id = $1`, closer)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var wd, from, until int
			if err := rows.Scan(&wd, &from, &until); err != nil {
				rows.Close()
				return nil, err
			}
			hours[wd] = [2]int{from, until}
		}
		rows.Close()
		busy := append([][2]time.Time{}, elsewhere[closer]...) // busy on their Google Calendar (D158)
		rows, err = tx.Query(ctx, `SELECT starts_at, ends_at FROM appointments WHERE closer_id = $1 AND status = 'booked' AND ends_at > $2`, closer, now)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var a, b time.Time
			if err := rows.Scan(&a, &b); err != nil {
				rows.Close()
				return nil, err
			}
			busy = append(busy, [2]time.Time{a, b})
		}
		rows.Close()
		local := now.In(zone)
		for d := 0; d < days; d++ {
			day := time.Date(local.Year(), local.Month(), local.Day()+d, 0, 0, 0, 0, zone)
			h, ok := hours[int(day.Weekday())]
			if !ok {
				continue
			}
			for m := h[0]; m+length <= h[1]; m += length {
				start := day.Add(time.Duration(m) * time.Minute)
				end := start.Add(time.Duration(length) * time.Minute)
				if !start.After(now) || slices.ContainsFunc(busy, func(b [2]time.Time) bool { return start.Before(b[1]) && b[0].Before(end) }) {
					continue
				}
				out = append(out, slot{CloserID: closer, StartsAt: start, EndsAt: end})
			}
		}
	}
	return out, nil
}

// teamSlots is GET /api/v1/teams/{id}/slots?days=: the team's closers' free slots, for anyone in the team.
func (s *server) teamSlots(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) || !inTeam(q.sc, q.grant, team) {
		return forbidden("This is not one of your teams.")
	}
	days := atoiOr(q.r.URL.Query().Get("days"), 7)
	if days < 1 || days > 31 {
		days = 7
	}
	ctx := q.r.Context()
	closers, err := s.closersOf(ctx, q.sc.orgID, team)
	if err != nil {
		return err
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	slots, err := freeSlots(ctx, tx, closers, s.now(), days, s.googleBusy(ctx, closers, s.now(), s.now().AddDate(0, 0, days+1)))
	if err != nil {
		return err
	}
	names := map[string]string{}
	rows, err := s.st.db.Query(ctx, `SELECT user_id::text, coalesce(nullif(name, ''), email) FROM people WHERE user_id = ANY($1::uuid[])`, nonNil(closers))
	if err == nil {
		for rows.Next() {
			var id, name string
			if rows.Scan(&id, &name) == nil {
				names[id] = name
			}
		}
		rows.Close()
	}
	writeJSON(q.w, 200, map[string]any{"team_id": team, "slots": slots, "closers": names})
	return nil
}

// bookAppointment is POST /api/v1/appointments {lead_id, closer_id, starts_at}: a caller who works the lead books a free slot of a
// closer of the lead's team. It becomes an appointment task on the closer's list, which tells them (D155).
func (s *server) bookAppointment(q *req) error {
	var body struct {
		LeadID   string    `json:"lead_id"`
		CloserID string    `json:"closer_id"`
		StartsAt time.Time `json:"starts_at"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if !validID(body.LeadID) || !validID(body.CloserID) || body.StartsAt.IsZero() {
		return bad("Choose the lead, the closer and the slot's start (lead_id, closer_id, starts_at).")
	}
	if !q.sc.can("call") || q.sc.external() {
		return forbidden("Your role does not book appointments.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx, op: op{ID: newUUIDString()}}
	lead, err := r.lead(body.LeadID, true)
	if err != nil {
		return err
	}
	if lead == nil || !canEditLead(q.sc, lead) {
		return notFound("The lead was not found, or is not one you work.")
	}
	team := asString(lead["team_id"])
	if team == "" {
		return conflictErr("The lead has no team, so it has no closers.")
	}
	closers, err := s.closersOf(ctx, q.sc.orgID, team)
	if err != nil {
		return err
	}
	if !slices.Contains(closers, body.CloserID) {
		return bad("That person is not a closer of the lead's team.")
	}
	// The closer's appointments are booked one at a time, so two callers cannot take the same slot.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "closer:"+body.CloserID); err != nil {
		return err
	}
	free, err := freeSlots(ctx, tx, []string{body.CloserID}, s.now(), 62, s.googleBusy(ctx, []string{body.CloserID}, body.StartsAt.Add(-time.Hour), body.StartsAt.Add(3*time.Hour)))
	if err != nil {
		return err
	}
	i := slices.IndexFunc(free, func(f slot) bool { return f.StartsAt.Equal(body.StartsAt) })
	if i < 0 {
		return conflictErr("That slot is not free any more. Choose another.")
	}
	var taskID string
	if err := tx.QueryRow(ctx, `INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, priority, due_at) VALUES (cw_org(), $1, $2, $3, 'Appointment', 'High', $4) RETURNING id::text`,
		body.LeadID, body.CloserID, "Appointment with "+asString(lead["name"]), body.StartsAt).Scan(&taskID); err != nil {
		return err
	}
	rows, err := queryJSON(ctx, tx, `INSERT INTO appointments (org_id, lead_id, closer_id, booked_by, team_id, client_id, task_id, starts_at, ends_at)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING to_jsonb(appointments.*)`, body.LeadID, body.CloserID, q.sc.userID, team,
		nullID(asString(lead["client_id"])), taskID, free[i].StartsAt, free[i].EndsAt)
	if err != nil {
		return err
	}
	if err := r.record(change{entity: "task", kind: "task.created", id: taskID, leadID: body.LeadID}); err != nil {
		return err
	}
	var made struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rows[0], &made)
	// The owner's event address hears "a lead booked", with ids only (step 33, D234).
	if err := emitEvent(ctx, tx, s, "lead.booked", made.ID, body.LeadID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// On the closer's Google Calendar when they connected it (D155, D158).
	s.addEvent(ctx, q.sc.orgID, made.ID, body.CloserID, body.LeadID, free[i].StartsAt, free[i].EndsAt)
	writeJSON(q.w, 200, rows[0])
	return nil
}

// cancelAppointment is POST /api/v1/appointments/{id}/cancel: whoever booked it, the closer, or their managers; its task goes too.
func (s *server) cancelAppointment(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such appointment.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lead, closer, booker, team string
	var task *string
	err = tx.QueryRow(ctx, `SELECT lead_id::text, closer_id::text, booked_by::text, coalesce(team_id::text, ''), task_id::text FROM appointments
		WHERE id = $1 AND status = 'booked' FOR UPDATE`, id).Scan(&lead, &closer, &booker, &team, &task)
	if err != nil {
		return notFound("No booked appointment under that id.")
	}
	if q.sc.userID != closer && q.sc.userID != booker && !runsTeam(q.sc, q.grant, team) {
		return forbidden("Whoever booked it, the closer or their team's leads cancel an appointment.")
	}
	if _, err := tx.Exec(ctx, `UPDATE appointments SET status = 'cancelled' WHERE id = $1`, id); err != nil {
		return err
	}
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx, op: op{ID: newUUIDString()}}
	if task != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE id = $1`, *task); err != nil {
			return err
		}
		if err := r.record(change{entity: "task", kind: "task.deleted", id: *task, leadID: lead, deleted: true}); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if err := s.removeEvents(ctx, `appointment_id = $1`, id); err != nil {
		log.Printf("WARN google event of appointment %s: %v", id, err)
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// listAppointments is GET /api/v1/appointments?lead_id=: a lead's appointments, or the person's own (booked by them or with them).
func (s *server) listAppointments(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var rows any
	if lead := q.r.URL.Query().Get("lead_id"); lead != "" {
		r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx}
		if l, err := r.lead(lead, false); err != nil || l == nil {
			return notFound("No such lead.")
		}
		rows, err = queryJSON(ctx, tx, `SELECT to_jsonb(a.*) FROM appointments a WHERE a.lead_id = $1 ORDER BY a.starts_at`, lead)
		if err != nil {
			return err
		}
	} else {
		if rows, err = queryJSON(ctx, tx, `SELECT to_jsonb(a.*) FROM appointments a WHERE (a.closer_id = $1 OR a.booked_by = $1) AND a.ends_at > now() - interval '1 day'
			ORDER BY a.starts_at LIMIT 500`, q.sc.userID); err != nil {
			return err
		}
	}
	writeJSON(q.w, 200, map[string]any{"appointments": rows})
	return nil
}

// creditDeal records who won a deal (D157) and closes its lead (D283), or takes both back when the deal leaves "Closed won".
func (r *run) creditDeal(deal map[string]any, won bool) error {
	id, lead := asString(deal["id"]), asString(deal["lead_id"])
	if !won {
		return r.exec(`DELETE FROM deal_credits WHERE deal_id = $1`, id)
	}
	if err := r.exec(`INSERT INTO deal_credits (org_id, deal_id, user_id, role, team_id, client_id)
		SELECT cw_org(), $1, $2, 'closer', l.team_id, l.client_id FROM leads l WHERE l.id = $3
		ON CONFLICT (deal_id, role) DO UPDATE SET user_id = EXCLUDED.user_id, at = now()`, id, r.sc.userID, lead); err != nil {
		return err
	}
	// The caller who set it: who booked its latest appointment, else who logged its latest "Transfer".
	if err := r.exec(`INSERT INTO deal_credits (org_id, deal_id, user_id, role, team_id, client_id)
		SELECT cw_org(), $1, c.who, 'caller', l.team_id, l.client_id FROM leads l,
			LATERAL (SELECT coalesce(
				(SELECT booked_by FROM appointments WHERE lead_id = l.id AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1),
				(SELECT agent_id FROM call_events WHERE lead_id = l.id AND outcome = 'Transfer' AND agent_id IS NOT NULL ORDER BY occurred_at DESC LIMIT 1)) AS who) c
		WHERE l.id = $2 AND c.who IS NOT NULL AND c.who <> $3
		ON CONFLICT (deal_id, role) DO UPDATE SET user_id = EXCLUDED.user_id, at = now()`, id, lead, r.sc.userID); err != nil {
		return err
	}
	// The owner's event address hears "a deal won", with ids only (step 33, D234).
	if err := emitEvent(r.ctx, r.tx, r.s, "deal.won", id, lead); err != nil {
		return err
	}
	// The won lead leaves the calling queues; follow-ups are tasks someone creates (D283).
	if err := r.exec(`UPDATE leads SET stage = 'Closed', verdict = 'Won', next_action = '', next_action_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`, lead); err != nil {
		return err
	}
	return r.record(change{entity: "lead", kind: "lead.updated", id: lead, leadID: lead})
}

func conflictErr(message string) error { return &apiError{http.StatusConflict, "conflict", message} }
