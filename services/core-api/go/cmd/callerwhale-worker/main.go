// callerwhale-worker: scheduling, workflow processing and cache invalidation for the Caller Whale CRM API.
//
// Environment: CALLERWHALE_API_URL (http://api:8088), CALLERWHALE_WORKER_TOKEN, REDIS_ADDR (optional host:port),
// REDIS_PASSWORD, CALLERWHALE_WORKER_BIND (health endpoint, default 127.0.0.1:8090), CALLERWHALE_WORKER_CONCURRENCY (4).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"callerwhale/backend/go/internal/worker"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	token := os.Getenv("CALLERWHALE_WORKER_TOKEN")
	if len(token) < 24 {
		log.Error("CALLERWHALE_WORKER_TOKEN must be set to the token the API knows (24+ characters)")
		os.Exit(2)
	}
	concurrency, _ := strconv.Atoi(env("CALLERWHALE_WORKER_CONCURRENCY", "4"))
	w := &worker.Worker{
		API: &worker.Client{Base: env("CALLERWHALE_API_URL", "http://127.0.0.1:8088"), Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}},
		Config: worker.Config{
			Batch: 50, Concurrency: concurrency, Idle: time.Second, TickEvery: time.Minute, LeaseSeconds: 60, InvalidateKey: "callerwhale:invalidate",
		},
		Log: log,
	}
	if addr := os.Getenv("REDIS_ADDR"); addr != "" {
		w.Publisher = &worker.Redis{Addr: addr, Password: os.Getenv("REDIS_PASSWORD")}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	health := http.NewServeMux()
	health.HandleFunc("/healthz", func(rw http.ResponseWriter, _ *http.Request) {
		last, _ := w.Stats.LastError.Load().(string)
		rw.Header().Set("Content-Type", "application/json")
		json.NewEncoder(rw).Encode(map[string]any{
			"ok": true, "processed": w.Stats.Processed.Load(), "failed": w.Stats.Failed.Load(), "ticks": w.Stats.Ticks.Load(), "last_error": last,
		})
	})
	server := &http.Server{Addr: env("CALLERWHALE_WORKER_BIND", "127.0.0.1:8090"), Handler: health, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("health endpoint stopped", "error", err)
		}
	}()
	log.Info("callerwhale-worker started", "api", w.API.Base)
	w.Run(ctx)
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutdown)
	log.Info("callerwhale-worker stopped")
}
