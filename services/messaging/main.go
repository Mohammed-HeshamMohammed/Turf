// messaging: conversations between the people of a workspace (direct chats and groups), and later with leads by text. It owns every
// conversation; the live server (Centrifugo) only delivers what this service has already saved. Who someone is comes from the auth
// service's signed tokens (checked locally); whether they are in the workspace comes from the authorization service.
// Plan: docs/plans/messaging-sms-voice.md.
package main

import (
	"callerwhale/authverify"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type config struct {
	port        string
	databaseURL string
	jwksURL     string          // the auth service's public keys
	authzURL    string          // the authorization service, private
	authzToken  string          // this service's token there (AUTHZ_TOKENS "messaging=...")
	origins     map[string]bool // pages that may call from a browser (CORS_ORIGINS)
	grantTTL    time.Duration
	liveAPI     string // Centrifugo's server API, private (http://centrifugo:8000/api); empty: nothing is delivered live
	liveAPIKey  string // Centrifugo's http_api.key
	liveSecret  string // Centrifugo's client.token.hmac_secret_key: connection tokens are signed with it
	livePublic  string // where apps open the socket (wss://live.callerwhale.com/connection/websocket)
}

func loadConfig(getenv func(string) string) (config, error) {
	trim := func(v string) string { return strings.TrimRight(strings.TrimSpace(v), "/") }
	c := config{
		port:        strings.TrimSpace(getenv("PORT")),
		databaseURL: strings.TrimSpace(getenv("DATABASE_URL")),
		jwksURL:     trim(getenv("AUTH_JWKS_URL")),
		authzURL:    trim(getenv("AUTHZ_URL")),
		authzToken:  strings.TrimSpace(getenv("AUTHZ_TOKEN")),
		grantTTL:    5 * time.Second,
		liveAPI:     trim(getenv("LIVE_API_URL")),
		liveAPIKey:  strings.TrimSpace(getenv("LIVE_API_KEY")),
		liveSecret:  strings.TrimSpace(getenv("LIVE_TOKEN_SECRET")),
		livePublic:  strings.TrimSpace(getenv("LIVE_PUBLIC_URL")),
	}
	if c.port == "" {
		c.port = "8108"
	}
	var err error
	if c.origins, err = parseOrigins(getenv("CORS_ORIGINS")); err != nil {
		return c, err
	}
	if c.databaseURL == "" || c.jwksURL == "" || c.authzURL == "" {
		return c, errors.New("set DATABASE_URL, AUTH_JWKS_URL and AUTHZ_URL")
	}
	if len(c.authzToken) < 32 {
		return c, errors.New("AUTHZ_TOKEN must be at least 32 characters: this service's token in authz's AUTHZ_TOKENS (messaging=...)")
	}
	if c.liveAPI != "" && (len(c.liveAPIKey) < 32 || len(c.liveSecret) < 32 || c.livePublic == "") {
		return c, errors.New("with LIVE_API_URL set, LIVE_API_KEY and LIVE_TOKEN_SECRET need at least 32 characters each and LIVE_PUBLIC_URL must be set")
	}
	return c, nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8108"
	}
	// "service health" is the container's health check: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "health" {
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
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stopAll := context.WithCancel(context.Background())
	defer stopAll()
	log.Print("INFO opening the messaging database and applying migrations")
	st, err := openStore(ctx, cfg.databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer st.close()
	if cfg.liveAPI == "" {
		log.Print("WARN LIVE_API_URL is not set: messages are saved, but nobody is told about them live")
	}
	s := &server{cfg: cfg, keys: authverify.NewKeyset(cfg.jwksURL), rules: newAuthz(cfg.authzURL, cfg.authzToken, cfg.grantTTL), st: st, live: newLive(cfg), now: time.Now}
	go s.deliver(ctx)
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Minute, WriteTimeout: time.Minute, IdleTimeout: 2 * time.Minute}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		stopAll()
		sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Printf("[START] Caller Whale messaging | Listening on port %s\n", cfg.port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
