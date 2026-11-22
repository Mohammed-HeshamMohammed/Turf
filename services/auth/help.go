package main

// (database_setup/0033_help_support.sql): help and feedback.
//   - A support conversation between an agency's owner or admins and Caller Whale's staff; members ask their owner (D292).
//   - "What's new" notes by role, each seen once; owners see every note; a note tied to a switch shows where it is on (D293, D309).
//   - Early features the owner switches on for the agency, kept in authz with the other switches (D294).
//   - "Send feedback" with the page and the app version, never lead data (D295).
// The help pages themselves are on the website (/help), searchable there.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *server) helpRoutes(mux *http.ServeMux) {
	mux.Handle("GET /v1/orgs/{org}/support-chats", serve(s.agencySupportChats))
	mux.Handle("POST /v1/orgs/{org}/support-chats", serve(s.agencySupportChats))
	mux.Handle("GET /v1/support-chats/{id}", serve(s.supportChat))
	mux.Handle("POST /v1/support-chats/{id}/messages", serve(s.supportReply))
	mux.Handle("POST /v1/support-chats/{id}/close", serve(s.supportClose))
	mux.Handle("GET /v1/admin/support-chats", serve(s.staffSupportChats))

	mux.Handle("GET /v1/whats-new", serve(s.whatsNew))
	mux.Handle("POST /v1/whats-new/{id}/seen", serve(s.whatsNewSeen))
	mux.Handle("GET /v1/admin/whats-new", serve(s.staffWhatsNew))
	mux.Handle("POST /v1/admin/whats-new", serve(s.staffWhatsNew))
	mux.Handle("DELETE /v1/admin/whats-new/{id}", serve(s.staffDeleteNote))

	mux.Handle("GET /v1/orgs/{org}/early-features", serve(s.earlyFeatures))
	mux.Handle("PUT /v1/orgs/{org}/early-features/{name}", serve(s.earlyFeatures))

	mux.Handle("POST /v1/feedback", serve(s.sendFeedback))
	mux.Handle("GET /v1/admin/feedback", serve(s.staffFeedback))
	mux.Handle("POST /v1/admin/feedback/{id}/handled", serve(s.staffFeedbackHandled))
}

// ---- support conversations ----

// agencyManager is the person, signed in, as the agency's owner or an admin; others are sent to their owner.
func (s *server) agencyManager(r *http.Request, org string) (claims, []string, error) {
	if _, err := uuid.Parse(org); err != nil {
		return claims{}, nil, bad("Choose a valid workspace.")
	}
	c, err := s.person(r)
	if err != nil {
		return claims{}, nil, err
	}
	roles, err := s.memberRoles(r, org, c.Sub)
	if err != nil {
		return claims{}, nil, err
	}
	if roles == nil {
		return claims{}, nil, newError(http.StatusNotFound, "not_found", "No such workspace.")
	}
	if !slices.ContainsFunc(roles, func(x string) bool { return x == "owner" || x == "solo" || x == "admin" }) {
		return claims{}, nil, forbidden("Support talks with the agency's owner and admins. Ask your owner, or read the help pages.")
	}
	return c, roles, nil
}

