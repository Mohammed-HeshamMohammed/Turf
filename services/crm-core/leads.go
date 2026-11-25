package crm

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
// Search is served by trigram indexes (0020): names, emails and addresses by any part, phones by their digits whatever the format,
// city and ZIP from their start. Each part is its own simple query on one table, so each can use its index.
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
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(term)
		args = append(args, "%"+escaped+"%", strings.ToLower(escaped)+"%")
		phone := `x.phone ILIKE $1`
		if digits := onlyDigits(term); len(digits) >= 3 && !strings.ContainsFunc(term, isNotPhone) {
			// A phone typed any way (813 555-0100, +1 (813)...) is compared by its digits.
			args = append(args, "%"+digits+"%")
			phone = `regexp_replace(x.phone, '[^0-9]', '', 'g') LIKE $3`
		}
		where = `l.id IN (SELECT x.id FROM leads x WHERE x.deleted_at IS NULL AND (x.name ILIKE $1 OR x.email ILIKE $1 OR ` + phone + `)
			UNION SELECT x.id FROM leads x JOIN properties a ON a.id = x.property_id WHERE x.deleted_at IS NULL
				AND (a.address ILIKE $1 OR lower(a.city) LIKE $2 OR lower(a.postal_code) LIKE $2)) AND `
	}
	visible, args := leadSeen(q.sc, "l", args)
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
	// One person's leads (the Team page's "Active leads"), or nobody's. leadSeen above already limits it to what the asker may see,
	// so a team lead filtering by someone outside their teams gets none.
	switch assignee := strings.TrimSpace(query.Get("assignee")); {
	case assignee == "unassigned":
		where += ` AND l.assignee_id IS NULL`
	case assignee != "":
		if !uuidPattern.MatchString(assignee) {
			return bad("That person does not exist.")
		}
		args = append(args, assignee)
		where += ` AND l.assignee_id = $` + strconv.Itoa(len(args))
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
		// A search counts up to 10,001 matches: enough to say "10,000+" without reading every match of a very common term.
		counted := `SELECT count(*) FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE ` + where
		if term != "" {
			counted = `SELECT count(*) FROM (SELECT 1 FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE ` + where + ` LIMIT 10001) c`
		}
		if err = tx.QueryRow(ctx, counted, args...).Scan(&total); err != nil {
			return err
		}
		body["total"] = total
		body["total_capped"] = term != "" && total > 10000
	}
	paged := append(args, limit, offset)
	// sort=newest: the most recently added first (the Leads page, so an import's leads appear at the top batch by batch); otherwise by name.
	order := ` ORDER BY l.name, l.id`
	if query.Get("sort") == "newest" {
		order = ` ORDER BY l.created_at DESC, l.id DESC`
	}
	leads, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) || `+readOnly(q.sc, "l")+` || `+leadTagsColumn("l")+` FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE `+where+order+` LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2), paged...)
	if err != nil {
		return err
	}
	for i, raw := range leads {
		if leads[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	// Paging through leads counts toward unusual access (D164): a page of 20 counts as one lead opened.
	s.noteAccess(q, "", (len(leads)+19)/20)
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
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM leads l WHERE l.id = $1 AND cw_seen_lead(l.id))`, id).Scan(&visible); err != nil {
		return err
	}
	if !visible {
		return notFound("That lead does not exist.")
	}
	body := map[string]any{"deals": []json.RawMessage{}}
	// The lead itself comes too: a page that lost it from this device's window (a fresh snapshot, a reset) gets it back.
	lead, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) || `+readOnly(q.sc, "l")+` || `+leadTagsColumn("l")+` FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE l.id = $1`, id)
	if err != nil {
		return err
	}
	for i, raw := range lead {
		if lead[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	// Who opened which lead (D165), and far more than usual (D164).
	if len(lead) > 0 {
		s.noteAccess(q, id, 1)
	}
	body["leads"] = lead
	for name, sql := range map[string]string{
		"tasks":    taskVisible + ` AND t.lead_id = $1`,
		"notes":    `SELECT to_jsonb(n) FROM notes n WHERE n.lead_id = $1 AND (NOT cw_external() OR n.visibility = 'shared')`,
		"calls":    `SELECT to_jsonb(c) || jsonb_build_object('phone', cw_call_phone(c.phone, c.lead_id)) FROM call_events c WHERE c.lead_id = $1 AND (NOT cw_external() OR c.shared_with_client)`,
		"handoffs": `SELECT to_jsonb(h) FROM handoffs h WHERE h.lead_id = $1 AND NOT cw_external()`,
		// Co-owners: other leads at the same property under another name, each kept as its own lead (linkCoOwners).
		"related": `SELECT jsonb_build_object('id', b.id, 'name', b.name, 'kind', k.kind) FROM lead_links k JOIN leads b ON b.id = k.related_id
			WHERE k.lead_id = $1 AND b.deleted_at IS NULL AND cw_seen_lead(b.id) ORDER BY b.name`,
	} {
		if body[name], err = queryJSON(ctx, tx, sql, id); err != nil {
			return err
		}
	}
	if q.sc.can("finance") {
		if body["deals"], err = queryJSON(ctx, tx, `SELECT to_jsonb(d) FROM deals d WHERE d.lead_id = $1 AND (NOT cw_external() OR d.shared_with_client) AND cw_visible_lead(d.lead_id)`, id); err != nil {
			return err
		}
	}
	writeJSON(q.w, http.StatusOK, body)
	return nil
}

func onlyDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isNotPhone is a character a typed phone number does not have (digits, spaces, +, -, dots and brackets are fine).
func isNotPhone(r rune) bool { return !strings.ContainsRune("0123456789 +-().", r) }
