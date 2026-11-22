package telnyx

// Working hours (D79), templates (D210), scheduled texts (D211) and one message to many leads (D212).

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	nilTeam = "00000000-0000-0000-0000-000000000000"
	// A lead is texted only between these local hours (the agency's time zone; the lead's own once leads carry one).
	textFromHour, textUntilHour = 8, 21
	bulkMax                     = 500
)

var dayKeys = []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// workingHours is an agency's or a team's week: when nil, always working.
type workingHours struct {
	zone *time.Location
	days map[string][2]int // day -> opening and closing minute of the day
}

func parseHours(zone string, raw []byte) (*workingHours, error) {
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, bad("Choose a time zone like America/Chicago.")
	}
	var days map[string][]string
	if err := json.Unmarshal(raw, &days); err != nil {
		return nil, bad("Send the days as {\"mon\": [\"09:00\", \"17:00\"]}.")
	}
	h := &workingHours{zone: loc, days: map[string][2]int{}}
	for day, span := range days {
		if !slices.Contains(dayKeys, day) || len(span) != 2 {
			return nil, bad("Each day is mon to sun, with an opening and a closing time.")
		}
		open, err1 := time.Parse("15:04", span[0])
		shut, err2 := time.Parse("15:04", span[1])
		if err1 != nil || err2 != nil || !shut.After(open) {
			return nil, bad("Times are HH:MM, closing after opening.")
		}
		h.days[day] = [2]int{open.Hour()*60 + open.Minute(), shut.Hour()*60 + shut.Minute()}
	}
	return h, nil
}

func (h *workingHours) open(t time.Time) bool {
	if h == nil {
		return true
	}
	local := t.In(h.zone)
	span, ok := h.days[dayKeys[local.Weekday()]]
	minute := local.Hour()*60 + local.Minute()
	return ok && minute >= span[0] && minute < span[1]
}

// deadline is when `wait` of working time has passed since `from`: a text that came in at night waits from the morning (D79).
func (h *workingHours) deadline(from time.Time, wait time.Duration) time.Time {
	if h == nil {
		return from.Add(wait)
	}
	t, left := from, wait
	for limit := from.Add(8 * 24 * time.Hour); left > 0 && t.Before(limit); t = t.Add(time.Minute) {
		if h.open(t) {
			left -= time.Minute
		}
	}
	return t
}

// hoursFor is the team's hours, or the agency's, or nil (always working).
func (s *server) hoursFor(ctx context.Context, org string, team *string) (*workingHours, error) {
	var zone string
	var days []byte
	err := s.st.db.QueryRow(ctx, `SELECT time_zone, days FROM sms_hours WHERE org_id = $1 AND team_id IN ($2::uuid, $3::uuid)
		ORDER BY (team_id = $3::uuid) LIMIT 1`, org, func() string {
		if team != nil && *team != "" {
			return *team
		}
		return nilTeam
	}(), nilTeam).Scan(&zone, &days)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseHours(zone, days)
}

// runsAgency: the owner or an admin. leadsTeam: a lead of that team.
func (sc scope) runsAgency() bool {
	return slices.ContainsFunc(sc.roles, func(r string) bool { return r == "owner" || r == "solo" || r == "admin" })
}
func (sc scope) leadsTeam(team string) bool { return team != "" && slices.Contains(sc.managed, team) }

