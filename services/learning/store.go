package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The learning store's own database. Created here, at start, and safe to run again.
const schema = `
CREATE SCHEMA IF NOT EXISTS learning;

-- A workspace that opted out or asked for erasure: nothing more is taken from it.
CREATE TABLE IF NOT EXISTS learning.workspaces (
  org_id uuid PRIMARY KEY,
  opted_out boolean NOT NULL DEFAULT false,
  erased_at timestamptz
);

-- One row per imported lead: hashes and shapes only (shape.go says what is and is not kept).
CREATE TABLE IF NOT EXISTS learning.leads (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  row_no bigint NOT NULL,
  project_id uuid,
  phone_hash bytea,
  email_hash bytea,
  name_shape text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  zip5 text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  has_address boolean NOT NULL DEFAULT false,
  has_unit boolean NOT NULL DEFAULT false,
  has_location boolean NOT NULL DEFAULT false,
  completeness smallint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}',
  flags jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  flagged_at timestamptz,
  expires_at timestamptz NOT NULL,
  UNIQUE (job_id, row_no)
);
CREATE INDEX IF NOT EXISTS leads_org ON learning.leads (org_id);
CREATE INDEX IF NOT EXISTS leads_phone ON learning.leads (org_id, phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_email ON learning.leads (org_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_expiry ON learning.leads (expires_at);

-- Which column titles meant which field, counted. Titles hold no personal details.
CREATE TABLE IF NOT EXISTS learning.mappings (
  header_key text NOT NULL,
  field text NOT NULL,
  times bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (header_key, field)
);

-- People who asked to be removed: a keyed hash of the phone or email (one key for all workspaces), so that what they asked for is kept
-- to: they are not taken in again from a later list. Nothing else about them is kept.
CREATE TABLE IF NOT EXISTS learning.suppressed (
  hash bytea PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);

-- What was done and when, with counts only: the record that an erasure or a purge happened.
CREATE TABLE IF NOT EXISTS learning.audit (
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  org_id uuid,
  affected bigint NOT NULL DEFAULT 0
);
`

type store struct {
	db        *pgxpool.Pool
	h         hasher
	retention time.Duration
}

