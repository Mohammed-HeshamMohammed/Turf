package main

// Leads and teams (build step 20, part one): each team's settings, its unassigned leads, and claiming them.
//
//   - A team's leads, an admin or the owner change its settings (D348); everyone in the team reads them.
//   - A team's leads and deputies hand out its unassigned leads; its agents may claim them too when the team allows it (D111), up to
//     the team's limit of open leads each (D183).

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
)

type teamSettings struct {
	TeamID      string `json:"team_id"`
	AgentsClaim bool   `json:"agents_claim"`
	OpenLimit   *int   `json:"open_limit"`
	Leaderboard bool   `json:"leaderboard"`
	// AgentsSeeTeam lets the team's agents see all its leads, read-only (D124).
	AgentsSeeTeam bool `json:"agents_see_team"`
}

func loadTeamSettings(ctx context.Context, tx pgx.Tx, team string) (teamSettings, error) {
	ts := teamSettings{TeamID: team}
	err := tx.QueryRow(ctx, `SELECT agents_claim, open_limit, leaderboard, agents_see_team FROM team_settings WHERE team_id = $1`, team).Scan(&ts.AgentsClaim, &ts.OpenLimit, &ts.Leaderboard, &ts.AgentsSeeTeam)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return ts, err
}

// runsTeam is whether the person runs this team: its lead, an admin or the owner (who see the whole workspace).
func runsTeam(sc scope, g grantReply, team string) bool {
	return slices.Contains(sc.scopes, "organization") || slices.Contains(g.ManagedTeamIDs, team)
}

// inTeam is whether the person works in, leads or deputises this team.
func inTeam(sc scope, g grantReply, team string) bool {
	return runsTeam(sc, g, team) || slices.Contains(sc.teamIDs, team) || slices.Contains(g.DeputyTeamIDs, team)
}

func (s *server) getTeamSettings(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) {
		return bad("Choose a team.")
	}
	if !inTeam(q.sc, q.grant, team) {
		return forbidden("This is not one of your teams.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ts, err := loadTeamSettings(ctx, tx, team)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"settings": ts, "can_change": runsTeam(q.sc, q.grant, team)})
	return nil
}

func (s *server) putTeamSettings(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) {
		return bad("Choose a team.")
	}
	if !runsTeam(q.sc, q.grant, team) {
		return forbidden("A team's leads, an admin or the owner change its settings.")
	}
	var body struct {
		AgentsClaim   *bool `json:"agents_claim"`
		AgentsSeeTeam *bool `json:"agents_see_team"`
		OpenLimit     *int  `json:"open_limit"` // 0 clears the limit
		Leaderboard   *bool `json:"leaderboard"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.OpenLimit != nil && (*body.OpenLimit < 0 || *body.OpenLimit > 100000) {
		return bad("Choose a limit of open leads from 1 to 100000, or 0 for none.")
	}
	ctx := q.r.Context()
	// The team must be in the CRM's copy of the tree before it can have settings.
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
	var known bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE id = $1)`, team).Scan(&known); err != nil {
		return err
	}
	if !known {
		return notFound("That team is not in this workspace.")
	}
	ts, err := loadTeamSettings(ctx, tx, team)
	if err != nil {
		return err
	}
	if body.AgentsClaim != nil {
		ts.AgentsClaim = *body.AgentsClaim
	}
	if body.Leaderboard != nil {
		ts.Leaderboard = *body.Leaderboard
	}
	if body.AgentsSeeTeam != nil {
		ts.AgentsSeeTeam = *body.AgentsSeeTeam
	}
	if body.OpenLimit != nil {
		ts.OpenLimit = body.OpenLimit
		if *body.OpenLimit == 0 {
			ts.OpenLimit = nil
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO team_settings (team_id, org_id, agents_claim, open_limit, leaderboard, updated_by, updated_at, agents_see_team)
		VALUES ($1, cw_org(), $2, $3, $4, $5, now(), $6)
		ON CONFLICT (team_id) DO UPDATE SET agents_claim = EXCLUDED.agents_claim, open_limit = EXCLUDED.open_limit, leaderboard = EXCLUDED.leaderboard, agents_see_team = EXCLUDED.agents_see_team,
			updated_by = EXCLUDED.updated_by, updated_at = now()`, team, ts.AgentsClaim, ts.OpenLimit, ts.Leaderboard, q.sc.userID, ts.AgentsSeeTeam); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"settings": ts})
	return nil
}

// teamPool lists a team's unassigned leads, newest last, for those who hand them out and, when the team allows it, its agents.
// It shows what is needed to choose one, not the whole record.
func (s *server) teamPool(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) {
		return bad("Choose a team.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ts, err := loadTeamSettings(ctx, tx, team)
	if err != nil {
		return err
	}
	handsOut := runsTeam(q.sc, q.grant, team) || slices.Contains(q.grant.DeputyTeamIDs, team)
	if !handsOut && !(slices.Contains(q.sc.teamIDs, team) && ts.AgentsClaim) {
		return forbidden("This team's unassigned leads are handed out by its leads.")
	}
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', l.id, 'name', l.name, 'stage', l.stage, 'source', l.source, 'priority', l.priority, 'created_at', l.created_at)
		FROM leads l WHERE l.team_id = $1 AND l.assignee_id IS NULL AND l.deleted_at IS NULL AND l.archived_at IS NULL
		ORDER BY l.created_at LIMIT 500`, team)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"leads": rows, "settings": ts, "hands_out": handsOut})
	return nil
}

