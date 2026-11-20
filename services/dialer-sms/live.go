package main

// Build step 21, part B: joining an agent's live call (D119), recording rules (D276, D277), voicemail messages (D278) and callbacks due
// while their agent is away (D153).

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// recordingNotice is said to the lead when a recorded call is answered. The wording each state needs is for the lawyer to confirm
// (D276); until then this one plays everywhere.
const recordingNotice = "This call may be recorded."

var supervisorRole = map[string]string{"listen": "monitor", "whisper": "whisper", "takeover": "barge"}

// joinCall is POST /api/v1/calls/{id}/join {mode}: a lead of the call's team, its deputy or the owner joins an agent's live call, to
// listen, speak only to the agent, or take the call over, by rank (D119, D76). They join from their own calling login; the agent sees
// who joined. Whether the lead must be told is for the lawyer, state by state.
func (s *server) joinCall(ctx context.Context, sc scope, id, mode string) (map[string]any, error) {
	role, ok := supervisorRole[mode]
	if !ok {
		return nil, bad("Join to listen, whisper or take over.")
	}
	c, err := s.loadCall(ctx, nil, `id = $1 AND org_id = $2`, id, sc.orgID)
	if err != nil {
		return nil, err
	}
	if c == nil || c.LeadID == nil {
		return nil, notFound("No such call.")
	}
	if c.EndedAt != nil || c.CallControlID == nil {
		return nil, conflictErr("This call is not live.")
	}
	lead, err := s.crm.lead(ctx, sc.orgID, sc.userID, *c.LeadID)
	var refused errCRMRefused
	if errors.As(err, &refused) {
		return nil, notFound(refused.message)
	}
	if err != nil {
		return nil, err
	}
	if c.UserID == sc.userID || rankOrder[lead.Rank] < rankOrder["deputy"] {
		return nil, forbidden("Only a lead of the call's team, its deputy, an admin or the owner joins an agent's call.")
	}
	var login string
	_ = s.st.db.QueryRow(ctx, `SELECT sip_username FROM agent_credentials WHERE user_id = $1`, sc.userID).Scan(&login)
	if login == "" {
		return nil, conflictErr("Set up calling in the browser first: you join from there.")
	}
	joinID := newUUID()
	answer, err := s.carrier.dial(ctx, dialRequest{From: c.FromNumber, To: "sip:" + login + "@sip.telnyx.com", ClientState: c.ID + ":join:" + joinID,
		TimeoutSecs: 30, SuperviseID: *c.CallControlID, SupervisorRole: role})
	if err != nil {
		log.Printf("WARN join %s: %v", c.ID, err)
		return nil, &apiError{502, "carrier", "The carrier did not connect you. Try again in a moment."}
	}
	if _, err = s.st.db.Exec(ctx, `INSERT INTO call_joins (id, call_id, user_id, mode, call_control_id, joined_at) VALUES ($1, $2, $3, $4, $5, $6)`,
		joinID, c.ID, sc.userID, mode, answer.CallControlID, s.now()); err != nil {
		return nil, err
	}
	return map[string]any{"id": joinID, "call_id": c.ID, "mode": mode}, nil
}

// joinsOf is who joined a call, for the agent's screen (D119: the agent always sees it).
func (s *server) joinsOf(ctx context.Context, call string) ([]map[string]any, error) {
	rows, err := s.st.db.Query(ctx, `SELECT user_id::text, mode, joined_at FROM call_joins WHERE call_id = $1 ORDER BY joined_at`, call)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var user, mode string
		var at time.Time
		if err := rows.Scan(&user, &mode, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"user_id": user, "mode": mode, "joined_at": at})
	}
	return out, rows.Err()
}

