package crm

import (
	"context"
	"log"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
	"github.com/riverqueue/river/rivertype"
)

// The background work runs through River, a job queue kept in this database (split 2, D389). A request only records what is wanted
// and queues a job in the same transaction, so the job cannot be lost between the two; whichever container works the queue (today the
// API itself, later crm-merge) picks it up. Long jobs run in slices of sliceBudget and go back in line between slices: a huge list
// cannot hold a worker for an hour, other workspaces' imports take turns with it, and a container that stops mid-merge loses at most a
// slice (River gives a job whose container died to another after RescueStuckJobsAfter, 30 minutes; the merges themselves resume from their last
// batch).

const (
	queueMerge  = "merge"  // lead and call merges: the heavy database work, one at a time per container
	queueAssign = "assign" // lead assignments, and the check that adopts work nobody is doing
	sliceBudget = 2 * time.Minute
	jobTimeout  = 10 * time.Minute // a slice that runs this long is cut off (a batch never takes near this)
)

// uniqueWhileQueued: an import or assignment is never queued twice at once, but can be queued again after its job finished (a retry).
var uniqueWhileQueued = river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{
	rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRetryable, rivertype.JobStateRunning, rivertype.JobStateScheduled,
}}

type leadMergeArgs struct {
	Job string `json:"job"`
}

func (leadMergeArgs) Kind() string { return "lead_merge" }
func (leadMergeArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: queueMerge, UniqueOpts: uniqueWhileQueued}
}

type callMergeArgs struct {
	Job string `json:"job"`
}

func (callMergeArgs) Kind() string { return "call_merge" }
func (callMergeArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: queueMerge, UniqueOpts: uniqueWhileQueued}
}

type assignArgs struct {
	Org string `json:"org"`
	Run string `json:"run"`
}

func (assignArgs) Kind() string { return "assignment" }
func (assignArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: queueAssign, UniqueOpts: uniqueWhileQueued}
}

type adoptArgs struct{}

func (adoptArgs) Kind() string                 { return "adopt_work" }
func (adoptArgs) InsertOpts() river.InsertOpts { return river.InsertOpts{Queue: queueAssign} }

type leadMergeWorker struct {
	river.WorkerDefaults[leadMergeArgs]
	s *server
}

func (w *leadMergeWorker) Timeout(*river.Job[leadMergeArgs]) time.Duration { return jobTimeout }
func (w *leadMergeWorker) Work(ctx context.Context, job *river.Job[leadMergeArgs]) error {
	return again(w.s.mergeSlice(ctx, job.Args.Job, sliceBudget))
}

type callMergeWorker struct {
	river.WorkerDefaults[callMergeArgs]
	s *server
}

func (w *callMergeWorker) Timeout(*river.Job[callMergeArgs]) time.Duration { return jobTimeout }
func (w *callMergeWorker) Work(ctx context.Context, job *river.Job[callMergeArgs]) error {
	return again(w.s.callMergeSlice(ctx, job.Args.Job, sliceBudget))
}

type assignWorker struct {
	river.WorkerDefaults[assignArgs]
	s *server
}

func (w *assignWorker) Timeout(*river.Job[assignArgs]) time.Duration { return jobTimeout }
func (w *assignWorker) Work(ctx context.Context, job *river.Job[assignArgs]) error {
	return again(w.s.assignSlice(ctx, job.Args.Org, job.Args.Run, sliceBudget))
}

type adoptWorker struct {
	river.WorkerDefaults[adoptArgs]
	s *server
}

func (w *adoptWorker) Work(ctx context.Context, _ *river.Job[adoptArgs]) error { return w.s.adoptWork(ctx) }

// again puts a sliced job back in line when more is left (a snooze does not count as a failed try).
func again(more bool) error {
	if more {
		return river.JobSnooze(time.Second)
	}
	return nil
}

// migrateJobs creates or updates River's own tables (in the schema crm, through the search path), after crm-core's scripts.
func migrateJobs(ctx context.Context, st *store) error {
	migrator, err := rivermigrate.New(riverpgxv5.New(st.db), &rivermigrate.Config{Logger: quietLogger()})
	if err != nil {
		return err
	}
	_, err = migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	return err
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
}

