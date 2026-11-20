package main

// The record of people changes (D58, D184): who invited, changed, suspended, restored or removed whom, which teams changed their
// leads or deputies, and who left. The owner and admins see all of it, a team lead their teams' part, and each person what was done
// to them, with the reason when one was written (D57). Kept two years; the lawyer may change it.

import (
	"context"
	"log"
	"net/http"
	"slices"
	"strconv"
	"time"
)

const peopleLogDays = 730

type peopleEntry struct {
	ID       int64          `json:"id"`
	At       int64          `json:"at"`
	ActorID  string         `json:"actor_id"`
	TargetID string         `json:"target_id"`
	Action   string         `json:"action"`
	Detail   map[string]any `json:"detail"`
	TeamIDs  []string       `json:"team_ids"`
}

func (p *postgres) logPeople(ctx context.Context, org string, e peopleEntry) error {
	if e.Detail == nil {
		e.Detail = map[string]any{}
	}
	if _, err := p.db.Exec(ctx, `INSERT INTO authz_people_log (org_id, at, actor_id, target_id, action, detail, team_ids) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		org, e.At, e.ActorID, e.TargetID, e.Action, e.Detail, nonNil(e.TeamIDs)); err != nil {
		return err
	}
	_, err := p.db.Exec(ctx, `DELETE FROM authz_people_log WHERE org_id = $1 AND at < $2`, org, e.At-int64(peopleLogDays*24*3600))
	return err
}

func (p *postgres) peopleLog(ctx context.Context, org string, since int64, limit int) ([]peopleEntry, error) {
	rows, err := p.db.Query(ctx, `SELECT id, at, actor_id, target_id, action, detail, team_ids FROM authz_people_log WHERE org_id = $1 AND at >= $2 ORDER BY at DESC, id DESC LIMIT $3`, org, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []peopleEntry{}
	for rows.Next() {
		var e peopleEntry
		if err := rows.Scan(&e.ID, &e.At, &e.ActorID, &e.TargetID, &e.Action, &e.Detail, &e.TeamIDs); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// record writes one change to people. A failure is logged, never fatal: the change itself already happened.
func (s *server) record(ctx context.Context, org, actor, target, action string, teams []string, detail map[string]any) {
	e := peopleEntry{At: s.now().Unix(), ActorID: actor, TargetID: target, Action: action, TeamIDs: teams, Detail: detail}
	if err := s.rules.logPeople(ctx, org, e); err != nil {
		log.Printf("WARN the record of people changes in %s: %v", org, err)
	}
}

// readPeopleLog answers GET /v1/orgs/{org}/people-log?viewer=<id>: the part of the record the viewer may see.
func (s *server) readPeopleLog(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	viewer := r.URL.Query().Get("viewer")
	if !validID(viewer) {
		return bad("Say who is asking (viewer).")
	}
	staff, err := s.rules.staffRole(r.Context(), viewer)
	if err != nil {
		return store(err)
	}
	f, err := s.rules.facts(r.Context(), viewer, org)
	if err != nil {
		return store(err)
	}
	all := staffBoss(staff) || slices.Contains(f.roles, "owner") || slices.Contains(f.roles, "solo") || slices.Contains(f.roles, "admin")
	if !all && !f.member {
		return forbidden("You are not a member of this workspace.")
	}
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days < 1 || days > peopleLogDays {
		days = 90
	}
	entries, err := s.rules.peopleLog(r.Context(), org, s.now().Add(-time.Duration(days)*24*time.Hour).Unix(), 1000)
	if err != nil {
		return store(err)
	}
	shown := []peopleEntry{}
	for _, e := range entries {
		mine := e.TargetID == viewer
		led := slices.ContainsFunc(e.TeamIDs, func(t string) bool { return slices.Contains(f.managed, t) })
		if all || mine || led {
			shown = append(shown, e)
		}
	}
	view := "mine"
	if all {
		view = "all"
	} else if len(f.managed) > 0 {
		view = "teams"
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": shown, "view": view})
	return nil
}
