package main

// List imports, the crm-core half (docs/plans/crm-core-and-imports.md). The import worker receives and parses files into SQL rows;
// the person confirms mapping and duplicates; this service merges those rows into leads in batches.
// The holding tables belong to the "importing" schema: the worker's login can reach only those, never the leads.

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const mergeBatch = 50000

// importFields are the CRM fields a source column can be matched to. Phones and emails may repeat (phone 1, phone 2).
var importFields = []string{"name", "first_name", "last_name", "phone", "email", "address", "unit", "city", "region", "zip", "country", "latitude", "longitude", "parcel", "value", "source"}
var sourceImportFields = []string{
	"source_record_id", "county", "living_area", "year_built", "lot_size_acres", "lot_size_square_feet",
	"land_use", "property_type", "property_use", "subdivision", "legal_description", "units",
	"bedrooms", "bathrooms", "stories", "garage_type", "garage_area", "carport", "carport_area",
	"cooling", "heating", "fireplaces", "owner_1_first_name", "owner_1_last_name",
	"owner_2_first_name", "owner_2_last_name", "owner_3_first_name", "owner_3_last_name",
	"owner_4_first_name", "owner_4_last_name", "owner_mailing_address", "owner_mailing_city",
	"owner_mailing_state", "owner_mailing_zip", "ownership_length", "owner_type", "owner_occupied",
	"vacancy", "batch_name", "original_file_name", "upload_date", "status", "original_status",
	"status_time", "status_agent", "lead_file_campaign",
}

func validImportField(field string, column map[string]any) bool {
	return slices.Contains(importFields, field) || slices.Contains(sourceImportFields, field) ||
		(column["source_detail"] != nil && column["standard_key"] == field && roleName.MatchString(field))
}

const jobColumns = `id::text, name, filename, size, chunk_size, total_chunks, status, progress, columns, report, error, loaded_rows, merged_rows, project_id::text, created_at, updated_at, kind, source_timezone, for_skip_tracing`

func (s *server) importRights(q *req) error {
	if !q.sc.can("import") {
		return forbidden("Your role cannot import lists.")
	}
	return nil
}

// job is one of this person's uploads (or any in the workspace, for an administrator).
func (s *server) job(ctx context.Context, q *req, id string) (map[string]any, error) {
	if !validID(id) {
		return nil, notFound("That import does not exist.")
	}
	rows, err := s.st.db.Query(ctx, `SELECT `+jobColumns+` FROM importing.jobs WHERE id = $1 AND org_id = $2 AND (user_id = $3 OR $4)`, id, q.sc.orgID, q.sc.userID, q.sc.can("admin"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list, err := scanJobs(rows)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, notFound("That import does not exist.")
	}
	return list[0], nil
}

func scanJobs(rows pgx.Rows) ([]map[string]any, error) {
	out := []map[string]any{}
	for rows.Next() {
		var id, name, filename, status, errText, kind, sourceTimezone string
		var forSkipTracing bool
		var size, loaded, merged int64
		var chunk, total int
		var progress, columns, report any
		var project *string
		var created, updated time.Time
		if err := rows.Scan(&id, &name, &filename, &size, &chunk, &total, &status, &progress, &columns, &report, &errText, &loaded, &merged, &project, &created, &updated, &kind, &sourceTimezone, &forSkipTracing); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "name": name, "filename": filename, "size": size, "chunk_size": chunk, "total_chunks": total,
			"status": status, "progress": progress, "columns": columns, "report": report, "error": errText, "loaded_rows": loaded, "merged_rows": merged,
			"project_id": project, "created_at": created, "updated_at": updated, "kind": kind, "source_timezone": sourceTimezone, "for_skip_tracing": forSkipTracing})
	}
	return out, rows.Err()
}

