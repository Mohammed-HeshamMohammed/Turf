package main

// Build step 10: lead threads. A lead's texts are one thread, seen by whoever may see the lead (the CRM decides, D16). One person
// sends (D17): the lead's agent, unless someone above them took it over. Takeover follows rank: the owner or an admin over a lead of
// the lead's team, a lead over its deputy, a deputy over the agent (D76). The holder hands control back; the agent can ask for it back
// but not take it (D18). Everyone who sees the thread reads and writes its internal notes (D96). A text from the lead that waits longer
// than the agency's wait tells the team's leads and deputies; one waiting on someone who took the thread over returns control to the
// agent, and both are told (D21, D48, D77). The thread follows the lead: whoever the CRM says works it now is its agent (D19, D20).

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var rankOrder = map[string]int{"agent": 1, "deputy": 2, "lead": 3, "owner": 4}

type threadRow struct {
	AssigneeID   *string    `json:"assignee_id"`
	TeamLeads    []string   `json:"team_leads"`
	TeamDeputies []string   `json:"team_deputies"`
	HolderID     *string    `json:"holder_id"`
	HolderRank   string     `json:"holder_rank"`
	TakenAt      *time.Time `json:"taken_at"`
	BackAskedAt  *time.Time `json:"back_asked_at"`
	WaitingSince *time.Time `json:"waiting_since"`
	AlertedAt    *time.Time `json:"alerted_at"`
}

// sender is who may send in the thread now: whoever took it over, else the lead's agent; "" when the lead has neither.
func (t threadRow) sender() string {
	if t.HolderID != nil {
		return *t.HolderID
	}
	if t.AssigneeID != nil {
		return *t.AssigneeID
	}
	return ""
}

func (t threadRow) senderRank() string {
	switch {
	case t.HolderID != nil:
		return t.HolderRank
	case t.AssigneeID != nil:
		return "agent"
	}
	return ""
}

// mayTakeOver: a rank above the agent's, and above whoever holds it now (D76).
func (t threadRow) mayTakeOver(rank, me string) bool {
	return rankOrder[rank] >= rankOrder["deputy"] && rankOrder[rank] > rankOrder[t.senderRank()] && t.sender() != me
}

func nonNilList(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// leadThread asks the CRM whether the person may see the lead, keeps what it says about who works it, and answers the thread's control.
func (s *server) leadThread(ctx context.Context, sc scope, lead string) (leadInfo, threadRow, error) {
	if !validID(lead) {
		return leadInfo{}, threadRow{}, bad("Choose a lead (lead_id).")
	}
	info, err := s.crm.lead(ctx, sc.orgID, sc.userID, lead)
	var refused errCRMRefused
	if errors.As(err, &refused) {
		return info, threadRow{}, notFound(refused.message)
	}
	if err != nil {
		return info, threadRow{}, err
	}
	var t threadRow
	err = s.st.db.QueryRow(ctx, `INSERT INTO sms_threads (org_id, lead_id, assignee_id, team_id, team_leads, team_deputies)
		VALUES ($1, $2, nullif($3, '')::uuid, nullif($4, '')::uuid, $5::text[]::uuid[], $6::text[]::uuid[])
		ON CONFLICT (org_id, lead_id) DO UPDATE SET assignee_id = EXCLUDED.assignee_id, team_id = EXCLUDED.team_id,
			team_leads = EXCLUDED.team_leads, team_deputies = EXCLUDED.team_deputies, updated_at = now()
		RETURNING assignee_id::text, team_leads::text[], team_deputies::text[], holder_id::text, holder_rank, taken_at, back_asked_at, waiting_since, alerted_at`,
		sc.orgID, lead, info.AssigneeID, info.TeamID, nonNilList(info.TeamLeads), nonNilList(info.TeamDeputies)).
		Scan(&t.AssigneeID, &t.TeamLeads, &t.TeamDeputies, &t.HolderID, &t.HolderRank, &t.TakenAt, &t.BackAskedAt, &t.WaitingSince, &t.AlertedAt)
	return info, t, err
}

// mustBeSender refuses a text from anyone but the thread's sender (D17).
func (t threadRow) mustBeSender(me string) error {
	if who := t.sender(); who != "" && who != me {
		if t.HolderID != nil {
			return &apiError{http.StatusConflict, "not_holder", "Someone took this conversation over. Ask them to hand it back."}
		}
		return &apiError{http.StatusConflict, "not_holder", "The lead's agent answers this conversation. Take it over to send."}
	}
	return nil
}

// threadView is GET /api/v1/sms/threads/{lead}: the texts, the notes, and who sends and who may take over.
func (s *server) threadView(ctx context.Context, sc scope, lead string) (map[string]any, error) {
	info, t, err := s.leadThread(ctx, sc, lead)
	if err != nil {
		return nil, err
	}
	rows, err := s.st.db.Query(ctx, `SELECT * FROM sms_messages WHERE org_id = $1 AND lead_id = $2 ORDER BY created_at, id`, sc.orgID, lead)
	if err != nil {
		return nil, err
	}
	msgs, err := pgx.CollectRows(rows, pgx.RowToStructByName[smsRow])
	if err != nil {
		return nil, err
	}
	notes, err := s.notes(ctx, sc.orgID, lead)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"messages": msgs, "notes": notes, "control": t, "sender_id": t.sender(), "your_rank": info.Rank,
		"may_send": t.sender() == "" || t.sender() == sc.userID, "may_take_over": t.mayTakeOver(info.Rank, sc.userID),
		"may_hand_back": t.HolderID != nil && *t.HolderID == sc.userID,
		"may_ask_back":  t.HolderID != nil && t.AssigneeID != nil && *t.AssigneeID == sc.userID,
	}, nil
}

