package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"
)

// A big workspace: the snapshot carries a window of leads with the real totals, search reaches the rest, and a device far behind is told to
// take a fresh snapshot instead of paging through every change.
func TestABigWorkspaceSendsAWindowAndSearchFindsTheRest(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot", nil) // the workspace is made when it is first used
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.leads (org_id, name) SELECT '%s'::uuid, 'Lead ' || n FROM generate_series(1, %d) n`, orgA, snapshotLeads+200)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`UPDATE crm.leads SET name = 'Zelda Needle' WHERE org_id = '%s'::uuid AND name = 'Lead 7'`, orgA)); err != nil {
		t.Fatal(err)
	}
	status, snap := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	if status != http.StatusOK {
		t.Fatalf("snapshot: %d", status)
	}
	if got := len(snap["leads"].([]any)); got != snapshotLeads {
		t.Fatalf("window: %d leads, want %d", got, snapshotLeads)
	}
	if snap["leads_total"].(float64) < float64(snapshotLeads+200) {
		t.Fatalf("total: %v", snap["leads_total"])
	}
	// The counts the overview shows cover every lead, not the window.
	if stages, _ := snap["stage_counts"].(map[string]any); stages["New"] == nil || stages["New"].(float64) < float64(snapshotLeads+200) {
		t.Fatalf("stage counts: %v", snap["stage_counts"])
	}
	if snap["unassigned_count"].(float64) < float64(snapshotLeads+200) {
		t.Fatalf("unassigned: %v", snap["unassigned_count"])
	}
	_, found := e.call(alice, orgA, "GET", "/api/v1/leads/search?q="+url.QueryEscape("needle"), nil)
	if found["total"].(float64) != 1 || len(found["leads"].([]any)) != 1 {
		t.Fatalf("search: %v", found)
	}
	// The Leads list asks with no search at all: the whole workspace is counted and a page of it comes back.
	_, page := e.call(alice, orgA, "GET", "/api/v1/leads/search?offset=10&limit=5", nil)
	if page["total"].(float64) < float64(snapshotLeads+200) || len(page["leads"].([]any)) != 5 {
		t.Fatalf("browse: total %v, %d leads", page["total"], len(page["leads"].([]any)))
	}
	// The Calls queue asks for leads that can be called: none of these has a phone number yet.
	_, calls := e.call(alice, orgA, "GET", "/api/v1/leads/search?callable=1&limit=5", nil)
	if calls["total"].(float64) != 0 {
		t.Fatalf("callable: %v", calls["total"])
	}
	if status, _ = e.call(alice, orgA, "GET", "/api/v1/leads/search?project=nope", nil); status != http.StatusBadRequest {
		t.Fatalf("a bad list id: %d", status)
	}
	if status, _ = e.call(alice, orgA, "GET", "/api/v1/leads/search?q=a", nil); status != http.StatusBadRequest {
		t.Fatalf("one-letter search: %d", status)
	}
	// Far behind: a reset, not thousands of changes.
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.change_log (org_id, entity, entity_id, lead_id, op) SELECT '%s'::uuid, 'lead', id, id, 'upsert' FROM crm.leads WHERE org_id = '%s'::uuid LIMIT %d`, orgA, orgA, maxPullBehind+50)); err != nil {
		t.Fatal(err)
	}
	_, pulled := e.call(alice, orgA, "GET", fmt.Sprintf("/sync/pull?cursor=%v&access_revision=%v", snap["cursor"], snap["access_revision"]), nil)
	if pulled["reset"] != true {
		t.Fatalf("pull far behind: %v", pulled)
	}
}

// A list whose leads have no phone number and no email is told apart in the snapshot, so it can be marked as a useless list.
func TestTheSnapshotSaysHowManyLeadsOfEachListCanBeContacted(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot", nil) // the workspace is made when it is first used
	good, empty := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	for _, id := range []string{good, empty} {
		if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.projects (id, org_id, name) VALUES ('%s', '%s', 'list')`, id, orgA)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.leads (org_id, project_id, name, phone) VALUES ('%s', '%s', 'a', '5125550100'), ('%s', '%s', 'b', ''), ('%s', '%s', 'c', '')`, orgA, good, orgA, good, orgA, empty)); err != nil {
		t.Fatal(err)
	}
	_, snap := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	contactable := snap["project_contactable"].(map[string]any)
	if contactable[good] != float64(1) || contactable[empty] != float64(0) {
		t.Fatalf("contactable: %v", contactable)
	}
}