// importReply answers with the job as it stands, plus (while uploading) which pieces the server already holds, so an
// interrupted upload resumes where it stopped.
func (s *server) importReply(q *req, id string) error {
	ctx := q.r.Context()
	job, err := s.job(ctx, q, id)
	if err != nil {
		return err
	}
	if job["status"] == "uploading" {
		rows, err := s.st.db.Query(ctx, `SELECT n FROM importing.chunks WHERE job_id = $1 ORDER BY n`, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		received := []int{}
		for rows.Next() {
			var n int
			if err = rows.Scan(&n); err != nil {
				return err
			}
			received = append(received, n)
		}
		job["received"] = received
	}
	writeJSON(q.w, http.StatusOK, job)
	return nil
}

func (s *server) importGet(q *req) error { return s.importReply(q, q.r.PathValue("id")) }

// importRows shows the source rows as soon as the worker stores them, before they become CRM leads.
func (s *server) importRows(q *req) error {
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
	var total int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1`, id).Scan(&total); err != nil {
		return err
	}
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('row_no', row_no, 'cells', cells, 'state', state, 'lead_id', lead_id, 'source_data', source_data)
		FROM importing.rows WHERE job_id = $1 ORDER BY row_no OFFSET $2 LIMIT 50`, id, max(offset, 0))
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"total": total, "rows": rows})
	return nil
}

func (s *server) importList(q *req) error {
	kind := q.r.URL.Query().Get("kind")
	if kind == "" {
		kind = "lead_list"
	}
	if kind != "lead_list" && kind != "readymode_calls" {
		return bad("Choose a supported import type.")
	}
	rows, err := s.st.db.Query(q.r.Context(), `SELECT `+jobColumns+` FROM importing.jobs WHERE org_id = $1 AND (user_id = $2 OR $3) AND kind = $4 ORDER BY created_at DESC LIMIT 50`,
		q.sc.orgID, q.sc.userID, q.sc.can("admin"), kind)
	if err != nil {
		return err
	}
	defer rows.Close()
	list, err := scanJobs(rows)
	if err != nil {
		return err
	}
	for _, j := range list {
		delete(j, "columns")
	}
	writeJSON(q.w, http.StatusOK, list)
	return nil
}

func writeJob(q *req, job map[string]any) error {
	writeJSON(q.w, http.StatusOK, job)
	return nil
}

type columnChoice struct {
	Idx   int     `json:"idx"`
	Field *string `json:"field"`
	Use   bool    `json:"use"`
}

