package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Build step 16, part B. Each team has one chat that follows the team: its leads, deputy leads and the people placed in it join
// and leave as authz changes them, and nobody leaves it while they are in the team; they can mute it (D52, D185). The agency has
// one announcements channel with everyone in it; only the owner, admins and team leads post there, and they can mark a post
// important (D74, D350). The service keeps both in step with authz's roster whenever someone in the workspace uses chat.

const (
	announcementsTitle = "Announcements"
	// largeGroup is the size from which only the owner, admins and team leads may use @everyone (D86).
	largeGroup = 30
	// resync is how long a workspace's chats count as in step before they are checked again even when nothing seemed to change,
	// so a second copy of the service changing them in between is caught up with.
	resync = time.Minute
)

// inside is someone who belongs to the agency's own chats: anyone with a role other than client.
func inside(m member) bool {
	return slices.ContainsFunc(m.Roles, func(r string) bool { return r != "client" })
}

// leads are the people who may post announcements, mark them important and use @everyone anywhere: the owner, admins and team
// leads (a team lead role, or leading a team).
func (r roster) leads() map[string]bool {
	out := map[string]bool{}
	for _, m := range r.Members {
		if slices.ContainsFunc(m.Roles, func(x string) bool { return x == "owner" || x == "solo" || x == "admin" || x == "manager" }) {
			out[strings.ToLower(m.UserID)] = true
		}
	}
	for _, t := range r.Teams {
		for _, id := range t.ManagerIDs {
			out[strings.ToLower(id)] = true
		}
	}
	return out
}

