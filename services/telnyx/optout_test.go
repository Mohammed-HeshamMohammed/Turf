package telnyx

import (
	"context"
	"testing"
)

func TestReadingARepliesForAnOptOut(t *testing.T) {
	for text, want := range map[string]optOutReading{
		"STOP":                     {clear: true, calls: true, texts: true},
		"Stop.":                    {clear: true, calls: true, texts: true},
		"stop texting me please":   {clear: true, texts: true},
		"Stop calling me!":         {clear: true, calls: true},
		"Don't call me again":      {clear: true, calls: true},
		"Leave me alone":           {clear: true, calls: true, texts: true},
		"never call me again":      {clear: true, calls: true, texts: true},
		"let's stop at that price": {unclear: true},
		"please stop all these companies calling me": {unclear: true},
		"Sounds good, call me tomorrow":              {},
		"":                                           {},
	} {
		if got := readOptOut(text); got != want {
			t.Errorf("%q: %+v, want %+v", text, got, want)
		}
	}
}

// Step 25: a reply that is only an opt-out blocks at once, texts or calls or both as it says (D207, D209, D351); one that mentions
// "stop" waits for the agent's choice (D208); consent belongs to the lead's client (D366), a list's confirmation counts (D355), and
// after 6 months without contact it is confirmed again (D358).
func TestOptOutRepliesAndConsent(t *testing.T) {
	e := newEnv(t)
	const phone = "+15125557001"
	lead := e.addLead(phone)
	text := func(id string) (int, map[string]any) {
		return e.call("POST", "/api/v1/sms", map[string]any{"lead_id": id, "text": "Hello"})
	}
	reply := func(body string) {
		e.simCall("/sim/inbound-sms", map[string]any{"from": phone, "to": e.number, "text": body})
		e.sim.drain()
	}
	reply("Hi, who is this?")
	if status, out := text(lead); status != 200 {
		t.Fatalf("the lead's own reply is consent: %d %v", status, out)
	}

	// "stop" inside a sentence: nothing is sent until the agent chooses.
	reply("Let's stop at that price, ok?")
	if status, _ := text(lead); status != 409 {
		t.Fatalf("texted before choosing: %d", status)
	}
	_, thread := e.call("GET", "/api/v1/sms?lead_id="+lead, nil)
	waiting := ""
	for _, m := range thread["messages"].([]any) {
		if m := m.(map[string]any); m["opt_out_question"] == "waiting" {
			waiting = m["id"].(string)
		}
	}
	if waiting == "" {
		t.Fatalf("the reply is not marked as waiting: %v", thread)
	}
	if status, _ := e.call("POST", "/api/v1/sms/"+waiting+"/opt-out", map[string]any{"opt_out": false}); status != 200 {
		t.Fatalf("choose: %d", status)
	}
	if status, _ := text(lead); status != 200 {
		t.Fatalf("texting after 'not an opt-out': %d", status)
	}

	// "Stop calling me" stops calls only.
	reply("Stop calling me")
	e.crm.mu.Lock()
	b := e.crm.blocks[phone]
	e.crm.mu.Unlock()
	if b["calls"] != true || b["texts"] != false {
		t.Fatalf("calls-only block: %v", b)
	}
	if status, _ := text(lead); status != 200 {
		t.Fatalf("texts were blocked by 'stop calling me': %d", status)
	}

	// "Leave me alone" stops both, and START lifts what the reply made.
	reply("Leave me alone!")
	if status, _ := text(lead); status != 409 {
		t.Fatalf("texted after 'leave me alone': %d", status)
	}
	reply("START")
	if status, out := text(lead); status != 200 {
		t.Fatalf("START: %d %v", status, out)
	}

	// Consent is per client: the same number under another client needs its own.
	const shared = "+15125557002"
	ours, theirs := e.addLead(shared), e.addLead(shared)
	e.crm.mu.Lock()
	e.crm.leads[ours].ClientID, e.crm.leads[theirs].ClientID = newUUID(), newUUID()
	e.crm.mu.Unlock()
	if status, _ := e.call("POST", "/api/v1/sms/consent", map[string]any{"lead_id": ours, "source": "call"}); status != 200 {
		t.Fatalf("consent: %d", status)
	}
	if status, _ := text(ours); status != 200 {
		t.Fatalf("texting with the client's consent: %d", status)
	}
	if status, _ := text(theirs); status != 409 {
		t.Fatalf("another client's consent was used: %d", status)
	}

	// A list the agency confirmed consent for.
	listed := e.addLead("+15125557003")
	e.crm.mu.Lock()
	e.crm.leads[listed].ListConsent = true
	e.crm.mu.Unlock()
	if status, _ := text(listed); status != 200 {
		t.Fatalf("list consent: %d", status)
	}

	// Six months without contact: confirmed again on a call.
	old := e.addLead("+15125557004")
	e.call("POST", "/api/v1/sms/consent", map[string]any{"lead_id": old, "source": "form"})
	if _, err := e.s.st.db.Exec(context.Background(), `UPDATE sms_consents SET at = now() - interval '200 days' WHERE phone_number = '+15125557004'`); err != nil {
		t.Fatal(err)
	}
	if status, _ := text(old); status != 409 {
		t.Fatalf("texted after 6 months without contact: %d", status)
	}
	e.call("POST", "/api/v1/sms/consent", map[string]any{"lead_id": old, "source": "call"})
	if status, _ := text(old); status != 200 {
		t.Fatalf("texting after confirming again: %d", status)
	}
}