// leadClaim gives an unassigned lead of a team to the person asking (D111): its leads and deputies always, its agents when the team
// lets them, and an agent only below the team's limit of open leads (D183).
func (r *run) leadClaim(p map[string]any) (any, error) {
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	// An unassigned lead is not yet visible to an agent; row security still keeps this to the workspace, and the checks below decide.
	before, err := r.one(`SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if before == nil || !isNull(before["deleted_at"]) || !isNull(before["archived_at"]) {
		return nil, reject("That lead is not open")
	}
	if asString(before["assignee_id"]) != "" {
		return nil, reject("Someone already holds this lead")
	}
	team := asString(before["team_id"])
	if team == "" {
		return nil, reject("Only a team's unassigned leads can be claimed")
	}
	g, err := r.s.rules.grant(r.ctx, r.sc.userID, r.sc.orgID, r.sc.secondStep)
	if err != nil {
		return nil, err
	}
	handsOut := runsTeam(r.sc, g, team) || slices.Contains(g.DeputyTeamIDs, team)
	if !handsOut {
		if !slices.Contains(r.sc.teamIDs, team) {
			return nil, reject("That lead belongs to a team you are not in")
		}
		ts, err := loadTeamSettings(r.ctx, r.tx, team)
		if err != nil {
			return nil, err
		}
		if !ts.AgentsClaim {
			return nil, reject("In this team the leads hand out unassigned leads")
		}
		if ts.OpenLimit != nil {
			var open int
			if err := r.tx.QueryRow(r.ctx, `SELECT count(*) FROM leads WHERE team_id = $1 AND assignee_id = $2 AND stage <> 'Closed' AND archived_at IS NULL AND deleted_at IS NULL`, team, r.sc.userID).Scan(&open); err != nil {
				return nil, err
			}
			if open >= *ts.OpenLimit {
				return nil, reject("You hold %d open leads in this team, its limit. Finish or release some first", open)
			}
		}
	}
	if err = r.exec(`UPDATE leads SET assignee_id = $2, version = version + 1, updated_at = now() WHERE id = $1`, id, r.sc.userID); err != nil {
		return nil, err
	}
	if err = r.exec(`INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id) VALUES (cw_org(), $1, NULL, $2, 'claimed', $2)`, id, r.sc.userID); err != nil {
		return nil, err
	}
	after, err := r.one(`SELECT to_jsonb(l) FROM leads l WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	if err = r.record(change{entity: "lead", kind: "lead.assigned", id: id, leadID: id, before: before, after: after}); err != nil {
		return nil, err
	}
	return redactLead(after, r.sc), nil
}
