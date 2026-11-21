package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// store is the service's PostgreSQL link. Its tables live in the schema "messaging".
//
// Row security (who may see which conversation) does not apply to a superuser, or to a login that bypasses it. A database made by a
// platform such as Coolify hands out exactly such a login. So when the login is a superuser, the service makes a restricted role of
// its own (appRole: no login, no superuser, no bypass) and every request runs as it; when the login is ordinary, requests run as the
// login itself. A login that bypasses row security without being a superuser cannot be made safe, and the service does not start.
type store struct {
	db       *pgxpool.Pool
	runAs    string // the role requests run as; empty: the login itself
	livePass string // the password for liveRole; empty: leave it as it is
}

const appRole = "messaging_app"

// liveRole is the login the live server (Centrifugo) reads the outbox with: it may read and delete outbox rows and nothing else, so
// the live server never sees a conversation. With a superuser login and LIVE_DB_PASSWORD set, the service makes it at every start
// (and sets its password); otherwise whoever runs the database makes it (README, "Live updates").
const liveRole = "messaging_live"

func openStore(ctx context.Context, url, livePass string) (*store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "messaging,public"
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	s := &store{db: db, livePass: livePass}
	if err = db.Ping(ctx); err == nil {
		err = s.migrate(ctx)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("messaging database: %w", err)
	}
	return s, nil
}

func (s *store) close()                         { s.db.Close() }
func (s *store) ping(ctx context.Context) error { return s.db.Ping(ctx) }

// migrate is the only place that changes the database's structure. Numbered scripts run once each, in order, in one transaction
// under an advisory lock (two copies starting together do not both run them). A script that was already applied and has changed
// since stops the service from starting.
func (s *store) migrate(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8108)`); err != nil {
		return err
	}
	for _, ddl := range []string{
		`CREATE SCHEMA IF NOT EXISTS messaging`,
		`CREATE TABLE IF NOT EXISTS messaging.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
	} {
		if _, err = tx.Exec(ctx, ddl); err != nil {
			return err
		}
	}
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		body, err := migrationFiles.ReadFile(name)
		if err != nil {
			return err
		}
		body = bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n")) // a Windows checkout and a Linux build must agree on the checksum
		sum := sha256.Sum256(body)
		checksum := hex.EncodeToString(sum[:])
		var applied string
		err = tx.QueryRow(ctx, `SELECT checksum FROM messaging.schema_migrations WHERE name = $1`, name).Scan(&applied)
		switch {
		case err == nil && applied == checksum:
			continue
		case err == nil:
			return fmt.Errorf("%s was changed after it was applied; add a new numbered script instead", name)
		case err != pgx.ErrNoRows:
			return err
		}
		if _, err = tx.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO messaging.schema_migrations (name, checksum) VALUES ($1, $2)`, name, checksum); err != nil {
			return err
		}
		log.Printf("INFO applied %s", name)
	}
	if err = s.restrict(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// restrict decides what requests run as (see store) and, for a superuser login, makes that role and gives it the tables. It runs at every
// start, so tables added by a later script are covered too.
func (s *store) restrict(ctx context.Context, tx pgx.Tx) error {
	var super, bypass bool
	if err := tx.QueryRow(ctx, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&super, &bypass); err != nil {
		return err
	}
	switch {
	case !super && !bypass:
		s.runAs = ""
		if s.livePass != "" {
			log.Printf("WARN LIVE_DB_PASSWORD is set but the database login is not a superuser, so it cannot make the %s login: make it by hand (README)", liveRole)
		}
		return nil
	case !super:
		return fmt.Errorf("the database login bypasses row security and is not a superuser, so it cannot be made safe: use an ordinary login")
	}
	for _, stmt := range []string{
		`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '` + appRole + `') THEN CREATE ROLE ` + appRole + ` NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
		`GRANT USAGE ON SCHEMA messaging TO ` + appRole,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA messaging TO ` + appRole,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA messaging TO ` + appRole,
		`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA messaging TO ` + appRole,
	} {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("making the restricted role: %w", err)
		}
	}
	if s.livePass != "" {
		if err := s.makeLiveRole(ctx, tx); err != nil {
			return fmt.Errorf("making the live server's login: %w", err)
		}
	}
	s.runAs = appRole
	log.Printf("INFO the database login is a superuser: requests run as the restricted role %s so row security applies", appRole)
	return nil
}

// makeLiveRole makes (or keeps) liveRole with the password it was given, allowed to read and delete outbox rows only.
func (s *store) makeLiveRole(ctx context.Context, tx pgx.Tx) error {
	var setPassword string
	if err := tx.QueryRow(ctx, `SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text)`, liveRole, s.livePass).Scan(&setPassword); err != nil {
		return err
	}
	for _, stmt := range []string{
		`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '` + liveRole + `') THEN CREATE ROLE ` + liveRole + ` NOLOGIN; END IF; END $$`,
		setPassword,
		`GRANT USAGE ON SCHEMA messaging TO ` + liveRole,
		`GRANT SELECT, DELETE ON messaging.outbox TO ` + liveRole,
	} {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	log.Printf("INFO the live server reads the outbox as %s (read and delete outbox rows only)", liveRole)
	return nil
}

// begin opens a transaction that runs as one person in one workspace: row security reads these settings.
func (s *store) begin(ctx context.Context, sc scope) (pgx.Tx, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if s.runAs != "" {
		if _, err = tx.Exec(ctx, `SET LOCAL ROLE `+s.runAs); err != nil {
			tx.Rollback(ctx)
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('cw.org_id', $1, true), set_config('cw.user_id', $2, true)`, sc.orgID, sc.userID); err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// oneJSON runs a query that answers one JSON value; ok is false when it found no row (or a null).
func oneJSON(ctx context.Context, tx pgx.Tx, sql string, args ...any) (json.RawMessage, bool, error) {
	var raw []byte
	err := tx.QueryRow(ctx, sql, args...).Scan(&raw)
	if err == pgx.ErrNoRows || (err == nil && raw == nil) {
		return nil, false, nil
	}
	return raw, err == nil, err
}

func manyJSON(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]json.RawMessage, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		out = append(out, raw)
	}
	return out, rows.Err()
}
