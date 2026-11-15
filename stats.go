package main

// Team monitoring: what each person did over a range of days (calls, connects, qualified leads, callbacks, bad numbers, tasks,
// notes) and what they hold now, plus their recent activity. Who sees whom follows the team tree: the agency owner (and anyone
// with workspace-wide records) sees everyone, a team manager sees themself and the callers and closers of the teams they run,
// everyone else sees themself.
//
// The numbers are counted from the records themselves when asked (call_events, tasks, notes, audit_events, leads), over at most
// 93 days, with indexes made for it (0018). Days are the workspace's own (orgs.timezone). Calls brought in from another
// dialer's history are not counted as anyone's work here.

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"time"
)

const maxStatsDays = 93

// watched is the people this person may monitor, in the order shown, with their name, roles and team.
type watched struct {
	UserID    string   `json:"user_id"`
	Name      string   `json:"name"`
	Roles     []string `json:"roles"`
	TeamID    string   `json:"team_id"`
	TeamName  string   `json:"team_name"`
	Suspended bool     `json:"suspended"`
}

// whoMayIWatch lists the people the asking person may monitor (never clients).
func (s *server) whoMayIWatch(ctx context.Context, q *req) ([]watched, error) {
	members, err := s.rules.members(ctx, q.sc.orgID)
	if err != nil {
		return nil, err
	}
	teams, err := s.rules.teams(ctx, q.sc.orgID)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, t := range teams {
		names[t.TeamID] = t.Name
	}
	everyone := slices.Contains(q.sc.scopes, "organization")
	managed := q.grant.ManagedTeamIDs
	out := []watched{}
	for _, m := range members {
		if len(m.Roles) == 0 || (len(m.Roles) == 1 && m.Roles[0] == "client") {
			continue
		}
		team := ""
		if len(m.TeamIDs) == 1 {
			team = m.TeamIDs[0]
		}
		if !everyone && m.UserID != q.sc.userID && !(team != "" && slices.Contains(managed, team)) {
			continue
		}
		out = append(out, watched{UserID: m.UserID, Roles: m.Roles, TeamID: team, TeamName: names[team], Suspended: m.SuspendedAt != nil})
	}
	ids := make([]string, 0, len(out))
	for _, w := range out {
		ids = append(ids, w.UserID)
	}
	if len(ids) > 0 {
		rows, err := s.st.db.Query(ctx, `SELECT user_id::text, name FROM people WHERE user_id = ANY($1::uuid[])`, ids)
		if err != nil {
			return nil, err
		}
		found := map[string]string{}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = name
		}
		rows.Close()
		for i := range out {
			if out[i].Name = found[out[i].UserID]; out[i].Name == "" {
				out[i].Name = "Member"
			}
		}
	}
	return out, nil
}

// statsRange reads from and to (YYYY-MM-DD, both days included); the default is the last seven days.
func statsRange(r *http.Request, today time.Time) (string, string, error) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if to == "" {
		to = today.Format(time.DateOnly)
	}
	end, err := time.Parse(time.DateOnly, to)
	if err != nil {
		return "", "", bad("to is a day: YYYY-MM-DD.")
	}
	if from == "" {
		from = end.AddDate(0, 0, -6).Format(time.DateOnly)
	}
	start, err := time.Parse(time.DateOnly, from)
	if err != nil {
		return "", "", bad("from is a day: YYYY-MM-DD.")
	}
	if start.After(end) {
		return "", "", bad("from comes before to.")
	}
	if end.Sub(start) > (maxStatsDays-1)*24*time.Hour {
		return "", "", bad("Choose at most 93 days.")
	}
	return from, to, nil
}

