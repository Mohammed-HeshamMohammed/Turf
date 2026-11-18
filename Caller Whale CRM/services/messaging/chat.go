package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxBody    = 8000 // characters in one message
	maxTitle   = 120
	maxMembers = 200
)

// announce queues a live update for everyone in the conversation (and anyone named in `also`, such as a person just removed),
// in the same transaction as the change itself. Each person hears it on their own channel.
func announce(ctx context.Context, tx pgx.Tx, sc scope, conversation, kind string, data map[string]any, also ...string) error {
	return queue(ctx, tx, sc, conversation, kind, data, `SELECT m.user_id::text FROM members m WHERE m.conversation_id = $1 AND m.left_at IS NULL UNION SELECT unnest($2::text[])`, conversation, also)
}

// tell queues a live update for the named people only (a person's own settings, told to their other devices).
func tell(ctx context.Context, tx pgx.Tx, sc scope, conversation, kind string, data map[string]any, users ...string) error {
	return queue(ctx, tx, sc, conversation, kind, data, `SELECT unnest($1::text[])`, users)
}

func queue(ctx context.Context, tx pgx.Tx, sc scope, conversation, kind string, data map[string]any, who string, args ...any) error {
	if data == nil {
		data = map[string]any{}
	}
	data["type"], data["org_id"], data["conversation_id"] = kind, sc.orgID, conversation
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}
	n := strconv.Itoa(len(args) + 1)
	if _, err = tx.Exec(ctx, `INSERT INTO outbox (method, payload)
		SELECT 'broadcast', jsonb_build_object('channels', coalesce(jsonb_agg('`+channelPrefix+`' || u), '[]'::jsonb), 'data', $`+n+`::jsonb)
		FROM (`+who+`) AS people(u)`, append(args, string(body))...); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `SELECT pg_notify('messaging_outbox', '')`)
	return err
}

func (s *server) listConversations(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := manyJSON(ctx, tx, `SELECT conversation_json(c) FROM conversations c
		JOIN members me ON me.conversation_id = c.id AND me.user_id = cw_user() AND me.left_at IS NULL
		ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 500`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"conversations": rows})
	return nil
}

// conversationJSON is the conversation as the person asking sees it, or "not found" when they are not in it.
func conversationJSON(ctx context.Context, tx pgx.Tx, id string) (json.RawMessage, error) {
	raw, ok, err := oneJSON(ctx, tx, `SELECT conversation_json(c) FROM conversations c WHERE c.id = $1 AND cw_member(c.id)`, id)
	if err == nil && !ok {
		err = notFound("That conversation does not exist.")
	}
	return raw, err
}

func (s *server) getConversation(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That conversation does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	raw, err := conversationJSON(ctx, tx, id)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, raw)
	return nil
}

// teammates checks that every id is someone else in the workspace, and returns them once each, in lower case.
func (s *server) teammates(ctx context.Context, sc scope, ids []string) ([]string, error) {
	roster, err := s.rules.members(ctx, sc.orgID)
	if err != nil {
		return nil, err
	}
	in := map[string]bool{}
	for _, m := range roster {
		in[strings.ToLower(m.UserID)] = true
	}
	out := []string{}
	for _, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == sc.userID || slices.Contains(out, id) {
			continue
		}
		if !validID(id) || !in[id] {
			return nil, bad("Everyone in a conversation must be a member of this workspace.")
		}
		out = append(out, id)
	}
	return out, nil
}

