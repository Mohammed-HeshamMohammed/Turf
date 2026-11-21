package crm

// Build step 25: "do not call" by number (migrations/0032_do_not_call.sql).
//
//   - The agency's block list: a number that asked this agency to stop is blocked for every client, team and later import. A block says
//     what it stops, calls, texts or both (D209, D351). Anyone who calls or texts may add one; only the owner or an admin lifts it, with a
//     reason (D207).
//   - Caller Whale's database, read by every agency: "no calls from anyone" once the agent confirms it (D351), a known complainer once a
//     second agency reports it or staff confirm it (D139). Registry numbers are never copied there (D363). Only staff remove a number;
//     an agency's owner or admin asks for a review with a reason (D141). Staff also see anyone marking unusually many numbers.
//   - A blocked number makes its leads do-not-call (a trigger keeps imports and new leads in line); the dialer asks here before every
//     call and text.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// markWatch is how many numbers one person may put in Caller Whale's database in a day before staff are shown it.
const markWatch = 20

func (s *server) blockRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/blocks", s.member(s.listBlocks))
	mux.Handle("GET /api/v1/blocks/check", s.member(s.checkBlock))
	mux.Handle("POST /api/v1/blocks", s.member(s.addBlock))
	mux.Handle("POST /api/v1/blocks/lift", s.member(s.liftBlock))
	mux.Handle("POST /api/v1/blocks/review", s.member(s.askReview))
	mux.Handle("POST /api/v1/projects/{id}/text-consent", s.member(s.listTextConsent))
	mux.Handle("GET /api/v1/platform/do-not-call", s.user(s.staffBlocks))
	mux.Handle("POST /api/v1/platform/do-not-call/{id}/confirm", s.user(s.staffConfirm))
	mux.Handle("POST /api/v1/platform/do-not-call/{id}/remove", s.user(s.staffRemove))
	mux.Handle("POST /api/v1/platform/do-not-call/reviews/{id}/keep", s.user(s.staffKeep))
}

// phoneKey is a number's last ten digits, as crm.phone_key makes it; "" when it is too short to be a number.
func phoneKey(phone string) string {
	if len(nonDigits.ReplaceAllString(phone, "")) < 7 {
		return ""
	}
	return lastTen(phone)
}

type blockAsk struct {
	Phone  string `json:"phone"`
	Calls  bool   `json:"calls"`
	Texts  bool   `json:"texts"`
	Kind   string `json:"kind"`   // agency (default), anyone or complainer
	Reason string `json:"reason"` // asked_agency (default), opt_out_reply, deleted_on_request, other
	Source string `json:"source"`
	Note   string `json:"note"`
	LeadID string `json:"lead_id"`
}

// block puts a number on the agency's list (widening a block already there) and, for the other two kinds, in Caller Whale's database;
// leads with the number become do-not-call when calls are blocked. It runs in the caller's transaction, as the person who marked it.
func block(ctx context.Context, tx pgx.Tx, sc scope, a blockAsk) error {
	key := phoneKey(a.Phone)
	if key == "" {
		return nil
	}
	if a.Kind == "anyone" || a.Kind == "complainer" {
		a.Calls, a.Texts = true, true
	}
	if !a.Calls && !a.Texts {
		a.Calls, a.Texts = true, true // unclear: both (D209)
	}
	if a.Reason == "" {
		a.Reason = "asked_agency"
	}
	by, lead := nullID(sc.userID), nullID(a.LeadID)
	if _, err := tx.Exec(ctx, `INSERT INTO number_blocks (org_id, phone_key, calls, texts, reason, source, note, lead_id, marked_by)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (org_id, phone_key) WHERE lifted_at IS NULL DO UPDATE SET calls = number_blocks.calls OR EXCLUDED.calls,
			texts = number_blocks.texts OR EXCLUDED.texts`, key, a.Calls, a.Texts, a.Reason, a.Source, a.Note, lead, by); err != nil {
		return err
	}
	if a.Kind == "anyone" || a.Kind == "complainer" {
		if err := markShared(ctx, tx, sc, key, a); err != nil {
			return err
		}
	}
	if a.Calls {
		return flagLeads(ctx, tx, key)
	}
	return nil
}

