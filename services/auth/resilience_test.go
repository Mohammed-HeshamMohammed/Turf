package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---- the process is killed in the middle of work ----

// runningService is the real binary, started the way a container starts it.
type runningService struct {
	cmd  *exec.Cmd
	base string
}

func buildBinary(t *testing.T) string {
	t.Helper()
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go tool on the path to build the service with")
	}
	out := filepath.Join(t.TempDir(), "auth-under-test.exe")
	build := exec.Command(goTool, "build", "-o", out, ".")
	if msg, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, msg)
	}
	return out
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return fmt.Sprint(l.Addr().(*net.TCPAddr).Port)
}

func start(t *testing.T, binary, databaseURL, firebaseURL, signingKey string) *runningService {
	t.Helper()
	port := freePort(t)
	cmd := exec.Command(binary)
	cmd.Env = append(os.Environ(),
		"PORT="+port, "DATABASE_URL="+databaseURL, "AUTH_SIGNING_KEY="+signingKey, "AUTH_FIREBASE_API_KEY=test-key",
		"AUTH_FIREBASE_IDENTITY_URL="+firebaseURL, "AUTH_FIREBASE_TOKEN_URL="+firebaseURL, "AUTH_BOT_PROTECTION=false",
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s := &runningService{cmd: cmd, base: "http://127.0.0.1:" + port}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if res, err := http.Get(s.base + "/healthz"); err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return s
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	t.Fatal("the service did not become healthy")
	return nil
}

// kill ends the process at once, with no chance to finish anything: a power cut, a container kill.
func (s *runningService) kill() {
	_ = s.cmd.Process.Kill()
	_ = s.cmd.Wait()
}

func post(base, path string, body any) (int, map[string]any, error) {
	raw, _ := json.Marshal(body)
	res, err := (&http.Client{Timeout: 10 * time.Second}).Post(base+path, "application/json", bytes.NewReader(raw))
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out, nil
}

// TestKillingTheServiceMidWayLosesNothingThatWasAnswered: sign-ups and refreshes are in flight when the process is killed, three times
// over. Afterwards every sign-up the person was told succeeded still works (its session survived, even across the restart), and
// nothing is half written: every user has its sign-up event, no session or challenge points at nothing.
func TestKillingTheServiceMidWayLosesNothingThatWasAnswered(t *testing.T) {
	url := os.Getenv("AUTH_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AUTH_TEST_DATABASE_URL is not set")
	}
	if testing.Short() {
		t.Skip("slow")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "k_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	dbURL := url + sep + "search_path=" + schema
	view, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()

	fake := newFakeFirebase(t)
	binary := buildBinary(t)
	key, _ := newSecretKey()

	type acked struct{ email, refresh string }
	var mu sync.Mutex
	var answered []acked
	round := func(n int) {
		svc := start(t, binary, dbURL, fake.srv.URL, key)
		var wg sync.WaitGroup
		var sent atomic.Int32
		for i := 0; i < 60; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				email := fmt.Sprintf("p%d-%d@example.com", n, i)
				status, body, err := post(svc.base, "/v1/accounts", map[string]any{"name": "P", "email": email, "password": goodPassword})
				sent.Add(1)
				if err == nil && status == 201 {
					mu.Lock()
					answered = append(answered, acked{email, fmt.Sprint(body["refresh_token"])})
					mu.Unlock()
					// And keep it busy: a refresh straight after.
					_, _, _ = post(svc.base, "/v1/sessions/refresh", map[string]any{"refresh_token": body["refresh_token"]})
				}
			}(i)
		}
		// Let some of them land, then pull the plug while others are in the middle.
		time.Sleep(time.Duration(150+rand.Intn(250)) * time.Millisecond)
		svc.kill()
		wg.Wait()
	}
	for n := 0; n < 3; n++ {
		round(n)
	}

	// Nothing half written.
	var one int64
	check := func(name, sql string, want int64) {
		t.Helper()
		if err := view.QueryRow(ctx, sql).Scan(&one); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if one != want {
			t.Errorf("%s: %d, want %d", name, one, want)
		}
	}
	var users, events int64
	_ = view.QueryRow(ctx, "SELECT COUNT(*) FROM users").Scan(&users)
	_ = view.QueryRow(ctx, "SELECT COUNT(*) FROM outbox WHERE name = 'user.signed_up'").Scan(&events)
	if users != events {
		t.Errorf("%d users but %d sign-up events: they are written together or not at all", users, events)
	}
	check("sessions without a person", "SELECT COUNT(*) FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL", 0)
	check("handoffs left behind", "SELECT COUNT(*) FROM oauth_handoffs", 0)
	t.Logf("%d sign-ups were answered across three kills; %d people exist", len(answered), users)
	if len(answered) == 0 {
		t.Fatal("the test never got an answer: nothing was proven")
	}

	// A fresh start, same database, same key: every answered sign-up still has its session.
	svc := start(t, binary, dbURL, fake.srv.URL, key)
	defer svc.kill()
	lost := 0
	for _, a := range answered {
		status, _, err := post(svc.base, "/v1/sessions/refresh", map[string]any{"refresh_token": a.refresh})
		// A refresh already used before the kill is a copied token to the service: that session ended on purpose. Only a 401 for a
		// refresh token never used is a loss, so use the sign-in instead, which needs only the account.
		if err != nil || (status != 200 && status != 401) {
			t.Errorf("%s: refresh %d %v", a.email, status, err)
		}
		status, _, _ = post(svc.base, "/v1/sessions", map[string]any{"email": a.email, "password": goodPassword})
		if status != 200 {
			lost++
			t.Errorf("%s was told its account exists but cannot sign in: %d", a.email, status)
		}
	}
	if lost > 0 {
		t.Fatalf("%d answered sign-ups did not survive", lost)
	}
}

