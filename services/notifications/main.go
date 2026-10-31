// Notification service. Everything Caller Whale sends to a person goes out from here: the mail server login and the email
// templates live in this service only. Other services call POST /v1/mail with a service token (NOTIFY_TOKENS).
package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	service = "notifications"
	version = "0.2.0"
	// A caller may ask for this many emails a minute: a sign-in code or an invitation is one request each.
	perMinute = 60
	maxBody   = 16 * 1024
)

// Config is read from the environment only; nothing about the mail server or the callers is written in the code.
type Config struct {
	// Tokens maps a caller's name to its token ("auth=...,core-api=..."), each at least 24 characters.
	Tokens map[string]string
	SMTP   SMTP
}

func loadConfig() Config {
	cfg := Config{Tokens: map[string]string{}}
	for _, pair := range strings.Split(os.Getenv("NOTIFY_TOKENS"), ",") {
		name, token, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if ok && name != "" && len(token) >= 24 {
			cfg.Tokens[name] = token
		}
	}
	port := strings.TrimSpace(os.Getenv("NOTIFY_SMTP_PORT"))
	if port == "" {
		port = "587"
	}
	cfg.SMTP = SMTP{
		Host:     strings.TrimSpace(os.Getenv("NOTIFY_SMTP_HOST")),
		Port:     port,
		User:     strings.TrimSpace(os.Getenv("NOTIFY_SMTP_USER")),
		Password: os.Getenv("NOTIFY_SMTP_PASSWORD"),
		From:     strings.TrimSpace(os.Getenv("NOTIFY_MAIL_FROM")),
	}
	return cfg
}

// Server is the HTTP side: who may ask, how often, and which sender delivers.
type Server struct {
	tokens     map[string]string
	sender     Sender
	configured bool
	now        func() time.Time
	mu         sync.Mutex
	window     map[string][]time.Time
}

func newServer(tokens map[string]string, sender Sender, configured bool) *Server {
	return &Server{tokens: tokens, sender: sender, configured: configured, now: time.Now, window: map[string][]time.Time{}}
}

func newMux() *http.ServeMux { return newServer(nil, nil, false).mux() }

func (s *Server) mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": service})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": service, "version": version})
	})
	mux.HandleFunc("POST /v1/mail", s.mail)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found."})
	})
	return mux
}

// caller returns the name of the service whose token this request carries.
func (s *Server) caller(r *http.Request) (string, bool) {
	given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if given == "" || given == r.Header.Get("Authorization") {
		return "", false
	}
	found := ""
	for name, token := range s.tokens {
		if subtle.ConstantTimeCompare([]byte(given), []byte(token)) == 1 {
			found = name
		}
	}
	return found, found != ""
}

func (s *Server) allow(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	kept := s.window[name][:0]
	for _, t := range s.window[name] {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	if len(kept) >= perMinute {
		s.window[name] = kept
		return false
	}
	s.window[name] = append(kept, now)
	return true
}

type mailRequest struct {
	Template string         `json:"template"`
	To       string         `json:"to"`
	Data     map[string]any `json:"data"`
}

func (s *Server) mail(w http.ResponseWriter, r *http.Request) {
	name, ok := s.caller(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "A service token is needed."})
		return
	}
	if !s.allow(name) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Too many requests."})
		return
	}
	if !s.configured || s.sender == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No mail server is set up (NOTIFY_SMTP_HOST and NOTIFY_MAIL_FROM)."})
		return
	}
	var req mailRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Send JSON."})
		return
	}
	msg, err := Render(req.Template, strings.TrimSpace(req.To), req.Data)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if err := s.sender.Send(msg); err != nil {
		// The reason is for this service's log; the caller only learns that the mail server did not take it.
		log.Printf("mail %q for %s not sent: %v", req.Template, name, err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "The mail server did not accept the message."})
		return
	}
	log.Printf("mail %q sent for %s", req.Template, name)
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8102"
	}
	// "service health" is the container's health check: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "health" {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	cfg := loadConfig()
	if len(cfg.Tokens) == 0 {
		log.Print("NOTIFY_TOKENS is empty: no service can send mail yet")
	}
	if !cfg.SMTP.Configured() {
		log.Print("NOTIFY_SMTP_HOST or NOTIFY_MAIL_FROM is empty: mail requests answer 503 until they are set")
	}
	srv := newServer(cfg.Tokens, cfg.SMTP, cfg.SMTP.Configured())
	log.Printf("%s listening on :%s", service, port)
	log.Fatal((&http.Server{Addr: ":" + port, Handler: srv.mux(), ReadHeaderTimeout: 5 * time.Second}).ListenAndServe())
}
