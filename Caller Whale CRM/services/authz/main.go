// Authorization: decides what each person may do, and which database rights each request runs under. It has no public
// address: only Caller Whale's own services call it, each with its own token. The rules live in SpiceDB.
// Plan: docs/plans/authorization-service.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8104"
	}
	switch {
	// "service health" is the container's health check: the image has no shell or curl.
	case len(os.Args) > 1 && os.Args[1] == "health":
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	// "service new-key" prints a signing key for AUTHZ_SIGNING_KEY and exits.
	case len(os.Args) > 1 && os.Args[1] == "new-key":
		key, err := newSecretKey()
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(key)
		return
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	var k *keys
	if cfg.signingKey == "" {
		log.Print("WARN AUTHZ_SIGNING_KEY is not set: using a temporary key, so grants stop verifying when this process stops")
		k, err = generateKeys()
	} else {
		k, err = keysFromBase64(cfg.signingKey)
	}
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	rules, err := newSpice(cfg)
	if err != nil {
		return err
	}
	if err := rules.writeSchema(ctx); err != nil {
		return err
	}
	s := &server{cfg: cfg, rules: rules, keys: k, now: time.Now}
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	failed := make(chan error, 1)
	go func() { failed <- srv.ListenAndServe() }()
	log.Printf("authz listening on http://localhost:%s", cfg.port)
	select {
	case err := <-failed:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}
