package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The database tests need a disposable PostgreSQL: MESSAGING_TEST_ADMIN_URL (a superuser, to reset the schema) and
// MESSAGING_TEST_DATABASE_URL (an ordinary login, as production runs, so row security applies). Without them they are skipped.

type fakeRules struct {
	mu     sync.Mutex
	grants map[string]grantReply // user|org
	roster map[string][]member
}

func (f *fakeRules) grant(_ context.Context, user, org string, _ bool) (grantReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if g, ok := f.grants[user+"|"+org]; ok {
		return g, nil
	}
	return grantReply{Code: "not_member", Reason: "You are not in this workspace."}, nil
}

func (f *fakeRules) members(_ context.Context, org string) ([]member, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.roster[org], nil
}

// join puts people in a workspace as ordinary team members who may use conversations.
func (f *fakeRules) join(org string, users ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range users {
		f.grants[u+"|"+org] = grantReply{Allowed: true, Scopes: []string{"organization"}, Capabilities: []string{"edit", "message"}}
		f.roster[org] = append(f.roster[org], member{UserID: u})
	}
}

// fakeLive stands in for Centrifugo: it keeps what it was told to broadcast, and can be switched off.
type fakeLive struct {
	mu   sync.Mutex
	got  []map[string]any
	down bool
	ts   *httptest.Server
}

func newFakeLive(t *testing.T, key string) *fakeLive {
	f := &fakeLive{}
	f.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.down || r.Header.Get("X-API-Key") != key || r.URL.Path != "/api/broadcast" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.got = append(f.got, body)
		_, _ = w.Write([]byte(`{"result":{}}`))
	}))
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeLive) setDown(down bool) { f.mu.Lock(); f.down = down; f.mu.Unlock() }

func (f *fakeLive) seen() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any{}, f.got...)
}

const (
	testLiveKey    = "test-live-api-key-0123456789abcdef"
	testLiveSecret = "test-live-token-secret-0123456789ab"
)

type env struct {
	t     *testing.T
	s     *server
	ts    *httptest.Server
	fx    verifyFixture
	rules *fakeRules
	live  *fakeLive
	admin *pgx.Conn
}

func newEnv(t *testing.T) *env { return newEnvWith(t, false) }

// newEnvWith runs the service as an ordinary login, or (asSuperuser) as the superuser a platform's own database hands out.
func newEnvWith(t *testing.T, asSuperuser bool) *env {
	t.Helper()
	appURL, adminURL := os.Getenv("MESSAGING_TEST_DATABASE_URL"), os.Getenv("MESSAGING_TEST_ADMIN_URL")
	if appURL == "" || adminURL == "" {
		t.Skip("set MESSAGING_TEST_DATABASE_URL and MESSAGING_TEST_ADMIN_URL to run the database tests")
	}
	if asSuperuser {
		appURL = adminURL
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close(ctx) })
	if _, err = admin.Exec(ctx, `DROP SCHEMA IF EXISTS messaging CASCADE`); err != nil {
		t.Fatal(err)
	}
	st, err := openStore(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.close)

	fx := newVerifyFixture(t)
	jwks := fx.jwks("k1")
	rules := &fakeRules{grants: map[string]grantReply{}, roster: map[string][]member{}}
	fl := newFakeLive(t, testLiveKey)
	cfg := config{databaseURL: appURL, liveAPI: fl.ts.URL + "/api", liveAPIKey: testLiveKey, liveSecret: testLiveSecret, livePublic: "wss://live.example/connection/websocket"}
	s := &server{cfg: cfg, keys: serveVerifyKeys(t, &jwks, nil), rules: rules, st: st, live: newLive(cfg), now: time.Now}
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return &env{t: t, s: s, ts: ts, fx: fx, rules: rules, live: fl, admin: admin}
}

func (e *env) token(user string) string {
	return e.fx.sign("k1", "EdDSA", func(m map[string]any) {
		m["sub"] = user
		m["name"] = "Person " + user[:4]
	})
}

// call makes a signed-in request and returns the status and the decoded JSON body.
func (e *env) call(user, org, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+"/api/v1/messaging"+path, reader)
	req.Header.Set("Authorization", "Bearer "+e.token(user))
	if org != "" {
		req.Header.Set("x-callerwhale-org", org)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// must is call that fails the test unless the status is the one expected.
func (e *env) must(want int, user, org, method, path string, body any) map[string]any {
	e.t.Helper()
	status, out := e.call(user, org, method, path, body)
	if status != want {
		e.t.Fatalf("%s %s as %s: status %d, want %d: %v", method, path, user[:4], status, want, out)
	}
	return out
}

// send posts one message and returns it as saved.
func (e *env) send(user, org, conversation, text string) map[string]any {
	e.t.Helper()
	return e.must(201, user, org, "POST", "/conversations/"+conversation+"/messages", map[string]any{"id": newID(), "body": text})["message"].(map[string]any)
}

// conversation finds one conversation in the person's list.
func (e *env) conversation(user, org, id string) map[string]any {
	e.t.Helper()
	for _, c := range e.must(200, user, org, "GET", "/conversations", nil)["conversations"].([]any) {
		if c.(map[string]any)["id"] == id {
			return c.(map[string]any)
		}
	}
	return nil
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
