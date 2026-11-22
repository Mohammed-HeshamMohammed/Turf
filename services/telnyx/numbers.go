package telnyx

// Build step 21, part A: team numbers (D116), the number a lead already knows (D117), the hours leads may be called and texted
// (D151), agents' status (D152), and who an incoming call rings (D150).

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// numberFor is the number to call or text a lead from: the one asked for, if it is the agency's; the one the lead already knows,
// so their replies still arrive after a move (D117); the lead's team's; the agency's default; then any of the agency's (D116).
func (s *server) numberFor(ctx context.Context, sc scope, lead leadInfo, asked, kind string) (string, error) {
	to := e164(lead.Phone)
	var from string
	err := s.st.db.QueryRow(ctx, `SELECT n.phone_number FROM numbers n WHERE n.org_id = $1 AND n.`+kind+`
		ORDER BY (n.phone_number = $3) DESC,
			EXISTS (SELECT 1 FROM sms_messages m WHERE m.org_id = n.org_id AND ((m.from_number = n.phone_number AND m.to_number = $4) OR (m.to_number = n.phone_number AND m.from_number = $4)))
			OR EXISTS (SELECT 1 FROM calls c WHERE c.org_id = n.org_id AND ((c.from_number = n.phone_number AND c.to_number = $4) OR (c.to_number = n.phone_number AND c.from_number = $4))) DESC,
			(n.team_id IS NOT NULL AND n.team_id::text = $5) DESC, n.is_default DESC, (n.user_id = $2) DESC, n.created_at
		LIMIT 1`, sc.orgID, sc.userID, e164(asked), to, lead.TeamID).Scan(&from)
	if errors.Is(err, pgx.ErrNoRows) {
		if s.cfg.fromNumber == "" {
			return "", conflictErr("This workspace has no phone number yet.")
		}
		return s.cfg.fromNumber, nil
	}
	return from, err
}

// contactWindow is the agency's hours for calling and texting leads (8:00 to 21:00 unless it chose shorter), in its time zone (D151).
func (s *server) contactWindow(ctx context.Context, org string) (from, until int, zone *time.Location) {
	from, until = textFromHour, textUntilHour
	_ = s.st.db.QueryRow(ctx, `SELECT contact_from, contact_until FROM sms_settings WHERE org_id = $1`, org).Scan(&from, &until)
	return from, until, s.agencyZone(ctx, org)
}

// mayContactNow refuses a call or text outside those hours. Each lead's own time zone replaces the agency's once leads carry one.
func (s *server) mayContactNow(ctx context.Context, org string) error {
	if s.cfg.simulate && s.cfg.anyHours {
		return nil
	}
	from, until, zone := s.contactWindow(ctx, org)
	local := s.now().In(zone)
	if local.Hour() < from || local.Hour() >= until {
		return &apiError{http.StatusConflict, "outside_hours", "Leads are called and texted only between " + hourLabel(from) + " and " + hourLabel(until) + " their time."}
	}
	return nil
}

func hourLabel(h int) string { return time.Date(2000, 1, 1, h, 0, 0, 0, time.UTC).Format("15:04") }

// putContactHours is part of PUT /api/v1/sms/settings: the owner or an admin shortens the hours, never past 8:00 to 21:00.
func (s *server) putContactHours(ctx context.Context, sc scope, from, until int) error {
	if !sc.can("admin") {
		return forbidden("Only the owner or an admin changes this.")
	}
	if from < textFromHour || until > textUntilHour || until <= from {
		return bad("Choose hours inside 8:00 to 21:00.")
	}
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_settings (org_id, contact_from, contact_until) VALUES ($1, $2, $3)
		ON CONFLICT (org_id) DO UPDATE SET contact_from = EXCLUDED.contact_from, contact_until = EXCLUDED.contact_until`, sc.orgID, from, until)
	return err
}

// ---- agents' status (D152) ----

// statusOf is a person's status: on a call when a call of theirs has not ended, else what they set (off when they set nothing).
func (s *server) statusOf(ctx context.Context, org, user string) (string, error) {
	var onCall bool
	if err := s.st.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM calls WHERE org_id = $1 AND user_id = $2 AND ended_at IS NULL AND created_at > $3)`,
		org, user, s.now().Add(-4*time.Hour)).Scan(&onCall); err != nil {
		return "", err
	}
	if onCall {
		return "on_call", nil
	}
	status := "off"
	err := s.st.db.QueryRow(ctx, `SELECT status FROM agent_status WHERE org_id = $1 AND user_id = $2`, org, user).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return status, err
}

func (s *server) setStatus(ctx context.Context, sc scope, status string) error {
	if !slices.Contains([]string{"available", "break", "off"}, status) {
		return bad("A status is available, break or off; on a call is set by itself.")
	}
	_, err := s.st.db.Exec(ctx, `INSERT INTO agent_status (org_id, user_id, status, updated_at) VALUES ($1, $2, $3, now())
		ON CONFLICT (org_id, user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`, sc.orgID, sc.userID, status)
	return err
}

// teamStatus is GET /api/v1/status: everyone's status for the owner, admins and team leads (who see their team's at work, D152);
// the person's own for anyone else.
func (s *server) teamStatus(ctx context.Context, sc scope) ([]map[string]any, error) {
	ids := []string{sc.userID}
	if sc.runsAgency() || len(sc.managed) > 0 {
		rows, err := s.st.db.Query(ctx, `SELECT user_id::text FROM agent_status WHERE org_id = $1 UNION SELECT DISTINCT user_id::text FROM calls WHERE org_id = $1 AND ended_at IS NULL`, sc.orgID)
		if err != nil {
			return nil, err
		}
		ids, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
	}
	out := []map[string]any{}
	for _, id := range ids {
		status, err := s.statusOf(ctx, sc.orgID, id)
		if err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"user_id": id, "status": status})
	}
	return out, nil
}

// ---- who an incoming call rings (D150) ----

// inboundTarget is who a lead's call rings: the lead's own agent; if they are not available, the team's other available agents; then
// its leads and deputies; "" sends it to voicemail in the lead's thread. Someone rings only when available with a calling login.
func (s *server) inboundTarget(ctx context.Context, org, numberOwner, from string) (string, error) {
	candidates := []string{}
	if found, err := s.crm.findLead(ctx, org, numberOwner, from); err == nil && found.Found {
		if lead, err := s.crm.lead(ctx, org, numberOwner, found.LeadID); err == nil {
			candidates = append(candidates, lead.AssigneeID)
			candidates = append(candidates, lead.TeamAgents...)
			candidates = append(candidates, lead.TeamLeads...)
			candidates = append(candidates, lead.TeamDeputies...)
		}
	} else {
		candidates = append(candidates, numberOwner) // a number with no lead behind it: the number's owner
	}
	seen := map[string]bool{}
	for _, id := range candidates {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		status, err := s.statusOf(ctx, org, id)
		if err != nil {
			return "", err
		}
		var login string
		_ = s.st.db.QueryRow(ctx, `SELECT sip_username FROM agent_credentials WHERE user_id = $1`, id).Scan(&login)
		if status == "available" && login != "" {
			return id, nil
		}
	}
	return "", nil
}