// markShared adds a number to Caller Whale's database, or adds this agency's mark to it. "No calls from anyone" blocks at once, the
// agent having confirmed it; a complainer waits for a second agency or for staff.
func markShared(ctx context.Context, tx pgx.Tx, sc scope, key string, a blockAsk) error {
	kind := map[string]string{"anyone": "no_calls_anyone", "complainer": "complainer"}[a.Kind]
	var id, had string
	err := tx.QueryRow(ctx, `SELECT id::text, kind FROM shared_blocks WHERE phone_key = $1 AND removed_at IS NULL FOR UPDATE`, key).Scan(&id, &had)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		err = tx.QueryRow(ctx, `INSERT INTO shared_blocks (phone_key, kind, confirmed_at, confirmed_how)
			VALUES ($1, $2, CASE WHEN $2 = 'no_calls_anyone' THEN now() END, CASE WHEN $2 = 'no_calls_anyone' THEN 'agent' ELSE '' END) RETURNING id::text`, key, kind).Scan(&id)
	case err == nil && kind == "no_calls_anyone" && had == "complainer":
		_, err = tx.Exec(ctx, `UPDATE shared_blocks SET kind = 'no_calls_anyone', confirmed_at = coalesce(confirmed_at, now()),
			confirmed_how = CASE WHEN confirmed_at IS NULL THEN 'agent' ELSE confirmed_how END WHERE id = $1`, id)
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO shared_block_marks (block_id, org_id, user_id, lead_id, kind, note) VALUES ($1, cw_org(), $2, $3, $4, $5)`,
		id, nullID(sc.userID), nullID(a.LeadID), kind, a.Note); err != nil {
		return err
	}
	// A second agency reporting the same number confirms it.
	_, err = tx.Exec(ctx, `UPDATE shared_blocks SET confirmed_at = now(), confirmed_how = 'second_agency' WHERE id = $1 AND confirmed_at IS NULL
		AND (SELECT count(DISTINCT org_id) FROM shared_block_marks WHERE block_id = $1) >= 2`, id)
	return err
}

// flagLeads makes the agency's leads with a number do-not-call, and tells the devices.
func flagLeads(ctx context.Context, tx pgx.Tx, key string) error {
	return logLeads(ctx, tx, `UPDATE leads SET do_not_call = true, version = version + 1, updated_at = now()
		WHERE org_id = cw_org() AND deleted_at IS NULL AND NOT do_not_call AND crm.phone_key(phone) = $1 RETURNING id::text`, key)
}

func logLeads(ctx context.Context, tx pgx.Tx, sql string, args ...any) error {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range ids {
		var seq int64
		if err = tx.QueryRow(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert') RETURNING seq`, id).Scan(&seq); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'lead.updated', 'entity', 'lead', 'seq', $1::bigint)::text)`, seq); err != nil {
			return err
		}
	}
	return nil
}

func nullID(id string) any {
	if validID(id) {
		return id
	}
	return nil
}

// blocked is what stops a number for this agency: calls, texts, and why, in words for the person.
type blocked struct {
	Calls  bool   `json:"calls"`
	Texts  bool   `json:"texts"`
	Shared bool   `json:"shared"` // in Caller Whale's database
	Why    string `json:"why"`
}

func numberBlocked(ctx context.Context, tx pgx.Tx, phone string) (blocked, error) {
	var b blocked
	key := phoneKey(phone)
	if key == "" {
		return b, nil
	}
	var reason string
	err := tx.QueryRow(ctx, `SELECT calls, texts, reason FROM number_blocks WHERE org_id = cw_org() AND phone_key = $1 AND lifted_at IS NULL`, key).Scan(&b.Calls, &b.Texts, &reason)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return b, err
	}
	switch {
	case reason == "deleted_on_request":
		b.Why = "This person asked for their information to be deleted; their number is never contacted again."
	case b.Calls && b.Texts:
		b.Why = "This number asked this agency to stop calling and texting."
	case b.Calls:
		b.Why = "This number asked this agency to stop calling."
	case b.Texts:
		b.Why = "This number asked this agency to stop texting."
	}
	var kind string
	err = tx.QueryRow(ctx, `SELECT kind FROM shared_blocks WHERE phone_key = $1 AND confirmed_at IS NOT NULL AND removed_at IS NULL`, key).Scan(&kind)
	if err == nil {
		b.Calls, b.Texts, b.Shared = true, true, true
		b.Why = map[string]string{"no_calls_anyone": "This number asked for no calls from anyone; it is in Caller Whale's do-not-call database.",
			"complainer": "This number is a known complainer in Caller Whale's do-not-call database."}[kind]
		err = nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return b, err
}

// manages is the owner or an admin of the whole agency.
func manages(sc scope) bool {
	return sc.can("admin") && slices.Contains(sc.scopes, "organization")
}

// listBlocks is GET /api/v1/blocks: the agency's block list with who marked each and who lifted it, for the owner and admins.
func (s *server) listBlocks(q *req) error {
	if !manages(q.sc) {
		return forbidden("Only the owner and admins see the block list.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', b.id, 'phone_key', b.phone_key, 'calls', b.calls, 'texts', b.texts, 'reason', b.reason,
			'source', b.source, 'note', b.note, 'lead_id', b.lead_id, 'marked_by', b.marked_by, 'marked_at', b.marked_at, 'lifted_at', b.lifted_at,
			'lifted_by', b.lifted_by, 'lift_reason', b.lift_reason,
			'shared', EXISTS (SELECT 1 FROM shared_blocks s WHERE s.phone_key = b.phone_key AND s.confirmed_at IS NOT NULL AND s.removed_at IS NULL))
		FROM number_blocks b WHERE b.org_id = cw_org() ORDER BY b.marked_at DESC LIMIT 1000`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"blocks": rows})
	return nil
}

