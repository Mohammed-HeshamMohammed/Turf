package crm

// Looking at an import before it is added (preview) and after (what was folded into existing leads, and undoing one).

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// importPreview says what adding the list will do: how many new leads, how many rows fill gaps in leads already there, how many are
// left out, and how many still wait for a decision, with a few examples of each.
func (s *server) importPreview(q *req) error {
	id := q.r.PathValue("id")
	if _, err := s.job(q.r.Context(), q, id); err != nil {
		return err
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	counts := json.RawMessage(`{}`)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object(
			'new_leads', count(*) FILTER (WHERE state IN ('clean', 'import')),
			'fill_existing', count(*) FILTER (WHERE state = 'merge'),
			'left_out', count(*) FILTER (WHERE state = 'skip'),
			'waiting', count(*) FILTER (WHERE state = 'near_duplicate'))
		FROM importing.rows WHERE job_id = $1`, id)
	if err != nil {
		return err
	}
	if len(rows) == 1 {
		counts = rows[0]
	}
	newSample, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('row_no', row_no, 'name', name, 'phone', phone, 'email', email, 'address', address)
		FROM importing.rows WHERE job_id = $1 AND state IN ('clean', 'import') ORDER BY row_no LIMIT 5`, id)
	if err != nil {
		return err
	}
	// For a row folded into a lead: that lead, and what the row would put in it (only the fields the lead is missing).
	fillSample, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('row_no', r.row_no, 'name', r.name, 'lead_id', r.match_lead, 'lead_name', l.name,
			'would_fill', array_remove(ARRAY[CASE WHEN l.phone = '' AND r.phone IS NOT NULL THEN 'phone' END, CASE WHEN l.email = '' AND r.email IS NOT NULL THEN 'email' END], NULL))
		FROM importing.rows r JOIN leads l ON l.id = r.match_lead AND cw_visible_lead(l.id)
		WHERE r.job_id = $1 AND r.state = 'merge' ORDER BY r.row_no LIMIT 5`, id)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"counts": counts, "new_sample": newSample, "fill_sample": fillSample})
	return nil
}

// importMerges is the merge log: the rows of a finished import that were folded into leads already in the account, and what each filled.
func (s *server) importMerges(q *req) error {
	id := q.r.PathValue("id")
	if _, err := s.job(q.r.Context(), q, id); err != nil {
		return err
	}
	offset, _ := strconv.Atoi(q.r.URL.Query().Get("offset"))
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('row_no', r.row_no, 'name', r.name, 'phone', r.phone, 'email', r.email, 'lead_id', r.lead_id,
			'lead_name', l.name, 'filled', r.filled)
		FROM importing.rows r LEFT JOIN leads l ON l.id = r.lead_id AND cw_visible_lead(l.id)
		WHERE r.job_id = $1 AND r.state = 'merged' AND r.filled IS NOT NULL ORDER BY r.row_no OFFSET $2 LIMIT 200`, id, max(offset, 0))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"rows": rows})
	return nil
}