// startJobs makes the job queue's client. With work set this process also works the merge and assignment queues and runs the adopt
// check every minute (River runs a periodic job on one elected copy only); without it the client only queues jobs.
func (s *server) startJobs(ctx context.Context, work bool) error {
	workers := river.NewWorkers()
	river.AddWorker(workers, &leadMergeWorker{s: s})
	river.AddWorker(workers, &callMergeWorker{s: s})
	river.AddWorker(workers, &assignWorker{s: s})
	river.AddWorker(workers, &adoptWorker{s: s})
	river.AddWorker(workers, &upkeepWorker{s: s})
	cfg := &river.Config{Workers: workers, Logger: quietLogger(), RescueStuckJobsAfter: 30 * time.Minute, JobTimeout: jobTimeout}
	if work {
		cfg.Queues = map[string]river.QueueConfig{queueMerge: {MaxWorkers: 1}, queueAssign: {MaxWorkers: 2}, queueUpkeep: {MaxWorkers: 2}, queueOutbox: {MaxWorkers: 4}}
		if s.scanner == nil {
			log.Printf("WARN CLAMD_ADDR is not set: files on leads wait unopened until a scanner is set up")
		}
		cfg.PeriodicJobs = append(s.periodicJobs(cfg.Queues), river.NewPeriodicJob(river.PeriodicInterval(time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return adoptArgs{}, nil }, &river.PeriodicJobOpts{ID: "adopt_work", RunOnStart: true}))
	}
	client, err := river.NewClient(riverpgxv5.New(s.st.db), cfg)
	if err != nil {
		return err
	}
	s.jobs = client
	if work {
		return client.Start(ctx)
	}
	return nil
}

// stopJobs lets running slices finish their batch (up to 15 seconds) before the process ends.
func (s *server) stopJobs() {
	if s.jobs == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.jobs.Stop(ctx); err != nil {
		log.Printf("WARN the job queue did not stop cleanly: %v", err)
	}
}

// startWork runs an update and, when it changed a row, queues the job that does the work, in one transaction.
func (s *server) startWork(ctx context.Context, job river.JobArgs, sql string, args ...any) (pgconn.CommandTag, error) {
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil || tag.RowsAffected() == 0 {
		return tag, err
	}
	if _, err = s.jobs.InsertTx(ctx, tx, job, nil); err != nil {
		return tag, err
	}
	return tag, tx.Commit(ctx)
}