// recordingOn says whether the owner switched recording on for the agency or for the lead's team (D276).
func (s *server) recordingOn(ctx context.Context, org, team string) (bool, error) {
	var on bool
	err := s.st.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM call_recording WHERE org_id = $1 AND (team_id = $2::uuid OR team_id::text = $3))`, org, nilTeam, team).Scan(&on)
	return on, err
}

// putRecording is PUT /api/v1/recording {team_id, on}: the owner (or an admin) switches recording on or off for the agency or a team.
func (s *server) putRecording(ctx context.Context, sc scope, team string, on bool) error {
	if !sc.runsAgency() {
		return forbidden("Only the owner or an admin switches call recording.")
	}
	if team == "" {
		team = nilTeam
	}
	if !validID(team) {
		return bad("Choose a team.")
	}
	var err error
	if on {
		_, err = s.st.db.Exec(ctx, `INSERT INTO call_recording (org_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, sc.orgID, team)
	} else {
		_, err = s.st.db.Exec(ctx, `DELETE FROM call_recording WHERE org_id = $1 AND team_id = $2`, sc.orgID, team)
	}
	return err
}

// pauseRecording is POST /api/v1/calls/{id}/recording {pause}: the call's agent pauses or resumes its recording; the pauses are kept
// so the recording shows where and how long (D277).
func (s *server) pauseRecording(ctx context.Context, sc scope, id string, pause bool) error {
	c, err := s.loadCall(ctx, nil, `id = $1 AND org_id = $2`, id, sc.orgID)
	if err != nil {
		return err
	}
	if c == nil || c.UserID != sc.userID {
		return notFound("No such call.")
	}
	if c.EndedAt != nil || c.CallControlID == nil || !c.Record {
		return conflictErr("This call is not being recorded now.")
	}
	var open bool
	if err := s.st.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM recording_pauses WHERE call_id = $1 AND resumed_at IS NULL)`, id).Scan(&open); err != nil {
		return err
	}
	if pause == open {
		return nil // already as asked
	}
	action := "record_resume"
	if pause {
		action = "record_pause"
	}
	if err := s.carrier.action(ctx, *c.CallControlID, action, nil); err != nil {
		return &apiError{502, "carrier", "The carrier did not take that. Try again."}
	}
	if pause {
		_, err = s.st.db.Exec(ctx, `INSERT INTO recording_pauses (call_id, paused_at) VALUES ($1, $2)`, id, s.now())
	} else {
		_, err = s.st.db.Exec(ctx, `UPDATE recording_pauses SET resumed_at = $2 WHERE call_id = $1 AND resumed_at IS NULL`, id, s.now())
	}
	if err != nil || !c.Captions {
		return err
	}
	// Captions pause with the recording (D277).
	if pause {
		if aerr := s.carrier.action(ctx, *c.CallControlID, "transcription_stop", nil); aerr != nil {
			log.Printf("WARN call %s: transcription_stop: %v", c.ID, aerr)
		}
	} else {
		s.startCaptions(ctx, c)
	}
	_, err = s.st.db.Exec(ctx, `UPDATE calls SET captions_paused = $2, updated_at = now() WHERE id = $1`, id, pause)
	return err
}

func (s *server) pausesOf(ctx context.Context, call string) ([]map[string]any, error) {
	rows, err := s.st.db.Query(ctx, `SELECT paused_at, resumed_at FROM recording_pauses WHERE call_id = $1 ORDER BY paused_at`, call)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var at time.Time
		var back *time.Time
		if err := rows.Scan(&at, &back); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"paused_at": at, "resumed_at": back})
	}
	return out, rows.Err()
}

// ---- voicemail messages (D278) ----

type voicemailDrop struct {
	ID       string  `json:"id"`
	TeamID   *string `json:"team_id"`
	Name     string  `json:"name"`
	AudioURL string  `json:"audio_url"`
}

// saveDrop is POST /api/v1/voicemail-drops {name, audio_url, team_id}: the owner, admins and team leads (for their team).
func (s *server) saveDrop(ctx context.Context, sc scope, d voicemailDrop) (voicemailDrop, error) {
	team := ""
	if d.TeamID != nil {
		team = *d.TeamID
	}
	if !sc.runsAgency() && !sc.leadsTeam(team) {
		return d, forbidden("The owner, admins and team leads record voicemail messages; a team lead for their own team.")
	}
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" || len([]rune(d.Name)) > 80 || !strings.HasPrefix(d.AudioURL, "https://") {
		return d, bad("Name the message and give the https address of its recording.")
	}
	d.ID = newUUID()
	_, err := s.st.db.Exec(ctx, `INSERT INTO voicemail_drops (id, org_id, team_id, name, audio_url, created_by) VALUES ($1, $2, nullif($3, '')::uuid, $4, $5, $6)`,
		d.ID, sc.orgID, team, d.Name, d.AudioURL, sc.userID)
	return d, err
}

// dropsFor is GET /api/v1/voicemail-drops?lead_id=: the agency's messages and the lead's team's, for the agent to pick.
func (s *server) dropsFor(ctx context.Context, sc scope, lead string) ([]voicemailDrop, error) {
	info, err := s.crm.lead(ctx, sc.orgID, sc.userID, lead)
	var refused errCRMRefused
	if errors.As(err, &refused) {
		return nil, notFound(refused.message)
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.st.db.Query(ctx, `SELECT id::text, team_id::text, name, audio_url FROM voicemail_drops WHERE org_id = $1 AND (team_id IS NULL OR team_id::text = $2) ORDER BY name`, sc.orgID, info.TeamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []voicemailDrop{}
	for rows.Next() {
		var d voicemailDrop
		if err := rows.Scan(&d.ID, &d.TeamID, &d.Name, &d.AudioURL); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// dropURL is the recording of a voicemail message the agent picked, if it is the agency's.
func (s *server) dropURL(ctx context.Context, org, id string) (string, error) {
	var url string
	err := s.st.db.QueryRow(ctx, `SELECT audio_url FROM voicemail_drops WHERE id = $1 AND org_id = $2`, id, org).Scan(&url)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", bad("That voicemail message does not exist.")
	}
	return url, err
}

// ---- callbacks due while their agent is away (D153) ----

// checkCallbacks tells the team's leads and deputies about a callback that came due while its agent was not available and has
// waited the agency's wait. It stays with the agent, flagged overdue in the CRM; the leads can give that one call to someone else.
func (s *server) checkCallbacks(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `SELECT c.id::text, c.org_id::text, c.user_id::text, c.lead_id::text FROM calls c
		LEFT JOIN sms_settings x ON x.org_id = c.org_id
		WHERE c.disposition = 'Callback' AND c.callback_at IS NOT NULL AND c.lead_id IS NOT NULL
			AND c.callback_at <= $1::timestamptz - make_interval(mins => coalesce(x.wait_minutes, 15))
			AND c.callback_at > $1::timestamptz - interval '7 days'
			AND NOT EXISTS (SELECT 1 FROM callback_alerts a WHERE a.call_id = c.id)
			AND NOT EXISTS (SELECT 1 FROM calls later WHERE later.lead_id = c.lead_id AND later.created_at > c.callback_at - interval '1 hour')
		LIMIT 200`, s.now())
	if err != nil {
		return err
	}
	type due struct{ id, org, agent, lead string }
	list := []due{}
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.org, &d.agent, &d.lead); err != nil {
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
		status, err := s.statusOf(ctx, d.org, d.agent)
		if err != nil {
			return err
		}
		if status == "available" || status == "on_call" {
			continue // they are at work: it is theirs to make
		}
		_, t, err := s.leadThread(ctx, scope{userID: d.agent, orgID: d.org}, d.lead)
		if err != nil {
			log.Printf("WARN callback %s: %v", d.id, err)
			continue
		}
		told := append(append([]string{}, t.TeamLeads...), t.TeamDeputies...)
		if _, err := s.st.db.Exec(ctx, `INSERT INTO callback_alerts (call_id, told_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`, d.id, s.now()); err != nil {
			return err
		}
		if len(told) > 0 {
			if err := s.alert(ctx, d.org, d.lead, "callback", told); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *server) checkCallbacksPeriodically(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.checkCallbacks(ctx); err != nil {
				log.Printf("WARN callbacks due: %v", err)
			}
			if err := s.forgetOldCalls(ctx); err != nil {
				log.Printf("WARN removing old captions: %v", err)
			}
		}
	}
}

var _ = http.StatusOK
