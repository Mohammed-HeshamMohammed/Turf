package crm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Each program asks only for what it uses: crm-merge needs the database alone, crm-outbox also authz (emails and reports look up
// teams and members), and the API everything it always needed.
func TestEachProgramAsksOnlyForItsOwnSettings(t *testing.T) {
	token := strings.Repeat("t", 32)
	env := func(pairs ...string) func(string) string {
		m := map[string]string{}
		for i := 0; i+1 < len(pairs); i += 2 {
			m[pairs[i]] = pairs[i+1]
		}
		return func(k string) string { return m[k] }
	}
	db := "postgres://x@y/z"
	if c, err := loadConfigFor("merge", env("DATABASE_URL", db)); err != nil || c.port != "8120" {
		t.Fatalf("crm-merge with only the database: %v, port %q", err, c.port)
	}
	if _, err := loadConfigFor("outbox", env("DATABASE_URL", db)); err == nil {
		t.Fatal("crm-outbox started without authz")
	}
	if c, err := loadConfigFor("outbox", env("DATABASE_URL", db, "AUTHZ_URL", "http://authz:8105", "AUTHZ_TOKEN", token)); err != nil || c.port != "8121" {
		t.Fatalf("crm-outbox with the database and authz: %v, port %q", err, c.port)
	}
	if _, err := loadConfigFor("api", env("DATABASE_URL", db, "AUTHZ_URL", "http://authz:8105", "AUTHZ_TOKEN", token)); err == nil {
		t.Fatal("the API started without the auth service's keys")
	}
	if c, err := loadConfig(env("DATABASE_URL", db, "AUTH_JWKS_URL", "http://auth/jwks", "AUTHZ_URL", "http://authz:8105", "AUTHZ_TOKEN", token)); err != nil || c.port != "8107" || !c.runJobs {
		t.Fatalf("the API: %v, port %q, works the queue %v", err, c.port, c.runJobs)
	}
	if c, _ := loadConfig(env("DATABASE_URL", db, "AUTH_JWKS_URL", "j", "AUTHZ_URL", "a", "AUTHZ_TOKEN", token, "CRM_RUN_JOBS", "false")); c.runJobs {
		t.Fatal("CRM_RUN_JOBS=false left the API working the queue")
	}
}

// A job container finds the database already updated by the API, answers its health check and shows its queues.
func TestAJobContainerAnswersItsHealthAndQueues(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.s.st.waitForUpdate(ctx, 50*time.Millisecond); err != nil {
		t.Fatalf("an updated database was not seen as updated: %v", err)
	}
	ts := httptest.NewServer(e.s.jobsHandler("crm-merge", mergeQueues))
	defer ts.Close()
	for path, want := range map[string]int{"/healthz": 200, "/version": 200, "/status": 200, "/api/v1/leads": 404} {
		res, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		_ = json.NewDecoder(res.Body).Decode(&body)
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("%s: %d %v", path, res.StatusCode, body)
		}
		if path == "/status" {
			queues, _ := body["queues"].(map[string]any)
			if _, ok := queues[queueMerge]; !ok || queues[queueOutbox] != nil {
				t.Fatalf("crm-merge shows the wrong queues: %v", body)
			}
		}
	}
}

// Until the API has applied an update, a job container waits instead of running new code on the old structure.
func TestAJobContainerWaitsForTheDatabaseUpdate(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.admin.Exec(ctx, `DELETE FROM crm.schema_migrations WHERE name = (SELECT max(name) FROM crm.schema_migrations)`); err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	if err := e.s.st.waitForUpdate(wait, 50*time.Millisecond); err == nil {
		t.Fatal("a job container went ahead before the last update was applied")
	}
}
