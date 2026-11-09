package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// A finished import goes once to the learning store, and a week later the holding rows lose their personal details but keep their fingerprint.
func TestAFinishedImportIsCopiedToTheLearningStoreAndThenBlanked(t *testing.T) {
	e := newEnv(t)
	e.seed()
	e.call(alice, orgA, "GET", "/sync/snapshot", nil) // the workspace is made when it is first used
	ctx := context.Background()
	var job string
	if err := e.admin.QueryRow(ctx, fmt.Sprintf(`INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, status, kind, columns)
		VALUES ('%s', '%s', 'Austin', 'a.csv', 10, 10, 1, 'done', 'lead_list', '[{"idx":0,"header":"Owner Name","field":"name","used":true}]') RETURNING id::text`, orgA, alice)).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO importing.rows (job_id, row_no, fp, cells, name, phone, email, address, city, region, zip, state, source_data)
		VALUES ('%s', 1, '\x0102', ARRAY['Pat Owner','5125550100'], 'Pat Owner', '5125550100', 'pat@example.com', '1 Main St', 'Austin', 'TX', '78701', 'merged', '{"bedrooms": 3}'),
		       ('%s', 2, '\x0103', ARRAY['x'], 'Sam', '5125550101', NULL, NULL, NULL, NULL, NULL, 'skip', '{}')`, job, job)); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var bodies []string
	learning := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, r.Header.Get("Authorization")+" "+string(raw))
		mu.Unlock()
		_, _ = w.Write([]byte(`{"stored":1}`))
	}))
	defer learning.Close()
	e.s.cfg.learningURL, e.s.cfg.learningToken = learning.URL, strings.Repeat("t", 32)

	if err := e.s.learnJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 1 || !strings.HasPrefix(bodies[0], "Bearer "+strings.Repeat("t", 32)+" ") {
		t.Fatalf("sent: %v", bodies)
	}
	var sent struct {
		Rows    []map[string]any `json:"rows"`
		Mapping []map[string]any `json:"mapping"`
	}
	if err := json.Unmarshal([]byte(strings.SplitN(bodies[0], " ", 3)[2]), &sent); err != nil {
		t.Fatal(err)
	}
	if len(sent.Rows) != 1 || sent.Rows[0]["city"] != "Austin" || len(sent.Mapping) != 1 {
		t.Fatalf("payload: %+v", sent)
	}
	// Once only: a second call finds it already copied.
	if err := e.s.learnJob(ctx, job); err != nil || len(bodies) != 1 {
		t.Fatalf("second call sent again: %v %d", err, len(bodies))
	}

	// Within the week the rows keep their values; after it they are blanked, the fingerprint stays.
	if n, err := e.s.scrubLearned(ctx); err != nil || n != 0 {
		t.Fatalf("scrub too early: %d %v", n, err)
	}
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`UPDATE importing.jobs SET learned_at = now() - interval '8 days' WHERE id = '%s'`, job)); err != nil {
		t.Fatal(err)
	}
	if n, err := e.s.scrubLearned(ctx); err != nil || n != 2 {
		t.Fatalf("scrub: %d %v", n, err)
	}
	var name, phone *string
	var cells int
	var fp []byte
	if err := e.admin.QueryRow(ctx, fmt.Sprintf(`SELECT name, phone, cardinality(cells), fp FROM importing.rows WHERE job_id = '%s' AND row_no = 1`, job)).Scan(&name, &phone, &cells, &fp); err != nil {
		t.Fatal(err)
	}
	if name != nil || phone != nil || cells != 0 || len(fp) != 2 {
		t.Fatalf("after the scrub: %v %v %d %v", name, phone, cells, fp)
	}
}

func TestTheLearningTokenIsNeededWhenItsAddressIsSet(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "x", "AUTH_JWKS_URL": "http://a", "AUTHZ_URL": "http://b", "AUTHZ_TOKEN": strings.Repeat("a", 32), "LEARNING_URL": "http://learning:8112"}
	if _, err := loadConfig(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a learning address without a token must be refused")
	}
	env["LEARNING_TOKEN"] = strings.Repeat("l", 32)
	if c, err := loadConfig(func(k string) string { return env[k] }); err != nil || c.learningURL != "http://learning:8112" {
		t.Fatalf("config: %+v %v", c, err)
	}
}

func TestAnAdministratorCanOptTheWorkspaceOutOfTheLearningCopy(t *testing.T) {
	e := newEnv(t)
	e.seed()
	var paths []string
	learning := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		_, _ = w.Write([]byte(`{"erased":3}`))
	}))
	defer learning.Close()
	e.s.cfg.learningURL, e.s.cfg.learningToken = learning.URL, strings.Repeat("t", 32)
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/learning/opt-out", map[string]any{}); status != http.StatusOK {
		t.Fatalf("opt out: %d", status)
	}
	if len(paths) != 1 || paths[0] != "POST /v1/workspaces/"+orgA+"/opt-out" {
		t.Fatalf("sent: %v", paths)
	}
}
