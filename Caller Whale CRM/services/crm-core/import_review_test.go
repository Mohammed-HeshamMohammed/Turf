package main

import (
	"context"
	"strconv"
	"testing"
	"time"
)

// seedRows writes holding rows as the worker would: row_no, name, phone, state, group, the lead it matches.
func (e *env) seedRows(id string, rows []seedRow) {
	e.t.Helper()
	for _, r := range rows {
		if _, err := e.admin.Exec(context.Background(), `INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, state, group_id, match_lead)
			VALUES ($1, $2, sha256($3::bytea), ARRAY[$4], $4, $5, $6, $7, $8)`,
			id, r.no, []byte(strconv.Itoa(r.no)), r.name, r.phone, r.state, r.group, r.match); err != nil {
			e.t.Fatal(err)
		}
	}
}

type seedRow struct {
	no                 int
	name, phone, state string
	group              *int
	match              *string
}

func (e *env) waitDone(id string) {
	e.t.Helper()
	var state string
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		_ = e.admin.QueryRow(context.Background(), `SELECT status FROM importing.jobs WHERE id = $1`, id).Scan(&state)
		if state == "done" {
			return
		}
	}
	e.t.Fatalf("merge finished as %q", state)
}

func TestPreviewMergeLogAndUndoOfAFoldedRow(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	var lead string
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"name": "Lee Existing"}), "applied")
	if err := e.admin.QueryRow(ctx, `SELECT id::text FROM crm.leads WHERE name = 'Lee Existing'`).Scan(&lead); err != nil {
		t.Fatal(err)
	}
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Austin"})
	id := job["id"].(string)
	e.seedRows(id, []seedRow{{1, "Sam Seller", "5550101", "clean", nil, nil}, {2, "Lee Existing", "5550177", "merge", nil, &lead}, {3, "Gone", "5550102", "skip", nil, nil}})
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'ready' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}

	// The preview says what adding the list does, before it is added.
	_, preview := e.call(alice, orgA, "GET", "/api/v1/imports/"+id+"/preview", nil)
	counts, _ := preview["counts"].(map[string]any)
	if counts["new_leads"] != float64(1) || counts["fill_existing"] != float64(1) || counts["left_out"] != float64(1) || counts["waiting"] != float64(0) {
		t.Fatalf("preview counts: %v", preview)
	}
	if fill, _ := preview["fill_sample"].([]any); len(fill) != 1 || fill[0].(map[string]any)["lead_name"] != "Lee Existing" {
		t.Fatalf("preview of a fill: %v", preview["fill_sample"])
	}

	e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/merge", nil)
	e.waitDone(id)
	var phone string
	_ = e.admin.QueryRow(ctx, `SELECT phone FROM crm.leads WHERE id = $1`, lead).Scan(&phone)
	if phone != "5550177" {
		t.Fatalf("the existing lead was not filled: %q", phone)
	}

	// The merge log shows which lead absorbed the row and what it filled.
	_, log := e.call(alice, orgA, "GET", "/api/v1/imports/"+id+"/merges", nil)
	rows, _ := log["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["lead_id"] != lead || rows[0].(map[string]any)["filled"].([]any)[0] != "phone" {
		t.Fatalf("merge log: %v", log)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/rows/1/undo-merge", nil); status != 404 {
		t.Fatalf("a row that became a new lead has no merge to undo: %d", status)
	}

	// Undoing it empties what it filled and makes the row a lead of its own.
	status, undone := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/rows/2/undo-merge", nil)
	if status != 200 || undone["emptied"].([]any)[0] != "phone" {
		t.Fatalf("undo: %d %v", status, undone)
	}
	_ = e.admin.QueryRow(ctx, `SELECT phone FROM crm.leads WHERE id = $1`, lead).Scan(&phone)
	var separate int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE name = 'Lee Existing' AND phone = '5550177' AND id <> $1`, lead).Scan(&separate)
	if phone != "" || separate != 1 {
		t.Fatalf("after undo: lead phone %q, separate leads %d", phone, separate)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/rows/2/undo-merge", nil); status != 404 {
		t.Fatalf("a second undo: %d", status)
	}
}

func TestDecidingAllRepeatsCanKeepTheLastRowAndReachOnlyOneKind(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	var lead string
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"name": "Lee Existing"}), "applied")
	if err := e.admin.QueryRow(ctx, `SELECT id::text FROM crm.leads WHERE name = 'Lee Existing'`).Scan(&lead); err != nil {
		t.Fatal(err)
	}
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Austin"})
	id := job["id"].(string)
	e.seedRows(id, []seedRow{
		{1, "Pat", "5550100", "near_duplicate", ptr(1), nil}, {2, "Pat O.", "5550100", "near_duplicate", ptr(1), nil},
		{3, "Lee", "5550177", "near_duplicate", ptr(2), &lead}})
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'reviewing' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/duplicates", map[string]any{"all": "merge", "only": "sideways"}); status != 400 {
		t.Fatalf("a bad scope: %d", status)
	}
	// Only the repeats inside the list, keeping the later row; the one that matches a lead in the account still waits.
	_, after := e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/duplicates", map[string]any{"all": "merge", "only": "inside", "keep": "last"})
	if after["status"] != "reviewing" {
		t.Fatalf("a row still waits: %v", after["status"])
	}
	states := map[int]string{}
	rows, err := e.admin.Query(ctx, `SELECT row_no, state FROM importing.rows WHERE job_id = $1`, id)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var no int
		var state string
		_ = rows.Scan(&no, &state)
		states[no] = state
	}
	rows.Close()
	if states[1] != "skip" || states[2] != "import" || states[3] != "near_duplicate" {
		t.Fatalf("states: %v", states)
	}
}

func TestConfirmedColumnAnswersAreRememberedByHeading(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Austin"})
	id := job["id"].(string)
	columns := `[{"idx":0,"header":"Owner","key":"owner","suggested":"name"},{"idx":1,"header":"Cell","key":"cell","suggested":"phone"},{"idx":2,"header":"Mood","key":"mood","suggested":null}]`
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'mapping', columns = $2::jsonb WHERE id = $1`, id, columns); err != nil {
		t.Fatal(err)
	}
	status, _ := e.call(alice, orgA, "PUT", "/api/v1/imports/"+id+"/mapping", map[string]any{"columns": []any{
		map[string]any{"idx": 0, "field": "name", "use": true}, map[string]any{"idx": 1, "field": "phone", "use": true}, map[string]any{"idx": 2, "use": false}}})
	if status != 200 {
		t.Fatalf("mapping: %d", status)
	}
	got := map[string]string{}
	rows, err := e.admin.Query(ctx, `SELECT header_key, coalesce(field, '') || '/' || used::text FROM importing.mapping_memory WHERE org_id = $1`, orgA)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key, answer string
		_ = rows.Scan(&key, &answer)
		got[key] = answer
	}
	rows.Close()
	if got["owner"] != "name/true" || got["cell"] != "phone/true" || got["mood"] != "/false" || len(got) != 3 {
		t.Fatalf("remembered: %v", got)
	}
}

