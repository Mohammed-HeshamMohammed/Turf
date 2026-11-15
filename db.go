package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// store is the CRM's PostgreSQL link. The tables live in the schema "crm"; the import holding tables in "importing".
type store struct {
	db *pgxpool.Pool
	// How long a migration waits for a table in use, how many times it is tried, and the pause between tries (migrate's defaults when 0).
	lockTimeout, lockPause time.Duration
	lockTries              int
}

func openStore(ctx context.Context, url string) (*store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "crm,public"
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	s := &store{db: db}
	if err = db.Ping(ctx); err == nil {
		err = s.migrate(ctx)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("CRM database: %w", err)
	}
	return s, nil
}

func (s *store) close()                         { s.db.Close() }
func (s *store) ping(ctx context.Context) error { return s.db.Ping(ctx) }

// migrate is the only place that changes the database's structure. Numbered scripts run once each, in order, under an advisory lock
// held for the whole run (two copies starting together do not both run them). Each script is its own transaction, so a finished one
// is kept and its locks are let go before the next starts. A script waits at most lockTimeout for a table someone else is using; it is
// tried again a few times and then crm-core stops with the names of the sessions in its way (the running copy keeps serving). Without
// this, a script waiting for one table also kept every earlier script's locks (0020's indexes on the leads) and lead saves queued
// behind it. A script that was already applied and has changed since stops the service from starting.
func (s *store) migrate(ctx context.Context) error {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(8107)`); err != nil {
			conn.Conn().Close(context.Background()) // a session lock must not go back to the pool with the connection
		}
		conn.Release()
	}()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(8107)`); err != nil {
		return err
	}
	for _, ddl := range []string{
		`CREATE SCHEMA IF NOT EXISTS crm`,
		`CREATE TABLE IF NOT EXISTS crm.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
	} {
		if _, err = conn.Exec(ctx, ddl); err != nil {
			return err
		}
	}
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	timeout, tries, pause := s.lockTimeout, s.lockTries, s.lockPause
	if timeout <= 0 {
		timeout, tries, pause = 5*time.Second, 6, 5*time.Second
	}
	for _, name := range names {
		body, err := migrationFiles.ReadFile(name)
		if err != nil {
			return err
		}
		body = bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n")) // a Windows checkout and a Linux build must agree on the checksum
		sum := sha256.Sum256(body)
		checksum := hex.EncodeToString(sum[:])
		var applied string
		err = conn.QueryRow(ctx, `SELECT checksum FROM crm.schema_migrations WHERE name = $1`, name).Scan(&applied)
		switch {
		case err == nil && (applied == checksum || applied == earlierChecksum[name]):
			continue
		case err == nil:
			return fmt.Errorf("%s was changed after it was applied; add a new numbered script instead", name)
		case err != pgx.ErrNoRows:
			return err
		}
		for try := 1; ; try++ {
			blocked, err := s.applyMigration(ctx, conn, name, string(body), checksum, timeout)
			if err == nil {
				break
			}
			var pg *pgconn.PgError
			if !errors.As(err, &pg) || pg.Code != "55P03" { // lock_not_available
				return fmt.Errorf("%s: %w", name, err)
			}
			if try >= tries {
				return fmt.Errorf("%s: a table it changes stayed in use for %d tries of %s; in the way: %s", name, tries, timeout, blocked)
			}
			log.Printf("WARN %s waited %s for a table in use (try %d of %d); in the way: %s", name, timeout, try, tries, blocked)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(pause):
			}
		}
		log.Printf("INFO applied %s", name)
	}
	return nil
}

// earlierChecksum accepts the one earlier version of a script that a database may already have applied, where the script was changed
// only to take work out of it (that work is done elsewhere, e.g. in lateIndexes).
var earlierChecksum = map[string]string{
	// The first 0022 also built properties_addr_key, which is now a late index.
	"migrations/0022_merge_picks_and_co_owners.sql": "91b7f50252d202a725549b531e709991f03a6a201c00eea2cdaa8bada97d7783",
}

// lateIndexes are built after crm-core is serving, one at a time and without blocking writes (CREATE INDEX CONCURRENTLY), because
// building them takes longer than a deploy may wait for the service to answer. Until one is ready its queries are only slower.
var lateIndexes = []struct{ name, create string }{
	{"properties_addr_key", `CREATE INDEX CONCURRENTLY IF NOT EXISTS properties_addr_key ON crm.properties (org_id, importing.addr_key(address, postal_code))`},
}

// buildLateIndexes builds the late indexes that are missing; one left unfinished by a stopped build is dropped and built again. Only
// one copy of crm-core builds at a time.
func (s *store) buildLateIndexes(ctx context.Context) error {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(8108)`); err != nil {
			conn.Conn().Close(context.Background())
		}
		conn.Release()
	}()
	var mine bool
	if err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(8108)`).Scan(&mine); err != nil || !mine {
		return err
	}
	if _, err = conn.Exec(ctx, `SET statement_timeout = 0`); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), `RESET statement_timeout`)
	for _, ix := range lateIndexes {
		var valid bool
		err := conn.QueryRow(ctx, `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'crm' AND c.relname = $1`, ix.name).Scan(&valid)
		switch {
		case err == nil && valid:
			continue
		case err == nil:
			if _, err = conn.Exec(ctx, `DROP INDEX CONCURRENTLY IF EXISTS crm.`+ix.name); err != nil {
				return fmt.Errorf("%s: %w", ix.name, err)
			}
		case err != pgx.ErrNoRows:
			return err
		}
		start := time.Now()
		log.Printf("INFO building index %s in the background", ix.name)
		if _, err = conn.Exec(ctx, ix.create); err != nil {
			return fmt.Errorf("%s: %w", ix.name, err)
		}
		log.Printf("INFO built index %s in %s", ix.name, time.Since(start).Round(time.Second))
	}
	return nil
}

// applyMigration runs one script and records it, in one transaction that waits at most timeout for any lock. While it waits, the
// sessions holding what it needs are looked up (from another connection), so a failure can say who they are.
func (s *store) applyMigration(ctx context.Context, conn *pgxpool.Conn, name, body, checksum string, timeout time.Duration) (string, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, fmt.Sprintf(`SET LOCAL lock_timeout = '%dms'`, timeout.Milliseconds())); err != nil {
		return "", err
	}
	pid := conn.Conn().PgConn().PID()
	blocked := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		select {
		case <-done:
			blocked <- "nobody seen"
		case <-time.After(timeout * 3 / 4):
			blocked <- s.blockers(ctx, pid)
		}
	}()
	_, err = tx.Exec(ctx, body)
	close(done)
	who := <-blocked
	if err != nil {
		return who, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO crm.schema_migrations (name, checksum) VALUES ($1, $2)`, name, checksum); err != nil {
		return who, err
	}
	return who, tx.Commit(ctx)
}