// importUndoMerge reverses one folded row: whatever it filled into the lead is emptied again (only if the lead still holds that very
// value), and the row becomes a lead of its own, as if the person had answered "not the same person".
func (s *server) importUndoMerge(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	rowNo, err := strconv.ParseInt(q.r.PathValue("row"), 10, 64)
	if err != nil {
		return bad("That row does not exist.")
	}
	if job["status"] != "done" {
		return bad("A merge can be undone once the import has finished.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lead string
	var phone, email *string
	var filled []string
	err = tx.QueryRow(ctx, `SELECT lead_id::text, phone, email, filled FROM importing.rows
		WHERE job_id = $1 AND row_no = $2 AND state = 'merged' AND filled IS NOT NULL FOR UPDATE`, id, rowNo).Scan(&lead, &phone, &email, &filled)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("That row was not folded into a lead already in the account.")
	}
	if err != nil {
		return err
	}
	reverted := []string{}
	for _, field := range filled {
		var value *string
		column := "phone"
		value = phone
		if field == "email" {
			column, value = "email", email
		}
		if value == nil {
			continue
		}
		tag, err := tx.Exec(ctx, `UPDATE leads SET `+column+` = '', version = version + 1, updated_at = now() WHERE id = $1 AND `+column+` = $2 AND deleted_at IS NULL`, lead, *value)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			reverted = append(reverted, field)
		}
	}
	if len(reverted) > 0 {
		if _, err = tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, lead); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE importing.rows SET state = 'import', lead_id = NULL, match_lead = NULL, filled = NULL WHERE job_id = $1 AND row_no = $2`, id, rowNo); err != nil {
		return err
	}
	var project, team *string
	if err = tx.QueryRow(ctx, `SELECT project_id::text, team_id::text FROM importing.jobs WHERE id = $1`, id).Scan(&project, &team); err != nil {
		return err
	}
	if _, err = mergeBatchIn(ctx, tx, q.sc, id, project, team); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"row_no": rowNo, "lead_id": lead, "emptied": reverted})
	return nil
}

// clearedFields are the fields the tidying checks, and what makes a row count as "had something there that could not be used".
var clearedFields = map[string]string{
	"phone":         "phone IS NULL AND NOT (DIGITS)",
	"phone_made_up": "phone IS NULL AND (DIGITS)",
	"email":         "email IS NULL",
	"value":         "value IS NULL",
	"latitude":      "latitude IS NULL",
	"longitude":     "longitude IS NULL",
}

// importCleared lists the rows behind one count of the cleaning report: the rows that had something in a field's column(s) that the
// tidying could not use, with what was there. ?field=phone|phone_made_up|email|value|latitude|longitude, 500 rows a page.
func (s *server) importCleared(q *req) error {
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	field := q.r.URL.Query().Get("field")
	condition, ok := clearedFields[field]
	if !ok {
		return bad("Choose which count to show the rows of.")
	}
	column := strings.TrimSuffix(field, "_made_up")
	// The places of that field's columns in the stored cells; they are numbers from the job's own columns, never text from the request.
	var cells, filled, digits, headers []string
	columns, _ := job["columns"].([]any)
	for _, raw := range columns {
		col, _ := raw.(map[string]any)
		if col["field"] != column {
			continue
		}
		n := int(asNumberOr(col["idx"], -1)) + 1
		if n < 1 {
			continue
		}
		cells = append(cells, fmt.Sprintf("cells[%d]", n))
		filled = append(filled, fmt.Sprintf("btrim(cells[%d]) <> ''", n))
		digits = append(digits, fmt.Sprintf("importing.norm_phone(cells[%d]) IS NOT NULL", n))
		header, _ := col["header"].(string)
		headers = append(headers, header)
	}
	if len(cells) == 0 {
		writeJSON(q.w, 200, map[string]any{"total": 0, "headers": []string{}, "rows": []any{}})
		return nil
	}
	where := "(" + strings.Join(filled, " OR ") + ") AND " + strings.ReplaceAll(condition, "DIGITS", strings.Join(digits, " OR "))
	offset, _ := strconv.Atoi(q.r.URL.Query().Get("offset"))
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var total int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND `+where, id).Scan(&total); err != nil {
		return err
	}
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('row_no', row_no, 'name', name, 'values', to_jsonb(ARRAY[`+strings.Join(cells, ", ")+`]))
		FROM importing.rows WHERE job_id = $1 AND `+where+` ORDER BY row_no OFFSET $2 LIMIT 500`, id, max(offset, 0))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"total": total, "headers": headers, "rows": rows})
	return nil
}

// importColumnsAgain goes back to the column step: the rows loaded so far are thrown away and the worker reads the kept file again,
// so a column that was left out can be kept after all. Possible until the list is added to the leads, and while its file is kept.
func (s *server) importColumnsAgain(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	status, _ := job["status"].(string)
	if job["kind"] != "lead_list" || (status != "mapping" && status != "reviewing" && status != "ready") {
		return bad("The columns can be chosen again until the list is added to your leads.")
	}
	ctx := q.r.Context()
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE importing.jobs SET status = 'queued', columns = '[]', report = '{}', loaded_rows = 0, merged_rows = 0, error = '',
			worker = NULL, heartbeat_at = NULL, progress = '{"phase":"queued","done":0}', updated_at = now()
		WHERE id = $1 AND status = $2`, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return bad("This import has already changed. Refresh it and try again.")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM importing.rows WHERE job_id = $1`, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.importReply(q, id)
}
