package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type phone struct {
	mu     sync.Mutex
	got    []string
	titles []string
	prio   []string
	down   bool
}

func (p *phone) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.down {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	b, _ := io.ReadAll(r.Body)
	p.got, p.titles, p.prio = append(p.got, string(b)), append(p.titles, r.Header.Get("Title")), append(p.prio, r.Header.Get("Priority"))
}

func (p *phone) count() int { p.mu.Lock(); defer p.mu.Unlock(); return len(p.got) }

const token = "relay-token-relay-token-relay-token-1"

func setup(t *testing.T, now time.Time) (*server, *phone, *phone) {
	owner, cofounder := &phone{}, &phone{}
	a, b := httptest.NewServer(http.HandlerFunc(owner.serve)), httptest.NewServer(http.HandlerFunc(cofounder.serve))
	t.Cleanup(a.Close)
	t.Cleanup(b.Close)
	env := map[string]string{"RELAY_TOKEN": token, "PUSH_TARGETS": "owner=" + a.URL + ",cofounder=" + b.URL, "ONCALL_ORDER": "owner,cofounder", "ONCALL_FROM": "2026-11-23"}
	cfg, err := loadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	return &server{cfg: cfg, http: http.DefaultClient, now: func() time.Time { return now }}, owner, cofounder
}

func send(t *testing.T, s *server, level, body, auth string) int {
	r := httptest.NewRequest("POST", "/alerts?level="+level, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+auth)
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	return w.Code
}

const firing = `{"status":"firing","alerts":[{"status":"firing","labels":{"alertname":"Calls failing","severity":"urgent"},"annotations":{"summary":"Calls are failing"}}]}`

// Step 42, D301: an urgent alert wakes only whoever is on call this week; the other person gets it when that push fails.
func TestUrgentGoesToWhoeverIsOnCall(t *testing.T) {
	s, owner, cofounder := setup(t, time.Date(2026, 11, 25, 3, 0, 0, 0, time.UTC)) // the owner's week
	if code := send(t, s, "urgent", firing, "wrong"); code != 401 {
		t.Fatalf("a stranger: %d", code)
	}
	if code := send(t, s, "urgent", firing, token); code != 204 || owner.count() != 1 || cofounder.count() != 0 || owner.prio[0] != "5" || owner.titles[0] != "Caller Whale: Calls are failing" {
		t.Fatalf("urgent: %d %v %v", code, owner, cofounder)
	}
	s.now = func() time.Time { return time.Date(2026, 12, 1, 3, 0, 0, 0, time.UTC) } // the cofounder's week
	send(t, s, "urgent", firing, token)
	if cofounder.count() != 1 || owner.count() != 1 {
		t.Fatalf("the second week: %d %d", owner.count(), cofounder.count())
	}
	cofounder.down = true
	if code := send(t, s, "urgent", firing, token); code != 204 || owner.count() != 2 {
		t.Fatalf("a failed push passes to the other: %d %d", code, owner.count())
	}
}

// Step 42, D300: a routine alert goes to everyone, never loud; a fix never wakes anyone.
func TestRoutineGoesToEveryone(t *testing.T) {
	s, owner, cofounder := setup(t, time.Date(2026, 11, 25, 3, 0, 0, 0, time.UTC))
	send(t, s, "routine", `{"status":"firing","alerts":[{"status":"firing","labels":{"alertname":"Disk"},"annotations":{"summary":"Disk 90% full"}}]}`, token)
	if owner.count() != 1 || cofounder.count() != 1 || owner.prio[0] != "3" {
		t.Fatalf("routine: %v %v", owner.prio, cofounder.got)
	}
	send(t, s, "urgent", `{"status":"resolved","alerts":[{"status":"resolved","labels":{"alertname":"Calls"},"annotations":{"summary":"Calls are failing"}}]}`, token)
	if owner.count() != 2 || cofounder.count() != 2 || !strings.HasPrefix(owner.got[1], "Fixed:") {
		t.Fatalf("a fix: %v", owner.got)
	}
}

func TestSettings(t *testing.T) {
	if _, err := loadConfig(func(k string) string { return map[string]string{"RELAY_TOKEN": "short"}[k] }); err == nil {
		t.Fatal("a short token")
	}
	if _, err := loadConfig(func(k string) string {
		return map[string]string{"RELAY_TOKEN": token, "PUSH_TARGETS": "owner=https://ntfy.sh/x", "ONCALL_ORDER": "owner,nobody"}[k]
	}); err == nil {
		t.Fatal("an unknown person on call")
	}
}