// teamPeople are the people a team chat holds: the team's leads, deputies and members, only those still in the agency's chats.
func (r roster) teamPeople(t team) []string {
	in := map[string]bool{}
	for _, m := range r.Members {
		if inside(m) {
			in[strings.ToLower(m.UserID)] = true
		}
	}
	out := []string{}
	add := func(id string) {
		if id = strings.ToLower(id); in[id] && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	for _, id := range append(slices.Clone(t.ManagerIDs), t.DeputyIDs...) {
		add(id)
	}
	for _, m := range r.Members {
		if slices.ContainsFunc(m.TeamIDs, func(x string) bool { return strings.EqualFold(x, t.TeamID) }) {
			add(m.UserID)
		}
	}
	slices.Sort(out)
	return out
}

// everyone is the people the announcements channel holds.
func (r roster) everyone() []string {
	out := []string{}
	for _, m := range r.Members {
		if inside(m) && validID(m.UserID) {
			out = append(out, strings.ToLower(m.UserID))
		}
	}
	slices.Sort(out)
	return out
}

type syncedAt struct {
	fingerprint string
	at          time.Time
}

// follow keeps the workspace's team chats and announcements channel in step with authz. It writes only when the roster
// changed since this copy of the service last did so (or a minute passed), so most requests cost one cached roster read.
func (s *server) follow(ctx context.Context, sc scope) error {
	r, err := s.rules.roster(ctx, sc.orgID)
	if err != nil {
		return err
	}
	teamIDs, names, people := []string{}, []string{}, []string{}
	var plan strings.Builder
	for _, t := range r.Teams {
		if !validID(t.TeamID) {
			continue
		}
		id := strings.ToLower(t.TeamID)
		teamIDs, names = append(teamIDs, id), append(names, t.Name)
		for _, u := range r.teamPeople(t) {
			people = append(people, id+"|"+u)
		}
		fmt.Fprintf(&plan, "%s=%s;", id, t.Name)
	}
	all := r.everyone()
	slices.Sort(people)
	fmt.Fprintf(&plan, "%s/%s", strings.Join(people, ","), strings.Join(all, ","))
	sum := sha256.Sum256([]byte(plan.String()))
	fingerprint := hex.EncodeToString(sum[:])
	if last, ok := s.synced.Load(sc.orgID); ok {
		if l := last.(syncedAt); l.fingerprint == fingerprint && s.now().Sub(l.at) < resync {
			return nil
		}
	}
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = syncChats(ctx, tx, sc, teamIDs, names, people, all); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.synced.Store(sc.orgID, syncedAt{fingerprint, s.now()})
	return nil
}

// syncChats makes the chats match the roster in one transaction: a chat for each team (named as the team is), the announcements
// channel, everyone who should be in them (a newcomer starts with nothing unread), and nobody who should not.
func syncChats(ctx context.Context, tx pgx.Tx, sc scope, teamIDs, names, people, all []string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('messaging-team-chats|' || cw_org()::text))`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO conversations (org_id, kind, title, team_id, created_by)
		SELECT cw_org(), 'team', n, t::uuid, cw_user() FROM unnest($1::text[], $2::text[]) AS x(t, n)
		ON CONFLICT (org_id, team_id) DO UPDATE SET title = EXCLUDED.title WHERE conversations.title <> EXCLUDED.title`, teamIDs, names); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO conversations (org_id, kind, title, created_by) VALUES (cw_org(), 'announcements', $1, cw_user())
		ON CONFLICT (org_id) WHERE kind = 'announcements' DO NOTHING`, announcementsTitle); err != nil {
		return err
	}
	pairTeams, pairUsers := make([]string, 0, len(people)), make([]string, 0, len(people))
	for _, p := range people {
		t, u, _ := strings.Cut(p, "|")
		pairTeams, pairUsers = append(pairTeams, t), append(pairUsers, u)
	}
	const wanted = `SELECT c.id AS conversation_id, x.u::uuid AS user_id FROM unnest($1::text[], $2::text[]) AS x(t, u)
			JOIN conversations c ON c.org_id = cw_org() AND c.kind = 'team' AND c.team_id = x.t::uuid
		UNION SELECT c.id, u::uuid FROM conversations c, unnest($3::text[]) AS u WHERE c.org_id = cw_org() AND c.kind = 'announcements'`
	rows, err := tx.Query(ctx, `WITH wanted AS (`+wanted+`),
		joined AS (
			INSERT INTO members (conversation_id, user_id, org_id, last_read_seq)
			SELECT w.conversation_id, w.user_id, cw_org(), c.last_seq FROM wanted w JOIN conversations c ON c.id = w.conversation_id
			ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now(), last_read_seq = EXCLUDED.last_read_seq, role = 'member'
			WHERE members.left_at IS NOT NULL
			RETURNING conversation_id, user_id, false AS gone),
		left_ AS (
			UPDATE members m SET left_at = now() FROM conversations c
			WHERE c.id = m.conversation_id AND c.org_id = cw_org() AND c.kind IN ('team', 'announcements') AND m.left_at IS NULL
			  AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.conversation_id = m.conversation_id AND w.user_id = m.user_id)
			RETURNING m.conversation_id, m.user_id, true AS gone)
		SELECT conversation_id::text, coalesce(array_agg(user_id::text) FILTER (WHERE gone), '{}') FROM (SELECT * FROM joined UNION ALL SELECT * FROM left_) x
		GROUP BY conversation_id`, pairTeams, pairUsers, all)
	if err != nil {
		return err
	}
	type change struct {
		conversation string
		gone         []string
	}
	changes := []change{}
	for rows.Next() {
		var c change
		if err = rows.Scan(&c.conversation, &c.gone); err != nil {
			rows.Close()
			return err
		}
		changes = append(changes, c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	// Whoever joined or left hears about it, as do the people already there (the member list changed).
	for _, c := range changes {
		if err = announce(ctx, tx, sc, c.conversation, "conversation", nil, c.gone...); err != nil {
			return err
		}
	}
	return nil
}

// mentionGroups turns @everyone, @managers, @team and @team:<id> into the people in the conversation they reach, and checks who
// may use them: in the announcements channel and in large groups only the owner, admins and team leads use @everyone (D86).
func mentionGroups(r roster, sc scope, kind, teamID string, members []string, groups []string) (people, used []string, err error) {
	leads := r.leads()
	in := func(ids ...string) {
		for _, id := range ids {
			if id = strings.ToLower(id); id != sc.userID && slices.Contains(members, id) && !slices.Contains(people, id) {
				people = append(people, id)
			}
		}
	}
	teamOf := func(id string) (team, bool) {
		for _, t := range r.Teams {
			if strings.EqualFold(t.TeamID, id) {
				return t, true
			}
		}
		return team{}, false
	}
	people, used = []string{}, []string{}
	for _, g := range groups {
		g = strings.ToLower(strings.TrimSpace(g))
		if slices.Contains(used, g) {
			continue
		}
		switch {
		case g == "everyone":
			if (kind == "announcements" || len(members) > largeGroup) && !leads[sc.userID] {
				return nil, nil, forbidden("Here only the owner, admins and team leads can mention everyone.")
			}
			in(members...)
		case g == "managers":
			for id := range leads {
				in(id)
			}
			if t, ok := teamOf(teamID); ok && kind == "team" {
				in(t.DeputyIDs...)
			}
		case g == "team" || strings.HasPrefix(g, "team:"):
			id := strings.TrimPrefix(strings.TrimPrefix(g, "team"), ":")
			if id == "" {
				if kind != "team" {
					return nil, nil, bad("Name the team to mention (team:<id>); @team alone works in a team chat.")
				}
				id = teamID
			}
			t, ok := teamOf(id)
			if !ok {
				return nil, nil, bad("That team does not exist.")
			}
			in(r.teamPeople(t)...)
		default:
			return nil, nil, bad("Mention everyone, managers, team, or team:<id>.")
		}
		used = append(used, g)
	}
	return people, used, nil
}
