package crm

// Build step 26, part A (migrations/0033_scripts_reviews_ai.sql): calling scripts per client with a team's own version (D142), call
// review against the agency's checklist (D143), and the switches for the AI's call suggestions and captions (D148).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *server) scriptRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/scripts", s.member(s.listScripts))
	mux.Handle("POST /api/v1/scripts", s.member(s.saveScript))
	mux.Handle("PATCH /api/v1/scripts/{id}", s.member(s.saveScript))
	mux.Handle("DELETE /api/v1/scripts/{id}", s.member(s.archiveScript))
	mux.Handle("GET /api/v1/leads/{id}/script", s.member(s.leadScript))
	mux.Handle("POST /api/v1/calls/{id}/review", s.member(s.reviewCall))
	mux.Handle("GET /api/v1/calls/{id}/reviews", s.member(s.callReviews))
	mux.Handle("GET /api/v1/reviews/mine", s.member(s.myReviews))
	mux.Handle("GET /api/v1/teams/{id}/reviews", s.member(s.teamReviews))
	mux.Handle("GET /api/v1/ai-settings", s.member(s.aiSettings))
	mux.Handle("PUT /api/v1/ai-settings", s.member(s.aiSettings))
	mux.Handle("PUT /api/v1/teams/{id}/ai", s.member(s.teamAI))
	mux.Handle("PUT /api/v1/me/suggestions", s.member(s.hideSuggestions))
}

// isOwner is the agency's owner (or a solo operator), who switches the AI on (D148).
func isOwner(sc scope) bool {
	return slices.Contains(sc.roles, "owner") || slices.Contains(sc.roles, "solo")
}

// writesFor is whether the person writes a client's script: the owner or an admin, or a lead of a team working for that client (any
// team they lead, for the agency's own business).
func writesFor(ctx context.Context, tx pgx.Tx, q *req, client string) (bool, error) {
	if manages(q.sc) {
		return true, nil
	}
	if len(q.grant.ManagedTeamIDs) == 0 {
		return false, nil
	}
	if client == "" {
		return true, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM team_clients WHERE client_id = $1 AND team_id = ANY($2::uuid[]))`, client, q.grant.ManagedTeamIDs).Scan(&ok)
	return ok, err
}

// listScripts is GET /api/v1/scripts: the agency's scripts for whoever writes them; for everyone else, those of their own teams and the
// clients their teams work for.
func (s *server) listScripts(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not see calling scripts here.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	teams := slices.Concat(q.sc.teamIDs, q.grant.ManagedTeamIDs, q.grant.DeputyTeamIDs)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(x) FROM (SELECT id, client_id, team_id, name, body, updated_by, updated_at FROM scripts
		WHERE org_id = cw_org() AND archived_at IS NULL AND ($1 OR (team_id IS NULL OR team_id = ANY($2::uuid[]))
			AND (client_id IS NULL OR client_id IN (SELECT client_id FROM team_clients WHERE team_id = ANY($2::uuid[]))))
		ORDER BY client_id NULLS FIRST, team_id NULLS FIRST, name) x`, manages(q.sc), nonNil(teams))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"scripts": rows})
	return nil
}

