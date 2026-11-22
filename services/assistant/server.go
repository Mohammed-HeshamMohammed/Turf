package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

var version = "dev"

// counter allows at most `max` events per key in a sliding window. It lives in memory: with more than one copy of the service each
// copy counts its own visitors, which only makes the limits looser, never stricter.
// ponytail: per-copy counts; move them to Redis if the service is ever scaled out and the limits must be exact.
type counter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	hits   map[string][]time.Time
}

func newCounter(window time.Duration, max int) *counter {
	return &counter{window: window, max: max, hits: map[string][]time.Time{}}
}

func (c *counter) allow(key string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	recent := c.hits[key][:0]
	for _, t := range c.hits[key] {
		if now.Sub(t) < c.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= c.max {
		c.hits[key] = recent
		return false
	}
	c.hits[key] = append(recent, now)
	if len(c.hits) > 50000 { // forget visitors who have gone quiet
		for k, v := range c.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > c.window {
				delete(c.hits, k)
			}
		}
	}
	return true
}

type server struct {
	ai      *ai
	origins map[string]bool
	now     func() time.Time
	perMin  *counter // every message, scripted or not
	aiPerIP *counter // AI answers per visitor per day
	aiAll   *counter // AI answers for everyone per day: the bill has a ceiling
	// AGENT_TOKEN: the CRM's and the dialer's key to the in-app assistant; empty turns it off.
	agentToken string
}

func parseOrigins(text string) (map[string]bool, error) {
	origins := map[string]bool{}
	for _, item := range strings.Split(text, ",") {
		if item = strings.TrimSpace(item); item == "" {
			continue
		}
		u, err := url.Parse(item)
		if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || item != u.Scheme+"://"+u.Host {
			return nil, fmt.Errorf("CORS_ORIGINS: %q is not an origin like https://callerwhale.com", item)
		}
		origins[item] = true
	}
	return origins, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, text string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": text}})
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "assistant"})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": "assistant", "version": version, "ai": s.ai.enabled()})
	})
	mux.HandleFunc("POST /v1/chat", s.chat)
	mux.HandleFunc("POST /v1/agent/complete", s.agentComplete)
	return s.cors(mux)
}

// cors lets pages on the listed origins (the Caller Whale site) call this service from a browser; the gateway passes preflights on.
func (s *server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && s.origins[origin] {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "content-type")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// visitor is the address the request came from: the gateway puts the real one first in X-Forwarded-For.
func visitor(r *http.Request) string {
	if first := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); net.ParseIP(first) != nil {
		return first
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

var knownPages = []string{"/", "/pricing", "/features", "/security", "/contact", "/signup", "/signin", "/why-caller-whale"}

type chatRequest struct {
	Messages []message `json:"messages"`
	Page     string    `json:"page"`
}

const (
	maxMessages = 12
	maxChars    = 600
)

func (s *server) chat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "Send a conversation as JSON.")
		return
	}
	if n := len(req.Messages); n == 0 || n > maxMessages || req.Messages[n-1].Role != "user" {
		fail(w, http.StatusBadRequest, "Send between 1 and 12 messages, the last one from the visitor.")
		return
	}
	for i := range req.Messages {
		m := &req.Messages[i]
		m.Content = strings.TrimSpace(m.Content)
		if (m.Role != "user" && m.Role != "assistant") || m.Content == "" || len([]rune(m.Content)) > maxChars {
			fail(w, http.StatusBadRequest, "Each message needs a role and up to 600 characters.")
			return
		}
	}
	page := "/"
	if slices.Contains(knownPages, req.Page) {
		page = req.Page
	}
	now, who := s.now(), visitor(r)
	if !s.perMin.allow(who, now) {
		w.Header().Set("Retry-After", "30")
		fail(w, http.StatusTooManyRequests, "That is a lot of messages at once. Give me a moment.")
		return
	}

	if a, ok := scripted(req.Messages); ok {
		log.Printf("chat scripted page=%s", page)
		writeJSON(w, http.StatusOK, map[string]any{"source": "scripted", "answer": a})
		return
	}
	if s.ai.enabled() && s.aiPerIP.allow(who, now) && s.aiAll.allow("all", now) {
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		reply, err := s.ai.ask(ctx, req.Messages, page)
		if err == nil {
			log.Printf("chat ai page=%s", page)
			writeJSON(w, http.StatusOK, map[string]any{"source": "ai", "answer": answer{Reply: reply, Suggestions: nudges(page)}})
			return
		}
		log.Printf("WARN the AI failed, answering from the script: %v", err)
	}
	log.Printf("chat fallback page=%s", page)
	writeJSON(w, http.StatusOK, map[string]any{"source": "scripted", "answer": fallback})
}

// nudges are the follow-up buttons under an AI answer: where this page's visitors usually go next.
func nudges(page string) []string {
	if page == "/pricing" {
		return []string{startPlans, "What is in Pro?"}
	}
	return []string{startPlans, "Is there a free trial?"}
}