// checkBlock is GET /api/v1/blocks/check?phone=: whether this agency may call and text a number.
func (s *server) checkBlock(q *req) error {
	if q.sc.external() {
		return forbidden("Clients do not check numbers.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	b, err := numberBlocked(ctx, tx, q.r.URL.Query().Get("phone"))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, b)
	return nil
}

// addBlock is POST /api/v1/blocks: a person who calls or texts marks a number. "anyone" is the agent confirming that the person wants
// no calls from anyone (D351); "complainer" reports a known complainer.
func (s *server) addBlock(q *req) error {
	if q.sc.external() || (!q.sc.can("call") && !q.sc.can("message")) {
		return forbidden("Your role does not mark numbers.")
	}
	var a blockAsk
	if err := readJSON(q.w, q.r, &a); err != nil {
		return err
	}
	if a.Kind == "" {
		a.Kind = "agency"
	}
	if !slices.Contains([]string{"agency", "anyone", "complainer"}, a.Kind) || !slices.Contains([]string{"", "asked_agency", "other"}, a.Reason) {
		return bad("kind is agency, anyone or complainer; reason is asked_agency or other.")
	}
	if phoneKey(a.Phone) == "" {
		return bad("Give the phone number to block.")
	}
	if len(a.Note) > 500 {
		return bad("Keep the note under 500 characters.")
	}
	if a.Source == "" {
		a.Source = "lead"
	}
	if !slices.Contains([]string{"lead", "call", "text"}, a.Source) {
		return bad("source is lead, call or text.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = block(ctx, tx, q.sc, a); err != nil {
		return err
	}
	b, err := numberBlocked(ctx, tx, a.Phone)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, b)
	return nil
}

// liftBlock is POST /api/v1/blocks/lift {phone, reason}: the owner or an admin lifts the agency's block, with a reason that is kept. A
// number in Caller Whale's database stays blocked: only a review by staff removes it.
func (s *server) liftBlock(q *req) error {
	if !manages(q.sc) {
		return forbidden("Only the owner or an admin lifts a block.")
	}
	var body struct {
		Phone  string `json:"phone"`
		Reason string `json:"reason"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) < 3 || len(reason) > 500 {
		return bad("Say why the block is lifted (3 to 500 characters).")
	}
	key := phoneKey(body.Phone)
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM number_blocks WHERE org_id = cw_org() AND phone_key = $1 AND lifted_at IS NULL AND locked)`, key).Scan(&locked); err != nil {
		return err
	}
	if locked {
		return forbidden("This block came with a lead from another agency and stays (D251).")
	}
	tag, err := tx.Exec(ctx, `UPDATE number_blocks SET lifted_at = now(), lifted_by = $2, lift_reason = $3 WHERE org_id = cw_org() AND phone_key = $1 AND lifted_at IS NULL`,
		key, q.sc.userID, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("That number is not on the agency's block list.")
	}
	b, err := numberBlocked(ctx, tx, body.Phone)
	if err != nil {
		return err
	}
	if !b.Calls {
		if err = logLeads(ctx, tx, `UPDATE leads SET do_not_call = false, version = version + 1, updated_at = now()
			WHERE org_id = cw_org() AND deleted_at IS NULL AND do_not_call AND crm.phone_key(phone) = $1 RETURNING id::text`, key); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, b)
	return nil
}

// askReview is POST /api/v1/blocks/review {phone, reason}: the owner or an admin asks Caller Whale to look again at a number in its
// database.
func (s *server) askReview(q *req) error {
	if !manages(q.sc) {
		return forbidden("Only the owner or an admin asks for a review.")
	}
	var body struct {
		Phone  string `json:"phone"`
		Reason string `json:"reason"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) < 3 || len(reason) > 1000 {
		return bad("Say why Caller Whale should look again (3 to 1,000 characters).")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO shared_block_reviews (block_id, org_id, user_id, reason)
		SELECT id, cw_org(), $2, $3 FROM shared_blocks WHERE phone_key = $1 AND removed_at IS NULL RETURNING id::text`, phoneKey(body.Phone), q.sc.userID, reason).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("That number is not in Caller Whale's database.")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": id, "status": "waiting"})
	return nil
}

// listTextConsent is POST /api/v1/projects/{id}/text-consent {confirm}: whoever imports lists confirms that the agency holds consent to
// text this list's numbers, for this list's client only (D355, D366); false takes it back. Who and when are kept.
func (s *server) listTextConsent(q *req) error {
	if !q.sc.can("import") || q.sc.external() {
		return forbidden("Your role does not confirm consent for lists.")
	}
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("No such list.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `UPDATE projects SET text_consent_at = CASE WHEN $2 THEN now() END, text_consent_by = CASE WHEN $2 THEN $3::uuid END
		WHERE id = $1 AND org_id = cw_org() RETURNING jsonb_build_object('id', id, 'text_consent_at', text_consent_at, 'text_consent_by', text_consent_by)`, id, body.Confirm, q.sc.userID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return notFound("No such list.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, rows[0])
	return nil
}

// staff lets Caller Whale's own staff through.
func (s *server) staff(q *req) error {
	p, err := s.rules.people(q.r.Context(), q.c.Sub)
	if err != nil {
		return err
	}
	if p.PlatformRole == "" {
		return forbidden("Only Caller Whale staff see this.")
	}
	return nil
}

// staffBlocks is GET /api/v1/platform/do-not-call: complainers waiting for confirmation, open reviews with every mark of their number, and
// anyone who marked more than markWatch numbers in the last day.
func (s *server) staffBlocks(q *req) error {
	if err := s.staff(q); err != nil {
		return err
	}
	ctx := q.r.Context()
	one := func(sql string) (out json.RawMessage, err error) {
		err = s.st.db.QueryRow(ctx, sql).Scan(&out)
		return
	}
	waiting, err := one(`SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'phone_key', s.phone_key, 'kind', s.kind, 'created_at', s.created_at,
			'marks', (SELECT jsonb_agg(jsonb_build_object('org_id', m.org_id, 'user_id', m.user_id, 'note', m.note, 'at', m.at)) FROM shared_block_marks m WHERE m.block_id = s.id))
		ORDER BY s.created_at), '[]') FROM shared_blocks s WHERE s.confirmed_at IS NULL AND s.removed_at IS NULL`)
	if err != nil {
		return err
	}
	reviews, err := one(`SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'block_id', r.block_id, 'phone_key', s.phone_key, 'kind', s.kind,
			'org_id', r.org_id, 'user_id', r.user_id, 'reason', r.reason, 'at', r.at,
			'marks', (SELECT jsonb_agg(jsonb_build_object('org_id', m.org_id, 'user_id', m.user_id, 'note', m.note, 'at', m.at)) FROM shared_block_marks m WHERE m.block_id = s.id))
		ORDER BY r.at), '[]') FROM shared_block_reviews r JOIN shared_blocks s ON s.id = r.block_id WHERE r.decided_at IS NULL`)
	if err != nil {
		return err
	}
	busy, err := one(`SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT user_id, org_id, count(*) AS marks FROM shared_block_marks
		WHERE at > now() - interval '1 day' AND user_id IS NOT NULL GROUP BY user_id, org_id HAVING count(*) > ` + strconv.Itoa(markWatch) + ` ORDER BY count(*) DESC) x`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"waiting": waiting, "reviews": reviews, "heavy_markers": busy})
	return nil
}

// staffConfirm is POST /api/v1/platform/do-not-call/{id}/confirm: staff checked a reported complainer.
func (s *server) staffConfirm(q *req) error {
	if err := s.staff(q); err != nil {
		return err
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE shared_blocks SET confirmed_at = now(), confirmed_how = 'staff', confirmed_by = $2
		WHERE id = $1 AND confirmed_at IS NULL AND removed_at IS NULL`, nullID(q.r.PathValue("id")), q.c.Sub)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("Nothing waits under that id.")
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// staffRemove is POST /api/v1/platform/do-not-call/{id}/remove {reason}: staff take a number out of the database. The row and its marks
// stay, with who removed it and why; any open review of it is decided.
func (s *server) staffRemove(q *req) error {
	if err := s.staff(q); err != nil {
		return err
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) < 3 || len(reason) > 1000 {
		return bad("Say why the number is removed (3 to 1,000 characters).")
	}
	ctx := q.r.Context()
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id := nullID(q.r.PathValue("id"))
	tag, err := tx.Exec(ctx, `UPDATE shared_blocks SET removed_at = now(), removed_by = $2, remove_reason = $3 WHERE id = $1 AND removed_at IS NULL`, id, q.c.Sub, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("No number in the database under that id.")
	}
	if _, err = tx.Exec(ctx, `UPDATE shared_block_reviews SET decided_at = now(), decided_by = $2, decision = 'removed', staff_note = $3 WHERE block_id = $1 AND decided_at IS NULL`,
		id, q.c.Sub, reason); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}

// staffKeep is POST /api/v1/platform/do-not-call/reviews/{id}/keep {note}: staff looked again and the number stays.
func (s *server) staffKeep(q *req) error {
	if err := s.staff(q); err != nil {
		return err
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE shared_block_reviews SET decided_at = now(), decided_by = $2, decision = 'kept', staff_note = $3 WHERE id = $1 AND decided_at IS NULL`,
		nullID(q.r.PathValue("id")), q.c.Sub, strings.TrimSpace(body.Note))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("No open review under that id.")
	}
	writeJSON(q.w, 200, map[string]any{"ok": true})
	return nil
}