func TestTwoRowsFoldedIntoOneLeadInOneBatchAreLoggedHonestly(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	var lead string
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"name": "Lee Existing"}), "applied")
	if err := e.admin.QueryRow(ctx, `SELECT id::text FROM crm.leads WHERE name = 'Lee Existing'`).Scan(&lead); err != nil {
		t.Fatal(err)
	}
	_, job := e.startImport(alice, orgA, map[string]any{"filename": "owners.csv", "size": 100, "name": "Austin"})
	id := job["id"].(string)
	e.seedRows(id, []seedRow{{1, "Lee Existing", "5550177", "merge", nil, &lead}, {2, "Lee E.", "5550188", "merge", nil, &lead}})
	if _, err := e.admin.Exec(ctx, `UPDATE importing.jobs SET status = 'ready' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	e.call(alice, orgA, "POST", "/api/v1/imports/"+id+"/merge", nil)
	e.waitDone(id)
	var phone string
	_ = e.admin.QueryRow(ctx, `SELECT phone FROM crm.leads WHERE id = $1`, lead).Scan(&phone)
	var first, second []string
	_ = e.admin.QueryRow(ctx, `SELECT filled FROM importing.rows WHERE job_id = $1 AND row_no = 1`, id).Scan(&first)
	_ = e.admin.QueryRow(ctx, `SELECT filled FROM importing.rows WHERE job_id = $1 AND row_no = 2`, id).Scan(&second)
	if phone != "5550177" || len(first) != 1 || len(second) != 0 {
		t.Fatalf("phone %q, first filled %v, second filled %v", phone, first, second)
	}
}