// importMapping records the person's answer: lead fields and structured source-only fields.
// The worker then loads only the columns that were kept; the others are not stored (the uploaded file is kept for a set time).
func (s *server) importMapping(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	if job["status"] != "mapping" {
		return bad("This import is not waiting for its columns to be confirmed.")
	}
	var body struct {
		Columns []columnChoice `json:"columns"`
	}
	if err = readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	columns, _ := job["columns"].([]any)
	chosen := map[int]columnChoice{}
	for _, c := range body.Columns {
		chosen[c.Idx] = c
	}
	mapped := map[string]bool{}
	for i, raw := range columns {
		col, _ := raw.(map[string]any)
		idx := int(asNumberOr(col["idx"], float64(i)))
		c, ok := chosen[idx]
		if !ok {
			return bad("Say what every column is, or that it is not used.")
		}
		if c.Use && (c.Field == nil || !validImportField(*c.Field, col)) {
			return bad("Choose a field for every column you keep.")
		}
		if c.Use && (*c.Field != "phone" && *c.Field != "email") && mapped[*c.Field] {
			return bad("Two columns are set to " + *c.Field + "; only phone and email can come from more than one.")
		}
		if c.Use {
			mapped[*c.Field] = true
			col["field"], col["used"] = *c.Field, true
		} else {
			col["field"], col["used"] = nil, false
		}
	}
	if !mapped["name"] && !mapped["first_name"] && !mapped["last_name"] {
		return bad("Keep a name column: leads need a name.")
	}
	skipping, _ := job["for_skip_tracing"].(bool)
	if !mapped["phone"] && !mapped["email"] && !(skipping && mapped["address"]) {
		if skipping {
			return bad("A list for skip tracing needs an address column (or a phone or an email column).")
		}
		return bad("Keep a phone or an email column: a list that nobody can contact is not added. A list of addresses only can be added when it is marked as being for skip tracing.")
	}
	if skipping {
		// The list is marked, so a list of addresses is not called useless later.
		tx, err := s.st.begin(q.r.Context(), q.sc)
		if err != nil {
			return err
		}
		defer tx.Rollback(q.r.Context())
		if _, err = tx.Exec(q.r.Context(), `UPDATE projects SET skip_tracing = true WHERE id = $1`, job["project_id"]); err != nil {
			return err
		}
		if err = tx.Commit(q.r.Context()); err != nil {
			return err
		}
	}
	// Remember the answers by heading, so the next list from this workspace with the same headings arrives already answered.
	for _, raw := range columns {
		col, _ := raw.(map[string]any)
		key, _ := col["key"].(string)
		if key == "" {
			continue
		}
		field, _ := col["field"].(string)
		used, _ := col["used"].(bool)
		if _, err = s.st.db.Exec(q.r.Context(), `INSERT INTO importing.mapping_memory (org_id, header_key, field, used) VALUES ($1, $2, NULLIF($3, ''), $4)
			ON CONFLICT (org_id, header_key) DO UPDATE SET field = EXCLUDED.field, used = EXCLUDED.used, updated_at = now()`, q.sc.orgID, key, field, used); err != nil {
			return err
		}
	}
	_, err = s.st.db.Exec(q.r.Context(), `UPDATE importing.jobs SET columns = $2, status = 'cleaning', progress = '{"phase":"cleaning","done":0}', updated_at = now() WHERE id = $1 AND status = 'mapping'`, id, columns)
	if err != nil {
		return err
	}
	return s.importReply(q, id)
}

func asNumberOr(v any, fallback float64) float64 {
	if n := asNumber(v); n != nil {
		return *n
	}
	return fallback
}

// importDuplicates lists rows that match each other, or an existing lead, after cleaning, for the person to decide on.
func (s *server) importDuplicates(q *req) error {
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
	var total int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND state = 'near_duplicate'`, id).Scan(&total); err != nil {
		return err
	}
	// The whole row as it was in the file (cells, in the order of the file's columns), and, for a lead already in the account, what it holds,
	// so the person compares complete rows and not a name and an address.
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('row_no', r.row_no, 'group_id', r.group_id, 'name', r.name, 'phone', r.phone, 'email', r.email,
			'address', r.address, 'city', r.city, 'zip', r.zip, 'cells', to_jsonb(r.cells), 'match_lead', r.match_lead, 'match_name', l.name,
			'match_phone', l.phone, 'match_email', l.email, 'match_address', p.address, 'match_city', p.city, 'match_zip', p.postal_code)
		FROM importing.rows r LEFT JOIN leads l ON l.id = r.match_lead AND cw_visible_lead(l.id) LEFT JOIN properties p ON p.id = l.property_id
		WHERE r.job_id = $1 AND r.state = 'near_duplicate' ORDER BY r.group_id, r.row_no OFFSET $2 LIMIT 200`, id, max(offset, 0))
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"total": total, "rows": rows})
	return nil
}

