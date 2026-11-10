package main

// /sync/snapshot, /sync/pull and /sync/push. Push applies each operation on its own and answers each one (applied, duplicate,
// rejected, conflict) in the order given. Pull returns committed changes after a cursor, already filtered by the person's
// current access; a change to something they can no longer see arrives as a removal. When the access revision the device
// holds is not the current one, it must drop its cache and take a fresh snapshot.

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) oneOp(q *req) error {
	var o op
	if err := readJSON(q.w, q.r, &o); err != nil {
		return err
	}
	res, err := s.apply(q.r.Context(), q.sc, o)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, res)
	return nil
}

func (s *server) push(q *req) error {
	var body struct {
		Operations     []op   `json:"operations"`
		AccessRevision *int64 `json:"access_revision"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if len(body.Operations) > 500 {
		return bad("Send at most 500 operations at a time")
	}
	results := make([]opResult, 0, len(body.Operations))
	for _, o := range body.Operations {
		res, err := s.apply(q.r.Context(), q.sc, o)
		if err != nil {
			return err
		}
		results = append(results, res)
	}
	stale := body.AccessRevision != nil && *body.AccessRevision != q.rev
	writeJSON(q.w, http.StatusOK, map[string]any{"results": results, "access_revision": q.rev, "reset": stale})
	return nil
}

func syncable(entity string) bool {
	switch entity {
	case "lead", "task", "note", "call", "deal", "handoff":
		return true
	}
	return false
}

// current is a record as this person may see it now; nil means deleted or not theirs to see.
func current(ctx context.Context, tx pgx.Tx, sc scope, entity, id string) (json.RawMessage, error) {
	var sql string
	switch entity {
	case "lead":
		sql = `SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 AND cw_visible_lead(l.id)`
	case "task":
		sql = taskVisible + ` AND t.id = $1`
	case "note":
		sql = `SELECT to_jsonb(n) FROM notes n WHERE n.id = $1 AND cw_visible_lead(n.lead_id) AND (NOT cw_external() OR n.visibility = 'shared')`
	case "call":
		sql = `SELECT to_jsonb(c) FROM call_events c WHERE c.id = $1 AND cw_visible_lead(c.lead_id) AND NOT cw_external()`
	case "deal":
		sql = `SELECT to_jsonb(d) FROM deals d WHERE d.id = $1 AND cw_visible_lead(d.lead_id) AND NOT cw_external()`
	case "handoff":
		sql = `SELECT to_jsonb(h) FROM handoffs h WHERE h.id = $1 AND cw_visible_lead(h.lead_id) AND NOT cw_external()`
	default:
		return nil, nil
	}
	if entity == "deal" && !sc.can("finance") {
		return nil, nil
	}
	var raw json.RawMessage
	err := tx.QueryRow(ctx, sql, id).Scan(&raw)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil || entity != "lead" {
		return raw, err
	}
	return redactRaw(raw, sc)
}

const taskVisible = `SELECT to_jsonb(t) FROM tasks t WHERE ((t.lead_id IS NULL AND (t.assignee_id = nullif(current_setting('cw.user_id', true), '')::uuid
	OR 'organization' = ANY(string_to_array(current_setting('cw.scopes', true), ',')))) OR cw_visible_lead(t.lead_id))
	AND (NOT cw_external() OR t.shared_external)`

func redactRaw(raw json.RawMessage, sc scope) (json.RawMessage, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return json.Marshal(redactLead(m, sc))
}

func (s *server) pull(q *req) error {
	ctx := q.r.Context()
	query := q.r.URL.Query()
	cursor, _ := strconv.ParseInt(query.Get("cursor"), 10, 64)
	if given, err := strconv.ParseInt(query.Get("access_revision"), 10, 64); err != nil || given != q.rev {
		writeJSON(q.w, http.StatusOK, map[string]any{"reset": true, "access_revision": q.rev})
		return nil
	}
	limit, _ := strconv.ParseInt(query.Get("limit"), 10, 64)
	if limit < 1 || limit > 2000 {
		limit = 500
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Far behind (a big import landed, or the device was away): a fresh snapshot is a few thousand records; paging through the
	// changes would be one per imported lead.
	var behind int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM change_log WHERE seq > $1 LIMIT $2) t`, cursor, maxPullBehind+1).Scan(&behind); err != nil {
		return err
	}
	if behind > maxPullBehind {
		writeJSON(q.w, http.StatusOK, map[string]any{"reset": true, "access_revision": q.rev})
		return nil
	}
	type entry struct {
		seq             int64
		entity, id, op_ string
	}
	rows, err := tx.Query(ctx, `SELECT seq, entity, entity_id::text, op FROM change_log WHERE seq > $1 ORDER BY seq LIMIT $2`, cursor, limit+1)
	if err != nil {
		return err
	}
	var page []entry
	for rows.Next() {
		var e entry
		if err = rows.Scan(&e.seq, &e.entity, &e.id, &e.op_); err != nil {
			rows.Close()
			return err
		}
		page = append(page, e)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	more := int64(len(page)) > limit
	if more {
		page = page[:limit]
	}
	// Only the latest state of each record matters within one page.
	type key struct{ entity, id string }
	seen := map[key]bool{}
	changes := []map[string]any{}
	for i := len(page) - 1; i >= 0; i-- {
		e := page[i]
		cursor = max(cursor, e.seq)
		k := key{e.entity, e.id}
		if seen[k] {
			continue
		}
		seen[k] = true
		var record json.RawMessage
		if e.op_ != "delete" {
			if record, err = current(ctx, tx, q.sc, e.entity, e.id); err != nil {
				return err
			}
		}
		switch {
		case record != nil:
			changes = append(changes, map[string]any{"entity": e.entity, "id": e.id, "op": "upsert", "record": record})
		case syncable(e.entity): // deleted, or no longer visible to this person: the device removes its copy
			changes = append(changes, map[string]any{"entity": e.entity, "id": e.id, "op": "remove"})
		}
	}
	for i, j := 0, len(changes)-1; i < j; i, j = i+1, j-1 {
		changes[i], changes[j] = changes[j], changes[i]
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"cursor": cursor, "changes": changes, "more": more, "access_revision": q.rev})
	return nil
}