// putHours is PUT /api/v1/sms/hours {team_id, time_zone, days}: the owner or an admin sets the agency's hours, a team's lead or
// they its team's (D79). An empty days list removes them.
func (s *server) putHours(ctx context.Context, sc scope, team, zone string, days json.RawMessage) error {
	if team == "" {
		team = nilTeam
	}
	if !sc.runsAgency() && !(team != nilTeam && sc.leadsTeam(team)) {
		return forbidden("The owner and admins set the agency's hours; a team lead sets their team's.")
	}
	if !validID(team) {
		return bad("Choose a team.")
	}
	if len(days) == 0 || string(days) == "null" || string(days) == "{}" {
		_, err := s.st.db.Exec(ctx, `DELETE FROM sms_hours WHERE org_id = $1 AND team_id = $2`, sc.orgID, team)
		return err
	}
	if _, err := parseHours(zone, days); err != nil {
		return err
	}
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_hours (org_id, team_id, time_zone, days) VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id, team_id) DO UPDATE SET time_zone = EXCLUDED.time_zone, days = EXCLUDED.days`, sc.orgID, team, zone, []byte(days))
	return err
}

// ---- templates (D210) ----

type template struct {
	ID     string  `json:"id"`
	TeamID *string `json:"team_id"`
	Name   string  `json:"name"`
	Body   string  `json:"body"`
	Text   string  `json:"text,omitempty"` // filled in for a lead
}

// fill puts the lead's details in a template: {first_name}, {last_name}, {name}.
func fill(body, name string) string {
	first, last, _ := strings.Cut(strings.TrimSpace(name), " ")
	return strings.NewReplacer("{first_name}", first, "{last_name}", strings.TrimSpace(last), "{name}", strings.TrimSpace(name)).Replace(body)
}

// saveTemplate is POST /api/v1/sms/templates {name, body, team_id}: the owner and admins for anyone, a team's lead for their team.
func (s *server) saveTemplate(ctx context.Context, sc scope, t template) (template, error) {
	t.Name, t.Body = strings.TrimSpace(t.Name), strings.TrimSpace(t.Body)
	team := ""
	if t.TeamID != nil {
		team = *t.TeamID
	}
	if !sc.runsAgency() && !sc.leadsTeam(team) {
		return t, forbidden("The owner, admins and team leads write templates; a team lead for their own team.")
	}
	if t.Name == "" || len([]rune(t.Name)) > 80 || t.Body == "" || len([]rune(t.Body)) > 1600 {
		return t, bad("Name the template (up to 80 characters) and write its text (up to 1,600).")
	}
	t.ID = newUUID()
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_templates (id, org_id, team_id, name, body, created_by) VALUES ($1, $2, nullif($3, '')::uuid, $4, $5, $6)`,
		t.ID, sc.orgID, team, t.Name, t.Body, sc.userID)
	return t, err
}

