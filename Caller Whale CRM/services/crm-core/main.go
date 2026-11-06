// crm-core: the CRM's backend. The web CRM (app.callerwhale.com) and the desktop app sync their leads, tasks, notes, calls, deals and
// handoffs here, and upload their lists here. Who someone is comes from the auth service's signed tokens (checked locally); what they
// may do comes from the authorization service. Plan: docs/plans/crm-core-and-imports.md.
package main

import (
	"context"
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
	port        string
	databaseURL string
	jwksURL     string          // the auth service's public keys
	authzURL    string          // the authorization service, private
	authzToken  string          // crm-core's own token there (AUTHZ_TOKENS "core-api=...")
	notifyURL   string          // where the website's contact form goes on to; empty turns it off
	importDir   string          // the folder shared with the import worker, where upload pieces wait
	importRole  string          // the import worker's database login, to be given the holding tables
	origins     map[string]bool // pages that may call from a browser (CORS_ORIGINS)
	grantTTL    time.Duration
	maxImportMB int64
}

func loadConfig(getenv func(string) string) (config, error) {
	trim := func(v string) string { return strings.TrimRight(strings.TrimSpace(v), "/") }
	c := config{
		port:        strings.TrimSpace(getenv("PORT")),
		databaseURL: strings.TrimSpace(getenv("DATABASE_URL")),
		jwksURL:     trim(getenv("AUTH_JWKS_URL")),
		authzURL:    trim(getenv("AUTHZ_URL")),
		authzToken:  strings.TrimSpace(getenv("AUTHZ_TOKEN")),
		notifyURL:   trim(getenv("NOTIFY_URL")),
		importDir:   strings.TrimSpace(getenv("IMPORT_DIR")),
		importRole:  strings.TrimSpace(getenv("IMPORT_DB_ROLE")),
		grantTTL:    5 * time.Second,
		maxImportMB: 20 * 1024,
	}
	if c.port == "" {
		c.port = "8107"
	}
	if c.importDir == "" {
		c.importDir = "/data/imports"
	}
	if v := strings.TrimSpace(getenv("MAX_IMPORT_MB")); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			return c, errors.New("MAX_IMPORT_MB must be a number of megabytes")
		}
		c.maxImportMB = n
	}
	var err error
	if c.origins, err = parseOrigins(getenv("CORS_ORIGINS")); err != nil {
		return c, err
	}
	if c.databaseURL == "" || c.jwksURL == "" || c.authzURL == "" {
		return c, errors.New("set DATABASE_URL, AUTH_JWKS_URL and AUTHZ_URL")
	}
	if len(c.authzToken) < 32 {
		return c, errors.New("AUTHZ_TOKEN must be at least 32 characters: crm-core's token in authz's AUTHZ_TOKENS (core-api=...)")
	}
	return c, nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8107"
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
	ctx, stopAll := context.WithCancel(context.Background())
	defer stopAll()
	st, err := openStore(ctx, cfg.databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer st.close()
	if err = st.grantImporter(ctx, cfg.importRole); err != nil {
		log.Fatal(err)
	}
	s := &server{cfg: cfg, keys: newKeyset(cfg.jwksURL), rules: newAuthz(cfg.authzURL, cfg.authzToken, cfg.grantTTL), st: st, hub: newHub(), now: time.Now}
	go s.hub.listen(ctx, cfg.databaseURL)
	go s.resumeMerges(ctx)
	go s.sweepUploads(ctx)
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, WriteTimeout: 5 * time.Minute, IdleTimeout: 2 * time.Minute}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		stopAll()
		sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Printf("[START] Caller Whale CRM core | Listening on port %s\n", cfg.port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