// importDecide settles repeat groups: "merge" keeps one row per group (folding it into the matching lead when there is one),
// "import" keeps every row as its own lead, "skip" leaves the group out. Rows that were not repeats import on their own.
func (s *server) importDecide(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	if job["status"] != "reviewing" {
		return bad("This import has no repeats waiting for a decision.")
	}
	var body struct {
		Decisions []struct {
			GroupID int64  `json:"group_id"`
			Action  string `json:"action"`
		} `json:"decisions"`
		All string `json:"all"`
		// With "all": which groups it reaches ("existing" = rows that match a lead already in the account, "inside" = rows that
		// repeat inside this list; empty = both), and for merge which row of a group stays ("first" in the file, or "last").
		Only string `json:"only"`
		Keep string `json:"keep"`
	}
	if err = readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if !slices.Contains([]string{"", "existing", "inside"}, body.Only) || !slices.Contains([]string{"", "first", "last"}, body.Keep) {
		return bad("only is existing or inside; keep is first or last.")
	}
	byAction := map[string][]int64{}
	for _, d := range body.Decisions {
		if !slices.Contains([]string{"merge", "import", "skip"}, d.Action) {
			return bad("Each decision is merge, import or skip.")
		}
		byAction[d.Action] = append(byAction[d.Action], d.GroupID)
	}
	ctx := q.r.Context()
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// reach picks the rows an action touches: the listed groups, or with "all" every waiting group (narrowed by "only").
	const reach = `(($3 AND ($4 = '' OR (match_lead IS NOT NULL) = ($4 = 'existing'))) OR group_id = ANY($2))`
	apply := func(action string, groups []int64, every bool) error {
		switch action {
		case "skip":
			_, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'skip' WHERE job_id = $1 AND state = 'near_duplicate' AND `+reach, id, groups, every, body.Only)
			return err
		case "import":
			_, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'import' WHERE job_id = $1 AND state = 'near_duplicate' AND `+reach, id, groups, every, body.Only)
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE importing.rows r SET state = CASE WHEN x.rn = 1 THEN CASE WHEN r.match_lead IS NOT NULL THEN 'merge' ELSE 'import' END ELSE 'skip' END
			FROM (SELECT row_no, row_number() OVER (PARTITION BY group_id ORDER BY CASE WHEN $5 = 'last' THEN -row_no ELSE row_no END) AS rn FROM importing.rows
				WHERE job_id = $1 AND state = 'near_duplicate' AND `+reach+`) x
			WHERE r.job_id = $1 AND r.row_no = x.row_no`, id, groups, every, body.Only, body.Keep)
		return err
	}
	for action, groups := range byAction {
		if err = apply(action, groups, false); err != nil {
			return err
		}
	}
	if body.All != "" {
		if !slices.Contains([]string{"merge", "import", "skip"}, body.All) {
			return bad("all is merge, import or skip.")
		}
		if err = apply(body.All, nil, true); err != nil {
			return err
		}
	}
	var left int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM importing.rows WHERE job_id = $1 AND state = 'near_duplicate'`, id).Scan(&left); err != nil {
		return err
	}
	if left == 0 {
		if _, err = tx.Exec(ctx, `UPDATE importing.jobs SET status = 'ready', progress = '{"phase":"ready","done":0}', updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.importReply(q, id)
}

func (s *server) importMerge(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	if job["kind"] != "lead_list" || job["status"] != "ready" {
		return bad("This import is not ready to be added to your leads yet.")
	}
	if _, err = s.st.db.Exec(q.r.Context(), `UPDATE importing.jobs SET status = 'merging', progress = '{"phase":"merging","done":0}', updated_at = now() WHERE id = $1 AND status = 'ready'`, id); err != nil {
		return err
	}
	go s.runMerge(context.Background(), id)
	return s.importReply(q, id)
}

// Retry only a failed merge. Worker upload and cleaning failures need their own recovery path.
// Rows already marked merged are skipped by mergeBatch, so a partial merge resumes safely.
func (s *server) importRetryMerge(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	progress, _ := job["progress"].(map[string]any)
	if job["status"] != "failed" || (progress["phase"] != "merging" && progress["phase"] != "call_merging") {
		return bad("Only a failed lead merge can be retried here.")
	}
	phase := progress["phase"].(string)
	result, err := s.st.db.Exec(q.r.Context(), `UPDATE importing.jobs SET status = $2, error = '', cancel_requested = false, updated_at = now()
		WHERE id = $1 AND status = 'failed' AND progress->>'phase' = $2`, id, phase)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return bad("This import has already changed. Refresh it and try again.")
	}
	if phase == "call_merging" {
		go s.runCallMerge(context.Background(), id)
	} else {
		go s.runMerge(context.Background(), id)
	}
	return s.importReply(q, id)
}

func (s *server) importCancel(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	switch job["status"] {
	case "done", "failed", "cancelled":
		return writeJob(q, job)
	}
	// The worker and the merge look at the flag between batches and stop; anything already merged stays.
	if _, err = s.st.db.Exec(q.r.Context(), `UPDATE importing.jobs SET cancel_requested = true, status = 'cancelled', updated_at = now() WHERE id = $1`, id); err != nil {
		return err
	}
	return s.importReply(q, id)
}

// Remove a failed or cancelled import. Completed imports retain their source rows
// until the source list is deleted.
func (s *server) importDelete(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That import does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var project *string
	var status string
	err = tx.QueryRow(ctx, `SELECT project_id::text, status FROM importing.jobs
		WHERE id = $1 AND org_id = cw_org() AND (user_id = $2 OR $3) FOR UPDATE`, id, q.sc.userID, q.sc.can("admin")).Scan(&project, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("That import does not exist.")
	}
	if err != nil {
		return err
	}
	if !slices.Contains([]string{"failed", "cancelled"}, status) {
		return bad("Only failed or cancelled imports can be removed. Delete the source list to remove a completed import and its leads.")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM importing.jobs WHERE id = $1`, id); err != nil {
		return err
	}
	var removedProject string
	if project != nil {
		err = tx.QueryRow(ctx, `DELETE FROM projects p WHERE p.id = $1
			AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.project_id = p.id)
			AND NOT EXISTS (SELECT 1 FROM importing.jobs j WHERE j.project_id = p.id)
			RETURNING id::text`, *project).Scan(&removedProject)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if removedProject != "" {
		if _, err = tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'project.changed')::text)`); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"removed": id, "removed_project": removedProject})
	return nil
}

// ------------------------------------------------------------------------------------------------------- merge

var mergeLock sync.Mutex // one big merge at a time in this process; across copies, SKIP LOCKED keeps batches apart

// runMerge moves the cleaned rows into leads, 50,000 at a time, each batch in its own transaction, so the CRM stays usable and
// a restart continues from the next batch (rows already merged are marked).
func (s *server) runMerge(ctx context.Context, id string) {
	mergeLock.Lock()
	defer mergeLock.Unlock()
	fail := func(err error) {
		log.Printf("ERROR merging import %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET status = 'failed', error = 'The list could not be added to your leads. Nothing was lost; try again or contact support.', updated_at = now() WHERE id = $1`, id)
	}
	var org, user string
	var project, team *string
	var total int64
	err := s.st.db.QueryRow(ctx, `SELECT j.org_id::text, j.user_id::text, j.project_id::text, j.team_id::text,
			(SELECT count(*) FROM importing.rows r WHERE r.job_id = j.id AND r.state IN ('clean', 'import', 'merge'))
		FROM importing.jobs j WHERE j.id = $1 AND j.status = 'merging'`, id).Scan(&org, &user, &project, &team, &total)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			fail(err)
		}
		return
	}
	sc := scope{userID: user, orgID: org, scopes: []string{"organization"}}
	var done int64
	for {
		var cancelled bool
		if err = s.st.db.QueryRow(ctx, `SELECT cancel_requested FROM importing.jobs WHERE id = $1`, id).Scan(&cancelled); err != nil || cancelled {
			return
		}
		n, err := s.mergeBatch(ctx, sc, id, project, team)
		if err != nil {
			fail(err)
			return
		}
		done += n
		if n == 0 {
			break
		}
		_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET merged_rows = merged_rows + $2, progress = jsonb_build_object('phase', 'merging', 'done', merged_rows + $2, 'total', $3::bigint), updated_at = now() WHERE id = $1`, id, n, total)
	}
	_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET status = 'done', progress = jsonb_build_object('phase', 'done', 'done', merged_rows, 'total', $2::bigint), updated_at = now() WHERE id = $1 AND status = 'merging'`, id, total)
	s.hub.publish(org, []byte(`{"kind":"import.done","entity":"lead","seq":0}`))
	go func() {
		if err := s.learnJob(context.WithoutCancel(ctx), id); err != nil && !errors.Is(err, errLearningOff) {
			log.Printf("WARN learning copy of import %s will be retried: %v", id, err)
		}
	}()
}