// agencySupportChats is GET (the agency's conversations) and POST {subject, body} (a new one) on /v1/orgs/{org}/support-chats.
func (s *server) agencySupportChats(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	c, _, err := s.agencyManager(r, org)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if r.Method == http.MethodPost {
		var body struct {
			Subject string `json:"subject"`
			Body    string `json:"body"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		subject, text := strings.TrimSpace(body.Subject), strings.TrimSpace(body.Body)
		if len(subject) < 3 || len(subject) > 150 || text == "" || len(text) > 5000 {
			return bad("Give a subject (3 to 150 characters) and your message (up to 5,000).")
		}
		var open int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM support_threads WHERE org_id = $1 AND status = 'open'`, org).Scan(&open); err != nil {
			return err
		}
		if open >= 10 {
			return newError(http.StatusTooManyRequests, "too_many", "The agency has 10 open conversations. Close one, or add to it.")
		}
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		var id string
		if err := tx.QueryRow(ctx, `INSERT INTO support_threads (org_id, opened_by, subject) VALUES ($1, $2, $3) RETURNING id::text`, org, c.Sub, subject).Scan(&id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO support_messages (thread_id, author_id, from_staff, body) VALUES ($1, $2, false, $3)`, id, c.Sub, text); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, map[string]any{"id": id})
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT jsonb_build_object('id', id, 'subject', subject, 'status', status, 'waiting_on', waiting_on, 'created_at', created_at, 'updated_at', updated_at)
		FROM support_threads WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 200`, org)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": list})
	return nil
}

// chatAccess is who may read a conversation: staff, or the owner and admins of its agency. It returns whether they are staff.
func (s *server) chatAccess(r *http.Request, id string) (c claims, staff bool, org, openedBy, status string, err error) {
	if _, err := uuid.Parse(id); err != nil {
		return claims{}, false, "", "", "", newError(http.StatusNotFound, "not_found", "No such conversation.")
	}
	err = s.db.QueryRow(r.Context(), `SELECT org_id::text, opened_by::text, status FROM support_threads WHERE id = $1`, id).Scan(&org, &openedBy, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return claims{}, false, "", "", "", newError(http.StatusNotFound, "not_found", "No such conversation.")
	}
	if err != nil {
		return claims{}, false, "", "", "", err
	}
	if c, err = s.staffActor(r, false); err == nil {
		return c, true, org, openedBy, status, nil
	}
	c, _, err = s.agencyManager(r, org)
	if err != nil {
		var api *apiError
		if errors.As(err, &api) && api.status == http.StatusForbidden {
			err = newError(http.StatusNotFound, "not_found", "No such conversation.")
		}
		return claims{}, false, "", "", "", err
	}
	return c, false, org, openedBy, status, nil
}

// supportChat is GET /v1/support-chats/{id}: the conversation with its messages.
func (s *server) supportChat(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	_, _, org, _, status, err := s.chatAccess(r, id)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT jsonb_build_object('id', m.id, 'from_staff', m.from_staff, 'author', CASE WHEN m.from_staff THEN 'Caller Whale' ELSE coalesce(u.display_name, '') END,
			'body', m.body, 'created_at', m.created_at)
		FROM support_messages m LEFT JOIN users u ON u.id::text = m.author_id::text WHERE m.thread_id = $1 ORDER BY m.created_at`, id)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "org_id": org, "status": status, "messages": list})
	return nil
}

// supportReply is POST /v1/support-chats/{id}/messages {body}. A staff reply emails whoever opened it; a closed one reopens.
func (s *server) supportReply(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	c, staff, _, openedBy, _, err := s.chatAccess(r, id)
	if err != nil {
		return err
	}
	var body struct {
		Body string `json:"body"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	text := strings.TrimSpace(body.Body)
	if text == "" || len(text) > 5000 {
		return bad("Write a message of up to 5,000 characters.")
	}
	ctx := r.Context()
	waiting := "staff"
	if staff {
		waiting = "agency"
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO support_messages (thread_id, author_id, from_staff, body) VALUES ($1, $2, $3, $4)`, id, c.Sub, staff, text); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE support_threads SET status = 'open', waiting_on = $2, updated_at = now() WHERE id = $1`, id, waiting); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if staff {
		s.tellOpener(ctx, openedBy, text)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (s *server) tellOpener(ctx context.Context, user, text string) {
	if s.mail == nil {
		return
	}
	var email string
	if err := s.db.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, user).Scan(&email); err != nil || email == "" {
		return
	}
	if len(text) > 600 {
		text = text[:600] + "…"
	}
	if err := s.mail.sendTemplate(ctx, "support_reply", email, map[string]any{"title": "Caller Whale support replied", "message": text,
		"link": strings.TrimRight(s.cfg.landingURL, "/") + "/dashboard/support"}); err != nil {
		log.Printf("WARN support reply email: %v", err)
	}
}

// supportClose is POST /v1/support-chats/{id}/close, by either side.
func (s *server) supportClose(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if _, _, _, _, _, err := s.chatAccess(r, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE support_threads SET status = 'closed', updated_at = now() WHERE id = $1`, id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// staffSupportChats is GET /v1/admin/support-chats?status=open|closed: the conversations, those waiting on staff first.
func (s *server) staffSupportChats(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}
	rows, err := s.db.Query(r.Context(), `SELECT jsonb_build_object('id', id, 'org_id', org_id, 'subject', subject, 'status', status, 'waiting_on', waiting_on,
			'created_at', created_at, 'updated_at', updated_at)
		FROM support_threads WHERE status = $1 ORDER BY (waiting_on = 'staff') DESC, updated_at LIMIT 500`, status)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": list})
	return nil
}

// ---- What's new ----

var noteRoles = []string{"owner", "admin", "manager", "caller", "closer", "researcher", "client"}

// whatsNew is GET /v1/whats-new?org=…&all=1: the notes for the person in that agency they have not seen (all=1: the last 50, seen
// or not). Owners see every note; others the ones for their roles; a note tied to a switch shows only where it is on.
func (s *server) whatsNew(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	org := r.URL.Query().Get("org")
	roles, features := []string{}, []string{}
	owner := false
	if org != "" {
		if _, err := uuid.Parse(org); err != nil {
			return bad("Choose a valid workspace.")
		}
		got, err := s.memberRoles(r, org, c.Sub)
		if err != nil {
			return err
		}
		if got == nil {
			return newError(http.StatusNotFound, "not_found", "No such workspace.")
		}
		roles = got
		owner = slices.Contains(roles, "owner") || slices.Contains(roles, "solo")
		if owner {
			roles = append(roles, "owner")
		}
		var about struct {
			Features []string `json:"features"`
		}
		if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org, nil, &about); err == nil {
			features = about.Features
		}
	}
	all := r.URL.Query().Get("all") == "1"
	rows, err := s.db.Query(r.Context(), `SELECT jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind, 'roles', n.roles, 'feature', n.feature,
			'published_at', n.published_at, 'seen', s.note_id IS NOT NULL)
		FROM whats_new n LEFT JOIN whats_new_seen s ON s.note_id = n.id AND s.user_id = $1
		WHERE n.published_at <= now() AND ($5 OR s.note_id IS NULL)
			AND ($4 OR cardinality(n.roles) = 0 OR n.roles && $2)
			AND (n.feature = '' OR n.feature = ANY($3))
		ORDER BY n.published_at DESC LIMIT 50`, c.Sub, roles, features, owner, all)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": list})
	return nil
}

// whatsNewSeen is POST /v1/whats-new/{id}/seen: the note does not show again.
func (s *server) whatsNewSeen(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		return newError(http.StatusNotFound, "not_found", "No such note.")
	}
	if _, err := s.db.Exec(r.Context(), `INSERT INTO whats_new_seen (user_id, note_id) SELECT $1, id FROM whats_new WHERE id = $2 ON CONFLICT DO NOTHING`, c.Sub, id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// staffWhatsNew is GET (every note) and POST {title, body, roles, feature, kind, published_at} on /v1/admin/whats-new.
func (s *server) staffWhatsNew(w http.ResponseWriter, r *http.Request) error {
	c, err := s.staffActor(r, false)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if r.Method == http.MethodPost {
		var body struct {
			Title   string   `json:"title"`
			Body    string   `json:"body"`
			Roles   []string `json:"roles"`
			Feature string   `json:"feature"`
			Kind    string   `json:"kind"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		title, text := strings.TrimSpace(body.Title), strings.TrimSpace(body.Body)
		if len(title) < 3 || len(title) > 120 || len(text) < 3 || len(text) > 4000 {
			return bad("Give a title (3 to 120 characters) and the note (up to 4,000).")
		}
		for _, role := range body.Roles {
			if !slices.Contains(noteRoles, role) {
				return bad("Roles are owner, admin, manager, caller, closer, researcher or client.")
			}
		}
		if body.Kind == "" {
			body.Kind = "feature"
		}
		if !slices.Contains([]string{"feature", "terms", "fix"}, body.Kind) {
			return bad("A note is a feature, terms or fix.")
		}
		if body.Roles == nil {
			body.Roles = []string{}
		}
		var id string
		if err := s.db.QueryRow(ctx, `INSERT INTO whats_new (title, body, roles, feature, kind, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
			title, text, body.Roles, strings.TrimSpace(body.Feature), body.Kind, c.Sub).Scan(&id); err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, map[string]any{"id": id})
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind, 'roles', n.roles, 'feature', n.feature,
			'published_at', n.published_at, 'seen_by', (SELECT count(*) FROM whats_new_seen s WHERE s.note_id = n.id))
		FROM whats_new n ORDER BY n.published_at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": list})
	return nil
}

func (s *server) staffDeleteNote(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		return newError(http.StatusNotFound, "not_found", "No such note.")
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM whats_new WHERE id = $1`, r.PathValue("id")); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// ---- early features (D294) ----

// earlyFeatures is GET /v1/orgs/{org}/early-features (the owner and admins) and PUT …/{name} {on} (the owner, with their second
// step): the switches authz lets owners turn on, each saying it may change.
func (s *server) earlyFeatures(w http.ResponseWriter, r *http.Request) error {
	org := r.PathValue("org")
	c, roles, err := s.agencyManager(r, org)
	if err != nil {
		return err
	}
	if r.Method == http.MethodPut {
		if !slices.Contains(roles, "owner") && !slices.Contains(roles, "solo") {
			return forbidden("Only the owner switches early features on.")
		}
		if !c.MFA {
			return newError(http.StatusForbidden, "mfa_required", "Confirm your identity with a second step first.")
		}
		var body struct {
			On bool `json:"on"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		if _, err := s.authzCall(r, http.MethodPut, "/v1/orgs/"+org+"/early-features/"+url.PathEscape(r.PathValue("name")),
			map[string]any{"on": body.On, "actor_id": c.Sub, "actor_second_step": c.MFA}, nil); err != nil {
			return err
		}
	}
	var out struct {
		Features []json.RawMessage `json:"features"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/early-features", nil, &out); err != nil {
		return err
	}
	if out.Features == nil {
		out.Features = []json.RawMessage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"features": out.Features})
	return nil
}

// ---- feedback (D295) ----

var (
	idInPath     = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,}`)
	versionShape = regexp.MustCompile(`^[0-9A-Za-z.+_-]{0,60}$`)
)

// cleanPage keeps only the page's path, with ids and numbers taken out, so no lead is named.
func cleanPage(page string) string {
	if u, err := url.Parse(strings.TrimSpace(page)); err == nil {
		page = u.Path
	}
	page = idInPath.ReplaceAllString(page, ":id")
	if len(page) > 300 {
		page = page[:300]
	}
	return page
}

// sendFeedback is POST /v1/feedback {note, page, version, org_id}: at most 20 a day per person.
func (s *server) sendFeedback(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Note    string `json:"note"`
		Page    string `json:"page"`
		Version string `json:"version"`
		OrgID   string `json:"org_id"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	note := strings.TrimSpace(body.Note)
	if len(note) < 3 || len(note) > 3000 {
		return bad("Write your feedback (3 to 3,000 characters).")
	}
	if !versionShape.MatchString(body.Version) {
		body.Version = ""
	}
	var org any
	if _, err := uuid.Parse(body.OrgID); err == nil {
		org = body.OrgID
	}
	ctx := r.Context()
	var today int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM feedback WHERE user_id = $1 AND created_at > now() - interval '1 day'`, c.Sub).Scan(&today); err != nil {
		return err
	}
	if today >= 20 {
		return newError(http.StatusTooManyRequests, "too_many", "Thank you: that is plenty of feedback for today.")
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO feedback (user_id, org_id, page, version, note) VALUES ($1, $2, $3, $4, $5)`, c.Sub, org, cleanPage(body.Page), body.Version, note); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
	return nil
}

// staffFeedback is GET /v1/admin/feedback?handled=1: the newest first, not yet handled unless asked.
func (s *server) staffFeedback(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT jsonb_build_object('id', f.id, 'from', coalesce(u.display_name, ''), 'org_id', f.org_id, 'page', f.page, 'version', f.version,
			'note', f.note, 'created_at', f.created_at, 'handled_at', f.handled_at)
		FROM feedback f LEFT JOIN users u ON u.id::text = f.user_id::text WHERE ($1 OR f.handled_at IS NULL) ORDER BY f.created_at DESC LIMIT 500`, r.URL.Query().Get("handled") == "1")
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"feedback": list})
	return nil
}

func (s *server) staffFeedbackHandled(w http.ResponseWriter, r *http.Request) error {
	c, err := s.staffActor(r, false)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		return newError(http.StatusNotFound, "not_found", "No such feedback.")
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE feedback SET handled_at = now(), handled_by = $2 WHERE id = $1`, r.PathValue("id"), c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