// saveScript is POST /api/v1/scripts {client_id, team_id, name, body} and PATCH /api/v1/scripts/{id} {name, body}. A client's script
// is written by writesFor; a team's version only by that team's leads, an admin or the owner, and only for a client the team works for.
func (s *server) saveScript(q *req) error {
	var body struct {
		ClientID string `json:"client_id"`
		TeamID   string `json:"team_id"`
		Name     string `json:"name"`
		Body     string `json:"body"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	name, text := strings.TrimSpace(body.Name), strings.TrimSpace(body.Body)
	if name == "" || len(name) > 120 || text == "" || len(text) > 20000 {
		return bad("Name the script (up to 120 characters) and write it (up to 20,000).")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id := q.r.PathValue("id")
	if id != "" {
		if !validID(id) {
			return notFound("No such script.")
		}
		var client, team *string
		if err := tx.QueryRow(ctx, `SELECT client_id::text, team_id::text FROM scripts WHERE id = $1 AND archived_at IS NULL`, id).Scan(&client, &team); err != nil {
			return notFound("No such script.")
		}
		body.ClientID, body.TeamID = deref(client), deref(team)
	}
	if (body.ClientID != "" && !validID(body.ClientID)) || (body.TeamID != "" && !validID(body.TeamID)) {
		return bad("client_id and team_id are ids.")
	}
	if body.TeamID == "" {
		ok, err := writesFor(ctx, tx, q, body.ClientID)
		if err != nil {
			return err
		}
		if !ok {
			return forbidden("The owner, admins and the team leads working for this client write its script.")
		}
	} else {
		if !runsTeam(q.sc, q.grant, body.TeamID) {
			return forbidden("Only the team's leads, an admin or the owner write the team's version.")
		}
		if body.ClientID != "" {
			var works bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM team_clients WHERE team_id = $1 AND client_id = $2)`, body.TeamID, body.ClientID).Scan(&works); err != nil {
				return err
			}
			if !works {
				return bad("That team does not work for this client.")
			}
		}
	}
	var rows []json.RawMessage
	if id != "" {
		rows, err = queryJSON(ctx, tx, `UPDATE scripts SET name = $2, body = $3, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING to_jsonb(scripts.*)`, id, name, text, q.sc.userID)
	} else {
		rows, err = queryJSON(ctx, tx, `INSERT INTO scripts (org_id, client_id, team_id, name, body, updated_by) VALUES (cw_org(), $1, $2, $3, $4, $5) RETURNING to_jsonb(scripts.*)`,
			nullID(body.ClientID), nullID(body.TeamID), name, text, q.sc.userID)
	}
	if err != nil {
		if isUnique(err) {
			return &apiError{http.StatusConflict, "conflict", "This client (or team) already has a script: change that one."}
		}
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// archiveScript is DELETE /api/v1/scripts/{id}: put away by whoever may write it.
func (s *server) archiveScript(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such script.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var client, team *string
	if err := tx.QueryRow(ctx, `SELECT client_id::text, team_id::text FROM scripts WHERE id = $1 AND archived_at IS NULL`, id).Scan(&client, &team); err != nil {
		return notFound("No such script.")
	}
	ok := team != nil && runsTeam(q.sc, q.grant, *team)
	if team == nil {
		if ok, err = writesFor(ctx, tx, q, deref(client)); err != nil {
			return err
		}
	}
	if !ok {
		return forbidden("Only whoever writes this script puts it away.")
	}
	if _, err = tx.Exec(ctx, `UPDATE scripts SET archived_at = now(), updated_by = $2 WHERE id = $1`, id, q.sc.userID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// scriptFor is the script for a lead: its team's version for the lead's client, else the client's own.
func scriptFor(ctx context.Context, tx pgx.Tx, client, team string) (json.RawMessage, error) {
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(x) FROM (SELECT id, client_id, team_id, name, body, updated_at FROM scripts
		WHERE org_id = cw_org() AND archived_at IS NULL AND client_id IS NOT DISTINCT FROM $1::uuid AND (team_id IS NULL OR team_id = $2::uuid)
		ORDER BY team_id NULLS LAST LIMIT 1) x`, nullID(client), nullID(team))
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// leadScript is GET /api/v1/leads/{id}/script: what to say to this lead, for whoever may see it.
func (s *server) leadScript(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not see calling scripts here.")
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such lead.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx}
	lead, err := r.lead(id, false)
	if err != nil {
		return err
	}
	if lead == nil {
		return notFound("The lead was not found, was deleted, or is outside your access.")
	}
	script, err := scriptFor(ctx, tx, asString(lead["client_id"]), asString(lead["team_id"]))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"script": script})
	return nil
}

// reviewCall is POST /api/v1/calls/{id}/review {scores: {item: 1-5}, comment}: a lead or deputy of the lead's team, an admin or the
// owner scores a call, never their own. Scoring again replaces their earlier review.
func (s *server) reviewCall(q *req) error {
	var body struct {
		Scores  map[string]int `json:"scores"`
		Comment string         `json:"comment"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if len(body.Comment) > 2000 {
		return bad("Keep the comment under 2,000 characters.")
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such call.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var agent, team *string
	err = tx.QueryRow(ctx, `SELECT c.agent_id::text, l.team_id::text FROM call_events c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, id).Scan(&agent, &team)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("No such call.")
	}
	if err != nil {
		return err
	}
	if !reviews(q, deref(team)) {
		return forbidden("A lead or deputy of the call's team, an admin or the owner reviews calls.")
	}
	if deref(agent) == q.sc.userID {
		return forbidden("Nobody reviews their own call.")
	}
	var checklist []string
	if err = tx.QueryRow(ctx, `SELECT review_checklist FROM orgs WHERE id = cw_org()`).Scan(&checklist); err != nil {
		return err
	}
	total := 0
	for item, v := range body.Scores {
		if !slices.Contains(checklist, item) || v < 1 || v > 5 {
			return bad("Score each item of the agency's checklist from 1 to 5.")
		}
		total += v
	}
	if len(body.Scores) == 0 {
		return bad("Score at least one item of the checklist.")
	}
	scores, _ := json.Marshal(body.Scores)
	rows, err := queryJSON(ctx, tx, `INSERT INTO call_reviews (org_id, call_id, agent_id, team_id, reviewer_id, scores, score, comment)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (call_id, reviewer_id) DO UPDATE SET scores = EXCLUDED.scores, score = EXCLUDED.score, comment = EXCLUDED.comment, updated_at = now()
		RETURNING to_jsonb(call_reviews.*)`, id, agent, team, q.sc.userID, scores, float64(total)/float64(len(body.Scores)), strings.TrimSpace(body.Comment))
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

// reviews is whether the person reviews calls of a team.
func reviews(q *req, team string) bool {
	return manages(q.sc) || (team != "" && (slices.Contains(q.grant.ManagedTeamIDs, team) || slices.Contains(q.grant.DeputyTeamIDs, team)))
}

// callReviews is GET /api/v1/calls/{id}/reviews: for the call's agent and its reviewers.
func (s *server) callReviews(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such call.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var agent, team *string
	if err := tx.QueryRow(ctx, `SELECT c.agent_id::text, l.team_id::text FROM call_events c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, id).Scan(&agent, &team); err != nil {
		return notFound("No such call.")
	}
	if deref(agent) != q.sc.userID && !reviews(q, deref(team)) {
		return forbidden("Only the call's agent and its reviewers see its reviews.")
	}
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(r.*) FROM call_reviews r WHERE r.call_id = $1 ORDER BY r.created_at`, id)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"reviews": rows})
	return nil
}

// myReviews is GET /api/v1/reviews/mine: the person's own scores and comments, newest first.
func (s *server) myReviews(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT to_jsonb(r.*) FROM call_reviews r WHERE r.agent_id = $1 ORDER BY r.created_at DESC LIMIT 200`, q.sc.userID)
	if err != nil {
		return err
	}
	var avg *float64
	if err := tx.QueryRow(ctx, `SELECT round(avg(score), 2)::float8 FROM call_reviews WHERE agent_id = $1`, q.sc.userID).Scan(&avg); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"reviews": rows, "average": avg})
	return nil
}

// teamReviews is GET /api/v1/teams/{id}/reviews?days=: the team's average and each agent's, for its leads and deputies, admins and the
// owner (the manager's reports).
func (s *server) teamReviews(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) || !reviews(q, team) {
		return forbidden("A team's leads and deputies, admins and the owner see its reviews.")
	}
	days := 30
	if d := atoiOr(q.r.URL.Query().Get("days"), 30); d >= 1 && d <= 366 {
		days = d
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	agents, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('agent_id', agent_id, 'reviews', count(*), 'average', round(avg(score), 2))
		FROM call_reviews WHERE team_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY agent_id ORDER BY avg(score)`, team, days)
	if err != nil {
		return err
	}
	var avg *float64
	var n int
	if err := tx.QueryRow(ctx, `SELECT round(avg(score), 2)::float8, count(*) FROM call_reviews WHERE team_id = $1 AND created_at > now() - make_interval(days => $2)`, team, days).Scan(&avg, &n); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"team_id": team, "days": days, "average": avg, "reviews": n, "agents": agents})
	return nil
}

// aiSettings is GET /api/v1/ai-settings (anyone in the agency: what is on, and the checklist) and PUT (the owner switches the AI's call
// suggestions and required captions; the owner or an admin sets the review checklist).
func (s *server) aiSettings(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not change the agency's settings.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if q.r.Method == http.MethodPut {
		var body struct {
			AISuggestions    *bool    `json:"ai_suggestions"`
			CaptionsRequired *bool    `json:"captions_required"`
			ReviewChecklist  []string `json:"review_checklist"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		if (body.AISuggestions != nil || body.CaptionsRequired != nil) && !isOwner(q.sc) {
			return forbidden("The owner switches the AI's call suggestions and captions.")
		}
		if body.ReviewChecklist != nil {
			if !manages(q.sc) {
				return forbidden("The owner or an admin sets the review checklist.")
			}
			if len(body.ReviewChecklist) == 0 || len(body.ReviewChecklist) > 12 {
				return bad("A checklist has 1 to 12 items.")
			}
			for i, item := range body.ReviewChecklist {
				body.ReviewChecklist[i] = strings.TrimSpace(item)
				if body.ReviewChecklist[i] == "" || len(body.ReviewChecklist[i]) > 120 {
					return bad("Each checklist item is up to 120 characters.")
				}
			}
		}
		list, _ := json.Marshal(body.ReviewChecklist)
		if _, err := tx.Exec(ctx, `UPDATE orgs SET ai_suggestions = coalesce($1, ai_suggestions), captions_required = coalesce($2, captions_required),
			review_checklist = CASE WHEN $3::jsonb = 'null' THEN review_checklist ELSE $3::jsonb END WHERE id = cw_org()`,
			body.AISuggestions, body.CaptionsRequired, string(list)); err != nil {
			return err
		}
	}
	var on, captions bool
	var checklist json.RawMessage
	if err := tx.QueryRow(ctx, `SELECT ai_suggestions, captions_required, review_checklist FROM orgs WHERE id = cw_org()`).Scan(&on, &captions, &checklist); err != nil {
		return err
	}
	var hidden bool
	_ = tx.QueryRow(ctx, `SELECT hide_suggestions FROM people WHERE user_id = $1`, q.sc.userID).Scan(&hidden)
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ai_suggestions": on, "captions_required": captions, "review_checklist": checklist, "hidden_for_me": hidden})
	return nil
}