// templatesFor is GET /api/v1/sms/templates?lead_id=: the agency's templates and the lead's team's, filled in for the lead to edit
// before sending.
func (s *server) templatesFor(ctx context.Context, sc scope, lead string) ([]template, error) {
	info, _, err := s.leadThread(ctx, sc, lead)
	if err != nil {
		return nil, err
	}
	rows, err := s.st.db.Query(ctx, `SELECT id::text, team_id::text, name, body FROM sms_templates WHERE org_id = $1 AND (team_id IS NULL OR team_id::text = $2) ORDER BY name`, sc.orgID, info.TeamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []template{}
	for rows.Next() {
		var t template
		if err := rows.Scan(&t.ID, &t.TeamID, &t.Name, &t.Body); err != nil {
			return nil, err
		}
		t.Text = fill(t.Body, info.Name)
		out = append(out, t)
	}
	return out, rows.Err()
}

// ---- scheduled texts (D211) and one message to many leads (D212) ----

// textingWindow is the next moment a lead may be texted at or after t: between 8:00 and 21:00 in the agency's time zone.
func textingWindow(t time.Time, zone *time.Location) time.Time {
	return textingWindowIn(t, zone, textFromHour, textUntilHour)
}

// textingWindowIn is the same within the agency's own, shorter, hours (D151).
func textingWindowIn(t time.Time, zone *time.Location, from, until int) time.Time {
	if zone == nil {
		zone = time.UTC
	}
	local := t.In(zone)
	switch {
	case local.Hour() < from:
		return time.Date(local.Year(), local.Month(), local.Day(), from, 0, 0, 0, zone)
	case local.Hour() >= until:
		next := local.AddDate(0, 0, 1)
		return time.Date(next.Year(), next.Month(), next.Day(), from, 0, 0, 0, zone)
	}
	return t
}

func (s *server) agencyZone(ctx context.Context, org string) *time.Location {
	if h, err := s.hoursFor(ctx, org, nil); err == nil && h != nil {
		return h.zone
	}
	return time.UTC
}

// scheduleText keeps a text for later: the same checks as sending now, then it waits (status scheduled) for its time, moved into the
// lead's texting hours.
func (s *server) scheduleText(ctx context.Context, sc scope, ask textAsk, at time.Time, batch string, anySender bool) (*smsRow, error) {
	to, lead, err := s.mayText(ctx, sc, ask, anySender)
	if err != nil {
		return nil, err
	}
	from0, until, zone := s.contactWindow(ctx, sc.orgID)
	at = textingWindowIn(at, zone, from0, until)
	from, err := s.numberFor(ctx, sc, lead, ask.From, "texts")
	if err != nil {
		return nil, err
	}
	id := newUUID()
	if _, err = s.st.db.Exec(ctx, `INSERT INTO sms_messages (id, org_id, user_id, lead_id, direction, from_number, to_number, body, route, status, send_at, batch_id)
		VALUES ($1, $2, $3, $4, 'outgoing', $5, $6, $7, $8, 'scheduled', $9, nullif($10, '')::uuid)`,
		id, sc.orgID, sc.userID, lead.LeadID, from, to, strings.TrimSpace(ask.Text), s.route(), at, batch); err != nil {
		return nil, err
	}
	return s.loadText(ctx, `id = $1`, id)
}

// sendDue sends the scheduled texts whose time came, each as the person who scheduled it with their rights now. One blocked since
// (STOP, do-not-call), or one its sender may no longer send, is cancelled, not sent (D211).
func (s *server) sendDue(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `UPDATE sms_messages SET status = 'queued', updated_at = now()
		WHERE id IN (SELECT id FROM sms_messages WHERE status = 'scheduled' AND send_at <= $1 ORDER BY send_at LIMIT 200 FOR UPDATE SKIP LOCKED)
		RETURNING id::text, org_id::text, user_id::text, lead_id::text, from_number, body, batch_id IS NOT NULL`, s.now())
	if err != nil {
		return err
	}
	type due struct {
		id, org, user, lead, from, body string
		batch                           bool
	}
	list := []due{}
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.org, &d.user, &d.lead, &d.from, &d.body, &d.batch); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, d := range list {
		g, err := s.rules.grant(ctx, d.user, d.org, false)
		if err == nil && g.Allowed {
			sc := scope{userID: d.user, orgID: d.org, scopes: g.Scopes, caps: g.Capabilities, roles: g.Roles, managed: g.ManagedTeamIDs}
			_, err = s.sendScheduled(ctx, sc, d.id, textAsk{LeadID: d.lead, Text: d.body, From: d.from}, d.batch)
		} else if err == nil {
			err = forbidden(g.Reason)
		}
		if err != nil {
			reason := err.Error()
			if _, err := s.st.db.Exec(ctx, `UPDATE sms_messages SET status = 'cancelled', error = $2, updated_at = now() WHERE id = $1`, d.id, reason); err != nil {
				return err
			}
			log.Printf("INFO scheduled text %s cancelled: %s", d.id, reason)
		}
	}
	return nil
}

func (s *server) sendDuePeriodically(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.sendDue(ctx); err != nil {
				log.Printf("WARN scheduled texts: %v", err)
			}
		}
	}
}

// bulkText is POST /api/v1/sms/bulk {lead_ids, text}: the owner, admins and team leads send one message to many leads, each in their
// own conversation, inside texting hours (D212). Leads that cannot be texted are listed with why; nothing else stops the rest.
func (s *server) bulkText(ctx context.Context, sc scope, leads []string, text string) (map[string]any, error) {
	if !sc.runsAgency() && len(sc.managed) == 0 {
		return nil, forbidden("Only the owner, admins and team leads send one message to many leads.")
	}
	if len(leads) == 0 || len(leads) > bulkMax {
		return nil, bad("Choose 1 to 500 leads.")
	}
	if err := s.textingAllowed(ctx, sc.orgID, true); err != nil {
		return nil, err
	}
	batch := newUUID()
	scheduled, refused := 0, []map[string]any{}
	for _, lead := range leads {
		m, err := s.scheduleText(ctx, sc, textAsk{LeadID: lead, Text: fill(text, s.leadName(ctx, sc, lead))}, s.now(), batch, true)
		if err != nil {
			refused = append(refused, map[string]any{"lead_id": lead, "reason": err.Error()})
			continue
		}
		_ = m
		scheduled++
	}
	return map[string]any{"batch_id": batch, "scheduled": scheduled, "refused": refused}, nil
}

func (s *server) leadName(ctx context.Context, sc scope, lead string) string {
	info, err := s.crm.lead(ctx, sc.orgID, sc.userID, lead)
	if err != nil {
		return ""
	}
	return info.Name
}

var _ = http.StatusOK