// A list of addresses (no phone, no email) is refused, unless it was brought in for skip tracing; then its list is not called useless.
func TestAListOfAddressesIsLetInOnlyForSkipTracing(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot", nil) // the workspace is made when it is first used
	project := "33333333-3333-4333-8333-333333333333"
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.projects (id, org_id, name) VALUES ('%s', '%s', 'addresses')`, project, orgA)); err != nil {
		t.Fatal(err)
	}
	makeJob := func(skip bool) string {
		var id string
		if err := e.admin.QueryRow(ctx, fmt.Sprintf(`INSERT INTO importing.jobs (org_id, user_id, project_id, name, filename, size, chunk_size, total_chunks, status, kind, for_skip_tracing, columns)
			VALUES ('%s', '%s', '%s', 'a', 'a.csv', 10, 10, 1, 'mapping', 'lead_list', %v, '[{"idx":0,"header":"Name"},{"idx":1,"header":"Address"}]') RETURNING id::text`, orgA, alice, project, skip)).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	answer := map[string]any{"columns": []map[string]any{{"idx": 0, "field": "name", "use": true}, {"idx": 1, "field": "address", "use": true}}}
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/imports/"+makeJob(false)+"/mapping", answer); status != http.StatusBadRequest {
		t.Fatalf("addresses only, not for skip tracing: %d", status)
	}
	if status, body := e.call(alice, orgA, "PUT", "/api/v1/imports/"+makeJob(true)+"/mapping", answer); status != http.StatusOK {
		t.Fatalf("addresses only, for skip tracing: %d %v", status, body)
	}
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`INSERT INTO crm.leads (org_id, project_id, name) VALUES ('%s', '%s', 'no phone')`, orgA, project)); err != nil {
		t.Fatal(err)
	}
	_, snap := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	if got := snap["project_contactable"].(map[string]any)[project]; got != float64(1) {
		t.Fatalf("a list for skip tracing must not count as useless: %v", got)
	}
}

// Opening a lead outside the device's window asks for what hangs off it: its tasks and notes come back, and a lead that does not exist does not.
func TestALeadsDetailsComeWhenItIsOpened(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	var lead string
	if err := e.admin.QueryRow(ctx, fmt.Sprintf(`INSERT INTO crm.leads (org_id, name) VALUES ('%s'::uuid, 'Detail Lead') RETURNING id`, orgA)).Scan(&lead); err != nil {
		t.Fatal(err)
	}
	var other string
	if err := e.admin.QueryRow(ctx, fmt.Sprintf(`INSERT INTO crm.leads (org_id, name) VALUES ('%s'::uuid, 'Another Lead') RETURNING id`, orgA)).Scan(&other); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		fmt.Sprintf(`INSERT INTO crm.tasks (org_id, lead_id, title) VALUES ('%s'::uuid, '%s'::uuid, 'Call back'), ('%s'::uuid, '%s'::uuid, 'Not this lead''s')`, orgA, lead, orgA, other),
		fmt.Sprintf(`INSERT INTO crm.notes (org_id, lead_id, body) VALUES ('%s'::uuid, '%s'::uuid, 'Said to try Friday')`, orgA, lead),
	} {
		if _, err := e.admin.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	status, details := e.call(alice, orgA, "GET", "/api/v1/leads/"+lead+"/details", nil)
	if status != http.StatusOK {
		t.Fatalf("details: %d", status)
	}
	// Only this lead's own task and note come back, not another lead's.
	if tasks := details["tasks"].([]any); len(tasks) != 1 || tasks[0].(map[string]any)["title"] != "Call back" {
		t.Fatalf("tasks: %v", details["tasks"])
	}
	if notes := details["notes"].([]any); len(notes) != 1 || notes[0].(map[string]any)["body"] != "Said to try Friday" {
		t.Fatalf("notes: %v", details["notes"])
	}
	// A lead that has been deleted answers as if it did not exist.
	if _, err := e.admin.Exec(ctx, fmt.Sprintf(`UPDATE crm.leads SET deleted_at = now() WHERE id = '%s'::uuid`, other)); err != nil {
		t.Fatal(err)
	}
	if status, _ = e.call(alice, orgA, "GET", "/api/v1/leads/"+other+"/details", nil); status != http.StatusNotFound {
		t.Fatalf("a deleted lead: %d", status)
	}
	// Another workspace's lead answers the same way: the details never cross workspaces.
	if status, _ = e.call(carol, orgB, "GET", "/api/v1/leads/"+lead+"/details", nil); status != http.StatusNotFound {
		t.Fatalf("a lead of another workspace: %d", status)
	}
	// A caller who sees only their own leads is not given the details of one that is not theirs.
	if status, _ = e.call(bob, orgA, "GET", "/api/v1/leads/"+lead+"/details", nil); status != http.StatusNotFound {
		t.Fatalf("a lead outside the caller's scope: %d", status)
	}
	for _, key := range []string{"tasks", "notes", "calls", "handoffs", "deals"} {
		if _, ok := details[key].([]any); !ok {
			t.Fatalf("details has no %s list: %v", key, details)
		}
	}
	if status, _ = e.call(alice, orgA, "GET", "/api/v1/leads/00000000-0000-0000-0000-000000000000/details", nil); status != http.StatusNotFound {
		t.Fatalf("a lead that does not exist: %d", status)
	}
	if status, _ = e.call(alice, orgA, "GET", "/api/v1/leads/nope/details", nil); status != http.StatusNotFound {
		t.Fatalf("a bad id: %d", status)
	}
}