func (s *server) createConversation(q *req) error {
	var body struct {
		Kind      string   `json:"kind"`
		Title     string   `json:"title"`
		MemberIDs []string `json:"member_ids"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	others, err := s.teammates(ctx, q.sc, body.MemberIDs)
	if err != nil {
		return err
	}
	title := strings.TrimSpace(body.Title)
	var directKey *string
	switch body.Kind {
	case "direct":
		if len(others) != 1 {
			return bad("A direct chat is with one other person.")
		}
		pair := []string{q.sc.userID, others[0]}
		slices.Sort(pair)
		key := pair[0] + "|" + pair[1]
		directKey, title = &key, ""
	case "group":
		if title == "" || utf8.RuneCountInString(title) > maxTitle {
			return bad("Name the group (up to 120 characters).")
		}
		if len(others) < 1 || len(others) >= maxMembers {
			return bad("A group needs at least two members, and at most 200.")
		}
	default:
		return bad("Start a direct chat or a group.")
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	status := http.StatusCreated
	err = tx.QueryRow(ctx, `INSERT INTO conversations (org_id, kind, title, direct_key, created_by) VALUES (cw_org(), $1, $2, $3, cw_user())
		ON CONFLICT (org_id, direct_key) DO NOTHING RETURNING id::text`, body.Kind, title, directKey).Scan(&id)
	switch {
	case errors.Is(err, pgx.ErrNoRows): // the two already have their chat: answer with it
		status = http.StatusOK
		if err = tx.QueryRow(ctx, `SELECT c.id::text FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.user_id = cw_user()
			WHERE c.org_id = cw_org() AND c.direct_key = $1`, directKey).Scan(&id); err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		role := "member"
		if body.Kind == "group" {
			role = "owner"
		}
		if _, err = tx.Exec(ctx, `INSERT INTO members (conversation_id, user_id, org_id, role) VALUES ($1, cw_user(), cw_org(), $2)`, id, role); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO members (conversation_id, user_id, org_id) SELECT $1, u::uuid, cw_org() FROM unnest($2::text[]) AS u`, id, others); err != nil {
			return err
		}
		if err = announce(ctx, tx, q.sc, id, "conversation", nil); err != nil {
			return err
		}
	}
	raw, err := conversationJSON(ctx, tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, status, raw)
	return nil
}