// mergeBatch adds up to 50,000 new leads (and folds rows into the leads they matched), in one transaction. It returns how
// many rows it settled; zero means none are left.
func (s *server) mergeBatch(ctx context.Context, sc scope, id string, project, team *string) (int64, error) {
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	n, err := mergeBatchIn(ctx, tx, sc, id, project, team)
	if err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}

// mergeBatchIn does the work of mergeBatch inside a transaction the caller owns and commits.
func mergeBatchIn(ctx context.Context, tx pgx.Tx, sc scope, id string, project, team *string) (int64, error) {
	var created int64
	err := tx.QueryRow(ctx, `
		WITH batch AS (
			SELECT r.*, gen_random_uuid() AS new_lead_id, gen_random_uuid() AS prop_id FROM importing.rows r
			WHERE r.job_id = $1 AND r.state IN ('clean', 'import') ORDER BY r.row_no LIMIT $2 FOR UPDATE SKIP LOCKED
		), props AS (
			INSERT INTO properties (id, org_id, address, unit, city, region, postal_code, country, parcel, latitude, longitude, location_source, details)
			SELECT prop_id, cw_org(), coalesce(address, ''), coalesce(unit, ''), coalesce(city, ''), coalesce(region, ''), coalesce(zip, ''), coalesce(country, ''), coalesce(parcel, ''),
				CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN latitude END, CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN longitude END,
				CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 'supplied' ELSE 'none' END,
				importing.property_details(source_data)
			FROM batch WHERE address IS NOT NULL OR zip IS NOT NULL OR city IS NOT NULL OR latitude IS NOT NULL RETURNING id
		), ins AS (
			INSERT INTO leads (id, org_id, project_id, team_id, property_id, assignee_id, name, phone, email, source, value_amount, stage, contacts)
			SELECT new_lead_id, cw_org(), $3::uuid, $4::uuid, p.id, $5::uuid, coalesce(nullif(b.name, ''), nullif(b.phone, ''), nullif(b.email, ''), nullif(b.address, ''), 'Unnamed lead'),
				coalesce(b.phone, ''), coalesce(b.email, ''), coalesce(nullif(b.source, ''), $6), b.value, 'New', coalesce(b.contacts, '{}')
			FROM batch b LEFT JOIN props p ON p.id = b.prop_id RETURNING id
		), feed AS (
			INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) SELECT cw_org(), 'lead', id, id, 'upsert' FROM ins RETURNING 1
		), settled AS (
			UPDATE importing.rows r SET state = 'merged', lead_id = b.new_lead_id FROM batch b WHERE r.job_id = $1 AND r.row_no = b.row_no RETURNING 1
		) SELECT (SELECT count(*) FROM settled)`, id, mergeBatch, project, team, sc.userID, "Import").Scan(&created)
	if err != nil {
		return 0, err
	}
	// Rows that matched an existing lead only fill what that lead is missing; nothing it already holds is replaced. What each row filled is
	// written down (filled), so the merge can be looked at and undone.
	var folded int64
	err = tx.QueryRow(ctx, `
		WITH picked AS (
			SELECT r.row_no, r.match_lead, r.phone, r.email, r.contacts FROM importing.rows r
			WHERE r.job_id = $1 AND r.state = 'merge' ORDER BY r.row_no LIMIT $2 FOR UPDATE SKIP LOCKED
		), batch AS (
			-- Several rows of one batch may match the same lead; only the first writes (an update takes one row per lead), so only it is
			-- written down as having filled something, and the others as having filled nothing.
			SELECT p.row_no, p.match_lead, p.rn, p.contacts, CASE WHEN p.rn = 1 THEN p.phone END AS phone, CASE WHEN p.rn = 1 THEN p.email END AS email,
				CASE WHEN p.rn = 1 THEN array_remove(ARRAY[CASE WHEN l.phone = '' AND p.phone IS NOT NULL THEN 'phone' END, CASE WHEN l.email = '' AND p.email IS NOT NULL THEN 'email' END], NULL)
					ELSE ARRAY[]::text[] END AS filled
			FROM (SELECT picked.*, row_number() OVER (PARTITION BY match_lead ORDER BY row_no) AS rn FROM picked) p LEFT JOIN leads l ON l.id = p.match_lead
		), upd AS (
			UPDATE leads l SET phone = CASE WHEN l.phone = '' THEN coalesce(b.phone, '') ELSE l.phone END,
				email = CASE WHEN l.email = '' THEN coalesce(b.email, '') ELSE l.email END,
				contacts = CASE WHEN l.contacts = '{}' THEN coalesce(b.contacts, '{}') ELSE l.contacts END, version = l.version + 1, updated_at = now()
			FROM batch b WHERE b.rn = 1 AND l.id = b.match_lead AND l.org_id = cw_org() AND l.deleted_at IS NULL RETURNING l.id
		), feed AS (
			INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) SELECT cw_org(), 'lead', id, id, 'upsert' FROM upd RETURNING 1
		), settled AS (
			UPDATE importing.rows r SET state = 'merged', lead_id = b.match_lead, filled = b.filled FROM batch b WHERE r.job_id = $1 AND r.row_no = b.row_no RETURNING 1
		) SELECT (SELECT count(*) FROM settled)`, id, mergeBatch).Scan(&folded)
	if err != nil {
		return 0, err
	}
	if created+folded > 0 {
		if _, err = tx.Exec(ctx, `SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'import.batch', 'entity', 'lead', 'seq', 0)::text)`); err != nil {
			return 0, err
		}
	}
	return created + folded, nil
}

