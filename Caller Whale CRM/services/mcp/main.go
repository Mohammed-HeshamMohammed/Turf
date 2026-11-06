// MCP: the one address (https://mcp.callerwhale.com) an AI assistant such as Claude, ChatGPT or Gemini is connected to. It speaks the
// Model Context Protocol over HTTPS, asks the auth service who each access token belongs to, and runs the few tools that person has
// allowed. It holds no data of its own and no secrets of the person's: only a shared secret for asking auth (docs/plans/ai-connectors.md).
package main

import (
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
	port       string
	publicURL  string // this service's public address, the "resource" assistants connect to
	authPublic string // the auth service's public address, where assistants send people to sign in
	authURL    string // the auth service's private address, for asking who a token belongs to
	authToken  string // shared secret for those questions (AUTH_MCP_TOKEN on the auth service)
}

func loadConfig(getenv func(string) string) (config, error) {
	trim := func(v string) string { return strings.TrimRight(strings.TrimSpace(v), "/") }
	c := config{
		port:       strings.TrimSpace(getenv("PORT")),
		publicURL:  trim(getenv("MCP_PUBLIC_URL")),
		authPublic: trim(getenv("MCP_AUTH_PUBLIC_URL")),
		authURL:    trim(getenv("MCP_AUTH_URL")),
		authToken:  strings.TrimSpace(getenv("MCP_AUTH_TOKEN")),
	}
	if c.port == "" {
		c.port = "8106"
	}
	if c.publicURL == "" || c.authPublic == "" || c.authURL == "" {
		return c, errors.New("set MCP_PUBLIC_URL, MCP_AUTH_PUBLIC_URL and MCP_AUTH_URL")
	}
	if len(c.authToken) < 32 {
		return c, errors.New("MCP_AUTH_TOKEN must be at least 32 characters, and the same as AUTH_MCP_TOKEN on the auth service")
	}
	return c, nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8106"
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
	srv := &http.Server{Addr: ":" + cfg.port, Handler: newServer(cfg, http.DefaultClient).handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	fmt.Printf("[START] Caller Whale MCP | Listening on port %s\n", cfg.port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
