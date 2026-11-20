package main

// Build step 41 (migrations/0046_agency_restores.sql): restoring one agency from a backup without touching any other (D297, D370).
//
// Staff restore a backup of the CRM database into a separate database, the restore copy (RESTORE_COPY_URL), with pg_restore. Then
// staff ask here; the agency's owner confirms with their second step; staff run it. The run brings the copy up to this version
// (the same migrations), and in one transaction replaces the agency's rows in every agency table with the copy's. Row security
// keeps both sides to that one agency. What never goes backwards: the agency's block list (numbers blocked since the backup stay
// blocked), and leads deleted on a person's request (deleted again). Every device of the agency starts over afterwards.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Tables that are not the agency's data to restore: the sync log and operation records stay as they are.
var restoreSkip = []string{"change_log", "operations", "org_resets", "schema_migrations"}

const restoreBatch = 2000

func (s *server) restoreRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/platform/restores", s.user(s.staffRestores))
	mux.Handle("POST /api/v1/platform/restores", s.user(s.staffRestores))
	mux.Handle("POST /api/v1/platform/restores/{id}/run", s.user(s.staffRunRestore))
	mux.Handle("POST /api/v1/platform/restores/{id}/cancel", s.user(s.staffCancelRestore))
	mux.Handle("GET /api/v1/restores", s.member(s.ownerRestores))
	mux.Handle("POST /api/v1/restores/{id}/confirm", s.member(s.ownerConfirmRestore))
}

// staffRestores is GET (every request) and POST {org_id, backup_date, reason} (ask the owner) on /api/v1/platform/restores.
func (s *server) staffRestores(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	ctx := q.r.Context()
	if q.r.Method == http.MethodPost {
		var body struct {
			OrgID      string `json:"org_id"`
			BackupDate string `json:"backup_date"`
			Reason     string `json:"reason"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		day, err := time.Parse("2006-01-02", body.BackupDate)
		reason := strings.TrimSpace(body.Reason)
		if !validID(body.OrgID) || err != nil || day.After(s.now()) || len(reason) < 5 || len(reason) > 1000 {
			return bad("Give the agency (org_id), the backup's day (backup_date, like 2026-11-17) and why (5 to 1,000 characters).")
		}
		var id string
		if err := s.st.db.QueryRow(ctx, `INSERT INTO agency_restores (org_id, backup_date, reason, requested_by) VALUES ($1, $2, $3, $4) RETURNING id::text`,
			body.OrgID, day, reason, q.c.sub).Scan(&id); err != nil {
			return err
		}
		s.tellOwners(ctx, body.OrgID, "Caller Whale asks to restore your agency from the backup of "+body.BackupDate+": "+reason+
			". Everything since then would be replaced. Confirm or ignore it under Settings → Restores.")
		writeJSON(q.w, http.StatusCreated, map[string]any{"id": id, "status": "waiting_owner"})
		return nil
	}
	rows, err := s.st.db.Query(ctx, `SELECT jsonb_build_object('id', r.id, 'org_id', r.org_id, 'agency', coalesce(o.name, ''), 'backup_date', r.backup_date, 'reason', r.reason,
			'status', r.status, 'requested_at', r.requested_at, 'confirmed_at', r.confirmed_at, 'ran_at', r.ran_at, 'report', r.report)
		FROM agency_restores r LEFT JOIN orgs o ON o.id = r.org_id ORDER BY r.requested_at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"restores": list})
	return nil
}

// ownerRestores is GET /api/v1/restores: the agency's restore requests, for its owner and admins.
func (s *server) ownerRestores(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see restore requests.")
	}
	rows, err := s.st.db.Query(q.r.Context(), `SELECT jsonb_build_object('id', id, 'backup_date', backup_date, 'reason', reason, 'status', status,
			'requested_at', requested_at, 'confirmed_at', confirmed_at, 'ran_at', ran_at)
		FROM agency_restores WHERE org_id = $1 ORDER BY requested_at DESC LIMIT 50`, q.sc.orgID)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"restores": list})
	return nil
}

