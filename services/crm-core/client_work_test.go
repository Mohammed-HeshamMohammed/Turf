package main

import (
	"context"
	"testing"
)

// Step 23, part B: a call or deal reaches the client only when shared (D136, D281); a list sent for approval waits for its client when
// the client requires it (D138); the owner sees quietly that a number is also under another client (D133).
func TestClientSharingApprovalAndTwins(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	cara := newID(t)
	e.rules.grants[cara+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"shared"}, Capabilities: []string{"publicComment"}, Roles: []string{"client"}}
	e.rules.roster[orgA] = append(e.rules.roster[orgA], member{UserID: cara, Roles: []string{"client"}})
	_, acme := e.call(alice, orgA, "POST", "/api/v1/clients", map[string]any{"name": "Acme", "approval_required": true})
	acmeID := acme["id"].(string)
	e.call(alice, orgA, "PUT", "/api/v1/clients/"+acmeID+"/members/"+cara, map[string]any{"main": true})
	_, list := e.call(alice, orgA, "POST", "/api/v1/projects", map[string]any{"name": "Acme sellers", "client_id": acmeID, "supplied_by": "client"})
	listID := list["id"].(string)
	theirs, ours := newID(t), newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": theirs, "name": "Pat Seller", "phone": "(512) 555-0199", "project_id": listID}), "applied")
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": ours, "name": "Pat Seller", "phone": "512-555-0199"}), "applied")
	e.want(e.op(alice, orgA, "lead.share_client", map[string]any{"id": theirs}), "applied")
	var call string
	if err := e.admin.QueryRow(ctx, `INSERT INTO crm.call_events (org_id, lead_id, outcome, meaning, occurred_at) VALUES ($1, $2, 'Reached', 'reached', now()) RETURNING id::text`, orgA, theirs).Scan(&call); err != nil {
		t.Fatal(err)
	}
	calls := func() int {
		_, snap := e.call(cara, orgA, "GET", "/sync/snapshot", nil)
		items, _ := snap["calls"].([]any)
		return len(items)
	}
	if calls() != 0 {
		t.Fatal("the client hears a call not shared with them")
	}
	e.want(e.op(alice, orgA, "call.share_client", map[string]any{"id": call}), "applied")
	if calls() != 1 {
		t.Fatal("the client does not get the call shared with them")
	}

	// Approval: the client approves; until then the list's leads are not called.
	if status, _ := e.call(cara, orgA, "POST", "/api/v1/projects/"+listID+"/approval", map[string]any{"approved": true}); status != 404 {
		t.Fatalf("approving a list not sent yet: %d", status)
	}
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/projects/"+listID+"/approval/send", nil); status != 200 {
		t.Fatalf("send for approval: %d", status)
	}
	_, waiting := e.call(cara, orgA, "GET", "/api/v1/clients/"+acmeID+"/approvals", nil)
	if items := waiting["lists"].([]any); len(items) != 1 || items[0].(map[string]any)["approval_status"] != "sent" {
		t.Fatalf("the client sees what waits: %v", waiting)
	}
	tx, _ := e.s.st.begin(ctx, scope{userID: alice, orgID: orgA, scopes: []string{"organization"}})
	if w, err := waitingApproval(ctx, tx, theirs); err != nil || !w {
		t.Fatalf("the lead waits for approval: %v %v", w, err)
	}
	tx.Rollback(ctx)
	if status, _ := e.call(alice, orgA, "POST", "/api/v1/projects/"+listID+"/approval", map[string]any{"approved": true}); status != 403 {
		t.Fatalf("the agency approves its own list: %d", status)
	}
	if status, out := e.call(cara, orgA, "POST", "/api/v1/projects/"+listID+"/approval", map[string]any{"approved": true, "note": "Go ahead"}); status != 200 || out["approval_status"] != "approved" {
		t.Fatalf("approve: %d %v", status, out)
	}
	tx, _ = e.s.st.begin(ctx, scope{userID: alice, orgID: orgA, scopes: []string{"organization"}})
	if w, _ := waitingApproval(ctx, tx, theirs); w {
		t.Fatal("still waiting after the client approved")
	}
	tx.Rollback(ctx)

	// The quiet marker: the same number under another client, for the owner only.
	if _, out := e.call(alice, orgA, "GET", "/api/v1/leads/"+theirs+"/twins", nil); out["under_other_clients"] != true {
		t.Fatalf("the owner's marker: %v", out)
	}
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/leads/"+theirs+"/twins", nil); status != 403 {
		t.Fatalf("a caller sees the marker: %d", status)
	}
}