func openStore(ctx context.Context, url string, h hasher, retention time.Duration) (*store, error) {
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	conn, err := db.Acquire(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	defer conn.Release()
	// One instance at a time sets the tables up.
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(727301)`); err != nil {
		db.Close()
		return nil, err
	}
	defer conn.Exec(ctx, `SELECT pg_advisory_unlock(727301)`)
	if _, err = conn.Exec(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("setting up the learning database: %w", err)
	}
	return &store{db: db, h: h, retention: retention}, nil
}

// row is one lead as the importer sends it. It is read, hashed and shaped here, and never written as it came.
type row struct {
	RowNo   int64             `json:"row_no"`
	Name    string            `json:"name"`
	Phone   string            `json:"phone"`
	Email   string            `json:"email"`
	Address string            `json:"address"`
	Unit    string            `json:"unit"`
	City    string            `json:"city"`
	Region  string            `json:"region"`
	Zip     string            `json:"zip"`
	Country string            `json:"country"`
	HasGeo  bool              `json:"has_location"`
	Details map[string]string `json:"details"`
	Flags   map[string]string `json:"flags"`
}

type ingest struct {
	OrgID     string `json:"org_id"`
	JobID     string `json:"job_id"`
	ProjectID string `json:"project_id"`
	Mapping   []struct {
		Header string `json:"header"`
		Field  string `json:"field"`
	} `json:"mapping"`
	Rows []row `json:"rows"`
}

func completeness(r row) int {
	n := 0
	for _, v := range []string{r.Name, r.Phone, r.Email, r.Address, r.City, r.Region, r.Zip} {
		if strings.TrimSpace(v) != "" {
			n++
		}
	}
	return n
}

// blocked says whether a workspace has opted out or asked for erasure.
func (s *store) blocked(ctx context.Context, org string) (bool, error) {
	var out bool
	err := s.db.QueryRow(ctx, `SELECT coalesce((SELECT opted_out OR erased_at IS NOT NULL FROM learning.workspaces WHERE org_id = $1), false)`, org).Scan(&out)
	return out, err
}

// add stores a batch. A batch sent twice (a retry) stores nothing the second time. Returns how many were stored.
func (s *store) add(ctx context.Context, in ingest) (int64, error) {
	expires := time.Now().Add(s.retention)
	h := s.h.forOrg(in.OrgID)
	batch := &pgx.Batch{}
	blocked, err := s.suppressedAmong(ctx, in.Rows)
	if err != nil {
		return 0, err
	}
	for i, r := range in.Rows {
		if blocked[i] {
			continue
		}
		batch.Queue(`INSERT INTO learning.leads (org_id, job_id, row_no, project_id, phone_hash, email_hash, name_shape, city, region, zip5, country,
				has_address, has_unit, has_location, completeness, details, flags, expires_at)
			VALUES ($1, $2, $3, nullif($4, '')::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
			ON CONFLICT (job_id, row_no) DO NOTHING`,
			in.OrgID, in.JobID, r.RowNo, in.ProjectID, h.phone(r.Phone), h.email(r.Email), nameShape(r.Name), short(r.City, 60), short(r.Region, 40), zip5(r.Zip), short(r.Country, 40),
			strings.TrimSpace(r.Address) != "", strings.TrimSpace(r.Unit) != "", r.HasGeo, completeness(r), jsonOf(cleanDetails(r.Details)), jsonOf(cleanFlags(r.Flags)), expires)
	}
	for _, m := range in.Mapping {
		if key, field := headerKey(m.Header), short(m.Field, 40); key != "" && field != "" {
			batch.Queue(`INSERT INTO learning.mappings (header_key, field) VALUES ($1, $2) ON CONFLICT (header_key, field) DO UPDATE SET times = learning.mappings.times + 1`, key, field)
		}
	}
	results := s.db.SendBatch(ctx, batch)
	defer results.Close()
	var stored int64
	for i := range in.Rows {
		if blocked[i] {
			continue
		}
		tag, err := results.Exec()
		if err != nil {
			return stored, err
		}
		stored += tag.RowsAffected()
	}
	return stored, nil
}

func jsonOf(m map[string]string) []byte {
	b, _ := json.Marshal(m)
	return b
}

// headerKey is a column title reduced to lower-case words: "Owner 1 First Name" and "owner_1_first_name" are one.
func headerKey(header string) string {
	return strings.Join(strings.FieldsFunc(strings.ToLower(header), func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') }), "_")
}

// flag adds what people decided about a lead (matched by its phone or email hash). Returns how many rows it reached.
func (s *store) flag(ctx context.Context, org, phone, email string, flags map[string]string) (int64, error) {
	flags = cleanFlags(flags)
	if len(flags) == 0 {
		return 0, nil
	}
	tag, err := s.db.Exec(ctx, `UPDATE learning.leads SET flags = flags || $4::jsonb, flagged_at = now()
		WHERE org_id = $1 AND (($2::bytea IS NOT NULL AND phone_hash = $2) OR ($3::bytea IS NOT NULL AND email_hash = $3))`,
		org, s.h.forOrg(org).phone(phone), s.h.forOrg(org).email(email), jsonOf(flags))
	return tag.RowsAffected(), err
}

// erasePerson removes the rows of one person (by phone or email) in one workspace.
func (s *store) erasePerson(ctx context.Context, org, phone, email string) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM learning.leads WHERE org_id = $1 AND (($2::bytea IS NOT NULL AND phone_hash = $2) OR ($3::bytea IS NOT NULL AND email_hash = $3))`,
		org, s.h.forOrg(org).phone(phone), s.h.forOrg(org).email(email))
	if err == nil {
		s.audit(ctx, "erase_person", org, tag.RowsAffected())
	}
	return tag.RowsAffected(), err
}

// suppressHashes are the keyed hashes (one key for every workspace) a removal request is remembered by.
func (s *store) suppressHashes(phone, email string) [][]byte {
	var out [][]byte
	if k := phoneKey(phone); k != "" {
		out = append(out, s.h.sum("suppress-phone", k))
	}
	if k := emailKey(email); k != "" {
		out = append(out, s.h.sum("suppress-email", k))
	}
	return out
}

// suppressedAmong says which of the rows are people who asked to be removed.
func (s *store) suppressedAmong(ctx context.Context, rows []row) ([]bool, error) {
	blocked := make([]bool, len(rows))
	var all [][]byte
	owner := map[string][]int{}
	for i, r := range rows {
		for _, h := range s.suppressHashes(r.Phone, r.Email) {
			all = append(all, h)
			owner[string(h)] = append(owner[string(h)], i)
		}
	}
	if len(all) == 0 {
		return blocked, nil
	}
	found, err := s.db.Query(ctx, `SELECT hash FROM learning.suppressed WHERE hash = ANY($1)`, all)
	if err != nil {
		return nil, err
	}
	defer found.Close()
	for found.Next() {
		var h []byte
		if err = found.Scan(&h); err != nil {
			return nil, err
		}
		for _, i := range owner[string(h)] {
			blocked[i] = true
		}
	}
	return blocked, found.Err()
}

// eraseEverywhere removes one person from every workspace, and remembers the request so they are not taken in again. The hashes differ per
// workspace, so each workspace is tried with its own.
func (s *store) eraseEverywhere(ctx context.Context, phone, email string) (int64, error) {
	for _, h := range s.suppressHashes(phone, email) {
		if _, err := s.db.Exec(ctx, `INSERT INTO learning.suppressed (hash) VALUES ($1) ON CONFLICT DO NOTHING`, h); err != nil {
			return 0, err
		}
	}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT org_id::text FROM learning.leads`)
	if err != nil {
		return 0, err
	}
	var orgs []string
	for rows.Next() {
		var org string
		if err = rows.Scan(&org); err != nil {
			rows.Close()
			return 0, err
		}
		orgs = append(orgs, org)
	}
	rows.Close()
	var total int64
	for _, org := range orgs {
		h := s.h.forOrg(org)
		tag, err := s.db.Exec(ctx, `DELETE FROM learning.leads WHERE org_id = $1 AND (($2::bytea IS NOT NULL AND phone_hash = $2) OR ($3::bytea IS NOT NULL AND email_hash = $3))`, org, h.phone(phone), h.email(email))
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
	}
	s.audit(ctx, "erase_person_everywhere", "", total)
	return total, nil
}

// eraseProject removes the learning copy of one list (the customer deleted the list).
func (s *store) eraseProject(ctx context.Context, org, project string) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM learning.leads WHERE org_id = $1 AND project_id = $2`, org, project)
	if err == nil {
		s.audit(ctx, "erase_list", org, tag.RowsAffected())
	}
	return tag.RowsAffected(), err
}