// resumeMerges continues imports that were merging when the service last stopped.
func (s *server) resumeMerges(ctx context.Context) {
	rows, err := s.st.db.Query(ctx, `SELECT id::text, status FROM importing.jobs WHERE status IN ('merging', 'call_merging') AND NOT cancel_requested`)
	if err != nil {
		log.Printf("WARN looking for imports to continue: %v", err)
		return
	}
	type pending struct{ id, status string }
	var ids []pending
	for rows.Next() {
		var item pending
		if rows.Scan(&item.id, &item.status) == nil {
			ids = append(ids, item)
		}
	}
	rows.Close()
	for _, item := range ids {
		if item.status == "call_merging" {
			go s.runCallMerge(ctx, item.id)
		} else {
			go s.runMerge(ctx, item.id)
		}
	}
}

// keepRows is how many days failed or cancelled imports retain their holding rows.
// Completed imports keep their original source rows in PostgreSQL until the list is deleted.
const keepRows = 14

// sweepRows deletes abandoned holding rows while retaining completed source rows.
func (s *server) sweepRows(ctx context.Context) (int64, error) {
	tag, err := s.st.db.Exec(ctx, `DELETE FROM importing.rows WHERE job_id IN
		(SELECT id FROM importing.jobs WHERE status IN ('failed', 'cancelled') AND updated_at < now() - make_interval(days => $1))`, keepRows)
	return tag.RowsAffected(), err
}

// sweepRowsPeriodically removes old failed holding rows. The worker owns the upload files.
func (s *server) sweepRowsPeriodically(ctx context.Context) {
	for {
		if n, err := s.sweepRows(ctx); err != nil {
			log.Printf("WARN clearing old import rows: %v", err)
		} else if n > 0 {
			log.Printf("INFO cleared %d old import rows", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(6 * time.Hour):
		}
	}
}
