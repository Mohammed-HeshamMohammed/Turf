package crm

import (
	"context"
	"testing"
	"time"
)

// A merge that was going when the job queue arrived (or whose job ended while its container stopped) has no job; the adopt check
// queues one, and only one, however often it runs.
func TestWorkWithoutAJobIsAdoptedOnce(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil)
	var job string
	if err := e.admin.QueryRow(ctx, `INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, status)
		VALUES ($1, $2, 'Left going', 'list.csv', 1, 1, 1, 'merging') RETURNING id::text`, orgA, alice).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, state)
		SELECT $1, g, sha256(('r' || g)::bytea), ARRAY['r'], 'Owner ' || g, (5125550000 + g)::text, 'clean' FROM generate_series(1, 3) g`, job); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := e.s.adoptWork(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var queued int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.river_job WHERE kind = 'lead_merge' AND args->>'job' = $1`, job).Scan(&queued)
	if queued != 1 {
		t.Fatalf("jobs queued for one merge: %d", queued)
	}
	var status string
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if _ = e.admin.QueryRow(ctx, `SELECT status FROM importing.jobs WHERE id = $1`, job).Scan(&status); status == "done" {
			break
		}
	}
	var leads int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.leads WHERE org_id = $1 AND name LIKE 'Owner %'`, orgA).Scan(&leads)
	if status != "done" || leads != 3 {
		t.Fatalf("adopted merge: status %q, leads %d", status, leads)
	}
}

// A long merge gives up its worker between slices and is put back in line, then finishes.
func TestASlicedMergeComesBackAndFinishes(t *testing.T) {
	e := newEnv(t)
	e.s.stopJobs() // the slices are run by hand here, so the queue's own worker must not take the merge first
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil)
	var job string
	if err := e.admin.QueryRow(ctx, `INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, status)
		VALUES ($1, $2, 'Sliced', 'list.csv', 1, 1, 1, 'merging') RETURNING id::text`, orgA, alice).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, state)
		VALUES ($1, 1, sha256('one'::bytea), ARRAY['one'], 'Pat Owner', '5125550100', 'clean')`, job); err != nil {
		t.Fatal(err)
	}
	// A budget that is always spent stops after the first batch and says more is left (the second slice finds nothing and finishes).
	if more := e.s.mergeSlice(ctx, job, time.Nanosecond); !more {
		t.Fatal("a spent budget should leave the rest for the next slice")
	}
	if more := e.s.mergeSlice(ctx, job, time.Nanosecond); more {
		t.Fatal("nothing left, yet the merge asked for another slice")
	}
	var status string
	var merged int64
	_ = e.admin.QueryRow(ctx, `SELECT status, merged_rows FROM importing.jobs WHERE id = $1`, job).Scan(&status, &merged)
	if status != "done" || merged != 1 {
		t.Fatalf("after the slices: %s, %d merged", status, merged)
	}
}
