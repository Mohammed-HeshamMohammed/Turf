package main

// ReadyMode's upload is parsed by the import worker. Core only links the staged
// events to CRM leads after the user confirms the prepared history.
import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const callMergeBatch = 500

func (s *server) importApplyCalls(q *req) error {
	if err := s.importRights(q); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	job, err := s.job(q.r.Context(), q, id)
	if err != nil {
		return err
	}
	if job["kind"] != "readymode_calls" || job["status"] != "call_ready" {
		return bad("This call history is not ready to add yet.")
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE importing.jobs SET status = 'call_merging',
		progress = jsonb_build_object('phase','call_merging','done',merged_rows,'total',coalesce((report->>'valid_calls')::bigint,0)), updated_at = now()
		WHERE id = $1 AND status = 'call_ready' AND kind = 'readymode_calls'`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return bad("This import has already changed. Refresh it and try again.")
	}
	go s.runCallMerge(context.Background(), id)
	return s.importReply(q, id)
}

func (s *server) runCallMerge(ctx context.Context, id string) {
	mergeLock.Lock()
	defer mergeLock.Unlock()
	fail := func(err error) {
		log.Printf("ERROR merging call history %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET status = 'failed', error = 'Call history could not be added. The staged rows are still here; retry this import.', updated_at = now() WHERE id = $1 AND status = 'call_merging'`, id)
	}
	var org, user string
	err := s.st.db.QueryRow(ctx, `SELECT org_id::text, user_id::text FROM importing.jobs WHERE id = $1 AND kind = 'readymode_calls' AND status = 'call_merging'`, id).Scan(&org, &user)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			fail(err)
		}
		return
	}
	sc := scope{userID: user, orgID: org, scopes: []string{"organization"}}
	for {
		var cancelled bool
		if err = s.st.db.QueryRow(ctx, `SELECT cancel_requested FROM importing.jobs WHERE id = $1`, id).Scan(&cancelled); err != nil || cancelled {
			return
		}
		n, err := s.mergeCallBatch(ctx, sc, id)
		if err != nil {
			fail(err)
			return
		}
		if n == 0 {
			break
		}
		_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET merged_rows = merged_rows + $2,
			progress = jsonb_build_object('phase','call_merging','done',merged_rows + $2,'total',coalesce((report->>'valid_calls')::bigint,0)),
			updated_at = now() WHERE id = $1 AND status = 'call_merging'`, id, n)
	}
	_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET status = 'done', error = '',
		progress = jsonb_build_object('phase','done','done',merged_rows,'total',coalesce((report->>'valid_calls')::bigint,0)),
		updated_at = now() WHERE id = $1 AND status = 'call_merging'`, id)
	s.hub.publish(org, []byte(`{"kind":"import.done","entity":"call","seq":0}`))
}

