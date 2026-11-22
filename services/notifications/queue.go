package main

// The mail queue. With DATABASE_URL set, a request saves the finished email and answers at once, and the sender below delivers it:
// a mail server that is slow, down or says "try later" no longer fails the request or loses the email. Without DATABASE_URL every
// email is sent during its request, as before.
//
// The sender runs in this same container (the notification service stays one container, D390). Two copies may run: each takes
// different rows (SKIP LOCKED) and a row it took is leased for two minutes, so a copy that dies mid-send only delays that email.
// The order of emails does not matter, so nothing waits on another.

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
	"math/rand/v2"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed database_setup/*.sql
var migrationFiles embed.FS

const (
	// lease is how long a taken row is left alone: longer than one send can take (20 s to connect, 40 s to talk).
	lease = 2 * time.Minute
	// poll is how often the queue is checked for retries that came due (a new email wakes the sender at once).
	poll = 5 * time.Second
	// batch is how many emails one pass takes; sendAtOnce how many of them go out side by side.
	batch      = 20
	sendAtOnce = 4
	// The longest wait between tries.
	maxBackoff = 10 * time.Minute
)

// keepFor is how long an email may wait before it is worth nothing. A sign-in code is useless after its own ten minutes.
func keepFor(template string) time.Duration {
	if template == "mfa_code" {
		return 10 * time.Minute
	}
	return 24 * time.Hour
}

// errPermanent marks a refusal no retry can change (the recipient does not exist, the message is refused for what it is).
var errPermanent = errors.New("refused for good")

type queue struct {
	db     *pgxpool.Pool
	sender Sender
	wake   chan struct{}
}

func openQueue(ctx context.Context, url string, sender Sender) (*queue, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "notifications"
	cfg.MaxConns = 8
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	q := &queue{db: db, sender: sender, wake: make(chan struct{}, 1)}
	if err = db.Ping(ctx); err == nil {
		err = q.migrate(ctx)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("notifications database: %w", err)
	}
	return q, nil
}

func (q *queue) close() { q.db.Close() }

// migrate applies the numbered scripts in database_setup once each, in order, in one transaction under an advisory lock. A script
// that was applied and has changed since stops the service from starting.
func (q *queue) migrate(ctx context.Context) error {
	tx, err := q.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, stmt := range []string{
		`SELECT pg_advisory_xact_lock(8102)`,
		`CREATE SCHEMA IF NOT EXISTS notifications`,
		`CREATE TABLE IF NOT EXISTS notifications.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
	} {
		if _, err = tx.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	names, err := fs.Glob(migrationFiles, "database_setup/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		body, err := migrationFiles.ReadFile(name)
		if err != nil {
			return err
		}
		body = bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n")) // a Windows checkout and a Linux build must agree
		sum := sha256.Sum256(body)
		checksum := hex.EncodeToString(sum[:])
		var applied string
		err = tx.QueryRow(ctx, `SELECT checksum FROM notifications.schema_migrations WHERE name = $1`, name).Scan(&applied)
		switch {
		case err == nil && applied == checksum:
			continue
		case err == nil:
			return fmt.Errorf("%s was changed after it was applied; add a new numbered script instead", name)
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		if _, err = tx.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO notifications.schema_migrations (name, checksum) VALUES ($1, $2)`, name, checksum); err != nil {
			return err
		}
		log.Printf("INFO applied %s", name)
	}
	return tx.Commit(ctx)
}

// add saves one email and wakes the sender.
func (q *queue) add(ctx context.Context, caller, template string, m Message) error {
	_, err := q.db.Exec(ctx, `INSERT INTO mail_queue (caller, template, message, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
		caller, template, m, keepFor(template).Seconds())
	if err != nil {
		return err
	}
	select {
	case q.wake <- struct{}{}:
	default: // a pass is already due
	}
	return nil
}

// run sends the queue for the life of the service: at once when an email is added, and every few seconds for retries.
func (q *queue) run(ctx context.Context) {
	tick := time.NewTicker(poll)
	defer tick.Stop()
	for {
		for {
			n, err := q.pass(ctx)
			if err != nil && ctx.Err() == nil {
				log.Printf("WARN mail queue: %v (emails wait in the database)", err)
			}
			if err != nil || n < batch {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-q.wake:
		case <-tick.C:
		}
	}
}

type queued struct {
	id       int64
	caller   string
	template string
	message  Message
	tries    int
}

// pass drops what is too old, takes the emails that are due (leasing them), and sends them side by side. It answers how many it took.
func (q *queue) pass(ctx context.Context) (int, error) {
	tag, err := q.db.Exec(ctx, `DELETE FROM mail_queue WHERE expires_at <= now()`)
	if err != nil {
		return 0, err
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("WARN %d emails could not be sent before they were too old to matter and were dropped", n)
	}
	rows, err := q.db.Query(ctx, `UPDATE mail_queue SET tries = tries + 1, next_try_at = now() + make_interval(secs => $1)
		WHERE id IN (SELECT id FROM mail_queue WHERE next_try_at <= now() ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
		RETURNING id, caller, template, message, tries`, lease.Seconds(), batch)
	if err != nil {
		return 0, err
	}
	var due []queued
	for rows.Next() {
		var r queued
		if err = rows.Scan(&r.id, &r.caller, &r.template, &r.message, &r.tries); err != nil {
			rows.Close()
			return 0, err
		}
		due = append(due, r)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	var wg sync.WaitGroup
	slots := make(chan struct{}, sendAtOnce)
	for _, r := range due {
		slots <- struct{}{}
		wg.Go(func() {
			defer func() { <-slots }()
			q.sendOne(ctx, r)
		})
	}
	wg.Wait()
	return len(due), nil
}

// sendOne sends one leased email and records what happened: sent or refused for good, the row goes; otherwise it waits longer.
func (q *queue) sendOne(ctx context.Context, r queued) {
	err := q.sender.Send(r.message)
	// The outcome is written even when the service is stopping, so a sent email is not sent again.
	write, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	switch {
	case err == nil:
		log.Printf("mail %q sent for %s (try %d)", r.template, r.caller, r.tries)
		_, err = q.db.Exec(write, `DELETE FROM mail_queue WHERE id = $1`, r.id)
	case errors.Is(err, errPermanent):
		log.Printf("WARN mail %q for %s refused for good, dropped: %v", r.template, r.caller, err)
		_, err = q.db.Exec(write, `DELETE FROM mail_queue WHERE id = $1`, r.id)
	default:
		wait := backoff(r.tries)
		log.Printf("WARN mail %q for %s not sent (try %d), trying again in %s: %v", r.template, r.caller, r.tries, wait.Round(time.Second), err)
		_, err = q.db.Exec(write, `UPDATE mail_queue SET next_try_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1`,
			r.id, wait.Seconds(), err.Error())
	}
	if err != nil {
		log.Printf("WARN mail queue: recording an outcome: %v", err)
	}
}

// backoff is the wait after a failed try: 10 s, 20 s, 40 s ... up to ten minutes, each a little shorter at random so emails that
// failed together do not all come back together.
func backoff(tries int) time.Duration {
	wait := 10 * time.Second << min(max(tries-1, 0), 10)
	wait = min(wait, maxBackoff)
	return wait - time.Duration(rand.Int64N(int64(wait/5)+1))
}

// waiting is how many emails are still on their way (for the logs and tests).
func (q *queue) waiting(ctx context.Context) (int, error) {
	var n int
	err := q.db.QueryRow(ctx, `SELECT count(*) FROM mail_queue`).Scan(&n)
	return n, err
}
