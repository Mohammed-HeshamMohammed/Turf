package crm

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

// The job containers of split 2 (D389): crm-merge works the merge, assignment and upkeep queues; crm-outbox the outbox (webhooks,
// emails, reports, shared learning, file scans). Each is crm-core's code with only its own jobs switched on, its own port, health
// check and settings. They never change the database's structure: they wait until the API has applied every update.

// healthProbe answers "service health", the containers' health check (the images have no shell or curl).
func healthProbe(port string) {
	if len(os.Args) < 2 || os.Args[1] != "health" {
		return
	}
	res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		log.Printf("health probe: %v", err)
		os.Exit(1)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		log.Printf("health probe: HTTP %d", res.StatusCode)
		os.Exit(1)
	}
	os.Exit(0)
}

// MainJobs runs one job container: role "merge" (cmd/crm-merge) or "outbox" (cmd/crm-outbox).
func MainJobs(role string) {
	service, queues := "crm-merge", mergeQueues
	if role == "outbox" {
		service, queues = "crm-outbox", outboxQueues
	}
	cfg, err := loadConfigFor(role, os.Getenv)
	healthProbe(cfg.port)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stopAll := context.WithCancel(context.Background())
	defer stopAll()
	st, err := waitForStore(ctx, cfg.databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer st.close()
	s := &server{cfg: cfg, st: st, hub: newHub(), now: time.Now}
	if cfg.authzURL != "" {
		s.rules = newAuthz(cfg.authzURL, cfg.authzToken, cfg.grantTTL)
	}
	if role == "outbox" {
		if cfg.clamdAddr != "" {
			s.scanner = clamd{addr: cfg.clamdAddr}
		}
		if cfg.emailRegion != "" {
			ses, err := newSES(ctx, cfg.emailRegion)
			if err != nil {
				log.Fatal(err)
			}
			s.mail = ses
		}
	}
	if err = s.startJobs(ctx, queues); err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.jobsHandler(service, queues), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		s.stopJobs() // running slices finish their batch first
		stopAll()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Printf("[START] Caller Whale %s | Listening on port %s\n", service, cfg.port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// jobsHandler is a job container's only HTTP: /healthz (the database answers), /version and /status (its queues). Nothing outside the
// private network reaches it.
func (s *server) jobsHandler(service string, queues map[string]river.QueueConfig) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := s.st.ping(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "service": service, "error": "The database does not answer."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": service})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": service, "version": version})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		counts, err := s.queueCounts(r.Context(), queues)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"service": service, "error": "The queue could not be read."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"service": service, "queues": counts})
	})
	return mux
}

// waitForStore connects without changing anything and waits, checking every 10 seconds, until the API has applied every database
// update this build knows (its own scripts and River's tables): a job container started before the API's new version must not run
// new code against the old structure.
func waitForStore(ctx context.Context, url string) (*store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "crm,public"
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	st := &store{db: db}
	if err = st.waitForUpdate(ctx, 10*time.Second); err != nil {
		db.Close()
		return nil, err
	}
	return st, nil
}

func (st *store) waitForUpdate(ctx context.Context, every time.Duration) error {
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	migrator, err := rivermigrate.New(riverpgxv5.New(st.db), &rivermigrate.Config{Logger: quietLogger()})
	if err != nil {
		return err
	}
	for said := false; ; said = true {
		var applied int
		err := st.db.QueryRow(ctx, `SELECT count(*) FROM crm.schema_migrations WHERE name = ANY($1)`, names).Scan(&applied)
		if err == nil && applied == len(names) {
			if result, verr := migrator.Validate(ctx, nil); verr == nil && result.OK {
				return nil
			}
		}
		if !said {
			log.Printf("INFO waiting for the database update (crm-core applies it when it starts): %d of %d scripts applied", applied, len(names))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
}

// queueCounts is how many jobs of each queue wait, run, are scheduled or are being retried.
func (s *server) queueCounts(ctx context.Context, queues map[string]river.QueueConfig) (map[string]map[string]int, error) {
	names := make([]string, 0, len(queues))
	counts := map[string]map[string]int{}
	for name := range queues {
		names = append(names, name)
		counts[name] = map[string]int{}
	}
	rows, err := s.st.db.Query(ctx, `SELECT queue, state::text, count(*) FROM crm.river_job
		WHERE queue = ANY($1) AND state IN ('available', 'running', 'retryable', 'scheduled') GROUP BY queue, state`, names)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var queue, state string
		var n int
		if err := rows.Scan(&queue, &state, &n); err != nil {
			return nil, err
		}
		counts[queue][state] = n
	}
	return counts, rows.Err()
}