// changeConversation renames a group (its owner only) or changes the person's own settings for it: archived, muted.
func (s *server) changeConversation(q *req) error {
	id := q.r.PathValue("id")
	var body struct {
		Title    *string `json:"title"`
		Archived *bool   `json:"archived"`
		Muted    *bool   `json:"muted"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	kind, role, err := membership(ctx, tx, id)
	if err != nil {
		return err
	}
	if body.Title != nil {
		title := strings.TrimSpace(*body.Title)
		if kind != "group" || role != "owner" {
			return forbidden("Only the group's owner renames it.")
		}
		if title == "" || utf8.RuneCountInString(title) > maxTitle {
			return bad("Name the group (up to 120 characters).")
		}
		if _, err = tx.Exec(ctx, `UPDATE conversations SET title = $2 WHERE id = $1`, id, title); err != nil {
			return err
		}
		if err = announce(ctx, tx, q.sc, id, "conversation", nil); err != nil {
			return err
		}
	}
	if body.Archived != nil || body.Muted != nil {
		if _, err = tx.Exec(ctx, `UPDATE members SET archived = coalesce($2, archived), muted = coalesce($3, muted) WHERE conversation_id = $1 AND user_id = cw_user()`, id, body.Archived, body.Muted); err != nil {
			return err
		}
		if err = tell(ctx, tx, q.sc, id, "conversation", nil, q.sc.userID); err != nil {
			return err
		}
	}
	raw, err := conversationJSON(ctx, tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, raw)
	return nil
}

// membership answers the conversation's kind and the person's role in it, locking the conversation so that messages and
// membership changes happen one at a time. "Not found" when the person is not in it.
func membership(ctx context.Context, tx pgx.Tx, conversation string) (kind, role string, err error) {
	if !validID(conversation) {
		return "", "", notFound("That conversation does not exist.")
	}
	err = tx.QueryRow(ctx, `SELECT c.kind, m.role FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.user_id = cw_user() AND m.left_at IS NULL
		WHERE c.id = $1 FOR UPDATE OF c`, conversation).Scan(&kind, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		err = notFound("That conversation does not exist.")
	}
	return kind, role, err
}

// changeMembers adds people to a group or removes them (its owner), or lets a person leave. The conversation says so in a line.
func (s *server) changeMembers(q *req) error {
	id := q.r.PathValue("id")
	var body struct {
		Add    []string `json:"add"`
		Remove []string `json:"remove"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	add, err := s.teammates(ctx, q.sc, body.Add)
	if err != nil {
		return err
	}
	remove := []string{}
	for _, u := range body.Remove {
		if u = strings.ToLower(strings.TrimSpace(u)); validID(u) && !slices.Contains(remove, u) {
			remove = append(remove, u)
		}
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	kind, role, err := membership(ctx, tx, id)
	if err != nil {
		return err
	}
	if kind != "group" {
		return bad("Only a group's members can change.")
	}
	leavingOnly := len(add) == 0 && len(remove) == 1 && remove[0] == q.sc.userID
	if role != "owner" && !leavingOnly {
		return forbidden("Only the group's owner adds or removes people. You can leave the group yourself.")
	}
	if len(add) > 0 {
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM members WHERE conversation_id = $1 AND left_at IS NULL`, id).Scan(&count); err != nil {
			return err
		}
		if count+len(add) > maxMembers {
			return bad("A group has at most 200 members.")
		}
		// Someone who joins starts with nothing unread: the earlier messages are there to read, not waiting on them.
		tag, err := tx.Exec(ctx, `INSERT INTO members (conversation_id, user_id, org_id, last_read_seq)
			SELECT $1, u::uuid, cw_org(), (SELECT last_seq FROM conversations WHERE id = $1) FROM unnest($2::text[]) AS u
			ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now(), last_read_seq = EXCLUDED.last_read_seq, role = 'member'
			WHERE members.left_at IS NOT NULL`, id, add)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			if _, _, err = addMessage(ctx, tx, q.sc, id, newMessage{kind: "system", body: "added", mentions: add}); err != nil {
				return err
			}
			// The line saying they were added is not something for them to catch up on either.
			if _, err = tx.Exec(ctx, `UPDATE members m SET last_read_seq = c.last_seq FROM conversations c
				WHERE c.id = m.conversation_id AND m.conversation_id = $1 AND m.user_id::text = ANY($2)`, id, add); err != nil {
				return err
			}
		}
	}
	if len(remove) > 0 {
		var gone []string
		if err = tx.QueryRow(ctx, `SELECT coalesce(array_agg(user_id::text), '{}') FROM members WHERE conversation_id = $1 AND left_at IS NULL AND user_id::text = ANY($2)`, id, remove).Scan(&gone); err != nil {
			return err
		}
		if len(gone) > 0 {
			word := "removed"
			if leavingOnly {
				word = "left"
			}
			// Written while the person leaving is still a member, so the line is theirs to write.
			if _, _, err = addMessage(ctx, tx, q.sc, id, newMessage{kind: "system", body: word, mentions: gone}); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `UPDATE members SET left_at = now() WHERE conversation_id = $1 AND user_id::text = ANY($2)`, id, gone); err != nil {
				return err
			}
			// A group always has an owner while it has members: the longest-standing member takes over.
			if _, err = tx.Exec(ctx, `UPDATE members SET role = 'owner' WHERE conversation_id = $1 AND user_id = (
				SELECT user_id FROM members WHERE conversation_id = $1 AND left_at IS NULL ORDER BY joined_at, user_id LIMIT 1)
				AND NOT EXISTS (SELECT 1 FROM members WHERE conversation_id = $1 AND left_at IS NULL AND role = 'owner')`, id); err != nil {
				return err
			}
		}
		remove = gone
	}
	if err = announce(ctx, tx, q.sc, id, "conversation", nil, remove...); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"added": add, "removed": remove})
	return nil
}

type newMessage struct {
	id, kind, body string
	replyTo        *string
	mentions       []string
	poll           *pollBody
}

type pollBody struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

// addMessage gives the message the conversation's next number and announces it. The conversation row is already locked
// (membership), so numbers never repeat or skip. Sending the same id again answers with the message as it was first saved.
func addMessage(ctx context.Context, tx pgx.Tx, sc scope, conversation string, m newMessage) (raw json.RawMessage, created bool, err error) {
	if m.id != "" {
		var where, who string
		err = tx.QueryRow(ctx, `SELECT conversation_id::text, sender_id::text FROM messages WHERE id = $1`, m.id).Scan(&where, &who)
		switch {
		case err == nil && where == conversation && who == sc.userID:
			raw, _, err = oneJSON(ctx, tx, `SELECT message_json(m) FROM messages m WHERE m.id = $1`, m.id)
			return raw, false, err
		case err == nil:
			return nil, false, conflict("That message id is already used.")
		case !errors.Is(err, pgx.ErrNoRows):
			return nil, false, err
		}
	}
	if m.mentions == nil {
		m.mentions = []string{}
	}
	var seq int64
	if err = tx.QueryRow(ctx, `UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq`, conversation).Scan(&seq); err != nil {
		return nil, false, err
	}
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO messages (id, org_id, conversation_id, seq, sender_id, kind, body, reply_to, mentions)
		VALUES (coalesce(nullif($1, '')::uuid, gen_random_uuid()), cw_org(), $2, $3, cw_user(), $4, $5, $6, $7::uuid[]) RETURNING id::text`,
		m.id, conversation, seq, m.kind, m.body, m.replyTo, m.mentions).Scan(&id)
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" { // the id belongs to a message this person cannot see
		return nil, false, conflict("That message id is already used.")
	}
	if err != nil {
		return nil, false, err
	}
	if m.poll != nil {
		options, _ := json.Marshal(m.poll.Options)
		if _, err = tx.Exec(ctx, `INSERT INTO polls (message_id, org_id, question, options) VALUES ($1, cw_org(), $2, $3::jsonb)`, id, m.poll.Question, string(options)); err != nil {
			return nil, false, err
		}
	}
	// Whoever sends a message has read everything up to it.
	if _, err = tx.Exec(ctx, `UPDATE members SET last_read_seq = $2 WHERE conversation_id = $1 AND user_id = cw_user()`, conversation, seq); err != nil {
		return nil, false, err
	}
	if raw, _, err = oneJSON(ctx, tx, `SELECT message_json(m) FROM messages m WHERE m.id = $1`, id); err != nil {
		return nil, false, err
	}
	return raw, true, announce(ctx, tx, sc, conversation, "message", map[string]any{"message": raw})
}

func (s *server) sendMessage(q *req) error {
	conversation := q.r.PathValue("id")
	var body struct {
		ID       string    `json:"id"`
		Body     string    `json:"body"`
		ReplyTo  *string   `json:"reply_to"`
		Mentions []string  `json:"mentions"`
		Poll     *pollBody `json:"poll"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if !validID(body.ID) {
		return bad("A message needs an id made by the app, so sending it twice saves it once.")
	}
	m := newMessage{id: strings.ToLower(body.ID), kind: "text", body: strings.TrimSpace(body.Body), replyTo: body.ReplyTo, poll: body.Poll}
	if p := body.Poll; p != nil {
		p.Question = strings.TrimSpace(p.Question)
		if p.Question == "" || utf8.RuneCountInString(p.Question) > 300 || len(p.Options) < 2 || len(p.Options) > 10 {
			return bad("A poll needs a question and two to ten choices.")
		}
		for i := range p.Options {
			if p.Options[i] = strings.TrimSpace(p.Options[i]); p.Options[i] == "" || utf8.RuneCountInString(p.Options[i]) > 100 {
				return bad("Each choice needs up to 100 characters.")
			}
		}
		m.kind, m.body = "poll", p.Question
	}
	if m.body == "" || utf8.RuneCountInString(m.body) > maxBody {
		return bad("Write a message of up to 8,000 characters.")
	}
	if m.replyTo != nil && !validID(*m.replyTo) {
		return bad("That message cannot be replied to.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, _, err = membership(ctx, tx, conversation); err != nil {
		return err
	}
	if m.replyTo != nil {
		var found bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2)`, *m.replyTo, conversation).Scan(&found); err != nil {
			return err
		}
		if !found {
			return bad("That message cannot be replied to.")
		}
	}
	// Only people in the conversation can be mentioned; anyone else named is left out.
	if err = tx.QueryRow(ctx, `SELECT coalesce(array_agg(user_id::text), '{}') FROM members WHERE conversation_id = $1 AND left_at IS NULL AND user_id::text = ANY($2)`,
		conversation, lower(body.Mentions)).Scan(&m.mentions); err != nil {
		return err
	}
	raw, created, err := addMessage(ctx, tx, q.sc, conversation, m)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(q.w, status, map[string]any{"message": raw})
	return nil
}

