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
	_, found := e.call(alice, orgA, "GET", "/api/v1/leads/search?q="+url.QueryEscape("needle"), nil)
	if found["total"].(float64) != 1 || len(found["leads"].([]any)) != 1 {
		t.Fatalf("search: %v", found)
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
