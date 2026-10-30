package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeAPI struct {
	mu        sync.Mutex
	pending   []Event
	processed []int64
	failOnce  map[int64]bool
	ticks     int
	tokens    []string
}

func (f *fakeAPI) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.tokens = append(f.tokens, r.Header.Get("Authorization"))
		switch {
		case r.URL.Path == "/internal/events/claim":
			batch := f.pending
			f.pending = nil
			json.NewEncoder(rw).Encode(map[string]any{"events": batch})
		case strings.HasPrefix(r.URL.Path, "/internal/events/") && strings.HasSuffix(r.URL.Path, "/process"):
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["org_id"] == "" {
				t.Errorf("process without org_id")
			}
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/internal/events/"), "/process")
			var n int64
			for _, c := range id {
				n = n*10 + int64(c-'0')
			}
			if f.failOnce[n] {
				delete(f.failOnce, n)
				rw.WriteHeader(http.StatusInternalServerError)
				io.WriteString(rw, `{"error":{"code":"internal"}}`)
				return
			}
			f.processed = append(f.processed, n)
			io.WriteString(rw, `{"runs":[]}`)
		case r.URL.Path == "/internal/scheduler/tick":
			f.ticks++
			io.WriteString(rw, `{"overdue_tasks":0}`)
		default:
			rw.WriteHeader(http.StatusNotFound)
		}
	})
}

func newWorker(base string) *Worker {
	return &Worker{
		API:    &Client{Base: base, Token: "token-token-token-token-1"},
		Config: Config{Batch: 50, Concurrency: 3, Idle: 10 * time.Millisecond, TickEvery: 20 * time.Millisecond, LeaseSeconds: 60},
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestEventsOfOneLeadStayInOrderAndFailuresAreCounted(t *testing.T) {
	api := &fakeAPI{failOnce: map[int64]bool{5: true}}
	for i := int64(1); i <= 6; i++ {
		lead := "lead-a"
		if i%2 == 0 {
			lead = "lead-b"
		}
		api.pending = append(api.pending, Event{ID: i, OrgID: "org", Kind: "lead.updated", LeadID: lead})
	}
	server := httptest.NewServer(api.handler(t))
	defer server.Close()
	w := newWorker(server.URL)
	count, err := w.ProcessBatch(context.Background())
	if err != nil || count != 6 {
		t.Fatalf("count %d err %v", count, err)
	}
	position := map[int64]int{}
	for i, id := range api.processed {
		position[id] = i
	}
	// lead-a: 1, 3, (5 failed) ; lead-b: 2, 4, 6 — each lane in order.
	if !(position[1] < position[3] && position[2] < position[4] && position[4] < position[6]) {
		t.Fatalf("order not kept per lead: %v", api.processed)
	}
	if _, done := position[5]; done || w.Stats.Failed.Load() != 1 || w.Stats.Processed.Load() != 5 {
		t.Fatalf("failure handling: processed=%v failed=%d", api.processed, w.Stats.Failed.Load())
	}
	for _, token := range api.tokens {
		if token != "Worker token-token-token-token-1" {
			t.Fatalf("token header %q", token)
		}
	}
}

func TestRunTicksAndStopsCleanly(t *testing.T) {
	api := &fakeAPI{}
	server := httptest.NewServer(api.handler(t))
	defer server.Close()
	w := newWorker(server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not stop after its context ended")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.ticks < 2 {
		t.Fatalf("expected repeated scheduler ticks, got %d", api.ticks)
	}
}

func TestAPIErrorsAreReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(http.StatusUnauthorized)
		io.WriteString(rw, `{"error":{"code":"unauthenticated"}}`)
	}))
	defer server.Close()
	_, err := newWorker(server.URL).ProcessBatch(context.Background())
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 401 {
		t.Fatalf("expected a 401 APIError, got %v", err)
	}
}

func TestRedisPublishSpeaksRESP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	got := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		var lines []string
		for len(lines) < 7 {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			lines = append(lines, strings.TrimRight(line, "\r\n"))
		}
		conn.Write([]byte(":1\r\n"))
		got <- strings.Join(lines, "|")
	}()
	r := &Redis{Addr: listener.Addr().String()}
	if err := r.Publish(context.Background(), "callerwhale:invalidate", "org lead x"); err != nil {
		t.Fatal(err)
	}
	if line := <-got; line != "*3|$7|PUBLISH|$15|callerwhale:invalidate|$10|org lead x" {
		t.Fatalf("wire format %q", line)
	}
}
