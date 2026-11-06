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
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// store is the CRM's PostgreSQL link. The tables live in the schema "crm"; the import holding tables in "importing".
type store struct{ db *pgxpool.Pool }

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

// migrate is the only place that changes the database's structure. Numbered scripts run once each, in order, each in one
// transaction under an advisory lock (two copies starting together do not both run them). A script that was already applied
// and has changed since stops the service from starting.
func (s *store) migrate(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8107)`); err != nil {
		return err
	}
	for _, ddl := range []string{
		`CREATE SCHEMA IF NOT EXISTS crm`,
		`CREATE TABLE IF NOT EXISTS crm.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
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
		err = tx.QueryRow(ctx, `SELECT checksum FROM crm.schema_migrations WHERE name = $1`, name).Scan(&applied)
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
		if _, err = tx.Exec(ctx, `INSERT INTO crm.schema_migrations (name, checksum) VALUES ($1, $2)`, name, checksum); err != nil {
			return err
		}
		log.Printf("INFO applied %s", name)
	}
	return tx.Commit(ctx)
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
