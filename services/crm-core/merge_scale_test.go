package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"
)

// How long the two merges take at a real size: a list of leads into a workspace that already has many, and a ReadyMode call history
// (several calls per person, some people already leads). Slow, so it runs only when MERGE_SCALE is set; it runs on the Coolify server
// through bench/ (the numbers that count are that machine's):
//
//	MERGE_SCALE=100000 CALL_SCALE=30000 EXISTING_LEADS=200000 go test -run TestMergeAtScale -v -timeout 2h
func TestMergeAtScale(t *testing.T) {
	rows := envInt("MERGE_SCALE", 0)
	if rows < 1 {
		t.Skip("set MERGE_SCALE to the number of list rows to merge")
	}
	calls, existing := envInt("CALL_SCALE", rows/3), envInt("EXISTING_LEADS", rows*2)
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil) // the workspace is made when it is first used
	run := func(what string, sql string, args ...any) {
		t.Helper()
		started := time.Now()
		if _, err := e.admin.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		t.Logf("%-46s %7.1fs", what, time.Since(started).Seconds())
	}
	project := "33333333-3333-4333-8333-333333333333"
	run("project", `INSERT INTO crm.projects (id, org_id, name) VALUES ($1, $2, 'Bench')`, project, orgA)

	// The workspace's leads before either import: each with a property, a phone, and every third an email.
	run(fmt.Sprintf("%d existing leads", existing), `
		WITH p AS (
			INSERT INTO crm.properties (org_id, address, city, region, postal_code, country)
			SELECT $1, g || ' Main St', 'Austin', 'TX', lpad((78000 + g % 900)::text, 5, '0'), 'US' FROM generate_series(1, $2) g RETURNING id
		), numbered AS (SELECT id, row_number() OVER () AS g FROM p)
		INSERT INTO crm.leads (org_id, project_id, property_id, name, phone, email, source)
		SELECT $1, $3, id, 'Owner ' || g, (5120000000 + g)::text, CASE WHEN g % 3 = 0 THEN 'owner' || g || '@example.com' ELSE '' END, 'Seed'
		FROM numbered`, orgA, existing, project)
	run("analyze", `ANALYZE crm.leads; ANALYZE crm.properties`)

	// A list: 70% new people, 30% rows that matched an existing lead and only fill what it is missing.
	var job string
	if err := e.admin.QueryRow(ctx, `INSERT INTO importing.jobs (org_id, user_id, project_id, name, filename, size, chunk_size, total_chunks, status)
		VALUES ($1, $2, $3, 'Bench list', 'list.csv', 1, 1, 1, 'merging') RETURNING id::text`, orgA, alice, project).Scan(&job); err != nil {
		t.Fatal(err)
	}
	run(fmt.Sprintf("%d list rows", rows), `
		INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, email, address, city, region, zip, country, state, match_lead)
		SELECT $1, g, sha256(('row' || g)::bytea), ARRAY['row ' || g], 'Seller ' || g, (7370000000 + g)::text, 'seller' || g || '@example.com',
			g || ' Oak Ave', 'Dallas', 'TX', lpad((75000 + g % 900)::text, 5, '0'), 'US',
			CASE WHEN g % 10 < 7 THEN 'clean' ELSE 'merge' END,
			CASE WHEN g % 10 >= 7 THEN (SELECT id FROM crm.leads WHERE org_id = $2 AND name = 'Owner ' || (1 + g % $3)) END
		FROM generate_series(1, $4) g`, job, orgA, existing, rows)
	run("analyze", `ANALYZE importing.rows`)
	started := time.Now()
	e.s.runMerge(ctx, job)
	var status string
	var merged int64
	_ = e.admin.QueryRow(ctx, `SELECT status, merged_rows FROM importing.jobs WHERE id = $1`, job).Scan(&status, &merged)
	took := time.Since(started).Seconds()
	t.Logf("LEAD MERGE  %d rows  %s  %.1fs  %.0f rows/s", merged, status, took, float64(merged)/took)
	if status != "done" {
		t.Fatalf("lead merge finished as %q", status)
	}

	// A ReadyMode history: a third of the people are existing leads, the rest new; three calls each, the last a do-not-call for one in twenty.
	var callJob string
	if err := e.admin.QueryRow(ctx, `INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, kind, status, report)
		VALUES ($1, $2, 'Bench calls', 'calls.csv', 1, 1, 1, 'readymode_calls', 'call_merging', jsonb_build_object('valid_calls', $3::bigint)) RETURNING id::text`,
		orgA, alice, calls).Scan(&callJob); err != nil {
		t.Fatal(err)
	}
	run(fmt.Sprintf("%d call rows", calls), `
		INSERT INTO importing.rows (job_id, row_no, fp, cells, call_data)
		SELECT $1, g, sha256(('call' || g)::bytea), ARRAY['call ' || g], jsonb_build_object(
			'source_record_id', g::text, 'agent', 'Previous agent',
			'phone', CASE WHEN p % 3 = 0 THEN (5120000000 + p)::text ELSE (8170000000 + p)::text END,
			'name', CASE WHEN p % 3 = 0 THEN 'Owner ' || p ELSE 'Caller ' || p END,
			'address', p || ' Elm St', 'city', 'Fort Worth', 'region', 'TX', 'zip', '76101',
			'outcome', CASE WHEN g % 3 = 2 AND p % 20 = 0 THEN 'Do not call' WHEN g % 2 = 0 THEN 'Voicemail' ELSE 'Contact' END,
			'code', 'VM', 'meaning', CASE WHEN g % 3 = 2 AND p % 20 = 0 THEN 'do_not_call' WHEN g % 2 = 0 THEN 'voicemail' ELSE 'reached' END,
			'occurred_at', to_char(timestamptz '2026-01-01 00:00:00+00' + g * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'notes', 'Bench call')
		FROM (SELECT g, 1 + (g - 1) / 3 AS p FROM generate_series(1, $2) g) s`, callJob, calls)
	run("analyze", `ANALYZE importing.rows`)
	started = time.Now()
	e.s.runCallMerge(ctx, callJob)
	_ = e.admin.QueryRow(ctx, `SELECT status, merged_rows FROM importing.jobs WHERE id = $1`, callJob).Scan(&status, &merged)
	took = time.Since(started).Seconds()
	t.Logf("CALL MERGE  %d rows  %s  %.1fs  %.0f rows/s", merged, status, took, float64(merged)/took)
	if status != "done" {
		t.Fatalf("call merge finished as %q", status)
	}
	var leads, events int64
	_ = e.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM crm.leads WHERE org_id = $1), (SELECT count(*) FROM crm.call_events WHERE import_job_id = $2)`, orgA, callJob).Scan(&leads, &events)
	t.Logf("leads now %d, calls added %d", leads, events)
}

func envInt(name string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return n
	}
	return fallback
}