// blockers describes the sessions that hold locks the session pid is waiting for.
func (s *store) blockers(ctx context.Context, pid uint32) string {
	rows, err := s.db.Query(ctx, `SELECT a.pid, coalesce(a.usename, ''), a.application_name, coalesce(host(a.client_addr), 'local'),
			coalesce(a.state, ''), coalesce(date_trunc('second', now() - a.xact_start)::text, ''), left(coalesce(a.query, ''), 200)
		FROM pg_stat_activity a WHERE a.pid = ANY(pg_blocking_pids($1::int))`, int(pid))
	if err != nil {
		return "unknown (" + err.Error() + ")"
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p int
		var user, app, addr, state, age, query string
		if err := rows.Scan(&p, &user, &app, &addr, &state, &age, &query); err != nil {
			return "unknown (" + err.Error() + ")"
		}
		out = append(out, fmt.Sprintf("pid %d user %q app %q from %s, %s, transaction open %s, last query %q", p, user, app, addr, state, age, query))
	}
	if len(out) == 0 {
		return "nobody seen"
	}
	return strings.Join(out, "; ")
}

var roleName = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// grantImporter lets the import worker's own login use the holding tables and read the few lead fields it matches on.
// The login itself is created by the owner in Coolify; until it exists this does nothing. It can never touch the leads.
func (s *store) grantImporter(ctx context.Context, role string) error {
	if role == "" {
		return nil
	}
	if !roleName.MatchString(role) {
		return fmt.Errorf("IMPORT_DB_ROLE: %q is not a role name", role)
	}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, role).Scan(&exists); err != nil || !exists {
		if !exists {
			log.Printf("WARN the import worker login %q does not exist yet; create it, then restart crm-core", role)
		}
		return err
	}
	q := pgx.Identifier{role}.Sanitize()
	for _, stmt := range []string{
		`GRANT USAGE ON SCHEMA importing TO ` + q,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA importing TO ` + q,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA importing TO ` + q,
		`REVOKE ALL ON importing.lead_match FROM ` + q,
		`GRANT SELECT ON importing.lead_match TO ` + q,
		`REVOKE ALL ON SCHEMA crm FROM ` + q,
		`DO $$ BEGIN IF current_setting('server_version_num')::int >= 170000 THEN EXECUTE 'GRANT MAINTAIN ON importing.rows TO ` + q + `'; END IF; END $$`,
	} {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("granting %s: %w", role, err)
		}
	}
	return nil
}

// begin opens a transaction that runs as one person in one workspace: row security reads these settings.
func (s *store) begin(ctx context.Context, sc scope) (pgx.Tx, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `SELECT set_config('cw.org_id', $1, true), set_config('cw.user_id', $2, true), set_config('cw.scopes', $3, true),
		set_config('cw.team_ids', $4, true), set_config('cw.project_ids', $5, true)`,
		sc.orgID, sc.userID, strings.Join(sc.scopes, ","), uuidArray(sc.teamIDs), uuidArray(sc.projectIDs))
	if err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// uuidArray is a PostgreSQL array literal of the ids that really are ids; anything else is left out.
func uuidArray(ids []string) string {
	keep := []string{}
	for _, id := range ids {
		if validID(id) {
			keep = append(keep, id)
		}
	}
	return "{" + strings.Join(keep, ",") + "}"
}