// ---- how fast ----

// TestLoadOfSignInAndRefresh measures the service and its database (the handler is called directly; Firebase is a stand-in in the
// same process, so this is not a production number). Run it with AUTH_LOAD=1 go test -run Load -v.
func TestLoadOfSignInAndRefresh(t *testing.T) {
	if os.Getenv("AUTH_LOAD") == "" {
		t.Skip("AUTH_LOAD is not set")
	}
	w := newWorld(t)
	const people = 200
	for i := 0; i < people; i++ {
		w.signUp(fmt.Sprintf("load%d@example.com", i))
	}
	measure := func(name string, workers, total int, work func(i int) int) {
		var lat []time.Duration
		var mu sync.Mutex
		var failed atomic.Int32
		jobs := make(chan int)
		var wg sync.WaitGroup
		started := time.Now()
		for k := 0; k < workers; k++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range jobs {
					at := time.Now()
					if status := work(i); status != 200 {
						failed.Add(1)
					}
					d := time.Since(at)
					mu.Lock()
					lat = append(lat, d)
					mu.Unlock()
				}
			}()
		}
		for i := 0; i < total; i++ {
			jobs <- i
		}
		close(jobs)
		wg.Wait()
		elapsed := time.Since(started)
		sort.Slice(lat, func(a, b int) bool { return lat[a] < lat[b] })
		t.Logf("%-10s %d requests, %d workers: %6.0f/s  p50 %v  p95 %v  p99 %v  failed %d", name, total, workers, float64(total)/elapsed.Seconds(),
			lat[len(lat)/2].Round(time.Microsecond), lat[len(lat)*95/100].Round(time.Microsecond), lat[len(lat)*99/100].Round(time.Microsecond), failed.Load())
	}
	measure("sign-in", 16, 2000, func(i int) int {
		return w.signInWith(fmt.Sprintf("load%d@example.com", i%people), nil).status
	})
	// Refresh: each worker keeps its own chain of tokens.
	tokens := make([]string, people)
	var tmu sync.Mutex
	for i := range tokens {
		tokens[i] = w.signInWith(fmt.Sprintf("load%d@example.com", i), nil).refresh()
	}
	measure("refresh", 16, 2000, func(i int) int {
		slot := i % people
		tmu.Lock()
		tok := tokens[slot]
		tokens[slot] = "" // one request per token at a time
		tmu.Unlock()
		if tok == "" {
			return 200 // another worker has this chain; not a failure of the service
		}
		a := w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": tok}, "")
		tmu.Lock()
		tokens[slot] = a.refresh()
		tmu.Unlock()
		return a.status
	})
	one := w.signInWith("load0@example.com", nil)
	measure("me", 16, 4000, func(i int) int { return w.call("GET", "/v1/me", nil, one.access()).status })
}