func (s *server) notes(ctx context.Context, org, lead string) ([]map[string]any, error) {
	rows, err := s.st.db.Query(ctx, `SELECT id::text, user_id::text, body, created_at FROM sms_notes WHERE org_id = $1 AND lead_id = $2 ORDER BY created_at, id`, org, lead)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, user, body string
		var at time.Time
		if err := rows.Scan(&id, &user, &body, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "user_id": user, "body": body, "created_at": at})
	}
	return out, rows.Err()
}

// threadAction is POST /api/v1/sms/threads/{lead}/{takeover|handback|ask-back|notes}.
func (s *server) threadAction(ctx context.Context, sc scope, lead, action, note string) (map[string]any, error) {
	info, t, err := s.leadThread(ctx, sc, lead)
	if err != nil {
		return nil, err
	}
	switch action {
	case "takeover":
		if !t.mayTakeOver(info.Rank, sc.userID) {
			return nil, forbidden("Only someone above whoever answers it now can take this conversation over.")
		}
		_, err = s.st.db.Exec(ctx, `UPDATE sms_threads SET holder_id = $3, holder_rank = $4, taken_at = $5, back_asked_at = NULL WHERE org_id = $1 AND lead_id = $2`,
			sc.orgID, lead, sc.userID, info.Rank, s.now())
	case "handback":
		if t.HolderID == nil || *t.HolderID != sc.userID {
			return nil, forbidden("Only whoever took the conversation over hands it back.")
		}
		_, err = s.st.db.Exec(ctx, `UPDATE sms_threads SET holder_id = NULL, holder_rank = '', taken_at = NULL, back_asked_at = NULL WHERE org_id = $1 AND lead_id = $2`, sc.orgID, lead)
	case "ask-back":
		if t.HolderID == nil || t.AssigneeID == nil || *t.AssigneeID != sc.userID {
			return nil, forbidden("Only the lead's agent asks for a taken-over conversation back.")
		}
		_, err = s.st.db.Exec(ctx, `UPDATE sms_threads SET back_asked_at = $3 WHERE org_id = $1 AND lead_id = $2`, sc.orgID, lead, s.now())
	case "notes":
		note = strings.TrimSpace(note)
		if note == "" || len([]rune(note)) > 4000 {
			return nil, bad("Write a note of up to 4,000 characters.")
		}
		_, err = s.st.db.Exec(ctx, `INSERT INTO sms_notes (id, org_id, lead_id, user_id, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			newUUID(), sc.orgID, lead, sc.userID, note, s.now())
	default:
		return nil, notFound("No such action.")
	}
	if err != nil {
		return nil, err
	}
	return s.threadView(ctx, sc, lead)
}

// textAnswered clears a thread's wait once someone texts the lead back.
func (s *server) textAnswered(ctx context.Context, org, lead string) error {
	_, err := s.st.db.Exec(ctx, `UPDATE sms_threads SET waiting_since = NULL, alerted_at = NULL WHERE org_id = $1 AND lead_id = $2`, org, lead)
	return err
}

// textWaiting starts a thread's wait when the lead texts and nobody has answered yet.
func (s *server) textWaiting(ctx context.Context, org, lead string) error {
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_threads (org_id, lead_id, waiting_since) VALUES ($1, $2, $3)
		ON CONFLICT (org_id, lead_id) DO UPDATE SET waiting_since = coalesce(sms_threads.waiting_since, EXCLUDED.waiting_since)`, org, lead, s.now())
	return err
}

// checkWaiting tells about the texts that waited longer than their agency's wait (D21, D48), and returns a taken-over conversation to
// its agent when its holder did not answer in time, telling both (D77). Run every minute.
func (s *server) checkWaiting(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `SELECT t.org_id::text, t.lead_id::text, t.assignee_id::text, t.holder_id::text, t.team_leads::text[], t.team_deputies::text[],
			t.team_id::text, t.waiting_since, coalesce(c.wait_minutes, 15)
		FROM sms_threads t LEFT JOIN sms_settings c ON c.org_id = t.org_id
		WHERE t.waiting_since IS NOT NULL AND t.alerted_at IS NULL AND t.waiting_since <= $1::timestamptz - make_interval(mins => coalesce(c.wait_minutes, 15))
		LIMIT 500`, s.now())
	if err != nil {
		return err
	}
	type due struct {
		org, lead       string
		agent, holder   *string
		leads, deputies []string
		team            *string
		since           time.Time
		wait            int
	}
	list := []due{}
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.org, &d.lead, &d.agent, &d.holder, &d.leads, &d.deputies, &d.team, &d.since, &d.wait); err != nil {
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
		// The wait counts only while the lead's team (or the agency) is working (D79).
		hours, err := s.hoursFor(ctx, d.org, d.team)
		if err != nil {
			return err
		}
		if hours.deadline(d.since, time.Duration(d.wait)*time.Minute).After(s.now()) {
			continue
		}
		if d.holder != nil {
			// The holder did not answer: the conversation goes back to the agent, the wait starts again for them, both are told.
			told := []string{*d.holder}
			if d.agent != nil && !slices.Contains(told, *d.agent) {
				told = append(told, *d.agent)
			}
			if _, err := s.st.db.Exec(ctx, `UPDATE sms_threads SET holder_id = NULL, holder_rank = '', taken_at = NULL, back_asked_at = NULL, waiting_since = $3
				WHERE org_id = $1 AND lead_id = $2`, d.org, d.lead, s.now()); err != nil {
				return err
			}
			if err := s.alert(ctx, d.org, d.lead, "returned", told); err != nil {
				return err
			}
			continue
		}
		told := []string{}
		for _, id := range append(d.leads, d.deputies...) {
			if !slices.Contains(told, id) {
				told = append(told, id)
			}
		}
		if _, err := s.st.db.Exec(ctx, `UPDATE sms_threads SET alerted_at = $3 WHERE org_id = $1 AND lead_id = $2`, d.org, d.lead, s.now()); err != nil {
			return err
		}
		if len(told) > 0 {
			if err := s.alert(ctx, d.org, d.lead, "unanswered", told); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *server) alert(ctx context.Context, org, lead, kind string, to []string) error {
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_alerts (id, org_id, lead_id, kind, to_users, created_at) VALUES ($1, $2, $3, $4, $5::text[]::uuid[], $6)`,
		newUUID(), org, lead, kind, to, s.now())
	return err
}

// myAlerts is GET /api/v1/sms/alerts: what the person was told and has not marked seen, newest first. With several leads told about
// the same text, the first to take it over holds it and the others see who in the thread (D48).
func (s *server) myAlerts(ctx context.Context, sc scope) ([]map[string]any, error) {
	rows, err := s.st.db.Query(ctx, `SELECT a.id::text, a.lead_id::text, a.kind, a.created_at, t.holder_id::text FROM sms_alerts a
		LEFT JOIN sms_threads t ON t.org_id = a.org_id AND t.lead_id = a.lead_id
		WHERE a.org_id = $1 AND $2::uuid = ANY(a.to_users) AND NOT ($2::uuid = ANY(a.seen_by)) ORDER BY a.created_at DESC LIMIT 100`, sc.orgID, sc.userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, lead, kind string
		var at time.Time
		var holder *string
		if err := rows.Scan(&id, &lead, &kind, &at, &holder); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "lead_id": lead, "kind": kind, "created_at": at, "holder_id": holder})
	}
	return out, rows.Err()
}

func (s *server) seenAlert(ctx context.Context, sc scope, id string) error {
	_, err := s.st.db.Exec(ctx, `UPDATE sms_alerts SET seen_by = array_append(seen_by, $3::uuid) WHERE id = $1 AND org_id = $2 AND $3::uuid = ANY(to_users) AND NOT ($3::uuid = ANY(seen_by))`, id, sc.orgID, sc.userID)
	return err
}

// putTextSettings is PUT /api/v1/sms/settings {wait_minutes}: the owner or an admin sets how long a text may wait (D21).
func (s *server) putTextSettings(ctx context.Context, sc scope, minutes int) error {
	if !sc.can("admin") {
		return forbidden("Only the owner or an admin changes this.")
	}
	if minutes < 1 || minutes > 1440 {
		return bad("Choose a wait of 1 to 1,440 minutes.")
	}
	_, err := s.st.db.Exec(ctx, `INSERT INTO sms_settings (org_id, wait_minutes) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET wait_minutes = EXCLUDED.wait_minutes`, sc.orgID, minutes)
	return err
}

func (s *server) checkWaitingPeriodically(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.checkWaiting(ctx); err != nil {
				log.Printf("WARN unanswered texts: %v", err)
			}
		}
	}
}
