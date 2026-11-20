package main

import (
	"context"
	"testing"
)

// Step 37: a lead goes to another agency with its contact details and a note; the sender keeps a closed copy; the receiver takes it
// into a team and client, with the sender's blocks locked and no consent to text; a decline reopens the sender's copy; an agreed fee is
// reminded to both owners when the deal closes, and the close is told to the sender only when both agreed (D248-D254, D373).
func TestLeadReferrals(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	boss := owner()
	boss.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = boss
	e.rules.grants[carol+"|"+orgB] = boss
	e.call(alice, orgA, "GET", "/api/v1/me", nil)
	e.call(carol, orgB, "GET", "/api/v1/me", nil)
	e.rules.roster[orgB] = []member{{UserID: carol, Roles: []string{"owner"}}}
	if _, err := e.admin.Exec(ctx, `INSERT INTO crm.people (user_id, name, tag) VALUES ($1, 'Carol Day', '4821') ON CONFLICT (user_id) DO UPDATE SET name = 'Carol Day', tag = '4821'`, carol); err != nil {
		t.Fatal(err)
	}
	e.call(carol, orgB, "PATCH", "/api/v1/organization", map[string]any{"name": "Day Homes"})

	// Finding the agency by its owner's Name#tag; a caller may not.
	if code, _ := e.call(bob, orgA, "GET", "/api/v1/referrals/agencies?owner=Carol%20Day%234821", nil); code != 403 {
		t.Fatalf("a caller looks for agencies: %d", code)
	}
	_, found := e.call(alice, orgA, "GET", "/api/v1/referrals/agencies?owner=carol%20day%234821", nil)
	if list := found["agencies"].([]any); len(list) != 1 || list[0].(map[string]any)["org_id"] != orgB || list[0].(map[string]any)["name"] != "Day Homes" {
		t.Fatalf("agencies: %v", found)
	}

	const lead = "aaaaaaaa-0000-4000-8000-000000003701"
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat Mover", "phone": "512-555-3701", "email": "pat@example.test"}), "applied")
	e.call(alice, orgA, "POST", "/api/v1/blocks", map[string]any{"phone": "512-555-3701", "texts": true})
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/leads/"+lead+"/send", map[string]any{"to_org": orgB, "note": "Moving to Austin"}); code != 400 {
		t.Fatalf("sent without the person's agreement: %d", code)
	}
	code, sent := e.call(alice, orgA, "POST", "/api/v1/leads/"+lead+"/send", map[string]any{"to_org": orgB, "note": "Moving to Austin", "consent_confirmed": true})
	if code != 200 || sent["to"] != "Day Homes" {
		t.Fatalf("send: %d %v", code, sent)
	}
	var stage, verdict string
	_ = e.admin.QueryRow(ctx, `SELECT stage, verdict FROM crm.leads WHERE id = $1`, lead).Scan(&stage, &verdict)
	if stage != "Closed" || verdict != "Sent to Day Homes" {
		t.Fatalf("the sender's copy: %s %s", stage, verdict)
	}
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/leads/"+lead+"/send", map[string]any{"to_org": orgB, "consent_confirmed": true}); code != 409 {
		t.Fatalf("sent twice: %d", code)
	}
	id := sent["id"].(string)

	// Declined with a reason: the sender's copy reopens, with the reason as a note.
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/referrals/"+id+"/decline", map[string]any{"reason": "x"}); code != 404 {
		t.Fatalf("the sender declines: %d", code)
	}
	if code, _ := e.call(carol, orgB, "POST", "/api/v1/referrals/"+id+"/decline", map[string]any{"reason": "Not our area"}); code != 200 {
		t.Fatalf("decline: %d", code)
	}
	_ = e.admin.QueryRow(ctx, `SELECT stage FROM crm.leads WHERE id = $1`, lead).Scan(&stage)
	var notes int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1 AND body LIKE '%Not our area'`, lead).Scan(&notes)
	if stage == "Closed" || notes != 1 {
		t.Fatalf("after a decline: %s %d", stage, notes)
	}

	// Sent again, accepted into a client of the receiver's.
	_, sent = e.call(alice, orgA, "POST", "/api/v1/leads/"+lead+"/send", map[string]any{"to_org": orgB, "note": "Moving to Austin", "consent_confirmed": true})
	id = sent["id"].(string)
	_, received := e.call(carol, orgB, "GET", "/api/v1/referrals", nil)
	if r := received["received"].([]any); len(r) != 2 || r[0].(map[string]any)["phone"] != "512-555-3701" || r[1].(map[string]any)["phone"] != nil {
		t.Fatalf("received: %v", received)
	}
	_, client := e.call(carol, orgB, "POST", "/api/v1/clients", map[string]any{"name": "Seller Co"})
	code, accepted := e.call(carol, orgB, "POST", "/api/v1/referrals/"+id+"/accept", map[string]any{"client_id": client["id"]})
	if code != 200 {
		t.Fatalf("accept: %d %v", code, accepted)
	}
	newLead := accepted["lead_id"].(string)
	var org, phone, source string
	var dnc bool
	_ = e.admin.QueryRow(ctx, `SELECT org_id::text, phone, source, do_not_call FROM crm.leads WHERE id = $1`, newLead).Scan(&org, &phone, &source, &dnc)
	if org != orgB || phone != "512-555-3701" || source != "From Person 1111's workspace" {
		t.Fatalf("the received lead: %s %s %s", org, phone, source)
	}
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.notes WHERE lead_id = $1 AND body LIKE '%Moving to Austin%'`, newLead).Scan(&notes)
	if notes != 1 {
		t.Fatal("the sender's note did not come")
	}
	var calls, texts, locked bool
	if err := e.admin.QueryRow(ctx, `SELECT calls, texts, locked FROM crm.number_blocks WHERE org_id = $1 AND lifted_at IS NULL`, orgB).Scan(&calls, &texts, &locked); err != nil || calls || !texts || !locked {
		t.Fatalf("the block that came with it: %v %v %v %v", calls, texts, locked, err)
	}
	if code, _ := e.call(carol, orgB, "POST", "/api/v1/blocks/lift", map[string]any{"phone": "512-555-3701", "reason": "They asked"}); code != 403 {
		t.Fatalf("the receiver lifts the sender's block: %d", code)
	}
	if code, _ := e.call(carol, orgB, "POST", "/api/v1/referrals/"+id+"/accept", nil); code != 409 {
		t.Fatalf("accepted twice: %d", code)
	}

	// A fee: one notes, the other agrees; the close is shared only when both say so.
	note := "10% of our fee"
	e.call(alice, orgA, "POST", "/api/v1/referrals/"+id+"/fee", map[string]any{"note": note})
	if code, _ := e.call(alice, orgA, "POST", "/api/v1/referrals/"+id+"/fee", map[string]any{"agree": true}); code != 409 {
		t.Fatalf("agreeing to one's own fee: %d", code)
	}
	e.call(carol, orgB, "POST", "/api/v1/referrals/"+id+"/fee", map[string]any{"agree": true})
	e.call(alice, orgA, "POST", "/api/v1/referrals/"+id+"/share-close", map[string]any{"agree": true})

	const deal = "aaaaaaaa-0000-4000-8000-000000003702"
	e.want(e.op(carol, orgB, "deal.create", map[string]any{"id": deal, "lead_id": newLead, "amount": 300000, "fee": 9000}), "applied")
	e.want(e.op(carol, orgB, "deal.update", map[string]any{"id": deal, "changes": map[string]any{"stage": "Closed won"}}), "applied")
	_, mine := e.call(alice, orgA, "GET", "/api/v1/referrals", nil)
	last := mine["sent"].([]any)[0].(map[string]any)
	if last["status"] != "accepted" || last["fee_agreed"] != true || last["deal_closed_at"] != nil {
		t.Fatalf("the close is told before both agreed: %v", last)
	}
	e.call(carol, orgB, "POST", "/api/v1/referrals/"+id+"/share-close", map[string]any{"agree": true})
	_, mine = e.call(alice, orgA, "GET", "/api/v1/referrals", nil)
	if mine["sent"].([]any)[0].(map[string]any)["deal_closed_at"] == nil {
		t.Fatal("the close is not told after both agreed")
	}
	var reminders int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.tasks WHERE title LIKE 'Referral fee for Pat Mover%'`).Scan(&reminders)
	if reminders != 2 {
		t.Fatalf("fee reminders: %d", reminders)
	}
}
