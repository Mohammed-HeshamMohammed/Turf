// Auth: the one source of truth for who someone is, for every Caller Whale app and service. Firebase holds accounts and passwords;
// this service adds the second steps, sessions, refresh tokens and the signed access tokens every other service checks.
// The human check is not here: it is in the gateway. Plan: docs/plans/go-auth.md.
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
		port = "8101"
	}
	switch {
	// "service health" is the container's health check: the image has no shell or curl.
	case len(os.Args) > 1 && os.Args[1] == "health":
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	// "service new-key" prints a signing key for AUTH_SIGNING_KEY and exits.
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
		log.Print("WARN AUTH_SIGNING_KEY is not set: using a temporary key, so every token stops working when this process stops")
		k, err = generateKeys()
	} else {
		k, err = keysFromBase64(cfg.signingKey)
	}
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	db, err := connect(ctx, cfg.databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := setupDatabase(ctx, db); err != nil {
		return err
	}
	s := &server{cfg: cfg, db: db, keys: k, fb: newFirebase(cfg.firebaseKey, cfg.firebaseIdentity, cfg.firebaseToken)}
	if cfg.notifyURL != "" && cfg.notifyToken != "" {
		s.mail = newNotify(cfg.notifyURL, cfg.notifyToken)
	}
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	failed := make(chan error, 1)
	go func() { failed <- srv.ListenAndServe() }()
	log.Printf("auth listening on http://localhost:%s", cfg.port)
	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
	}
	// A stop signal (a deploy, a restart): finish the requests in flight, then close. Nothing is half written: every change is one
	// statement or one transaction.
	log.Print("INFO stopping: finishing the requests in flight")
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