// adoptWork queues a job for every merge or assignment that is going but has none: work started before the job queue existed, and
// work whose job ended while its container was stopping. Ones that already have a job are skipped (uniqueWhileQueued).
func (s *server) adoptWork(ctx context.Context) error {
	var jobs []river.InsertManyParams
	rows, err := s.st.db.Query(ctx, `SELECT id::text, status FROM importing.jobs WHERE status IN ('merging', 'call_merging') AND NOT cancel_requested`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, status string
		if err = rows.Scan(&id, &status); err != nil {
			rows.Close()
			return err
		}
		if status == "call_merging" {
			jobs = append(jobs, river.InsertManyParams{Args: callMergeArgs{Job: id}})
		} else {
			jobs = append(jobs, river.InsertManyParams{Args: leadMergeArgs{Job: id}})
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	// Row security hides every workspace's runs from a plain connection; cw.resume lets this one read lift it (0023).
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT set_config('cw.resume', 'on', true)`); err != nil {
		return err
	}
	runs, err := tx.Query(ctx, `SELECT id::text, org_id::text FROM assignment_runs WHERE status = 'running'`)
	if err != nil {
		return err
	}
	for runs.Next() {
		var id, org string
		if err = runs.Scan(&id, &org); err != nil {
			runs.Close()
			return err
		}
		jobs = append(jobs, river.InsertManyParams{Args: assignArgs{Org: org, Run: id}})
	}
	runs.Close()
	if err = runs.Err(); err != nil {
		return err
	}
	tx.Rollback(ctx)
	for _, job := range jobs { // one at a time: a unique job that is already queued is skipped, not an error
		result, err := s.jobs.Insert(ctx, job.Args, nil)
		if err != nil {
			return err
		}
		if !result.UniqueSkippedAsDuplicate {
			log.Printf("INFO queued %s work that had no job: %+v", job.Args.Kind(), job.Args)
		}
	}
	return nil
}

// notify tells every copy of the API (and through it the browsers of the workspace) that something finished, through PostgreSQL: the
// work may run in another container than the one holding the browser's socket.
func (s *server) notify(ctx context.Context, org, kind, entity string) {
	if _, err := s.st.db.Exec(context.WithoutCancel(ctx), `SELECT pg_notify('cw_events', jsonb_build_object('org_id', $1::text, 'kind', $2::text, 'entity', $3::text, 'seq', 0)::text)`,
		org, kind, entity); err != nil {
		log.Printf("WARN could not announce %s for workspace %s: %v", kind, org, err)
	}
}

// The timed work. Each task is a River periodic job: the queue runs it on one elected copy only, so two containers never send the same
// webhook, email or report twice, and a run still going is never doubled by the next one (uniqueWhileQueued). A failed run is logged
// and waits for its next turn, as the loops it replaces did.
const (
	queueUpkeep = "upkeep" // database upkeep beside the merges (crm-merge)
	queueOutbox = "outbox" // everything that waits on another service (crm-outbox)
)

type upkeepArgs struct {
	Task string `json:"task"`
}

func (upkeepArgs) Kind() string { return "upkeep" }

type upkeepTask struct {
	name, queue string
	every       time.Duration
	atStart     bool
	run         func(*server, context.Context) error
}

// upkeepTasks lists the timed work and who does it. A task whose setting is off (no learning service, no scanner) is left out.
func (s *server) upkeepTasks() []upkeepTask {
	tasks := []upkeepTask{
		{"sweep_rows", queueUpkeep, 6 * time.Hour, true, func(s *server, ctx context.Context) error {
			n, err := s.sweepRows(ctx)
			if n > 0 {
				log.Printf("INFO cleared %d old import rows", n)
			}
			return err
		}},
		{"address_keys", queueUpkeep, time.Minute, true, func(s *server, ctx context.Context) error {
			n, err := s.fillAddressKeys(ctx)
			if n > 0 {
				log.Printf("INFO filled the address keys of %d properties", n)
			}
			return err
		}},
		{"send_events", queueOutbox, 30 * time.Second, false, (*server).sendDueEvents},
		{"email_waits", queueOutbox, time.Minute, false, (*server).checkEmailWaits},
		{"reports", queueOutbox, 10 * time.Minute, false, (*server).sendDueReports},
		{"shared_learning", queueOutbox, 24 * time.Hour, true, func(s *server, ctx context.Context) error { s.contributeAll(ctx); return nil }},
	}
	if s.cfg.learningURL != "" {
		tasks = append(tasks, upkeepTask{"learn_pending", queueUpkeep, 10 * time.Minute, true, func(s *server, ctx context.Context) error { s.learnPending(ctx); return nil }})
	}
	if s.scanner != nil {
		tasks = append(tasks, upkeepTask{"scan_files", queueOutbox, 30 * time.Second, false, (*server).scanWaiting})
	}
	return tasks
}

type upkeepWorker struct {
	river.WorkerDefaults[upkeepArgs]
	s *server
}

func (w *upkeepWorker) Timeout(*river.Job[upkeepArgs]) time.Duration { return 25 * time.Minute } // under the 30-minute rescue
func (w *upkeepWorker) Work(ctx context.Context, job *river.Job[upkeepArgs]) error {
	for _, task := range w.s.upkeepTasks() {
		if task.name == job.Args.Task {
			if err := task.run(w.s, ctx); err != nil && ctx.Err() == nil {
				log.Printf("WARN %s: %v (tried again at its next turn)", task.name, err)
			}
			return nil
		}
	}
	return nil // a task that is off in this copy's settings
}

func (s *server) periodicJobs(queues map[string]river.QueueConfig) []*river.PeriodicJob {
	var jobs []*river.PeriodicJob
	for _, task := range s.upkeepTasks() {
		if _, ok := queues[task.queue]; !ok {
			continue
		}
		args, opts := upkeepArgs{Task: task.name}, &river.InsertOpts{Queue: task.queue, MaxAttempts: 1, UniqueOpts: uniqueWhileQueued}
		jobs = append(jobs, river.NewPeriodicJob(river.PeriodicInterval(task.every),
			func() (river.JobArgs, *river.InsertOpts) { return args, opts }, &river.PeriodicJobOpts{ID: task.name, RunOnStart: task.atStart}))
	}
	return jobs
}