func (s *server) mergeCallBatch(ctx context.Context, sc scope, id string) (int64, error) {
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT row_no, call_data FROM importing.rows WHERE job_id = $1 AND state = 'loaded'
		ORDER BY row_no LIMIT $2 FOR UPDATE SKIP LOCKED`, id, callMergeBatch)
	if err != nil {
		return 0, err
	}
	type callRow struct {
		no   int64
		data map[string]any
	}
	var batch []callRow
	for rows.Next() {
		var row callRow
		if err = rows.Scan(&row.no, &row.data); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, row := range batch {
		if err = mergeOneCall(ctx, tx, id, row.no, row.data); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int64(len(batch)), nil
}

func mergeOneCall(ctx context.Context, tx pgx.Tx, jobID string, rowNo int64, data map[string]any) error {
	if data == nil {
		_, err := tx.Exec(ctx, `UPDATE importing.rows SET state = 'skip' WHERE job_id = $1 AND row_no = $2`, jobID, rowNo)
		return err
	}
	phone, name, address := str(data, "phone"), strings.TrimSpace(str(data, "name")), str(data, "address")
	if name == "" {
		name = phone
	}
	email, zip := str(data, "email"), str(data, "zip")
	if sourceID := str(data, "source_record_id"); sourceID != "" {
		var existingLead string
		err := tx.QueryRow(ctx, `SELECT lead_id::text FROM call_events WHERE org_id = cw_org() AND source = 'readymode'
			AND source_record_id = $1 AND occurred_at = $2::timestamptz AND phone = $3`, sourceID, str(data, "occurred_at"), phone).Scan(&existingLead)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE importing.rows SET state = 'merged', lead_id = $3 WHERE job_id = $1 AND row_no = $2`, jobID, rowNo, existingLead)
			return err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	var candidates []string
	if name != "" {
		matches, err := tx.Query(ctx, `SELECT l.id::text FROM leads l LEFT JOIN properties p ON p.id = l.property_id
			WHERE l.org_id = cw_org() AND l.deleted_at IS NULL AND lower(btrim(l.name)) = lower(btrim($1))
			AND (importing.norm_phone(l.phone) = $2 OR ($3 <> '' AND lower(l.email) = $3)
			     OR ($4 <> '' AND importing.addr_key(p.address, p.postal_code) = importing.addr_key($4, $5)))
			LIMIT 2`, name, phone, email, address, zip)
		if err != nil {
			return err
		}
		for matches.Next() {
			var candidate string
			if err = matches.Scan(&candidate); err != nil {
				matches.Close()
				return err
			}
			candidates = append(candidates, candidate)
		}
		err = matches.Err()
		matches.Close()
		if err != nil {
			return err
		}
	}
	var leadID string
	if len(candidates) == 1 {
		leadID = candidates[0]
	} else {
		var propertyID *string
		if address != "" || zip != "" {
			var value string
			err := tx.QueryRow(ctx, `INSERT INTO properties (org_id,address,city,region,postal_code,country)
				VALUES (cw_org(),$1,$2,$3,$4,'US') RETURNING id::text`, address, str(data, "city"), str(data, "region"), zip).Scan(&value)
			if err != nil {
				return err
			}
			propertyID = &value
		}
		err := tx.QueryRow(ctx, `INSERT INTO leads (org_id,property_id,name,phone,email,source)
			VALUES (cw_org(),$1,coalesce(nullif($2,''),$3),$3,$4,'ReadyMode') RETURNING id::text`, propertyID, name, phone, email).Scan(&leadID)
		if err != nil {
			return err
		}
	}
	var prior *time.Time
	if err := tx.QueryRow(ctx, `SELECT max(occurred_at) FROM call_events WHERE org_id = cw_org() AND lead_id = $1`, leadID).Scan(&prior); err != nil {
		return err
	}
	var callID string
	err := tx.QueryRow(ctx, `INSERT INTO call_events
		(org_id,lead_id,agent_label,phone,outcome,code,meaning,scheduled_at,source,occurred_at,
		 import_job_id,import_row_no,source_record_id,notes,recording_started_at,recording_ended_at,details)
		VALUES (cw_org(),$1,$2,$3,$4,$5,$6,$7::timestamptz,'readymode',$8::timestamptz,
		        $9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15::jsonb)
		ON CONFLICT (import_job_id,import_row_no) WHERE import_job_id IS NOT NULL DO UPDATE SET import_row_no = EXCLUDED.import_row_no
		RETURNING id::text`, leadID, str(data, "agent"), phone, str(data, "outcome"), str(data, "code"), str(data, "meaning"),
		optionalString(data, "scheduled_at"), str(data, "occurred_at"), jobID, rowNo, str(data, "source_record_id"), str(data, "notes"),
		optionalString(data, "recording_started_at"), optionalString(data, "recording_ended_at"), data).Scan(&callID)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE importing.rows SET state = 'merged', lead_id = $3 WHERE job_id = $1 AND row_no = $2`, jobID, rowNo, leadID); err != nil {
		return err
	}
	// Imported history never schedules an overdue callback or overwrites a newer call.
	// A past DNC remains a safety block even if another call was recorded later.
	if str(data, "meaning") == "do_not_call" {
		if _, err = tx.Exec(ctx, `UPDATE leads SET do_not_call = true, verdict = 'Do not call', stage = 'Closed', version = version + 1, updated_at = now() WHERE id = $1`, leadID); err != nil {
			return err
		}
	} else {
		occurred, parseErr := time.Parse(time.RFC3339, str(data, "occurred_at"))
		if parseErr != nil {
			return parseErr
		}
		if prior == nil || !prior.After(occurred) {
			switch str(data, "meaning") {
			case "wrong_number":
				_, err = tx.Exec(ctx, `UPDATE leads SET verdict = 'Wrong number', version = version + 1, updated_at = now() WHERE id = $1 AND NOT do_not_call`, leadID)
			case "reached":
				_, err = tx.Exec(ctx, `UPDATE leads SET stage = CASE WHEN $2 = 'Transfer' AND stage IN ('New','Contacted') THEN 'Qualified'
					WHEN stage = 'New' THEN 'Contacted' ELSE stage END, version = version + 1, updated_at = now()
					WHERE id = $1 AND NOT do_not_call`, leadID, str(data, "outcome"))
			}
			if err != nil {
				return err
			}
			if scheduled := optionalString(data, "scheduled_at"); scheduled != nil {
				_, err = tx.Exec(ctx, `UPDATE leads SET next_action = 'Call back', next_action_at = $2::timestamptz,
					version = version + 1, updated_at = now() WHERE id = $1 AND $2::timestamptz > now() AND NOT do_not_call`, leadID, scheduled)
				if err != nil {
					return err
				}
			}
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO change_log (org_id,entity,entity_id,lead_id,op)
		VALUES (cw_org(),'call',$1,$2,'upsert'),(cw_org(),'lead',$2,$2,'upsert')`, callID, leadID); err != nil {
		return err
	}
	return nil
}

func optionalString(data map[string]any, key string) *string {
	value := str(data, key)
	if value == "" {
		return nil
	}
	return &value
}
