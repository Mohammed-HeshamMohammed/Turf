package crm

import (
	"context"
	"testing"
)

// Step 23: clients. A list's client marks its leads; a client's people see only the leads shared with their client, and its figures;
// two clients' leads never merge (D126, D127, D133, D223).
func TestClientsOwnTheirLeads(t *testing.T) {
	e := newEnv(t)
	e.seed()
	cara := newID(t)
	e.rules.grants[cara+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"shared"}, Capabilities: []string{"publicComment"}, Roles: []string{"client"}}
	e.rules.roster[orgA] = append(e.rules.roster[orgA], member{UserID: cara, Roles: []string{"client"}})

	if status, _ := e.call(bob, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme"}); status != 403 {
		t.Fatalf("a caller adds a client: %d", status)
	}
	status, acme := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme"})
	if status != 200 {
		t.Fatalf("client: %d %v", status, acme)
	}
	acmeID := acme["id"].(string)
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": "Theirs", "supplied_by": "client"}); status != 400 {
		t.Fatalf("a client-supplied list without its client: %d", status)
	}
	status, list := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": "Acme sellers", "client_id": acmeID, "supplied_by": "client"})
	if status != 200 || list["client_id"] != acmeID || list["supplied_by"] != "client" {
		t.Fatalf("list: %d %v", status, list)
	}
	theirs, ours := newID(t), newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": theirs, "name": "Pat Seller", "phone": "555-0100", "project_id": list["id"]}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": ours, "name": "Pat Seller", "phone": "555-0100"}), "applied")
	var client *string
	if err := e.admin.QueryRow(context.Background(), `SELECT client_id::text FROM crm.leads WHERE id = $1`, theirs).Scan(&client); err != nil || client == nil || *client != acmeID {
		t.Fatalf("the lead belongs to the list's client: %v %v", client, err)
	}

	// The client's person, linked to Acme, sees nothing until a lead is shared with Acme.
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/clients/"+acmeID+"/members/"+bob, map[string]any{"main": true}); status != 400 {
		t.Fatalf("a caller made a client's person: %d", status)
	}
	if status, _ := e.call(alice, orgA, "PUT", "/api/v1/clients/"+acmeID+"/members/"+cara, map[string]any{"main": true}); status != 200 {
		t.Fatalf("link: %d", status)
	}
	leads := func() int {
		_, snap := e.call(cara, orgA, "GET", "/sync/snapshot", nil)
		items, _ := snap["leads"].([]any)
		return len(items)
	}
	if leads() != 0 {
		t.Fatal("the client sees a lead not shared with them")
	}
	if out := e.op(alice, orgA, "lead.share_client", map[string]any{"id": ours}); out["status"] == "applied" {
		t.Fatalf("shared the agency's own lead with a client: %v", out)
	}
	e.want(e.op(alice, orgA, "lead.share_client", map[string]any{"id": theirs}), "applied")
	if leads() != 1 {
		t.Fatal("the client does not see the lead shared with them")
	}

	// Two clients' copies of the same person never merge.
	if out := e.op(alice, orgA, "lead.merge", map[string]any{"keep_id": ours, "merge_id": theirs}); out["status"] == "applied" {
		t.Fatalf("merged two clients' leads: %v", out)
	}

	// Figures without names: for the client's own people and the agency's owner, not for others.
	_, sum := e.call(cara, orgA, "GET", "/api/v1/clients/"+acmeID+"/summary", nil)
	if sum["leads"] != float64(1) || sum["by_stage"] == nil {
		t.Fatalf("the client's figures: %v", sum)
	}
	_, other := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Beta"})
	if status, _ := e.call(cara, orgA, "GET", "/api/v1/clients/"+other["id"].(string)+"/summary", nil); status != 404 {
		t.Fatalf("a client reads another client's figures: %d", status)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/clients/"+acmeID+"/summary", nil); status != 403 {
		t.Fatalf("a caller reads a client's figures: %d", status)
	}
	_, mine := e.call(cara, orgA, "GET", "/api/v1/clients", nil)
	if items := mine["clients"].([]any); len(items) != 1 || items[0].(map[string]any)["name"] != "Acme" {
		t.Fatalf("a client sees only their own client: %v", mine)
	}
	_, all := e.call(alice, orgA, "GET", "/api/v1/clients", nil)
	if items := all["clients"].([]any); len(items) != 3 || items[0].(map[string]any)["own_business"] != true {
		t.Fatalf("the owner sees the agency's own business and every client: %v", all)
	}
}
