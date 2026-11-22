package telnyx

import (
	"context"
	"testing"
	"time"
)

// Step 39: with the carrier check on, nobody calls before the agency's brand is verified or texts before its campaign is provisioned;
// the owner enters the business and submits; the brand, then the campaign, then the numbers follow; the CRM is told (D268, D314).
func TestCarrierRegistrationOpensCallingThenTexting(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.s.cfg.carrierCheck = true
	rules := e.s.rules.(*fakeRules)
	g := rules.grants[e.user+"|"+e.org]
	g.Roles = []string{"owner"}
	rules.grants[e.user+"|"+e.org] = g
	lead := e.addLead("+15125554444")
	e.s.st.db.Exec(ctx, `INSERT INTO sms_consents (org_id, client_key, phone_number, source) VALUES ($1, '', '+15125554444', 'form')`, e.org)

	if status, out := e.call("POST", "/api/v1/calls", map[string]any{"lead_id": lead}); status != 403 || out["error"].(map[string]any)["code"] != "carrier_check" {
		t.Fatalf("a call before the carrier check: %d %v", status, out)
	}
	if status, out := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Hi"}); status != 403 || out["error"].(map[string]any)["code"] != "carrier_check" {
		t.Fatalf("a text before the carrier check: %d %v", status, out)
	}
	biz := map[string]any{"entity_type": "PRIVATE_PROFIT", "legal_name": "Blue Door Homes LLC", "display_name": "Blue Door Homes", "ein": "12-3456789",
		"email": "owner@bluedoor.test", "phone": "512-555-0100", "street": "1 Main St", "city": "Austin", "state": "tx", "postal_code": "78701"}
	if status, _ := e.call("POST", "/api/v1/carrier/submit", nil); status != 400 {
		t.Fatalf("submitted without details: %d", status)
	}
	if status, _ := e.call("PUT", "/api/v1/carrier", map[string]any{"business": biz}); status != 200 {
		t.Fatalf("details: %d", status)
	}
	status, out := e.call("POST", "/api/v1/carrier/submit", nil)
	// The simulator verifies the brand when it is read, so the campaign is created at once.
	if status != 200 || out["state"] != "campaign_pending" || out["may_call"] != true || out["may_text"] != false {
		t.Fatalf("submit: %d %v", status, out)
	}
	if status, _ := e.call("PUT", "/api/v1/carrier", map[string]any{"business": biz}); status != 409 {
		t.Fatalf("changed while with the carriers: %d", status)
	}
	if err := e.s.advanceRegistration(ctx, e.org); err != nil {
		t.Fatal(err)
	}
	_, out = e.call("GET", "/api/v1/carrier", nil)
	if out["state"] != "approved" || out["may_text"] != true {
		t.Fatalf("after the campaign: %v", out)
	}
	var numberStatus string
	_ = e.s.st.db.QueryRow(ctx, `SELECT campaign_status FROM numbers WHERE phone_number = $1`, e.number).Scan(&numberStatus)
	if numberStatus != "ASSIGNED" {
		t.Fatalf("the number is not on the campaign: %q", numberStatus)
	}
	if status, out := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Hi"}); status != 200 {
		t.Fatalf("a text after approval: %d %v", status, out)
	}
	e.crm.mu.Lock()
	told := e.crm.carriers[e.org]
	e.crm.mu.Unlock()
	if told["state"] != "approved" || told["may_text"] != true {
		t.Fatalf("the CRM was told: %v", told)
	}

	// A brand the carriers refuse can be corrected and sent again.
	other := newUUID()
	rules.grants[e.user+"|"+other] = g
	saved := e.org
	e.org = other
	biz["display_name"] = "Refused Homes"
	e.call("PUT", "/api/v1/carrier", map[string]any{"business": biz})
	if _, out := e.call("POST", "/api/v1/carrier/submit", nil); out["state"] != "brand_failed" || out["registration"].(map[string]any)["brand_failure"] == "" {
		t.Fatalf("a refused brand: %v", out)
	}
	biz["display_name"] = "Day Homes"
	if status, _ := e.call("PUT", "/api/v1/carrier", map[string]any{"business": biz}); status != 200 {
		t.Fatalf("corrected after a refusal: %d", status)
	}
	if _, out := e.call("POST", "/api/v1/carrier/submit", nil); out["state"] != "campaign_pending" {
		t.Fatalf("sent again: %v", out)
	}
	e.org = saved
}

