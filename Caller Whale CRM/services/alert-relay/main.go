// alert-relay passes Grafana's alerts to people's phones (build step 42, D300, D301). Grafana sends each alert here by webhook; an
// urgent one (calls, texts or sign-in down) goes to whoever is on call this week, and to the other person too when that push fails;
// a routine one goes to everyone (Grafana holds routine alerts at night). Pushes go to ntfy topics (ntfy is open source: the ntfy
// app on each phone subscribes to its person's secret topic). It runs on the monitoring resource's private network only.
//
// Settings: RELAY_TOKEN (32+ characters; Grafana's contact points send it), PUSH_TARGETS ("owner=https://ntfy.sh/<topic>,
// cofounder=https://ntfy.sh/<topic>"), ONCALL_ORDER ("owner,cofounder": whose week comes first), ONCALL_FROM (the Monday the
// first person's week starts, 2026-11-23), ALERTS_URL (the link sent with each alert, Grafana's alert list), PORT (8121).
package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
	"unicode"
)

type config struct {
	port, token, alertsURL string
	targets                map[string]string // person -> push URL
	order                  []string
	from                   time.Time
}

func loadConfig(getenv func(string) string) (config, error) {
	c := config{port: strings.TrimSpace(getenv("PORT")), token: strings.TrimSpace(getenv("RELAY_TOKEN")), alertsURL: strings.TrimSpace(getenv("ALERTS_URL")), targets: map[string]string{}}
	if c.port == "" {
		c.port = "8121"
	}
	if len(c.token) < 32 {
		return c, errors.New("RELAY_TOKEN needs at least 32 characters")
	}
	for _, pair := range strings.Split(getenv("PUSH_TARGETS"), ",") {
		name, url, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok {
			continue
		}
		if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
			return c, fmt.Errorf("PUSH_TARGETS: %s's address must start with https://", name)
		}
		c.targets[strings.TrimSpace(name)] = strings.TrimSpace(url)
	}
	if len(c.targets) == 0 {
		return c, errors.New("set PUSH_TARGETS, like owner=https://ntfy.sh/<topic>,cofounder=https://ntfy.sh/<topic>")
	}
	for _, name := range strings.Split(getenv("ONCALL_ORDER"), ",") {
		if name = strings.TrimSpace(name); name != "" {
			if _, ok := c.targets[name]; !ok {
				return c, fmt.Errorf("ONCALL_ORDER names %s, who has no PUSH_TARGETS address", name)
			}
			c.order = append(c.order, name)
		}
	}
	if len(c.order) == 0 {
		for name := range c.targets {
			c.order = append(c.order, name)
		}
		slices.Sort(c.order)
	}
	from := strings.TrimSpace(getenv("ONCALL_FROM"))
	if from == "" {
		from = "2026-11-23"
	}
	var err error
	if c.from, err = time.Parse("2006-01-02", from); err != nil {
		return c, errors.New("ONCALL_FROM is a date like 2026-11-23")
	}
	return c, nil
}

// onCall is whose week it is: the order repeats a week at a time from ONCALL_FROM.
func (c config) onCall(now time.Time) string {
	weeks := int(now.Sub(c.from).Hours() / (24 * 7))
	if now.Before(c.from) {
		weeks--
	}
	n := len(c.order)
	return c.order[((weeks%n)+n)%n]
}

type server struct {
	cfg  config
	http *http.Client
	now  func() time.Time
}

// grafanaMessage is the part of Grafana's webhook this relay reads.
type grafanaMessage struct {
	Status string `json:"status"`
	Alerts []struct {
		Status      string            `json:"status"`
		Labels      map[string]string `json:"labels"`
		Annotations map[string]string `json:"annotations"`
	} `json:"alerts"`
}

func plain(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	if r := []rune(s); len(r) > n {
		s = string(r[:n]) + "…"
	}
	return strings.TrimSpace(s)
}

// ascii keeps a header value to plain characters (ntfy reads titles from a header).
func ascii(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r > 126 {
			return -1
		}
		return r
	}, s)
}

func (s *server) push(url, title, body string, urgent bool) error {
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return err
	}
	priority := "3"
	if urgent {
		priority = "5"
	}
	req.Header.Set("Title", ascii(title))
	req.Header.Set("Priority", priority)
	req.Header.Set("Tags", map[bool]string{true: "rotating_light", false: "warning"}[urgent])
	if s.cfg.alertsURL != "" {
		req.Header.Set("Click", s.cfg.alertsURL)
	}
	res, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("push answered %s", res.Status)
	}
	return nil
}

// alerts is POST /alerts?level=urgent|routine, Grafana's webhook.
func (s *server) alerts(w http.ResponseWriter, r *http.Request) {
	given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(given), []byte(s.cfg.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var msg grafanaMessage
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&msg); err != nil {
		http.Error(w, "not a Grafana alert", http.StatusBadRequest)
		return
	}
	urgent := r.URL.Query().Get("level") == "urgent"
	var lines []string
	firing := 0
	for _, a := range msg.Alerts {
		text := a.Annotations["summary"]
		if text == "" {
			text = a.Labels["alertname"]
		}
		if a.Status == "resolved" {
			text = "Fixed: " + text
		} else {
			firing++
		}
		lines = append(lines, plain(text, 300))
	}
	if len(lines) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	title := "Caller Whale: " + lines[0]
	if len(lines) > 1 {
		title = fmt.Sprintf("Caller Whale: %d alerts", len(lines))
	}
	if firing == 0 {
		urgent = false // a fix never wakes anyone
	}
	body := strings.Join(lines, "\n")
	var who []string
	if urgent {
		first := s.cfg.onCall(s.now())
		who = append(who, first)
		for _, other := range s.cfg.order {
			if other != first {
				who = append(who, other) // only if the first push fails
			}
		}
	} else {
		who = s.cfg.order
	}
	sent := 0
	for _, person := range who {
		if err := s.push(s.cfg.targets[person], plain(title, 120), body, urgent); err != nil {
			log.Printf("WARN alert push to %s: %v", person, err)
			continue
		}
		sent++
		if urgent {
			break
		}
	}
	if sent == 0 {
		http.Error(w, "no push went through", http.StatusBadGateway) // Grafana tries again
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"alert-relay"}`))
	})
	mux.HandleFunc("POST /alerts", s.alerts)
	return mux
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "health" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8121"
		}
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
	s := &server{cfg: cfg, http: &http.Client{Timeout: 10 * time.Second}, now: time.Now}
	log.Printf("INFO alert relay on port %s; on call this week: %s", cfg.port, cfg.onCall(time.Now()))
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