// snapshot is everything the person may see, for a first sync or after a reset, with the cursor to continue from.
const (
	snapshotLeads = 3000 // leads in a snapshot; the rest are found by search
	maxPullBehind = 5000 // changes a device may be behind and still page through them
)

func (s *server) snapshot(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// The cursor is read first: anything committed after it arrives through the next pull.
	var cursor int64
	if err = tx.QueryRow(ctx, `SELECT coalesce(max(seq), 0) FROM change_log`).Scan(&cursor); err != nil {
		return err
	}
	// Not every lead: a workspace can hold hundreds of thousands, and a browser cannot. The window is the person's own leads first, then
	// the most recently changed; the totals say how many there are, and /api/v1/leads/search reaches the rest.
	if _, err = tx.Exec(ctx, `CREATE TEMP TABLE win ON COMMIT DROP AS
		SELECT l.id FROM leads l WHERE cw_visible_lead(l.id)
		ORDER BY (l.assignee_id::text = $1) DESC, l.updated_at DESC LIMIT $2`, q.sc.userID, snapshotLeads); err != nil {
		return err
	}
	var total int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM leads l WHERE cw_visible_lead(l.id)`).Scan(&total); err != nil {
		return err
	}
	counts := map[string]int64{}
	contactable := map[string]int64{} // leads of each list with a phone number or an email: a list with none is a useless list
	countRows, err := tx.Query(ctx, `SELECT project_id::text, count(*), count(*) FILTER (WHERE l.phone <> '' OR l.email <> '') FROM leads l WHERE project_id IS NOT NULL AND cw_visible_lead(l.id) GROUP BY project_id`)
	if err != nil {
		return err
	}
	for countRows.Next() {
		var id string
		var n, withContact int64
		if err = countRows.Scan(&id, &n, &withContact); err != nil {
			countRows.Close()
			return err
		}
		counts[id], contactable[id] = n, withContact
	}
	countRows.Close()
	leads, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) FROM leads l JOIN win ON win.id = l.id LEFT JOIN properties p ON p.id = l.property_id`)
	if err != nil {
		return err
	}
	for i, raw := range leads {
		if leads[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	body := map[string]any{"cursor": cursor, "access_revision": q.rev, "leads": leads, "leads_total": total, "project_counts": counts, "project_contactable": contactable, "deals": []json.RawMessage{}}
	for name, sql := range map[string]string{
		"tasks":    taskVisible + ` AND (t.lead_id IS NULL OR t.lead_id IN (SELECT id FROM win))`,
		"notes":    `SELECT to_jsonb(n) FROM notes n WHERE n.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR n.visibility = 'shared')`,
		"calls":    `SELECT to_jsonb(c) FROM call_events c WHERE c.lead_id IN (SELECT id FROM win) AND NOT cw_external()`,
		"handoffs": `SELECT to_jsonb(h) FROM handoffs h WHERE h.lead_id IN (SELECT id FROM win) AND NOT cw_external()`,
	} {
		if body[name], err = queryJSON(ctx, tx, sql); err != nil {
			return err
		}
	}
	if q.sc.can("finance") {
		if body["deals"], err = queryJSON(ctx, tx, `SELECT to_jsonb(d) FROM deals d WHERE d.lead_id IN (SELECT id FROM win) AND NOT cw_external()`); err != nil {
			return err
		}
	}
	// Offline copies must be renewed online within a day.
	body["offline_lease_expires_at"] = s.now().Add(24 * time.Hour)
	writeJSON(q.w, http.StatusOK, body)
	return nil
}