func lower(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, strings.ToLower(strings.TrimSpace(id)))
	}
	return out
}

// listMessages pages through a conversation by message number: `after` for what was missed, `before` to scroll back, neither for
// the newest. Always answered oldest first.
func (s *server) listMessages(q *req) error {
	conversation := q.r.PathValue("id")
	if !validID(conversation) {
		return notFound("That conversation does not exist.")
	}
	num := func(name string) int64 { n, _ := strconv.ParseInt(q.r.URL.Query().Get(name), 10, 64); return max(n, 0) }
	limit := num("limit")
	if limit == 0 || limit > 200 {
		limit = 50
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lastSeq int64
	err = tx.QueryRow(ctx, `SELECT last_seq FROM conversations c WHERE c.id = $1 AND cw_member(c.id)`, conversation).Scan(&lastSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("That conversation does not exist.")
	}
	if err != nil {
		return err
	}
	var rows []json.RawMessage
	if q.r.URL.Query().Has("after") {
		rows, err = manyJSON(ctx, tx, `SELECT message_json(m) FROM messages m WHERE m.conversation_id = $1 AND m.seq > $2 ORDER BY m.seq LIMIT $3`, conversation, num("after"), limit)
	} else {
		before := num("before")
		if before == 0 {
			before = lastSeq + 1
		}
		rows, err = manyJSON(ctx, tx, `SELECT message_json(m) FROM messages m WHERE m.conversation_id = $1 AND m.seq < $2 ORDER BY m.seq DESC LIMIT $3`, conversation, before, limit)
		slices.Reverse(rows)
	}
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"messages": rows, "last_seq": lastSeq})
	return nil
}

