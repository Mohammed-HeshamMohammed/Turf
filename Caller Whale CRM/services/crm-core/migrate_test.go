package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// A migration that waits for a table someone else holds must give up quickly, keep the scripts before it, hold no lock on the leads
// while it waits, and say who was in the way; once the table is free, the next start applies the rest.
func TestMigrationWaitingForATableFailsFastAndKeepsLeadsFree(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	st := e.s.st
	pending := []string{"migrations/0020_lead_search_indexes.sql", "migrations/0021_people_avatar.sql",
		"migrations/0022_merge_picks_and_co_owners.sql", "migrations/0023_assignment_runs_resume.sql", "migrations/0024_lead_files.sql"}
	if _, err := e.admin.Exec(ctx, `DELETE FROM crm.schema_migrations WHERE name = ANY($1)`, pending); err != nil {
		t.Fatal(err)
	}

	// Another session reads importing.rows and leaves its transaction open, as a worker idle in transaction would.
	holder, err := pgx.Connect(ctx, os.Getenv("CRM_TEST_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close(ctx)
	holdTx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = holdTx.Exec(ctx, `SET application_name = 'idle-holder'; SELECT count(*) FROM importing.rows`); err != nil {
		t.Fatal(err)
	}

	st.lockTimeout, st.lockTries, st.lockPause = 3*time.Second, 2, 100*time.Millisecond
	result := make(chan error, 1)
	go func() { result <- st.migrate(ctx) }()

	// While 0022 waits for importing.rows, lead saves go through: 0020's index builds were already committed.
	waitFor(t, func() bool {
		var waiting bool
		_ = e.admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%importing.rows%')`).Scan(&waiting)
		return waiting
	})
	probe, err := e.admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = probe.Exec(ctx, `SET LOCAL lock_timeout = '500ms'; LOCK TABLE crm.leads IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatalf("the leads were locked while a later migration waited: %v", err)
	}
	probe.Rollback(ctx)

	select {
	case err = <-result:
	case <-time.After(30 * time.Second):
		t.Fatal("the migration kept waiting")
	}
	if err == nil || !strings.Contains(err.Error(), "0022_merge_picks_and_co_owners.sql") || !strings.Contains(err.Error(), "idle-holder") {
		t.Fatalf("want a 0022 failure naming the session in the way, got %v", err)
	}
	var applied []string
	rows, _ := e.admin.Query(ctx, `SELECT name FROM crm.schema_migrations WHERE name = ANY($1) ORDER BY name`, pending)
	applied, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(applied, ",") != pending[0]+","+pending[1] {
		t.Fatalf("want 0020 and 0021 kept, got %v", applied)
	}

	holdTx.Rollback(ctx)
	if err = st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.schema_migrations WHERE name = ANY($1)`, pending).Scan(&n); err != nil || n != len(pending) {
		t.Fatalf("want every migration applied after the table was free, got %d (%v)", n, err)
	}
}

// properties_addr_key is built after start-up, without blocking writes, and a database that applied the first 0022 (which built it
// inside the migration) still starts.
func TestLateIndexAndEarlier0022(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	st := e.s.st
	for i := 0; i < 2; i++ { // the second run finds it built
		if done, err := st.buildLateIndexes(ctx); err != nil || !done {
			t.Fatalf("done=%v err=%v", done, err)
		}
	}
	var valid bool
	if err := e.admin.QueryRow(ctx, `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
		WHERE c.relname = 'properties_addr_key'`).Scan(&valid); err != nil || !valid {
		t.Fatalf("properties_addr_key: valid=%v err=%v", valid, err)
	}
	name := "migrations/0022_merge_picks_and_co_owners.sql"
	if _, err := e.admin.Exec(ctx, `UPDATE crm.schema_migrations SET checksum = $1 WHERE name = $2`, earlierChecksum[name], name); err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatalf("a database with the first 0022 must still start: %v", err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE crm.schema_migrations SET checksum = 'something else' WHERE name = $1`, name); err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err == nil || !strings.Contains(err.Error(), "was changed after it was applied") {
		t.Fatalf("any other changed checksum must still stop the start, got %v", err)
	}
}

// A start that finds another session holding the migrations' lock waits a bounded time and names it.
func TestMigrationLockHeldElsewhereNamesTheHolder(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	holder, err := pgx.Connect(ctx, os.Getenv("CRM_TEST_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close(ctx)
	if _, err = holder.Exec(ctx, `SET application_name = 'stale-migrator'; SELECT pg_advisory_lock(8107)`); err != nil {
		t.Fatal(err)
	}
	st := e.s.st
	st.advisoryWait = 1500 * time.Millisecond
	if err = st.migrate(ctx); err == nil || !strings.Contains(err.Error(), "stale-migrator") {
		t.Fatalf("want a failure naming the lock holder, got %v", err)
	}
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_unlock(8107)`); err != nil {
		t.Fatal(err)
	}
	if err = st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
}

// While another session holds the build lock the indexes are not done, and the next try (once it is free) builds them.
func TestLateIndexWaitsForTheOtherBuilder(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.admin.Exec(ctx, `DROP INDEX IF EXISTS crm.properties_addr_key`); err != nil {
		t.Fatal(err)
	}
	other, err := pgx.Connect(ctx, os.Getenv("CRM_TEST_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(ctx)
	if _, err = other.Exec(ctx, `SELECT pg_advisory_lock(8108)`); err != nil {
		t.Fatal(err)
	}
	if done, err := e.s.st.buildLateIndexes(ctx); err != nil || done {
		t.Fatalf("with another builder: want not done, got done=%v err=%v", done, err)
	}
	if _, err = other.Exec(ctx, `SELECT pg_advisory_unlock(8108)`); err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	go func() { e.s.st.keepBuildingLateIndexes(ctx, 50*time.Millisecond); close(finished) }()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("the index was not built")
	}
	var valid bool
	if err = e.admin.QueryRow(ctx, `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
		WHERE c.relname = 'properties_addr_key'`).Scan(&valid); err != nil || !valid {
		t.Fatalf("properties_addr_key: valid=%v err=%v", valid, err)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatal("timed out waiting")
}