// teamAI is PUT /api/v1/teams/{id}/ai {ai_suggestions: false|null}: a team's leads switch the suggestions off for their team, or back
// to the agency's choice.
func (s *server) teamAI(q *req) error {
	team := q.r.PathValue("id")
	if !validID(team) || !runsTeam(q.sc, q.grant, team) {
		return forbidden("A team's leads, an admin or the owner change its settings.")
	}
	var body struct {
		AISuggestions *bool `json:"ai_suggestions"`
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
	tag, err := tx.Exec(ctx, `INSERT INTO team_settings (team_id, org_id, ai_suggestions, updated_by) SELECT $1, cw_org(), $2, $3 WHERE EXISTS (SELECT 1 FROM teams WHERE id = $1)
		ON CONFLICT (team_id) DO UPDATE SET ai_suggestions = EXCLUDED.ai_suggestions, updated_by = EXCLUDED.updated_by, updated_at = now()`, team, body.AISuggestions, q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("That team is not in this workspace.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"team_id": team, "ai_suggestions": body.AISuggestions})
	return nil
}

// hideSuggestions is PUT /api/v1/me/suggestions {hidden}: the person hides the AI's suggestions on their own screen. Captions the
// agency requires keep running.
func (s *server) hideSuggestions(q *req) error {
	var body struct {
		Hidden bool `json:"hidden"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if _, err := s.st.db.Exec(q.r.Context(), `INSERT INTO people (user_id, hide_suggestions) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET hide_suggestions = EXCLUDED.hide_suggestions`, q.sc.userID, body.Hidden); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"hidden": body.Hidden})
	return nil
}

// callAI is what the dialer is told for a lead's calls: whether the AI's suggestions show to this person, and whether captions must run.
func callAI(ctx context.Context, tx pgx.Tx, user, team string) (suggest, captions bool, err error) {
	err = tx.QueryRow(ctx, `SELECT o.ai_suggestions AND coalesce(ts.ai_suggestions, true) AND NOT coalesce((SELECT hide_suggestions FROM people WHERE user_id = $2), false),
			o.captions_required
		FROM orgs o LEFT JOIN team_settings ts ON ts.team_id = $1::uuid WHERE o.id = cw_org()`, nullID(team), user).Scan(&suggest, &captions)
	return
}

func isUnique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func atoiOr(s string, fallback int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return fallback
}