// ownerConfirmRestore is POST /api/v1/restores/{id}/confirm: the owner agrees, with their second step.
func (s *server) ownerConfirmRestore(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("Only the owner confirms a restore.")
	}
	if !q.sc.secondStep {
		return &apiError{http.StatusForbidden, "second_step_required", "Pass your second sign-in step first."}
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE agency_restores SET status = 'confirmed', confirmed_by = $3, confirmed_at = now()
		WHERE id = $1 AND org_id = $2 AND status = 'waiting_owner'`, nullID(q.r.PathValue("id")), q.sc.orgID, q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("No restore waits for your confirmation.")
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"status": "confirmed"})
	return nil
}

func (s *server) staffCancelRestore(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE agency_restores SET status = 'cancelled' WHERE id = $1 AND status IN ('waiting_owner', 'confirmed')`, nullID(q.r.PathValue("id")))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("No such restore waiting.")
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"status": "cancelled"})
	return nil
}

// staffRunRestore is POST /api/v1/platform/restores/{id}/run: once the owner confirmed, the agency's data is replaced with the copy's.
func (s *server) staffRunRestore(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	if s.cfg.restoreCopyURL == "" {
		return &apiError{http.StatusServiceUnavailable, "no_copy", "Set RESTORE_COPY_URL to the database the backup was restored into first."}
	}
	ctx := q.r.Context()
	id := q.r.PathValue("id")
	var org string
	err := s.st.db.QueryRow(ctx, `UPDATE agency_restores SET status = 'failed', ran_by = $2, ran_at = now(), report = '{"error": "running"}'
		WHERE id = $1 AND status = 'confirmed' RETURNING org_id::text`, nullID(id), q.c.sub).Scan(&org)
	if errors.Is(err, pgx.ErrNoRows) {
		return conflictErr("Only a restore the owner confirmed can run.")
	}
	if err != nil {
		return err
	}
	report, runErr := s.restoreAgency(ctx, org, id)
	status := "done"
	if runErr != nil {
		status = "failed"
		report = map[string]any{"error": runErr.Error()}
		log.Printf("ERROR restoring agency %s: %v", org, runErr)
	}
	raw, _ := json.Marshal(report)
	if _, err := s.st.db.Exec(ctx, `UPDATE agency_restores SET status = $2, report = $3 WHERE id = $1`, id, status, raw); err != nil {
		return err
	}
	if runErr != nil {
		return &apiError{http.StatusInternalServerError, "restore_failed", "The restore did not run, and nothing changed: " + runErr.Error()}
	}
	s.tellOwners(ctx, org, "Your agency was restored from a backup by Caller Whale. Every device starts over with a fresh copy.")
	writeJSON(q.w, http.StatusOK, map[string]any{"status": status, "report": report})
	return nil
}

