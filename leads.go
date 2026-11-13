package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// searchLeads finds leads the person may see by name, phone, email or address, a page at a time. A snapshot carries only a window of a big
// workspace; this is how the rest is reached. Answers {"leads": [...], "total": n}: the leads as the snapshot sends them.
// Without `q` it browses every lead the person may see (archived ones left out), optionally of one `stage`: that is how the Leads page
// pages through a workspace of hundreds of thousands. `count=0` skips the total (the caller already knows it).
// ponytail: ILIKE scans the workspace's leads; add a pg_trgm index if searches over a few hundred thousand leads feel slow.
func (s *server) searchLeads(q *req) error {
	ctx := q.r.Context()
	query := q.r.URL.Query()
	term := strings.TrimSpace(query.Get("q"))
	if term != "" && (len([]rune(term)) < 2 || len(term) > 100) {
		return bad("Type at least two characters to search.")
	}
	limit, _ := strconv.Atoi(query.Get("limit"))
	if limit < 1 || limit > 100 {
		limit = 50
	}
	offset, _ := strconv.Atoi(query.Get("offset"))
	offset = max(offset, 0)
	// The person's own scopes are written into the query (leadVisible): the cw_visible_lead function runs a query for every lead it is asked
	// about, which counted a workspace of hundreds of thousands in minutes while the page showed "0 leads".
	args := []any{}
	where := ""
	if term != "" {
		args = append(args, "%"+strings.NewReplacer(`\`, `\`, `%`, `\%`, `_`, `\_`).Replace(term)+"%")
		where = `(l.name ILIKE $1 OR l.phone ILIKE $1 OR l.email ILIKE $1 OR p.address ILIKE $1 OR p.city ILIKE $1 OR p.postal_code ILIKE $1) AND `
	}
	visible, args := leadVisible(q.sc, "l", args)
	where += visible
	if term == "" {
		where = `l.archived_at IS NULL AND ` + where
	}
	// What the Calls queue, a list's rows and the mail picker ask for: one list, leads that can be called (a phone number, not closed),
	// leads with an email.
	if project := strings.TrimSpace(query.Get("project")); project != "" {
		if !uuidPattern.MatchString(project) {
			return bad("That list does not exist.")
		}
		args = append(args, project)
		where += ` AND l.project_id = $` + strconv.Itoa(len(args))
	}
	if query.Get("callable") == "1" {
		where += ` AND l.phone <> '' AND l.stage <> 'Closed' AND l.archived_at IS NULL`
	}
	if query.Get("email") == "1" {
		where += ` AND l.email <> ''`
	}
	if stage := strings.TrimSpace(query.Get("stage")); stage != "" && len(stage) <= 40 {
		args = append(args, stage)
		where += ` AND l.stage = $` + strconv.Itoa(len(args))
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	body := map[string]any{}
	if query.Get("count") != "0" {
		var total int64
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE `+where, args...).Scan(&total); err != nil {
			return err
		}
		body["total"] = total
	}
	paged := append(args, limit, offset)
	leads, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE `+where+` ORDER BY l.name, l.id LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2), paged...)
	if err != nil {
		return err
	}
	for i, raw := range leads {
		if leads[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	body["leads"] = leads
	writeJSON(q.w, http.StatusOK, body)
	return nil
}

// leadDetails answers what hangs off one lead: its tasks, notes, calls, handoffs and deals. A device holding only a window of a big workspace
// asks for them when a lead outside the window is opened, instead of the snapshot carrying the details of every lead. The same rules as the
// snapshot apply: a lead the person cannot see answers as if it did not exist, and an outside viewer gets only what was shared with them.
func (s *server) leadDetails(q *req) error {
	ctx := q.r.Context()
	id := q.r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		return notFound("That lead does not exist.")
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var visible bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM leads l WHERE l.id = $1 AND cw_visible_lead(l.id))`, id).Scan(&visible); err != nil {
		return err
	}
	if !visible {
		return notFound("That lead does not exist.")
	}
	body := map[string]any{"deals": []json.RawMessage{}}
	for name, sql := range map[string]string{
		"tasks":    taskVisible + ` AND t.lead_id = $1`,
		"notes":    `SELECT to_jsonb(n) FROM notes n WHERE n.lead_id = $1 AND (NOT cw_external() OR n.visibility = 'shared')`,
		"calls":    `SELECT to_jsonb(c) FROM call_events c WHERE c.lead_id = $1 AND NOT cw_external()`,
		"handoffs": `SELECT to_jsonb(h) FROM handoffs h WHERE h.lead_id = $1 AND NOT cw_external()`,
	} {
		if body[name], err = queryJSON(ctx, tx, sql, id); err != nil {
			return err
		}
	}
	if q.sc.can("finance") {
		if body["deals"], err = queryJSON(ctx, tx, `SELECT to_jsonb(d) FROM deals d WHERE d.lead_id = $1 AND NOT cw_external()`, id); err != nil {
			return err
		}
	}
	writeJSON(q.w, http.StatusOK, body)
	return nil
}
