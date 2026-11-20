package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Build step 4, with the change limits of step 15. Every person has a #tag after their name (Alex Morgan#K7P2), so two people never
// look the same in a search (D5, D14, D186); the screens show it only when two names on screen are the same (D187). The database
// gives tags and keeps name and tag unique (database_setup/0027_name_tags.sql); this file lets the person change theirs, sets
// the three privacy settings (D3, D30), and finds people by name or exact Name#tag.

var tagPattern = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{3,8}$`)

const (
	changesAllowed = 2           // name changes, and separately tag changes, in changeWindow (D29)
	changeWindow   = 30 * 86_400 // seconds
	// A new account sets its name in the first day without it counting: sign-up and the setup steps may both write it.
	settlingIn    = 86_400
	lookupsAnHour = 30 // exact Name#tag look-ups a person may make in an hour, so nobody can list everyone
)

// fullName is how a person is named where they must be told apart: Name#TAG.
func fullName(name, tag string) string {
	if tag == "" {
		return name
	}
	return name + "#" + tag
}

// changeAllowed says whether the person may change their name (what = "name") or tag again, and records the change when it is
// made (record). A brand-new account's first day does not count.
func (s *server) changeAllowed(ctx context.Context, q querier, user, what string, record bool) error {
	var created int64
	if err := q.QueryRow(ctx, "SELECT created_at FROM users WHERE id = $1", user).Scan(&created); err != nil {
		return err
	}
	if now()-created < settlingIn {
		return nil
	}
	var made int
	var oldest int64
	if err := q.QueryRow(ctx, "SELECT count(*), coalesce(min(at), 0) FROM name_changes WHERE user_id = $1 AND what = $2 AND at > $3", user, what, now()-changeWindow).Scan(&made, &oldest); err != nil {
		return err
	}
	if made >= changesAllowed {
		days := (oldest + changeWindow - now() + 86_399) / 86_400
		return newError(http.StatusTooManyRequests, "change_limit", fmt.Sprintf("Your %s can be changed twice in 30 days. You can change it again in %d days.", what, days))
	}
	if record {
		_, err := q.Exec(ctx, "INSERT INTO name_changes (user_id, what, at) VALUES ($1, $2, $3)", user, what, now())
		return err
	}
	return nil
}

// querier is the database pool or a transaction.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// changeTag answers POST /v1/me/tag {tag}: 3 to 8 letters and digits without 0, O, 1 and I, free with the person's name.
func (s *server) changeTag(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Tag string `json:"tag"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	tag := strings.ToUpper(strings.TrimPrefix(strings.TrimSpace(body.Tag), "#"))
	if !tagPattern.MatchString(tag) {
		return bad("A tag is 3 to 8 letters and digits. 0, O, 1 and I are left out because they look alike.")
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current string
	if err := tx.QueryRow(ctx, "SELECT tag FROM users WHERE id = $1 FOR UPDATE", c.Sub).Scan(&current); err != nil {
		return err
	}
	if tag != current {
		var taken bool
		if err := tx.QueryRow(ctx, "SELECT tag_taken(name_key, $2, id) FROM users WHERE id = $1", c.Sub, tag).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return conflict("Someone with your name already has that tag. Choose another.")
		}
		if err := s.changeAllowed(ctx, tx, c.Sub, "tag", true); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE users SET tag = $2 WHERE id = $1", c.Sub, tag); err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				return conflict("Someone with your name already has that tag. Choose another.")
			}
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"tag": tag})
	return nil
}