// agencyTables are the CRM's tables holding one agency's rows (an org_id column under row security), parents before children.
func agencyTables(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'crm' AND c.relkind = 'r' AND c.relrowsecurity
			AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
		ORDER BY c.relname`)
	if err != nil {
		return nil, err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	names = slices.DeleteFunc(names, func(n string) bool { return slices.Contains(restoreSkip, n) })
	rows, err = tx.Query(ctx, `SELECT c.relname, p.relname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = 'crm' AND c.oid <> p.oid`)
	if err != nil {
		return nil, err
	}
	parents := map[string][]string{}
	for rows.Next() {
		var child, parent string
		if err := rows.Scan(&child, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		parents[child] = append(parents[child], parent)
	}
	rows.Close()
	// Parents first: a depth-first walk over the foreign keys.
	ordered, seen := []string{}, map[string]int{}
	var visit func(string) error
	visit = func(t string) error {
		switch seen[t] {
		case 1:
			return fmt.Errorf("the tables' foreign keys loop through %s", t)
		case 2:
			return nil
		}
		seen[t] = 1
		for _, p := range parents[t] {
			if slices.Contains(names, p) {
				if err := visit(p); err != nil {
					return err
				}
			}
		}
		seen[t] = 2
		ordered = append(ordered, t)
		return nil
	}
	for _, t := range names {
		if err := visit(t); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}

// restoreAgency replaces the agency's rows with the copy's, in one transaction, and answers how many rows each table holds now.
func (s *server) restoreAgency(ctx context.Context, org, restoreID string) (map[string]any, error) {
	copyStore, err := openStore(ctx, s.cfg.restoreCopyURL) // brings the copy up to this version first
	if err != nil {
		return nil, fmt.Errorf("the restore copy: %w", err)
	}
	defer copyStore.close()
	src, err := copyStore.begin(ctx, scope{orgID: org})
	if err != nil {
		return nil, err
	}
	defer src.Rollback(ctx)
	live, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return nil, err
	}
	defer live.Rollback(ctx)
	tables, err := agencyTables(ctx, live)
	if err != nil {
		return nil, err
	}
	// The block list never goes backwards: today's blocks are kept to put back.
	keptBlocks, err := queryJSON(ctx, live, `SELECT to_jsonb(b) FROM number_blocks b`)
	if err != nil {
		return nil, err
	}
	for i := len(tables) - 1; i >= 0; i-- {
		if _, err := live.Exec(ctx, `DELETE FROM crm.`+pgx.Identifier{tables[i]}.Sanitize()); err != nil {
			return nil, fmt.Errorf("clearing %s: %w", tables[i], err)
		}
	}
	report := map[string]any{}
	for _, t := range tables {
		cols, err := insertableColumns(ctx, live, t)
		if err != nil {
			return nil, err
		}
		n, err := copyTable(ctx, src, live, t, cols)
		if err != nil {
			return nil, fmt.Errorf("restoring %s: %w", t, err)
		}
		report[t] = n
	}
	// Blocks made since the backup come back, and leads of numbers deleted on a person's request go again (D370).
	if len(keptBlocks) > 0 {
		cols, err := insertableColumns(ctx, live, "number_blocks")
		if err != nil {
			return nil, err
		}
		names := quoteAll(cols)
		raw, _ := json.Marshal(keptBlocks)
		if _, err := live.Exec(ctx, `INSERT INTO crm.number_blocks (`+names+`) SELECT `+names+` FROM jsonb_populate_recordset(NULL::crm.number_blocks, $1)
			ON CONFLICT DO NOTHING`, string(raw)); err != nil {
			return nil, fmt.Errorf("keeping the block list: %w", err)
		}
	}
	tag, err := live.Exec(ctx, `DELETE FROM leads l WHERE EXISTS (SELECT 1 FROM number_blocks b WHERE b.reason = 'deleted_on_request' AND b.phone_key = crm.phone_key(l.phone))`)
	if err != nil {
		return nil, err
	}
	report["deleted_again_on_request"] = tag.RowsAffected()
	// Every device starts over.
	var seq int64
	if err := live.QueryRow(ctx, `INSERT INTO change_log (org_id, entity, entity_id, op) VALUES (cw_org(), 'restore', $1, 'upsert') RETURNING seq`, restoreID).Scan(&seq); err != nil {
		return nil, err
	}
	if _, err := live.Exec(ctx, `INSERT INTO org_resets (org_id, seq) VALUES (cw_org(), $1)`, seq); err != nil {
		return nil, err
	}
	if err := live.Commit(ctx); err != nil {
		return nil, err
	}
	return report, nil
}

func insertableColumns(ctx context.Context, tx pgx.Tx, table string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'crm' AND table_name = $1
		AND is_generated = 'NEVER' ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func quoteAll(cols []string) string {
	q := make([]string, len(cols))
	for i, c := range cols {
		q[i] = pgx.Identifier{c}.Sanitize()
	}
	return strings.Join(q, ", ")
}

// copyTable moves one table's rows of the agency from the copy to the live database, in batches.
func copyTable(ctx context.Context, src, live pgx.Tx, table string, cols []string) (int, error) {
	name := `crm.` + pgx.Identifier{table}.Sanitize()
	names := quoteAll(cols)
	rows, err := src.Query(ctx, `SELECT to_jsonb(t) FROM `+name+` t`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	total := 0
	batch := []json.RawMessage{}
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		raw, _ := json.Marshal(batch)
		if _, err := live.Exec(ctx, `INSERT INTO `+name+` (`+names+`) SELECT `+names+` FROM jsonb_populate_recordset(NULL::`+name+`, $1)`, string(raw)); err != nil {
			return err
		}
		total += len(batch)
		batch = batch[:0]
		return nil
	}
	var all []json.RawMessage
	for rows.Next() {
		var r json.RawMessage
		if err := rows.Scan(&r); err != nil {
			return 0, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	for _, r := range all {
		batch = append(batch, r)
		if len(batch) == restoreBatch {
			if err := flush(); err != nil {
				return 0, err
			}
		}
	}
	return total, flush()
}