// Step 39: opt-out and complaint rates warn, then limit, then suspend the agency's texting; the owner appeals; staff clear it (D269).
func TestTextingStandingRisesAndStaffClearIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	rules := e.s.rules.(*fakeRules)
	g := rules.grants[e.user+"|"+e.org]
	g.Roles = []string{"owner"}
	rules.grants[e.user+"|"+e.org] = g
	if !isComplaint("This is SPAM, I reported you") || isComplaint("Is the house still for sale?") {
		t.Fatal("complaint words")
	}
	// 120 texts and 10 opt-outs: 8.3%, past the suspension line.
	for i := 0; i < 120; i++ {
		e.s.st.db.Exec(ctx, `INSERT INTO sms_messages (id, org_id, direction, from_number, to_number, body, status) VALUES ($1, $2, 'outgoing', $3, '+15125550199', 'Hi', 'delivered')`, newUUID(), e.org, e.number)
	}
	for i := 0; i < 10; i++ {
		e.s.st.db.Exec(ctx, `INSERT INTO sms_messages (id, org_id, direction, from_number, to_number, body, status, opt_out_question) VALUES ($1, $2, 'incoming', '+15125550199', $3, 'STOP', 'received', 'opt_out')`, newUUID(), e.org, e.number)
	}
	step := func() string {
		st, _ := e.s.standingOf(ctx, e.org)
		return st.Step
	}
	e.s.judgeAll(ctx)
	if step() != "warned" {
		t.Fatalf("first: %s", step())
	}
	e.s.judgeAll(ctx)
	if step() != "warned" {
		t.Fatalf("more than one step a day: %s", step())
	}
	e.advance(25 * time.Hour)
	e.s.judgeAll(ctx)
	lead := e.addLead("+15125554545")
	if step() != "limited" {
		t.Fatalf("second: %s", step())
	}
	if status, out := e.call("POST", "/api/v1/sms/bulk", map[string]any{"lead_ids": []string{lead}, "text": "Hi"}); status != 403 || out["error"].(map[string]any)["code"] != "texting_limited" {
		t.Fatalf("bulk while limited: %d %v", status, out)
	}
	e.advance(25 * time.Hour)
	e.s.judgeAll(ctx)
	if step() != "suspended" {
		t.Fatalf("third: %s", step())
	}
	if status, out := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Hi"}); status != 403 || out["error"].(map[string]any)["code"] != "texting_suspended" {
		t.Fatalf("a text while suspended: %d %v", status, out)
	}
	if status, _ := e.call("POST", "/api/v1/carrier/appeal", map[string]any{"note": "A bad list from a vendor; we removed it."}); status != 200 {
		t.Fatalf("appeal: %d", status)
	}
	if status, _ := e.call("POST", "/api/v1/carrier/appeal", map[string]any{"note": "And again, please look."}); status != 409 {
		t.Fatalf("a second appeal: %d", status)
	}
	e.crm.mu.Lock()
	told := e.crm.carriers[e.org]
	cleared := e.now().Add(time.Minute)
	e.crm.clearedAt = &cleared
	e.crm.mu.Unlock()
	if told["step"] != "suspended" || told["appeal"] == "" {
		t.Fatalf("the CRM was told: %v", told)
	}
	// Staff clear it in the CRM; the dialer learns it on its next report.
	e.s.tellCRM(ctx, e.org)
	if step() != "ok" {
		t.Fatalf("after the staff review: %s", step())
	}
	var kept int
	_ = e.s.st.db.QueryRow(ctx, `SELECT count(*) FROM texting_steps WHERE org_id = $1`, e.org).Scan(&kept)
	if kept != 5 { // warned, limited, suspended, appealed, cleared
		t.Fatalf("steps kept: %d", kept)
	}
}