// seenTagNote answers POST /v1/me/tag-note: the one-time note about the new tag was read (D106).
func (s *server) seenTagNote(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET tag_note_seen = true WHERE id = $1", c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// putPrivacy answers PUT /v1/me/privacy {phone_visible, find_me, message_me}; anything left out stays as it is.
func (s *server) putPrivacy(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Phone   *string `json:"phone_visible"`
		FindMe  *string `json:"find_me"`
		Message *string `json:"message_me"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	check := func(v *string, allowed ...string) bool { return v == nil || slices.Contains(allowed, *v) }
	if !check(body.Phone, "nobody", "leads", "agencies") || !check(body.FindMe, "exact", "agencies") || !check(body.Message, "requests", "agencies", "nobody") {
		return bad("Choose one of the offered settings.")
	}
	var phone, find, message string
	if err := s.db.QueryRow(r.Context(), `UPDATE users SET phone_visible = coalesce($2, phone_visible), find_me = coalesce($3, find_me), message_me = coalesce($4, message_me)
		WHERE id = $1 RETURNING phone_visible, find_me, message_me`, c.Sub, body.Phone, body.FindMe, body.Message).Scan(&phone, &find, &message); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"phone_visible": phone, "find_me": find, "message_me": message})
	return nil
}

// agencyMates is everyone who shares a workspace with the person, and the workspaces they share, by person.
func (s *server) agencyMates(r *http.Request, user string) (map[string][]string, error) {
	profile, err := readAccess(r.Context(), s.cfg.authzURL, s.cfg.authzToken, user)
	if err != nil {
		return nil, errAccessUnavailable
	}
	mates := map[string][]string{}
	for _, ws := range profile.Workspaces {
		var listed struct {
			Members []member `json:"members"`
		}
		if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+ws.OrgID+"/members", nil, &listed); err != nil {
			return nil, err
		}
		for _, m := range listed.Members {
			if m.UserID != user {
				mates[m.UserID] = append(mates[m.UserID], ws.OrgID)
			}
		}
	}
	return mates, nil
}

// searchPeople answers GET /v1/people/search?q=. Part of a name finds people in the person's own agencies; a full Name#tag finds
// that one person anywhere, unless they chose to be found only in their agencies (D30). Exact look-ups are counted.
func (s *server) searchPeople(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	name, tag, exact := strings.Cut(q, "#")
	name, tag = strings.TrimSpace(name), strings.ToUpper(strings.TrimSpace(tag))
	if utf8.RuneCountInString(name) < 2 || utf8.RuneCountInString(name) > 120 || (exact && !tagPattern.MatchString(tag)) {
		return bad("Type at least two letters of a name, or a full name with its #tag.")
	}
	mates, err := s.agencyMates(r, c.Sub)
	if err != nil {
		return err
	}
	ctx := r.Context()
	found := []map[string]any{}
	add := func(rows pgx.Rows) error {
		defer rows.Close()
		for rows.Next() {
			var id, name, tag, avatar, find, message string
			if err := rows.Scan(&id, &name, &tag, &avatar, &find, &message); err != nil {
				return err
			}
			shared := len(mates[id]) > 0
			if !shared && find != "exact" {
				continue
			}
			// Whether they can be sent a message request (personal chats, steps 6 and 7 enforce it).
			request := message == "requests" || (message == "agencies" && shared)
			found = append(found, map[string]any{"id": id, "name": name, "tag": tag, "avatar": avatar, "in_my_agencies": shared, "can_request": request})
		}
		return rows.Err()
	}
	if exact {
		var made int
		if err := s.db.QueryRow(ctx, "SELECT count(*) FROM people_lookups WHERE user_id = $1 AND at > $2", c.Sub, now()-3600).Scan(&made); err != nil {
			return err
		}
		if made >= lookupsAnHour {
			return newError(http.StatusTooManyRequests, "lookup_limit", "Too many look-ups. Try again in an hour.")
		}
		if _, err := s.db.Exec(ctx, "INSERT INTO people_lookups (user_id, at) VALUES ($1, $2)", c.Sub, now()); err != nil {
			return err
		}
		rows, err := s.db.Query(ctx, `SELECT id, display_name, tag, avatar, find_me, message_me FROM users
			WHERE name_key = name_key($1) AND tag = $2 AND id <> $3 AND disabled_at IS NULL`, name, tag, c.Sub)
		if err != nil {
			return err
		}
		if err := add(rows); err != nil {
			return err
		}
	} else {
		ids := make([]string, 0, len(mates))
		for id := range mates {
			ids = append(ids, id)
		}
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(name)
		rows, err := s.db.Query(ctx, `SELECT id, display_name, tag, avatar, find_me, message_me FROM users
			WHERE id = ANY($1) AND disabled_at IS NULL AND name_key LIKE '%' || name_key($2) || '%' ORDER BY display_name, tag LIMIT 20`, ids, escaped)
		if err != nil {
			return err
		}
		if err := add(rows); err != nil {
			return err
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": found})
	return nil
}

// phoneShown is whether a member's phone number may be shown to this viewer in this workspace (D3, D22): the server leaves it out
// otherwise. leadOrAbove: the viewer is the agency's owner, an admin or a team lead there.
func phoneShown(setting string, leadOrAbove bool) bool {
	return setting == "agencies" || (setting == "leads" && leadOrAbove)
}