// eraseWorkspace removes everything taken from a workspace and stops any more being taken.
func (s *store) eraseWorkspace(ctx context.Context, org string) (int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM learning.leads WHERE org_id = $1`, org)
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO learning.workspaces (org_id, opted_out, erased_at) VALUES ($1, true, now())
		ON CONFLICT (org_id) DO UPDATE SET opted_out = true, erased_at = now()`, org); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO learning.audit (action, org_id, affected) VALUES ('erase_workspace', $1, $2)`, org, tag.RowsAffected()); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

// setOptOut stops (or lets) a workspace's lists being taken. Opting out also removes what was taken.
func (s *store) setOptOut(ctx context.Context, org string, out bool) (int64, error) {
	if out {
		return s.eraseWorkspace(ctx, org)
	}
	_, err := s.db.Exec(ctx, `INSERT INTO learning.workspaces (org_id, opted_out) VALUES ($1, false) ON CONFLICT (org_id) DO UPDATE SET opted_out = false, erased_at = NULL`, org)
	return 0, err
}

// purge removes what has been kept past its time.
func (s *store) purge(ctx context.Context) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM learning.leads WHERE expires_at < now()`)
	if err == nil && tag.RowsAffected() > 0 {
		s.audit(ctx, "purge_expired", "", tag.RowsAffected())
	}
	return tag.RowsAffected(), err
}

func (s *store) audit(ctx context.Context, action, org string, n int64) {
	_, _ = s.db.Exec(ctx, `INSERT INTO learning.audit (action, org_id, affected) VALUES ($1, nullif($2, '')::uuid, $3)`, action, org, n)
}
