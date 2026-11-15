package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// store is the service's PostgreSQL link. Its tables live in the schema "dialer_sms" and no other service reads them. Every
// request a person makes is filtered by their workspace in the query itself; webhooks find their workspace from the call or
// the number.
type store struct {
	db *pgxpool.Pool
}

func openStore(ctx context.Context, url string) (*store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "dialer_sms,public"
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
		return nil, fmt.Errorf("dialer database: %w", err)
	}
	return s, nil
}

func (s *store) close()                         { s.db.Close() }
func (s *store) ping(ctx context.Context) error { return s.db.Ping(ctx) }

// migrate runs each numbered script once, in order, in one transaction under an advisory lock. A script changed after it was
// applied stops the service from starting.
func (s *store) migrate(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, ddl := range []string{
		`SELECT pg_advisory_xact_lock(8113)`,
		`CREATE SCHEMA IF NOT EXISTS dialer_sms`,
		`CREATE TABLE IF NOT EXISTS dialer_sms.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
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
		body = bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n"))
		sum := sha256.Sum256(body)
		checksum := hex.EncodeToString(sum[:])
		var applied string
		err = tx.QueryRow(ctx, `SELECT checksum FROM dialer_sms.schema_migrations WHERE name = $1`, name).Scan(&applied)
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
		if _, err = tx.Exec(ctx, `INSERT INTO dialer_sms.schema_migrations (name, checksum) VALUES ($1, $2)`, name, checksum); err != nil {
			return err
		}
		log.Printf("INFO applied %s", name)
	}
	return tx.Commit(ctx)
}
