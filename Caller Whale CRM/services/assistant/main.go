// assistant: the helper chat on the Caller Whale website. Common questions are answered from a written script (free and always the
// same); the rest go to an AI through OpenRouter, within strict limits. It keeps no data: the conversation lives in the visitor's browser.
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

func number(getenv func(string) string, name string, fallback int) (int, error) {
	v := strings.TrimSpace(getenv(name))
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a whole number", name)
	}
	return n, nil
}

func build(getenv func(string) string) (*server, string, error) {
	origins, err := parseOrigins(getenv("CORS_ORIGINS"))
	if err != nil {
		return nil, "", err
	}
	perIP, err := number(getenv, "ASSISTANT_AI_PER_VISITOR_PER_DAY", 30)
	if err != nil {
		return nil, "", err
	}
	all, err := number(getenv, "ASSISTANT_AI_PER_DAY", 2000)
	if err != nil {
		return nil, "", err
	}
	perMin, err := number(getenv, "ASSISTANT_MESSAGES_PER_MINUTE", 12)
	if err != nil {
		return nil, "", err
	}
	site := strings.TrimRight(strings.TrimSpace(getenv("SITE_URL")), "/")
	if site == "" {
		site = "https://callerwhale.com"
	}
	endpoint := strings.TrimSpace(getenv("OPENROUTER_URL"))
	if endpoint == "" {
		endpoint = "https://openrouter.ai/api/v1/chat/completions"
	}
	model := strings.TrimSpace(getenv("OPENROUTER_MODEL"))
	if model == "" {
		model = "openai/gpt-4o-mini"
	}
	port := strings.TrimSpace(getenv("PORT"))
	if port == "" {
		port = "8109"
	}
	s := &server{
		ai: newAI(endpoint, strings.TrimSpace(getenv("OPENROUTER_API_KEY")), model, site), origins: origins, now: time.Now,
		perMin: newCounter(time.Minute, perMin), aiPerIP: newCounter(24*time.Hour, perIP), aiAll: newCounter(24*time.Hour, all),
	}
	return s, port, nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8109"
	}
	// "service health" is the container's health check: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "health" {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	s, port, err := build(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	if !s.ai.enabled() {
		log.Printf("WARN OPENROUTER_API_KEY is not set: the assistant answers from its script only")
	}
	srv := &http.Server{Addr: ":" + port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	fmt.Printf("[START] Caller Whale assistant | Listening on port %s\n", port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
