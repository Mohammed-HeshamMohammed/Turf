package crm

// /sync/snapshot, /sync/pull and /sync/push. Push applies each operation on its own and answers each one (applied, duplicate,
// rejected, conflict) in the order given. Pull returns committed changes after a cursor, already filtered by the person's
// current access; a change to something they can no longer see arrives as a removal. When the access revision the device
// holds is not the current one, it must drop its cache and take a fresh snapshot.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
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
		sql = `SELECT to_jsonb(l) || ` + readOnly(sc, "l") + ` || ` + leadTagsColumn("l") + ` FROM leads l WHERE l.id = $1 AND cw_seen_lead(l.id)`
	case "task":
		sql = taskVisible + ` AND t.id = $1`
	case "note":
		sql = `SELECT to_jsonb(n) FROM notes n WHERE n.id = $1 AND cw_seen_lead(n.lead_id) AND (NOT cw_external() OR n.visibility = 'shared')`
	case "call":
		sql = `SELECT to_jsonb(c) || jsonb_build_object('phone', cw_call_phone(c.phone, c.lead_id)) FROM call_events c WHERE c.id = $1 AND cw_seen_lead(c.lead_id) AND (NOT cw_external() OR c.shared_with_client)`
	case "deal":
		sql = `SELECT to_jsonb(d) FROM deals d WHERE d.id = $1 AND cw_visible_lead(d.lead_id) AND (NOT cw_external() OR d.shared_with_client)`
	case "handoff":
		sql = `SELECT to_jsonb(h) FROM handoffs h WHERE h.id = $1 AND cw_seen_lead(h.lead_id) AND NOT cw_external()`
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
	// The agency was restored from a backup since this cursor: the device starts over.
	var restored bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM org_resets WHERE seq > $1)`, cursor).Scan(&restored); err != nil {
		return err
	}
	if behind > maxPullBehind || restored {
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
	// The server has just confirmed this person's access, so the device's offline permission is renewed for another day.
	writeJSON(q.w, http.StatusOK, map[string]any{"cursor": cursor, "changes": changes, "more": more, "access_revision": q.rev, "offline_lease_expires_at": s.now().Add(offlineLease)})
	return nil
}

// snapshot is everything the person may see, for a first sync or after a reset, with the cursor to continue from.
const (
	snapshotLeads = 3000 // leads in a snapshot; the rest are found by search
	maxPullBehind = 5000 // changes a device may be behind and still page through them
)

// offlineLease is how long a device may show its offline copy after the server last confirmed the person's access. Every sync renews it.
const offlineLease = 24 * time.Hour

// leadVisible is the same test as the cw_visible_lead function, written out as a condition on the lead's own row for a query that looks
// at many leads. The function runs a query of its own for every lead it is asked about, and the snapshot asked it about every lead of the
// workspace three times over: with a hundred thousand leads that was thirty-five seconds, and past a hundred seconds the proxy in front
// gives up. Here the person's own scopes are put into the query, so only the branches that apply are in it, and a person who sees the
// whole workspace has no test beyond the workspace and "not deleted". A test holds the two together.
// The values are added to args (numbered from len(args)+1) and the condition and the longer list come back.
func leadVisible(sc scope, alias string, args []any) (string, []any) {
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	var branches []string
	for _, kind := range sc.scopes {
		switch kind {
		case "organization":
			branches = []string{"TRUE"}
		case "team":
			if teams := sc.visibleTeams(); len(teams) > 0 && !slices.Contains(branches, "TRUE") {
				branches = append(branches, alias+".team_id = ANY("+add(teams)+"::uuid[])")
			}
		case "project":
			if len(sc.projectIDs) > 0 && !slices.Contains(branches, "TRUE") {
				branches = append(branches, alias+".project_id = ANY("+add(sc.projectIDs)+"::uuid[])")
			}
		case "own":
			if sc.userID != "" && !slices.Contains(branches, "TRUE") {
				me := add(sc.userID) + "::uuid"
				branches = append(branches, "("+alias+".assignee_id = "+me+" OR EXISTS (SELECT 1 FROM handoffs h WHERE h.lead_id = "+alias+".id AND h.to_user = "+me+" AND h.status = 'Requested'))")
			}
		case "shared":
			if sc.userID != "" && !slices.Contains(branches, "TRUE") {
				me := add(sc.userID)
				// Shared with them one by one, or shared with their client (D127).
				branches = append(branches, "(EXISTS (SELECT 1 FROM lead_shares s WHERE s.lead_id = "+alias+".id AND s.user_id = "+me+"::uuid) OR ("+alias+".shared_with_client AND EXISTS (SELECT 1 FROM client_members cm WHERE cm.client_id = "+alias+".client_id AND cm.user_id = "+me+"::uuid)))")
			}
		}
		if slices.Contains(branches, "TRUE") {
			branches = []string{"TRUE"}
		}
	}
	if len(branches) == 0 {
		return "FALSE", args
	}
	return "(" + alias + ".deleted_at IS NULL AND " + alias + ".org_id = cw_org() AND (" + strings.Join(branches, " OR ") + "))", args
}

// snapshotAfter is where the next page of a snapshot starts: the last lead of the page before, in the snapshot's order (the person's own
// leads first, then the most recently changed), and how many leads the snapshot has given so far. Keyed on that lead rather than counted,
// so a lead that changes or goes away between two pages cannot make the next page skip or repeat another.
type snapshotAfter struct {
	Mine  bool      `json:"m"`
	At    time.Time `json:"t"`
	ID    string    `json:"i"`
	Taken int       `json:"n"`
}

func (a snapshotAfter) token() string {
	raw, _ := json.Marshal(a)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func parseSnapshotAfter(token string) (*snapshotAfter, error) {
	if token == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	var a snapshotAfter
	if err == nil {
		err = json.Unmarshal(raw, &a)
	}
	if err != nil || !validID(a.ID) || a.Taken < 0 || a.Taken >= snapshotLeads {
		return nil, bad("That page of the snapshot does not exist.")
	}
	return &a, nil
}

func (s *server) snapshot(q *req) error {
	ctx := q.r.Context()
	// ?limit=N gives the first N leads of the window, and "next" in the answer is the token (?after=...) for the following N: a screen can
	// show the first leads at once and fill the rest in as the pages arrive. Without them the whole window comes in one answer.
	limit, _ := strconv.Atoi(q.r.URL.Query().Get("limit"))
	if limit < 1 || limit > snapshotLeads {
		limit = snapshotLeads
	}
	after, err := parseSnapshotAfter(q.r.URL.Query().Get("after"))
	if err != nil {
		return err
	}
	taken := 0
	if after != nil {
		taken = after.Taken
	}
	limit = min(limit, snapshotLeads-taken)
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
	var afterMine, afterAt, afterID any // all null on the first page, which `$3 IS NULL` lets through
	if after != nil {
		afterMine, afterAt, afterID = after.Mine, after.At, after.ID
	}
	// The window is the person's own leads, newest first, then everyone else's, newest first. Each half is read from an index in that order
	// and stops after `limit` leads (leads_recent), so a workspace of hundreds of thousands costs no more than a small one; the halves are
	// then put together. The page after another starts below the last lead of the one before in this same order.
	winArgs := []any{q.sc.userID, limit, afterMine, afterAt, afterID}
	visible, winArgs := leadSeen(q.sc, "l", winArgs) // the team view is in the window; the counts below are the person's own
	if _, err = tx.Exec(ctx, `CREATE TEMP TABLE win ON COMMIT DROP AS
		SELECT id, mine, updated_at FROM (
			(SELECT l.id, true AS mine, l.updated_at FROM leads l
				WHERE `+visible+` AND l.assignee_id = nullif($1, '')::uuid AND ($3::boolean IS NULL OR ($3::boolean AND (l.updated_at, l.id) < ($4::timestamptz, $5::uuid)))
				ORDER BY l.updated_at DESC, l.id DESC LIMIT $2)
			UNION ALL
			(SELECT l.id, false, l.updated_at FROM leads l
				WHERE `+visible+` AND l.assignee_id IS DISTINCT FROM nullif($1, '')::uuid AND ($3::boolean IS NULL OR $3::boolean OR (l.updated_at, l.id) < ($4::timestamptz, $5::uuid))
				ORDER BY l.updated_at DESC, l.id DESC LIMIT $2)
		) both_halves ORDER BY mine DESC, updated_at DESC, id DESC LIMIT $2`, winArgs...); err != nil {
		return err
	}
	var winRows int
	var last snapshotAfter
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM win`).Scan(&winRows); err != nil {
		return err
	}
	if winRows > 0 { // the last lead of the page is the smallest in the window's order
		if err = tx.QueryRow(ctx, `SELECT id::text, mine, updated_at FROM win ORDER BY mine, updated_at, id LIMIT 1`).Scan(&last.ID, &last.Mine, &last.At); err != nil {
			return err
		}
	}
	next := ""
	if winRows == limit && taken+winRows < snapshotLeads {
		last.Taken = taken + winRows
		next = last.token()
	}
	if after != nil { // a later page: only leads, and what belongs to them
		return s.snapshotPage(q, ctx, tx, next)
	}
	// One pass over the leads the person sees gives the total and, for each list, how many leads it has and how many of them can be contacted.
	countWhere, countArgs := leadVisible(q.sc, "l", nil)
	var total int64
	counts := map[string]int64{}
	callable := map[string]int64{}    // leads of each list the Calls queue can take: a phone number, not closed, not archived
	contactable := map[string]int64{} // leads of each list with a phone number or an email: a list with none is a useless list
	stages := map[string]int64{}      // leads of each stage that are not archived: the overview and the team page count from these, not from the window
	var unassigned int64              // of those, the open ones with no owner
	owned := map[string]int64{}       // and the open ones each person owns
	countRows, err := tx.Query(ctx, `SELECT l.project_id::text, l.stage, (l.archived_at IS NOT NULL), l.assignee_id::text, count(*), count(*) FILTER (WHERE l.phone <> '' OR l.email <> '' OR p.skip_tracing), count(*) FILTER (WHERE l.phone <> '' AND l.stage <> 'Closed' AND l.archived_at IS NULL)
		FROM leads l LEFT JOIN projects p ON p.id = l.project_id WHERE `+countWhere+` GROUP BY 1, 2, 3, 4`, countArgs...)
	if err != nil {
		return err
	}
	for countRows.Next() {
		var id *string
		var stage string
		var archived bool
		var owner *string
		var n, withContact, withPhone int64
		if err = countRows.Scan(&id, &stage, &archived, &owner, &n, &withContact, &withPhone); err != nil {
			countRows.Close()
			return err
		}
		total += n
		if id != nil {
			counts[*id], contactable[*id], callable[*id] = counts[*id]+n, contactable[*id]+withContact, callable[*id]+withPhone
		}
		if !archived {
			stages[stage] += n
			if stage != "Closed" {
				if owner == nil {
					unassigned += n
				} else {
					owned[*owner] += n
				}
			}
		}
	}
	countRows.Close()
	if err = countRows.Err(); err != nil {
		return err
	}
	leads, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) || `+readOnly(q.sc, "l")+` || `+leadTagsColumn("l")+` FROM leads l JOIN win ON win.id = l.id LEFT JOIN properties p ON p.id = l.property_id`)
	if err != nil {
		return err
	}
	for i, raw := range leads {
		if leads[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	body := map[string]any{"cursor": cursor, "access_revision": q.rev, "leads": leads, "leads_total": total, "project_counts": counts, "project_contactable": contactable, "project_callable": callable, "stage_counts": stages, "unassigned_count": unassigned, "assignee_counts": owned, "deals": []json.RawMessage{}, "next": next}
	for name, sql := range map[string]string{
		"tasks":    taskVisible + ` AND (t.lead_id IS NULL OR t.lead_id IN (SELECT id FROM win))`,
		"notes":    `SELECT to_jsonb(n) FROM notes n WHERE n.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR n.visibility = 'shared')`,
		"calls":    `SELECT to_jsonb(c) || jsonb_build_object('phone', cw_call_phone(c.phone, c.lead_id)) FROM call_events c WHERE c.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR c.shared_with_client)`,
		"handoffs": `SELECT to_jsonb(h) FROM handoffs h WHERE h.lead_id IN (SELECT id FROM win) AND NOT cw_external()`,
	} {
		if body[name], err = queryJSON(ctx, tx, sql); err != nil {
			return err
		}
	}
	if q.sc.can("finance") {
		if body["deals"], err = queryJSON(ctx, tx, `SELECT to_jsonb(d) FROM deals d WHERE d.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR d.shared_with_client) AND cw_visible_lead(d.lead_id)`); err != nil {
			return err
		}
	}
	// Offline copies must be renewed online within a day.
	body["offline_lease_expires_at"] = s.now().Add(offlineLease)
	writeJSON(q.w, http.StatusOK, body)
	return nil
}

// snapshotPage answers a later page of a snapshot: the leads of the window table and what belongs to them. The totals, the lists and the
// cursor came with the first page.
func (s *server) snapshotPage(q *req, ctx context.Context, tx pgx.Tx, next string) error {
	leads, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) || `+readOnly(q.sc, "l")+` || `+leadTagsColumn("l")+` FROM leads l JOIN win ON win.id = l.id LEFT JOIN properties p ON p.id = l.property_id`)
	if err != nil {
		return err
	}
	for i, raw := range leads {
		if leads[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	body := map[string]any{"leads": leads, "deals": []json.RawMessage{}, "next": next}
	for name, sql := range map[string]string{
		"tasks":    taskVisible + ` AND t.lead_id IN (SELECT id FROM win)`,
		"notes":    `SELECT to_jsonb(n) FROM notes n WHERE n.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR n.visibility = 'shared')`,
		"calls":    `SELECT to_jsonb(c) || jsonb_build_object('phone', cw_call_phone(c.phone, c.lead_id)) FROM call_events c WHERE c.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR c.shared_with_client)`,
		"handoffs": `SELECT to_jsonb(h) FROM handoffs h WHERE h.lead_id IN (SELECT id FROM win) AND NOT cw_external()`,
	} {
		if body[name], err = queryJSON(ctx, tx, sql); err != nil {
			return err
		}
	}
	if q.sc.can("finance") {
		if body["deals"], err = queryJSON(ctx, tx, `SELECT to_jsonb(d) FROM deals d WHERE d.lead_id IN (SELECT id FROM win) AND (NOT cw_external() OR d.shared_with_client) AND cw_visible_lead(d.lead_id)`); err != nil {
			return err
		}
	}
	writeJSON(q.w, http.StatusOK, body)
	return nil
}

// leadSeen is leadVisible widened to what the person may read: their teams that let agents see the whole team, read-only (D124). Only
// reading uses it; changes go through cw_visible_lead.
func leadSeen(sc scope, alias string, args []any) (string, []any) {
	visible, args := leadVisible(sc, alias, args)
	if len(sc.peekTeams) == 0 {
		return visible, args
	}
	args = append(args, sc.peekTeams)
	peek := "(" + alias + ".deleted_at IS NULL AND " + alias + ".org_id = cw_org() AND " + alias + ".team_id = ANY($" + strconv.Itoa(len(args)) + "::uuid[]))"
	return "(" + visible + " OR " + peek + ")", args
}

// readOnly is a column saying a lead is seen only through the team view (D124), so screens offer nothing that changes it.
func readOnly(sc scope, alias string) string {
	if len(sc.peekTeams) == 0 {
		return `jsonb_build_object('read_only', false)`
	}
	return `jsonb_build_object('read_only', NOT cw_visible_lead(` + alias + `.id))`
}
