package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// stepped is a confirmed account that has passed its second step, as owners and new owners must for a handover.
func (w *world) stepped(email string) answer {
	w.t.Helper()
	account := w.confirmed(email)
	w.addDevice(account.access(), "Phone")
	return w.call("POST", "/v1/sessions/refresh", map[string]any{"refresh_token": account.refresh()}, "")
}

// Step 13: the owner offers the agency to a member and chooses their own next role; the member accepts with their second step, and
// only once they pay when the agency pays through the provider (D28, D70, D199, D200). An offer can be cancelled and lapses. An agency
// whose owner is gone is paused by staff, and after 14 days an admin's takeover can be approved (D27, D201).
func TestOwnershipHandoverAndTakeover(t *testing.T) {
	w, fake, _ := lifecycleWorld(t)
	// The owner of the agency, with a second step, and two members.
	ownerTok := w.stepped("boss@example.com").access()
	boss, nia, ola := w.idOf("boss@example.com"), "", ""
	niaPlain := w.confirmed("nia@example.com").access()
	niaTok := w.stepped("nia2@example.com").access()
	nia, ola = w.idOf("nia2@example.com"), w.idOf("nia@example.com")
	fake.mu.Lock()
	fake.owner = boss
	fake.joined[nia], fake.joined[ola] = true, true
	fake.roles = map[string][]string{nia: {"caller"}, ola: {"admin"}}
	fake.mu.Unlock()

	offer := func(token string, body map[string]any) answer {
		return w.call("POST", "/v1/orgs/"+flowOrg+"/handover", body, token)
	}
	if a := offer(niaTok, map[string]any{"to": ola, "old_role": "admin"}); a.status != 403 {
		t.Fatalf("someone who is not the owner offers it: %d", a.status)
	}
	if a := offer(ownerTok, map[string]any{"to": "00000000-0000-4000-8000-000000000000", "old_role": "admin"}); a.status != 400 {
		t.Fatalf("to someone outside the agency: %d", a.status)
	}
	if a := offer(ownerTok, map[string]any{"to": nia, "old_role": "caller"}); a.status != 400 {
		t.Fatalf("the old owner as a caller: %d", a.status)
	}
	made := offer(ownerTok, map[string]any{"to": nia, "old_role": "admin"})
	if made.status != 201 {
		t.Fatalf("offer: %d %v", made.status, made.body)
	}
	if a := offer(ownerTok, map[string]any{"to": ola, "old_role": "leave"}); a.status != 409 {
		t.Fatalf("a second offer while one waits: %d", a.status)
	}
	if a := w.call("GET", "/v1/orgs/"+flowOrg+"/handover", nil, ownerTok); a.body["handover"].(map[string]any)["to_id"] != nia {
		t.Fatalf("the owner sees the offer: %v", a.body)
	}
	mine := w.call("GET", "/v1/me/handovers", nil, niaTok)
	list, _ := mine.body["handovers"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["org_name"] != "Blue Door Homes" {
		t.Fatalf("the member sees the offer: %v", mine.body)
	}
	id := made.str("id")

	// Accepting needs the second step; with a paid subscription, only once the new owner pays for it.
	if a := w.call("POST", "/v1/me/handovers/"+id+"/accept", nil, niaPlain); a.status != 403 || a.str("code") != "mfa_required" {
		t.Fatalf("accepting without a second step (and not offered to them): %d", a.status)
	}
	payer := boss
	billing := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write([]byte(`{"provider_paid":true,"payer_id":"` + payer + `"}`))
	}))
	defer billing.Close()
	w.s.cfg.billingURL, w.s.cfg.billingToken = billing.URL, "token"
	if a := w.call("POST", "/v1/me/handovers/"+id+"/accept", nil, niaTok); a.status != 409 || a.str("code") != "payment_needed" {
		t.Fatalf("before the new owner pays: %d %v", a.status, a.body)
	}
	payer = nia
	if a := w.call("POST", "/v1/me/handovers/"+id+"/accept", nil, niaTok); a.status != 200 {
		t.Fatalf("accept: %d %v", a.status, a.body)
	}
	fake.mu.Lock()
	newOwner, oldRoles := fake.owner, fake.roles[boss]
	fake.mu.Unlock()
	if newOwner != nia || len(oldRoles) != 1 || oldRoles[0] != "admin" {
		t.Fatalf("after the handover: owner %s, old owner's roles %v", newOwner, oldRoles)
	}
	if a := w.call("POST", "/v1/me/handovers/"+id+"/accept", nil, niaTok); a.status != 404 {
		t.Fatalf("accepting twice: %d", a.status)
	}
	w.s.cfg.billingURL = ""

	// An offer can be cancelled, and lapses after 7 days.
	if a := offer(niaTok, map[string]any{"to": boss, "old_role": "leave"}); a.status != 201 {
		t.Fatalf("offer back: %d %v", a.status, a.body)
	}
	if a := w.call("DELETE", "/v1/orgs/"+flowOrg+"/handover", nil, niaTok); a.status != 200 {
		t.Fatalf("cancel: %d", a.status)
	}
	lapsed := offer(niaTok, map[string]any{"to": boss, "old_role": "leave"})
	w.exec("UPDATE ownership_handovers SET expires_at = $1 WHERE id = $2", now()-1, lapsed.str("id"))
	if a := w.call("POST", "/v1/me/handovers/"+lapsed.str("id")+"/accept", nil, ownerTok); a.status != 404 {
		t.Fatalf("a lapsed offer: %d", a.status)
	}

	// The owner is gone: staff pause the agency; after 14 days an admin's takeover can be approved.
	staffTok := w.stepped("staff@example.com").access()
	fake.mu.Lock()
	fake.staff = w.idOf("staff@example.com")
	fake.mu.Unlock()
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/takeover", nil, func() string { return w.signInWith("nia@example.com", nil).access() }()); a.status != 409 {
		t.Fatalf("a takeover of an agency that is not paused: %d", a.status)
	}
	if a := w.call("PUT", "/v1/admin/workspaces/"+flowOrg+"/paused", map[string]any{"on": true}, ownerTok); a.status != 403 {
		t.Fatalf("someone who is not staff pauses: %d", a.status)
	}
	if a := w.call("PUT", "/v1/admin/workspaces/"+flowOrg+"/paused", map[string]any{"on": true}, staffTok); a.status != 200 || !fake.paused {
		t.Fatalf("pause: %d %v", a.status, a.body)
	}
	olaTok := w.signInWith("nia@example.com", nil).access()
	if a := w.call("POST", "/v1/orgs/"+flowOrg+"/takeover", nil, niaTok); a.status != 403 {
		t.Fatalf("someone who is not an admin asks: %d", a.status)
	}
	asked := w.call("POST", "/v1/orgs/"+flowOrg+"/takeover", nil, olaTok)
	if asked.status != 201 {
		t.Fatalf("an admin asks: %d %v", asked.status, asked.body)
	}
	waiting := w.call("GET", "/v1/admin/takeovers", nil, staffTok)
	if items, _ := waiting.body["requests"].([]any); len(items) != 1 {
		t.Fatalf("staff see the request: %v", waiting.body)
	}
	if a := w.call("POST", "/v1/admin/takeovers/"+asked.str("id")+"/approve", nil, staffTok); a.status != 409 {
		t.Fatalf("approved before 14 days: %d %v", a.status, a.body)
	}
	w.exec("UPDATE paused_workspaces SET paused_at = $1", now()-15*86_400)
	if a := w.call("POST", "/v1/admin/takeovers/"+asked.str("id")+"/approve", nil, staffTok); a.status != 200 {
		t.Fatalf("approve: %d %v", a.status, a.body)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.owner != ola || fake.paused || fake.joined[nia] {
		t.Fatalf("after the takeover: owner %s, paused %v, old owner still in %v", fake.owner, fake.paused, fake.joined[nia])
	}
}
