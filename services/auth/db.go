package main

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The database updates, numbered. They are applied in order and recorded in database_setup_history, and several copies starting
// together do not race (a database lock). Never change a numbered file: add the next number.
//
//go:embed database_setup/*.sql
var updates embed.FS

// setupLock is held while the schema is brought up to date, so two instances starting together do it one after the other.
const setupLock = 7273_6574 // "setup"

func connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = time.Hour
	return pgxpool.NewWithConfig(ctx, cfg)
}

// setupDatabase runs the numbered updates that database_setup_history has not seen, each in one transaction with its history row.
func setupDatabase(ctx context.Context, db *pgxpool.Pool) error {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", setupLock); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", setupLock)

	if _, err := conn.Exec(ctx, "CREATE TABLE IF NOT EXISTS database_setup_history (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)"); err != nil {
		return err
	}
	files, err := updates.ReadDir("database_setup")
	if err != nil {
		return err
	}
	type update struct {
		version int64
		sql     string
	}
	var all []update
	for _, f := range files {
		number, _, _ := strings.Cut(f.Name(), "_")
		version, err := strconv.ParseInt(number, 10, 64)
		if err != nil {
			return fmt.Errorf("database_setup/%s does not start with a number", f.Name())
		}
		text, err := updates.ReadFile("database_setup/" + f.Name())
		if err != nil {
			return err
		}
		all = append(all, update{version, string(text)})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].version < all[j].version })
	for _, u := range all {
		var seen int
		err := conn.QueryRow(ctx, "SELECT 1 FROM database_setup_history WHERE version = $1", u.version).Scan(&seen)
		if err == nil {
			continue
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		for _, statement := range statements(u.sql) {
			if _, err := tx.Exec(ctx, statement); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("database update %d: %w", u.version, err)
			}
		}
		if _, err := tx.Exec(ctx, "INSERT INTO database_setup_history (version, applied_at) VALUES ($1, $2)", u.version, now()); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// statements splits a SQL file into its statements: comments (from "--" to the end of the line) are dropped, then it is cut at ";".
// A function body between $$ and $$ is kept whole, ";" and all (0027 has the first ones).
func statements(sql string) []string {
	var lines []string
	for _, line := range strings.Split(sql, "\n") {
		line, _, _ = strings.Cut(line, "--")
		lines = append(lines, line)
	}
	var out []string
	var current strings.Builder
	quoted := false
	for i, part := range strings.Split(strings.Join(lines, "\n"), "$$") {
		if i > 0 {
			current.WriteString("$$")
			quoted = !quoted
		}
		if quoted {
			current.WriteString(part)
			continue
		}
		pieces := strings.Split(part, ";")
		for j, piece := range pieces {
			current.WriteString(piece)
			if j < len(pieces)-1 {
				if s := strings.TrimSpace(current.String()); s != "" {
					out = append(out, s)
				}
				current.Reset()
			}
		}
	}
	if s := strings.TrimSpace(current.String()); s != "" {
		out = append(out, s)
	}
	return out
}

// clock is the time; tests move it.
var clock = time.Now

func now() int64 { return clock().Unix() }
