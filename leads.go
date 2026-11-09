package main

import (
	"net/http"
	"strconv"
	"strings"
)

// searchLeads finds leads the person may see by name, phone, email or address, a page at a time. A snapshot carries only a window of a big
// workspace; this is how the rest is reached. Answers {"leads": [...], "total": n}: the leads as the snapshot sends them.
// ponytail: ILIKE scans the workspace's leads; add a pg_trgm index if searches over a few hundred thousand leads feel slow.
func (s *server) searchLeads(q *req) error {
	ctx := q.r.Context()
	term := strings.TrimSpace(q.r.URL.Query().Get("q"))
	if len([]rune(term)) < 2 || len(term) > 100 {
		return bad("Type at least two characters to search.")
	}
	limit, _ := strconv.Atoi(q.r.URL.Query().Get("limit"))
	if limit < 1 || limit > 100 {
		limit = 50
	}
	offset, _ := strconv.Atoi(q.r.URL.Query().Get("offset"))
	offset = max(offset, 0)
	like := "%" + strings.NewReplacer(`\`, `\`, `%`, `\%`, `_`, `\_`).Replace(term) + "%"
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	const match = `(l.name ILIKE $1 OR l.phone ILIKE $1 OR l.email ILIKE $1 OR p.address ILIKE $1 OR p.city ILIKE $1 OR p.postal_code ILIKE $1) AND cw_visible_lead(l.id)`
	var total int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE `+match, like).Scan(&total); err != nil {
		return err
	}
	leads, err := queryJSON(ctx, tx, `SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE `+match+` ORDER BY l.name, l.id LIMIT $2 OFFSET $3`, like, limit, offset)
	if err != nil {
		return err
	}
	for i, raw := range leads {
		if leads[i], err = redactRaw(raw, q.sc); err != nil {
			return err
		}
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"leads": leads, "total": total})
	return nil
}
