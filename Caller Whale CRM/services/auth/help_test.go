package main

import (
	"slices"
	"testing"
)

// Step 40: owners and admins talk with support and members are sent to their owner; staff answer and the opener is emailed; What's new
// shows each note once, by role, owners every note, switch notes where the switch is on; the owner switches early features on;
// feedback keeps the page without ids (D292-D295).
func TestHelpSupportWhatsNewAndFeedback(t *testing.T) {
	w, fake, _ := lifecycleWorld(t)
	owner := w.stepped("boss@example.com").access()
	caller := w.confirmed("caller@example.com").access()
	staff := w.stepped("staff@example.com").access()
	fake.mu.Lock()
	fake.joined[w.idOf("caller@example.com")] = true
	fake.staff = w.idOf("staff@example.com")
	fake.owner = w.idOf("boss@example.com")
	fake.mu.Unlock()

	// Support conversations.
	chats := "/v1/orgs/" + flowOrg + "/support-chats"
	if a := w.call("POST", chats, map[string]any{"subject": "Help", "body": "How do I import?"}, caller); a.status != 403 {
		t.Fatalf("a member writes to support: %d", a.status)
	}
	a := w.call("POST", chats, map[string]any{"subject": "Importing a list", "body": "The columns look wrong."}, owner)
	if a.status != 201 {
		t.Fatalf("open: %d %v", a.status, a.body)
	}
	id := a.body["id"].(string)
	if a := w.call("GET", "/v1/support-chats/"+id, nil, caller); a.status != 404 {
		t.Fatalf("a member reads it: %d", a.status)
	}
	if a := w.call("GET", "/v1/admin/support-chats", nil, staff); a.status != 200 || len(a.body["chats"].([]any)) != 1 || a.body["chats"].([]any)[0].(map[string]any)["waiting_on"] != "staff" {
		t.Fatalf("staff list: %d %v", a.status, a.body)
	}
	if a := w.call("GET", "/v1/admin/support-chats", nil, owner); a.status != 403 {
		t.Fatalf("an owner lists every conversation: %d", a.status)
	}
	sent := len(w.mail.templates)
	if a := w.call("POST", "/v1/support-chats/"+id+"/messages", map[string]any{"body": "Map the Owner column to name."}, staff); a.status != 200 {
		t.Fatalf("staff reply: %d", a.status)
	}
	if len(w.mail.templates) != sent+1 || w.mail.templates[sent] != "support_reply" || w.mail.tplTo[sent] != "boss@example.com" {
		t.Fatalf("the opener is not emailed: %v %v", w.mail.templates, w.mail.tplTo)
	}
	a = w.call("GET", "/v1/support-chats/"+id, nil, owner)
	if msgs := a.body["messages"].([]any); len(msgs) != 2 || msgs[1].(map[string]any)["author"] != "Caller Whale" {
		t.Fatalf("the conversation: %v", a.body)
	}
	if a := w.call("POST", "/v1/support-chats/"+id+"/close", nil, owner); a.status != 200 {
		t.Fatalf("close: %d", a.status)
	}

	// What's new.
	note := func(body map[string]any) string {
		a := w.call("POST", "/v1/admin/whats-new", body, staff)
		if a.status != 201 {
			t.Fatalf("note: %d %v", a.status, a.body)
		}
		return a.body["id"].(string)
	}
	if a := w.call("POST", "/v1/admin/whats-new", map[string]any{"title": "Hi", "body": "x"}, owner); a.status != 403 {
		t.Fatalf("an owner writes notes: %d", a.status)
	}
	forAll := note(map[string]any{"title": "Faster search", "body": "Search finds leads by street now."})
	forOwners := note(map[string]any{"title": "Billing page", "body": "See your plan's use.", "roles": []string{"owner"}})
	forSwitch := note(map[string]any{"title": "Team leads invite", "body": "Team leads invite into their teams.", "feature": "teams_v2"})
	ids := func(token string) []string {
		a := w.call("GET", "/v1/whats-new?org="+flowOrg, nil, token)
		out := []string{}
		for _, n := range a.body["notes"].([]any) {
			out = append(out, n.(map[string]any)["id"].(string))
		}
		return out
	}
	if got := ids(caller); len(got) != 1 || got[0] != forAll {
		t.Fatalf("the caller's notes: %v", got)
	}
	if got := ids(owner); len(got) != 2 || !slices.Contains(got, forOwners) || slices.Contains(got, forSwitch) {
		t.Fatalf("the owner's notes before the switch: %v", got)
	}
	w.call("POST", "/v1/whats-new/"+forAll+"/seen", nil, caller)
	if got := ids(caller); len(got) != 0 {
		t.Fatalf("a seen note again: %v", got)
	}

	// Early features: the owner, with the second step; then the switch's note shows.
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/early-features/teams_v2", map[string]any{"on": true}, caller); a.status != 403 {
		t.Fatalf("a member switches it: %d", a.status)
	}
	if a := w.call("PUT", "/v1/orgs/"+flowOrg+"/early-features/teams_v2", map[string]any{"on": true}, owner); a.status != 200 || a.body["features"].([]any)[0].(map[string]any)["on"] != true {
		t.Fatalf("switch on: %d %v", a.status, a.body)
	}
	if got := ids(caller); len(got) != 1 || got[0] != forSwitch {
		t.Fatalf("the switch's note: %v", got)
	}

	// Feedback: the page's path without ids.
	if a := w.call("POST", "/v1/feedback", map[string]any{"note": "The lead page is slow.", "page": "https://app.callerwhale.com/leads/0b7c2a3e-1f2d-4c5b-8a9e-112233445566?tab=notes#x", "version": "1.4.2", "org_id": flowOrg}, caller); a.status != 201 {
		t.Fatalf("feedback: %d %v", a.status, a.body)
	}
	a = w.call("GET", "/v1/admin/feedback", nil, staff)
	list := a.body["feedback"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["page"] != "/leads/:id" || list[0].(map[string]any)["version"] != "1.4.2" {
		t.Fatalf("staff feedback: %v", a.body)
	}
	fid := list[0].(map[string]any)["id"].(string)
	w.call("POST", "/v1/admin/feedback/"+fid+"/handled", nil, staff)
	if a := w.call("GET", "/v1/admin/feedback", nil, staff); len(a.body["feedback"].([]any)) != 0 {
		t.Fatalf("handled feedback still listed: %v", a.body)
	}
}