// markRead moves the person's "read up to" forward, never back, and tells the conversation (so "seen" can be shown).
func (s *server) markRead(q *req) error {
	conversation := q.r.PathValue("id")
	var body struct {
		Seq int64 `json:"seq"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, _, err = membership(ctx, tx, conversation); err != nil {
		return err
	}
	var seq int64
	if err = tx.QueryRow(ctx, `UPDATE members m SET last_read_seq = greatest(m.last_read_seq, least($2, c.last_seq)) FROM conversations c
		WHERE c.id = m.conversation_id AND m.conversation_id = $1 AND m.user_id = cw_user() RETURNING m.last_read_seq`, conversation, body.Seq).Scan(&seq); err != nil {
		return err
	}
	if err = announce(ctx, tx, q.sc, conversation, "read", map[string]any{"user_id": q.sc.userID, "seq": seq}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"last_read_seq": seq})
	return nil
}

// changed commits a change to one message and tells the conversation what the message looks like now.
func (s *server) changed(q *req, change func(ctx context.Context, tx pgx.Tx, id, conversation, sender, kind string) error) error {
	id := q.r.PathValue("id")
	gone := notFound("That message does not exist.")
	if !validID(id) {
		return gone
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var conversation, sender, kind string
	err = tx.QueryRow(ctx, `SELECT conversation_id::text, sender_id::text, kind FROM messages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&conversation, &sender, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return gone
	}
	if err != nil {
		return err
	}
	if err = change(ctx, tx, id, conversation, sender, kind); err != nil {
		return err
	}
	raw, _, err := oneJSON(ctx, tx, `SELECT message_json(m) FROM messages m WHERE m.id = $1`, id)
	if err != nil {
		return err
	}
	if err = announce(ctx, tx, q.sc, conversation, "message_changed", map[string]any{"message": raw}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"message": raw})
	return nil
}

