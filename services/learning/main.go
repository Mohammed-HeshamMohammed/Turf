// learning: the separate store of what Caller Whale learns from imported lists. It holds keyed hashes and shapes of leads, never the
// leads themselves, in its own database that crm-core and the import worker cannot read. Plan: docs/plans/learning-store-compliance.md.
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	port, databaseURL, token string
	key                      []byte
	enabled                  bool
	retention                time.Duration
}

func loadConfig(getenv func(string) string) (config, error) {
	c := config{port: strings.TrimSpace(getenv("PORT")), databaseURL: strings.TrimSpace(getenv("DATABASE_URL")), token: strings.TrimSpace(getenv("LEARNING_TOKEN"))}
	if c.port == "" {
		c.port = "8112"
	}
	if c.databaseURL == "" {
		return c, errors.New("set DATABASE_URL: this service's own database, not the CRM's")
	}
	if len(c.token) < 32 {
		return c, errors.New("LEARNING_TOKEN must be at least 32 characters: the token crm-core sends")
	}
	key, err := hex.DecodeString(strings.TrimSpace(getenv("LEARNING_HASH_KEY")))
	if err != nil || len(key) < 32 {
		return c, errors.New("LEARNING_HASH_KEY must be at least 64 hex characters (32 bytes), held only by the platform owners")
	}
	c.key = key
	c.enabled = strings.EqualFold(strings.TrimSpace(getenv("LEARNING_ENABLED")), "true")
	days := 730
	if v := strings.TrimSpace(getenv("LEARNING_RETENTION_DAYS")); v != "" {
		if days, err = strconv.Atoi(v); err != nil || days < 1 || days > 3650 {
			return c, errors.New("LEARNING_RETENTION_DAYS must be 1 to 3650")
		}
	}
	c.retention = time.Duration(days) * 24 * time.Hour
	return c, nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8112"
	}
	// "service health" is the container's health check: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "health" {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	st, err := openStore(ctx, cfg.databaseURL, hasher{key: cfg.key}, cfg.retention)
	if err != nil {
		log.Fatal(err)
	}
	s := &server{st: st, token: cfg.token, enabled: cfg.enabled}
	go s.purgeEvery(ctx)
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("learning listening on :%s (taking in lists: %v, kept for %v)", cfg.port, cfg.enabled, cfg.retention)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
