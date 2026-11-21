package crm

// ReadyMode's upload is parsed by the import worker. Core only links the staged
// events to CRM leads after the user confirms the prepared history.
import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

const callMergeBatch = 1000

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
	tag, err := s.startWork(q.r.Context(), callMergeArgs{Job: id}, `UPDATE importing.jobs SET status = 'call_merging',
		progress = jsonb_build_object('phase','call_merging','done',merged_rows,'total',coalesce((report->>'valid_calls')::bigint,0)), updated_at = now()
		WHERE id = $1 AND status = 'call_ready' AND kind = 'readymode_calls'`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return bad("This import has already changed. Refresh it and try again.")
	}
	return s.importReply(q, id)
}

// runCallMerge merges a whole call history at once (the speed test; the job queue runs it in slices, callMergeSlice).
func (s *server) runCallMerge(ctx context.Context, id string) {
	for s.callMergeSlice(ctx, id, 0) {
	}
}

// callMergeSlice links a call history's staged calls to leads, a batch at a time, until none are left or budget (0: no limit) has
// passed; more says it stopped early and the job queue puts the history back in line.
func (s *server) callMergeSlice(ctx context.Context, id string, budget time.Duration) (more bool) {
	mergeLock.Lock()
	defer mergeLock.Unlock()
	started := time.Now()
	fail := func(err error) {
		if ctx.Err() != nil {
			return // the process is stopping, not failing: the work stays going and is queued again (adoptWork)
		}
		log.Printf("ERROR merging call history %s: %v", id, err)
		_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET status = 'failed', error = 'Call history could not be added. The staged rows are still here; retry this import.', updated_at = now() WHERE id = $1 AND status = 'call_merging'`, id)
	}
	var org, user string
	err := s.st.db.QueryRow(ctx, `SELECT org_id::text, user_id::text FROM importing.jobs WHERE id = $1 AND kind = 'readymode_calls' AND status = 'call_merging'`, id).Scan(&org, &user)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			fail(err)
		}
		return false
	}
	sc := scope{userID: user, orgID: org, scopes: []string{"organization"}}
	for {
		var cancelled bool
		if err = s.st.db.QueryRow(ctx, `SELECT cancel_requested FROM importing.jobs WHERE id = $1`, id).Scan(&cancelled); err != nil || cancelled {
			return false
		}
		n, err := s.mergeCallBatch(ctx, sc, id)
		if err != nil {
			fail(err)
			return false
		}
		if n == 0 {
			break
		}
		_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET merged_rows = merged_rows + $2,
			progress = jsonb_build_object('phase','call_merging','done',merged_rows + $2,'total',coalesce((report->>'valid_calls')::bigint,0)),
			updated_at = now() WHERE id = $1 AND status = 'call_merging'`, id, n)
		if budget > 0 && time.Since(started) > budget {
			return true
		}
	}
	_, _ = s.st.db.Exec(ctx, `UPDATE importing.jobs SET status = 'done', error = '',
		progress = jsonb_build_object('phase','done','done',merged_rows,'total',coalesce((report->>'valid_calls')::bigint,0)),
		updated_at = now() WHERE id = $1 AND status = 'call_merging'`, id)
	s.notify(ctx, org, "import.done", "call")
	return false
}

// mergeCallBatch merges the next batch of staged call rows in one statement: importing.merge_call_batch (migration 0049) does, row by row
// inside the database, what Go used to do with several round trips per row. It returns how many rows it settled; zero means none are left.
func (s *server) mergeCallBatch(ctx context.Context, sc scope, id string) (int64, error) {
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var n int64
	if err = tx.QueryRow(ctx, `SELECT importing.merge_call_batch($1, $2)`, id, callMergeBatch).Scan(&n); err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}