// memberStats answers GET /api/v1/stats/members?from&to: one row of numbers per person this person may monitor, and their
// calls per day for a chart.
func (s *server) memberStats(q *req) error {
	ctx := q.r.Context()
	from, to, err := statsRange(q.r, s.now())
	if err != nil {
		return err
	}
	people, err := s.whoMayIWatch(ctx, q)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(people))
	for _, p := range people {
		ids = append(ids, p.UserID)
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	totals, err := queryJSON(ctx, tx, `
		WITH tz AS (SELECT coalesce((SELECT timezone FROM orgs WHERE id = cw_org()), 'UTC') AS name),
		bounds AS (SELECT ($2::date)::timestamp AT TIME ZONE tz.name AS a, ($3::date + 1)::timestamp AT TIME ZONE tz.name AS b FROM tz),
		who AS (SELECT unnest($1::uuid[]) AS u),
		calls AS (
			SELECT c.agent_id AS u, count(*) AS dials,
				count(*) FILTER (WHERE c.meaning = 'reached') AS connects,
				count(*) FILTER (WHERE c.meaning IN ('wrong_number', 'wrong_person', 'disconnected')) AS bad_numbers,
				count(*) FILTER (WHERE c.meaning = 'do_not_call') AS do_not_call,
				count(*) FILTER (WHERE c.outcome = 'Callback') AS callbacks,
				count(DISTINCT c.lead_id) AS leads_worked, max(c.occurred_at) AS last_call
			FROM call_events c, bounds
			WHERE c.org_id = cw_org() AND c.agent_id = ANY($1::uuid[]) AND c.import_job_id IS NULL AND c.occurred_at >= bounds.a AND c.occurred_at < bounds.b
			GROUP BY c.agent_id),
		qualified AS (
			SELECT e.actor_id AS u, count(DISTINCT e.entity_id) AS qualified
			FROM audit_events e, bounds
			WHERE e.org_id = cw_org() AND e.actor_id = ANY($1::uuid[]) AND e.entity = 'lead' AND e.at >= bounds.a AND e.at < bounds.b
			  AND e.after->>'stage' = 'Qualified' AND coalesce(e.before->>'stage', '') <> 'Qualified'
			GROUP BY e.actor_id),
		done AS (
			SELECT t.assignee_id AS u, count(*) AS tasks_done
			FROM tasks t, bounds
			WHERE t.org_id = cw_org() AND t.assignee_id = ANY($1::uuid[]) AND t.done_at >= bounds.a AND t.done_at < bounds.b
			GROUP BY t.assignee_id),
		open AS (
			SELECT t.assignee_id AS u, count(*) AS tasks_open, count(*) FILTER (WHERE t.due_at < now()) AS tasks_overdue
			FROM tasks t WHERE t.org_id = cw_org() AND t.assignee_id = ANY($1::uuid[]) AND t.done_at IS NULL
			GROUP BY t.assignee_id),
		written AS (
			SELECT n.author_id AS u, count(*) AS notes, max(n.occurred_at) AS last_note
			FROM notes n, bounds
			WHERE n.org_id = cw_org() AND n.author_id = ANY($1::uuid[]) AND n.occurred_at >= bounds.a AND n.occurred_at < bounds.b
			GROUP BY n.author_id),
		held AS (
			SELECT l.assignee_id AS u, count(*) AS leads_held
			FROM leads l WHERE l.org_id = cw_org() AND l.assignee_id = ANY($1::uuid[]) AND l.deleted_at IS NULL AND l.archived_at IS NULL
			GROUP BY l.assignee_id),
		last_seen AS (
			SELECT e.actor_id AS u, max(e.at) AS last_active
			FROM audit_events e WHERE e.org_id = cw_org() AND e.actor_id = ANY($1::uuid[])
			GROUP BY e.actor_id)
		SELECT jsonb_build_object('user_id', who.u,
			'dials', coalesce(calls.dials, 0), 'connects', coalesce(calls.connects, 0), 'bad_numbers', coalesce(calls.bad_numbers, 0),
			'do_not_call', coalesce(calls.do_not_call, 0), 'callbacks', coalesce(calls.callbacks, 0), 'leads_worked', coalesce(calls.leads_worked, 0),
			'qualified', coalesce(qualified.qualified, 0), 'tasks_done', coalesce(done.tasks_done, 0), 'tasks_open', coalesce(open.tasks_open, 0),
			'tasks_overdue', coalesce(open.tasks_overdue, 0), 'notes', coalesce(written.notes, 0), 'leads_held', coalesce(held.leads_held, 0),
			'last_active', greatest(last_seen.last_active, calls.last_call, written.last_note))
		FROM who LEFT JOIN calls ON calls.u = who.u LEFT JOIN qualified ON qualified.u = who.u LEFT JOIN done ON done.u = who.u
			LEFT JOIN open ON open.u = who.u LEFT JOIN written ON written.u = who.u LEFT JOIN held ON held.u = who.u
			LEFT JOIN last_seen ON last_seen.u = who.u`, ids, from, to)
	if err != nil {
		return err
	}
	daily, err := queryJSON(ctx, tx, `
		WITH tz AS (SELECT coalesce((SELECT timezone FROM orgs WHERE id = cw_org()), 'UTC') AS name),
		per_day AS (
			SELECT to_char((c.occurred_at AT TIME ZONE tz.name)::date, 'YYYY-MM-DD') AS day, c.agent_id,
				count(*) AS dials, count(*) FILTER (WHERE c.meaning = 'reached') AS connects
			FROM call_events c, tz
			WHERE c.org_id = cw_org() AND c.agent_id = ANY($1::uuid[]) AND c.import_job_id IS NULL
			  AND c.occurred_at >= ($2::date)::timestamp AT TIME ZONE tz.name AND c.occurred_at < ($3::date + 1)::timestamp AT TIME ZONE tz.name
			GROUP BY 1, 2)
		SELECT jsonb_build_object('day', day, 'user_id', agent_id, 'dials', dials, 'connects', connects) FROM per_day ORDER BY day`, ids, from, to)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"from": from, "to": to, "people": people, "totals": totals, "daily": daily})
	return nil
}

// memberActivity answers GET /api/v1/stats/members/{user}/activity?before=<id>: what that person did lately, newest first.
func (s *server) memberActivity(q *req) error {
	ctx := q.r.Context()
	user := q.r.PathValue("user")
	if !validID(user) {
		return bad("Choose a person.")
	}
	people, err := s.whoMayIWatch(ctx, q)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(people, func(w watched) bool { return w.UserID == user }) {
		return forbidden("You can follow only the people you manage.")
	}
	before, _ := strconv.ParseInt(q.r.URL.Query().Get("before"), 10, 64)
	if before <= 0 {
		before = 1 << 62
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	events, err := queryJSON(ctx, tx, `
		SELECT jsonb_build_object('id', e.id, 'at', e.at, 'action', e.action, 'entity', e.entity, 'entity_id', e.entity_id,
			'lead_name', l.name, 'stage', e.after->>'stage', 'outcome', c.outcome)
		FROM audit_events e
		LEFT JOIN leads l ON e.entity = 'lead' AND l.id = e.entity_id AND l.org_id = cw_org()
		LEFT JOIN call_events c ON e.entity = 'call' AND c.id = e.entity_id AND c.org_id = cw_org()
		WHERE e.org_id = cw_org() AND e.actor_id = $1::uuid AND e.id < $2
		ORDER BY e.id DESC LIMIT 50`, user, before)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"events": events})
	return nil
}
