package main

import (
	"context"
	"testing"
)

// Step 44, D367: after a person's data is deleted in the CRM, the dialer removes its calls and texts with that number in that agency,
// keeps the number from being texted again, leaves everyone else's alone, and says it is done.
func TestErasureRemovesANumbersCallsAndTexts(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	gone := e.addLead("+15125557701")
	kept := e.addLead("+15125557702")
	for _, from := range []string{"+15125557701", "+15125557702"} {
		e.simCall("/sim/inbound-sms", map[string]any{"from": from, "to": e.number, "text": "Hello from " + from})
	}
	e.sim.drain()
	if status, out := e.call("POST", "/api/v1/calls", map[string]any{"lead_id": gone}); status != 200 {
		t.Fatalf("call: %d %v", status, out)
	}
	_ = kept
	count := func(sql string) int {
		var n int
		if err := e.s.st.db.QueryRow(ctx, sql, e.org).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(`SELECT count(*) FROM sms_messages WHERE org_id = $1 AND from_number = '+15125557701'`) != 1 || count(`SELECT count(*) FROM calls WHERE org_id = $1 AND to_number = '+15125557701'`) != 1 {
		t.Fatal("the setup did not make the text and the call")
	}
	e.crm.mu.Lock()
	e.crm.toErase = []erasure{{ID: "req-1", OrgID: e.org, PhoneKey: "5125557701"}}
	e.crm.mu.Unlock()
	e.s.eraseRequested(ctx)

	if n := count(`SELECT count(*) FROM sms_messages WHERE org_id = $1 AND (from_number = '+15125557701' OR to_number = '+15125557701')`); n != 0 {
		t.Fatalf("texts left: %d", n)
	}
	if n := count(`SELECT count(*) FROM calls WHERE org_id = $1 AND (to_number = '+15125557701' OR from_number = '+15125557701')`); n != 0 {
		t.Fatalf("calls left: %d", n)
	}
	if n := count(`SELECT count(*) FROM sms_messages WHERE org_id = $1 AND from_number = '+15125557702'`); n != 1 {
		t.Fatalf("another person's text was removed: %d", n)
	}
	if n := count(`SELECT count(*) FROM sms_opt_outs WHERE org_id = $1 AND phone_number = '+15125557701'`); n != 1 {
		t.Fatal("the number can be texted again")
	}
	e.crm.mu.Lock()
	defer e.crm.mu.Unlock()
	if len(e.crm.erased) != 1 || e.crm.erased[0] != "req-1" {
		t.Fatalf("the CRM was not told: %v", e.crm.erased)
	}
}
