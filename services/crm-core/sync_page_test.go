package crm

import (
	"context"
	"fmt"
	"testing"
)

// A snapshot can be read a few leads at a time: the first page has the totals and the cursor, each page names the next, and together
// the pages hold every lead of the window once.
func TestASnapshotCanBeReadInPages(t *testing.T) {
	e := newEnv(t)
	e.seed()
	for i := 0; i < 7; i++ {
		e.want(e.op(alice, orgA, "lead.create", map[string]any{"name": fmt.Sprintf("Lead %d", i)}), "applied")
	}
	status, first := e.call(alice, orgA, "GET", "/sync/snapshot?limit=3", nil)
	if status != 200 {
		t.Fatalf("first page: %d", status)
	}
	if first["leads_total"] != float64(7) || first["cursor"] == nil || len(first["leads"].([]any)) != 3 {
		t.Fatalf("first page: total %v, cursor %v, leads %d", first["leads_total"], first["cursor"], len(first["leads"].([]any)))
	}
	seen := map[string]bool{}
	for _, raw := range first["leads"].([]any) {
		seen[raw.(map[string]any)["id"].(string)] = true
	}
	token, _ := first["next"].(string)
	pages := 1
	for token != "" {
		status, page := e.call(alice, orgA, "GET", "/sync/snapshot?limit=3&after="+token, nil)
		if status != 200 {
			t.Fatalf("page %d: %d", pages+1, status)
		}
		if page["cursor"] != nil || page["leads_total"] != nil {
			t.Fatalf("a later page repeats the totals: %v", page)
		}
		for _, raw := range page["leads"].([]any) {
			id := raw.(map[string]any)["id"].(string)
			if seen[id] {
				t.Fatalf("lead %s came twice", id)
			}
			seen[id] = true
		}
		token, _ = page["next"].(string)
		pages++
	}
	if len(seen) != 7 || pages != 3 {
		t.Fatalf("%d leads over %d pages", len(seen), pages)
	}
	// Without a limit the whole window still comes in one answer, with nothing more to ask for.
	_, whole := e.call(alice, orgA, "GET", "/sync/snapshot", nil)
	if len(whole["leads"].([]any)) != 7 || whole["next"] != "" {
		t.Fatalf("whole snapshot: %d leads, next %q", len(whole["leads"].([]any)), whole["next"])
	}
	if status, _ := e.call(alice, orgA, "GET", "/sync/snapshot?limit=3&after=not-a-token", nil); status != 400 {
		t.Fatalf("a made-up page token: %d", status)
	}
}

// The person's own leads come first, then everyone else's, and a page that ends between the two carries on from the right place.
func TestASnapshotPageEndingBetweenMyLeadsAndTheRestCarriesOn(t *testing.T) {
	e := newEnv(t)
	e.seed()
	for i := 0; i < 7; i++ {
		e.want(e.op(alice, orgA, "lead.create", map[string]any{"name": fmt.Sprintf("Lead %d", i)}), "applied")
	}
	if _, err := e.admin.Exec(context.Background(), `UPDATE crm.leads SET assignee_id = CASE WHEN name IN ('Lead 1', 'Lead 4', 'Lead 5') THEN $1::uuid END`, alice); err != nil { // the others are no one's
		t.Fatal(err)
	}
	var order []string
	token := ""
	for pages := 0; pages < 10; pages++ {
		path := "/sync/snapshot?limit=2"
		if token != "" {
			path += "&after=" + token
		}
		status, page := e.call(alice, orgA, "GET", path, nil)
		if status != 200 {
			t.Fatalf("page %d: %d", pages+1, status)
		}
		for _, raw := range page["leads"].([]any) {
			order = append(order, raw.(map[string]any)["name"].(string))
		}
		if token, _ = page["next"].(string); token == "" {
			break
		}
	}
	if len(order) != 7 {
		t.Fatalf("leads over the pages: %v", order)
	}
	mine := map[string]bool{"Lead 1": true, "Lead 4": true, "Lead 5": true}
	for i, name := range order {
		if mine[name] != (i < 3) {
			t.Fatalf("my leads are not first: %v", order)
		}
	}
	seen := map[string]bool{}
	for _, name := range order {
		if seen[name] {
			t.Fatalf("%s came twice: %v", name, order)
		}
		seen[name] = true
	}
}