func (s *server) editMessage(q *req) error {
	var body struct {
		Body string `json:"body"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	text := strings.TrimSpace(body.Body)
	if text == "" || utf8.RuneCountInString(text) > maxBody {
		return bad("Write a message of up to 8,000 characters.")
	}
	return s.changed(q, func(ctx context.Context, tx pgx.Tx, id, _, sender, kind string) error {
		if sender != q.sc.userID || kind != "text" {
			return forbidden("You can edit only your own messages.")
		}
		// A message can be edited for 15 minutes after it was sent (step 16); after that it stands, and can still be deleted.
		var late bool
		if err := tx.QueryRow(ctx, `SELECT created_at < now() - interval '15 minutes' FROM messages WHERE id = $1`, id).Scan(&late); err != nil {
			return err
		}
		if late {
			return &apiError{http.StatusConflict, "edit_window", "A message can be edited for 15 minutes after it was sent."}
		}
		_, err := tx.Exec(ctx, `UPDATE messages SET body = $2, edited_at = now() WHERE id = $1`, id, text)
		return err
	})
}

func (s *server) deleteMessage(q *req) error {
	return s.changed(q, func(ctx context.Context, tx pgx.Tx, id, _, sender, kind string) error {
		if sender != q.sc.userID || kind == "system" {
			return forbidden("You can delete only your own messages.")
		}
		_, err := tx.Exec(ctx, `UPDATE messages SET deleted_at = now() WHERE id = $1`, id)
		return err
	})
}

// react adds or takes back one reaction: one per person per emoji on a message.
func (s *server) react(add bool) handler {
	return func(q *req) error {
		emoji := q.r.PathValue("emoji")
		if emoji == "" || len(emoji) > 32 || !utf8.ValidString(emoji) {
			return bad("Choose a reaction.")
		}
		return s.changed(q, func(ctx context.Context, tx pgx.Tx, id, _, _, _ string) error {
			sql := `DELETE FROM reactions WHERE message_id = $1 AND user_id = cw_user() AND emoji = $2`
			if add {
				sql = `INSERT INTO reactions (message_id, user_id, emoji, org_id) VALUES ($1, cw_user(), $2, cw_org()) ON CONFLICT DO NOTHING`
			}
			_, err := tx.Exec(ctx, sql, id, emoji)
			return err
		})
	}
}

// vote records the person's choice in a poll. Voting again moves it; a null option takes it back.
func (s *server) vote(q *req) error {
	var body struct {
		Option *int `json:"option"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	return s.changed(q, func(ctx context.Context, tx pgx.Tx, id, _, _, _ string) error {
		var choices int
		err := tx.QueryRow(ctx, `SELECT jsonb_array_length(options) FROM polls WHERE message_id = $1`, id).Scan(&choices)
		if errors.Is(err, pgx.ErrNoRows) {
			return bad("That message is not a poll.")
		}
		if err != nil {
			return err
		}
		if body.Option == nil {
			_, err = tx.Exec(ctx, `DELETE FROM poll_votes WHERE message_id = $1 AND user_id = cw_user()`, id)
			return err
		}
		if *body.Option < 0 || *body.Option >= choices {
			return bad("Choose one of the poll's choices.")
		}
		_, err = tx.Exec(ctx, `INSERT INTO poll_votes (message_id, user_id, org_id, option) VALUES ($1, cw_user(), cw_org(), $2)
			ON CONFLICT (message_id, user_id) DO UPDATE SET option = EXCLUDED.option`, id, *body.Option)
		return err
	})
}

// searchMessages answers GET .../messages/search?q=: words in messages of the conversations the person is in, in this workspace only
// (D87). Row security already keeps every other conversation, and every other workspace, out.
func (s *server) searchMessages(q *req) error {
	term := strings.TrimSpace(q.r.URL.Query().Get("q"))
	if utf8.RuneCountInString(term) < 2 || len(term) > 200 {
		return bad("Search for at least two characters.")
	}
	escaped := strings.NewReplacer(`\`, `\`, `%`, `\%`, `_`, `\_`).Replace(term)
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := manyJSON(ctx, tx, `SELECT message_json(m) FROM messages m WHERE m.org_id = cw_org() AND cw_member(m.conversation_id) AND m.deleted_at IS NULL
		AND m.body ILIKE '%' || $1 || '%' ORDER BY m.created_at DESC LIMIT 50`, escaped)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"messages": rows})
	return nil
}
