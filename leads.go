package main

import (
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
	where := `cw_visible_lead(l.id)`
	args := []any{}
	if term == "" {
		where = `l.archived_at IS NULL AND ` + where
	} else {
		args = append(args, "%"+strings.NewReplacer(`\`, `\`, `%`, `\%`, `_`, `\_`).Replace(term)+"%")
		where = `(l.name ILIKE $1 OR l.phone ILIKE $1 OR l.email ILIKE $1 OR p.address ILIKE $1 OR p.city ILIKE $1 OR p.postal_code ILIKE $1) AND ` + where
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
