package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// crossAgencyTables hold rows of several agencies on purpose, with no row security; the service always names the agency itself. A
// new table with an org_id column and no row security fails TestEveryAgencyTableIsUnderRowSecurity until it is listed here, with a
// reason in its migration.
var crossAgencyTables = []string{
	"email_waits", "report_due", "event_due", "google_accounts", "google_events", "shared_blocks", "shared_block_marks", "shared_block_reviews",
	"lead_referrals", "carrier_standing", "agency_restores", "file_scans", "dialer_erasures", "learning_agreements", "shared_learning_runs", "orgs", "people", "schema_migrations",
}

// Step 43, D305: every table that holds an agency's rows is under forced row security, or deliberately listed as cross-agency.
func TestEveryAgencyTableIsUnderRowSecurity(t *testing.T) {
	e := newEnv(t)
	rows, err := e.admin.Query(context.Background(), `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'crm' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	checked := 0
	for rows.Next() {
		var name string
		var rls, forced bool
		if err := rows.Scan(&name, &rls, &forced); err != nil {
			t.Fatal(err)
		}
		checked++
		if slices.Contains(crossAgencyTables, name) {
			continue
		}
		if !rls || !forced {
			t.Errorf("crm.%s holds agencies' rows without forced row security", name)
		}
	}
	if checked < 30 {
		t.Fatalf("only %d tables checked", checked)
	}
}

var routePattern = regexp.MustCompile(`"((?:GET|POST|PUT|PATCH|DELETE) /(?:api|sync|internal)/[^"]*)"`)

// routes are every route the service registers, read from its source.
func routes(t *testing.T) []string {
	files, _ := filepath.Glob("*.go")
	var out []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range routePattern.FindAllStringSubmatch(string(src), -1) {
			if !slices.Contains(out, m[1]) {
				out = append(out, m[1])
			}
		}
	}
	return out
}

// Step 43, D305: signed in to another agency, every route of the service, given every id of the first agency, reads none of its
// leads, notes, tasks, files or clients, and changes none of them.
func TestNoRouteReachesAnotherAgency(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/api/v1/me", nil)
	e.call(carol, orgB, "GET", "/api/v1/me", nil)
	// Agency A's things, with words that must never show up in B.
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Isolation Secret", "phone": "512-555-7777", "email": "secret@isolation.test"}), "applied")
	_, client := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Isolation Client Co"})
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.notes (org_id, lead_id, body) VALUES ($1, $2, 'Isolation note text')`, orgA, lead); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.tasks (org_id, lead_id, title) VALUES ($1, $2, 'Isolation task title')`, orgA, lead); err != nil {
		t.Fatal(err)
	}
	e.raw(alice, orgA, "POST", "/api/v1/leads/"+lead+"/files?name=isolation.pdf", []byte("%PDF-1.7 Isolation file body"), http.Header{"Content-Type": {"application/pdf"}})
	e.call(alice, orgA, "POST", "/api/v1/forms", map[string]any{"name": "Isolation form", "client_id": client["id"]})
	e.call(alice, orgA, "POST", "/api/v1/blocks", map[string]any{"phone": "512-555-7777"})

	// Every id agency A has, from every table.
	var ids []string
	tables, _ := e.admin.Query(ctx, `SELECT table_name FROM information_schema.columns WHERE table_schema = 'crm' AND column_name = 'id' AND data_type = 'uuid'
		AND table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema = 'crm' AND column_name = 'org_id')`)
	var names []string
	for tables.Next() {
		var n string
		_ = tables.Scan(&n)
		names = append(names, n)
	}
	tables.Close()
	for _, n := range names {
		rows, err := e.admin.Query(ctx, `SELECT id::text FROM crm.`+n+` WHERE org_id = $1`, orgA)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var id string
			_ = rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
	}
	if len(ids) < 6 {
		t.Fatalf("agency A has only %d ids", len(ids))
	}
	secrets := []string{"Isolation Secret", "5125557777", "555-7777", "secret@isolation.test", "Isolation Client Co", "Isolation note text", "Isolation task title", "Isolation file body", "Isolation form"}
	// The control: agency A itself does see its lead, so a leak would be seen.
	if _, raw := e.raw(alice, orgA, "GET", "/sync/snapshot", nil, nil); !strings.Contains(string(raw), "Isolation Secret") {
		t.Fatalf("the control: agency A does not see its own lead: %.300s", raw)
	}
	param := regexp.MustCompile(`\{[^}]+\}`)
	all := routes(t)
	if len(all) < 80 {
		t.Fatalf("only %d routes found", len(all))
	}
	calls := 0
	for _, route := range all {
		method, path, _ := strings.Cut(route, " ")
		tries := []string{path}
		if param.MatchString(path) {
			tries = tries[:0]
			for _, id := range ids {
				tries = append(tries, param.ReplaceAllString(path, id))
			}
		}
		for _, p := range tries {
			var body any
			if method != "GET" && method != "DELETE" {
				body = map[string]any{}
			}
			_, raw := e.raw(carol, orgB, method, p, body, nil)
			calls++
			for _, s := range secrets {
				if strings.Contains(string(raw), s) {
					t.Errorf("%s %s as agency B shows %q", method, p, s)
				}
			}
			for _, id := range ids {
				if strings.Contains(string(raw), id) && !strings.Contains(p, id) {
					t.Errorf("%s %s as agency B shows agency A's id %s", method, p, id)
				}
			}
		}
	}
	// Nothing of agency A changed.
	var name string
	var notes, tasks, files int
	_ = e.admin.QueryRow(ctx, `SELECT name FROM crm.leads WHERE id = $1`, lead).Scan(&name)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1`, lead).Scan(&notes)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.tasks WHERE lead_id = $1`, lead).Scan(&tasks)
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.lead_files WHERE lead_id = $1`, lead).Scan(&files)
	if name != "Isolation Secret" || notes != 1 || tasks != 1 || files != 1 {
		t.Fatalf("agency A changed: %q notes %d tasks %d files %d", name, notes, tasks, files)
	}
	t.Logf("%d routes, %d calls as another agency", len(all), calls)
}
