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
type store struct{ db *pgxpool.Pool }

func openStore(ctx context.Context, url string) (*store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "messaging,public"
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
	return tx.Commit(ctx)
}

// begin opens a transaction that runs as one person in one workspace: row security reads these settings.
func (s *store) begin(ctx context.Context, sc scope) (pgx.Tx, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
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
