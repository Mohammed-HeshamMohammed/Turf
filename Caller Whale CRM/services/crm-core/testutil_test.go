package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The integration tests need a disposable PostgreSQL: CRM_TEST_ADMIN_URL (a superuser, to reset the schemas) and
// CRM_TEST_DATABASE_URL (an ordinary login, as production runs, so row security applies). Without them they are skipped.

type fakeRules struct {
	mu      sync.Mutex
	people_ map[string]peopleReply
	grants  map[string]grantReply // user|org
	roster  map[string][]member
	opened  []string
	down    bool
}

func (f *fakeRules) people(_ context.Context, user string) (peopleReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		return peopleReply{}, errUnavailable
	}
	return f.people_[user], nil
}

func (f *fakeRules) grant(_ context.Context, user, org string, _ bool) (grantReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		return grantReply{}, errUnavailable
	}
	if g, ok := f.grants[user+"|"+org]; ok {
		return g, nil
	}
	return grantReply{Code: "not_member", Reason: "You are not in this workspace."}, nil
}

func (f *fakeRules) open(_ context.Context, org, user, role string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opened = append(f.opened, org+"|"+user+"|"+role)
	p := f.people_[user]
	p.Workspaces = append(p.Workspaces, workspaceRoles{OrgID: org, Roles: []string{role}, BusinessOwner: true})
	f.people_[user] = p
	f.grants[user+"|"+org] = owner()
	return nil
}

func (f *fakeRules) members(_ context.Context, org string) ([]member, error) {
	return f.roster[org], nil
}

var everything = []string{"edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin", "review", "publicComment"}

func owner() grantReply {
	return grantReply{Allowed: true, Scopes: []string{"organization"}, Capabilities: everything}
}

type env struct {
	t     *testing.T
	s     *server
	ts    *httptest.Server
	fx    verifyFixture
	rules *fakeRules
	admin *pgx.Conn
}

func newEnv(t *testing.T) *env {
	t.Helper()
	appURL, adminURL := os.Getenv("CRM_TEST_DATABASE_URL"), os.Getenv("CRM_TEST_ADMIN_URL")
	if appURL == "" || adminURL == "" {
		t.Skip("set CRM_TEST_DATABASE_URL and CRM_TEST_ADMIN_URL to run the database tests")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close(ctx) })
	if _, err = admin.Exec(ctx, `DROP SCHEMA IF EXISTS crm CASCADE; DROP SCHEMA IF EXISTS importing CASCADE`); err != nil {
		t.Fatal(err)
	}
	st, err := openStore(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.close)

	fx := newVerifyFixture(t)
	jwks := fx.jwks("k1")
	rules := &fakeRules{people_: map[string]peopleReply{}, grants: map[string]grantReply{}, roster: map[string][]member{}}
	s := &server{cfg: config{}, keys: serveVerifyKeys(t, &jwks, nil), rules: rules, st: st, hub: newHub(), now: time.Now}
	hubCtx, stop := context.WithCancel(ctx)
	t.Cleanup(stop)
	go s.hub.listen(hubCtx, appURL)
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return &env{t: t, s: s, ts: ts, fx: fx, rules: rules, admin: admin}
}

func (e *env) token(user string) string {
	return e.fx.sign("k1", "EdDSA", func(m map[string]any) {
		m["sub"] = user
		m["name"] = "Person " + user[:4]
		m["email"] = user[:4] + "@example.com"
	})
}

// call makes a signed-in request and returns the status and the decoded JSON body.
// startImport seeds an upload owned by the worker, so Core's SQL mapping and
// merge tests do not depend on Core accepting file uploads.
func (e *env) startImport(user, org string, body map[string]any) (int, map[string]any) {
	e.t.Helper()
	name, _ := body["name"].(string)
	if name == "" {
		name = "Imported list"
	}
	status, project := e.call(user, org, "POST", "/api/v1/projects", map[string]any{"name": name})
	if status != 200 {
		e.t.Fatalf("create source list: %d %v", status, project)
	}
	filename, _ := body["filename"].(string)
	size, _ := body["size"].(int)
	var id string
	err := e.admin.QueryRow(context.Background(), `INSERT INTO importing.jobs
		(org_id, user_id, project_id, name, filename, size, chunk_size, total_chunks)
		VALUES ($1, $2, $3, $4, $5, $6, 8388608, 1) RETURNING id::text`,
		org, user, project["id"], name, filename, size).Scan(&id)
	if err != nil {
		e.t.Fatal(err)
	}
	return 200, map[string]any{"id": id, "project_id": project["id"], "status": "uploading"}
}

func (e *env) call(user, org, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	status, raw := e.raw(user, org, method, path, body, nil)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return status, out
}

func (e *env) raw(user, org, method, path string, body any, header http.Header) (int, []byte) {
	e.t.Helper()
	var reader io.Reader
	if b, ok := body.([]byte); ok {
		reader = bytes.NewReader(b)
	} else if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, reader)
	req.Header.Set("Authorization", "Bearer "+e.token(user))
	if org != "" {
		req.Header.Set("x-callerwhale-org", org)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, data
}

// op pushes one operation and returns its answer.
func (e *env) op(user, org, kind string, payload map[string]any) map[string]any {
	e.t.Helper()
	return e.opWith(user, org, kind, payload, "")
}

func (e *env) opWith(user, org, kind string, payload map[string]any, id string) map[string]any {
	e.t.Helper()
	if id == "" {
		id = newID(e.t)
	}
	status, out := e.call(user, org, "POST", "/api/v1/ops", map[string]any{"id": id, "kind": kind, "payload": payload})
	if status != 200 {
		e.t.Fatalf("op %s: status %d %v", kind, status, out)
	}
	return out
}

func newID(t *testing.T) string {
	t.Helper()
	var id string
	conn, err := pgx.Connect(context.Background(), os.Getenv("CRM_TEST_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if err = conn.QueryRow(context.Background(), `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (e *env) want(out map[string]any, status string) map[string]any {
	e.t.Helper()
	if out["status"] != status {
		e.t.Fatalf("want status %s, got %v", status, out)
	}
	result, _ := out["result"].(map[string]any)
	return result
}
