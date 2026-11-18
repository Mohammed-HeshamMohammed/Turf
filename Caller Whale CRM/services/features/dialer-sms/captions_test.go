package main

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestReadingCaptionsForSignals(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	now := time.Date(2026, 11, 18, 14, 0, 0, 0, ny) // a Wednesday, 2 pm
	kinds := func(text string) []string {
		var out []string
		for _, h := range readSignals(text, now, ny, 8, 21) {
			out = append(out, h.kind)
		}
		slices.Sort(out)
		return out
	}
	for text, want := range map[string][]string{
		"How much would you offer for the house?":                {"asked_price"},
		"We need to sell soon, there's another offer already":    {"other_buyer", "sell_soon"},
		"Please stop calling me.":                                {"opt_out"},
		"I'm sick of all these companies calling me":             {"opt_out", "opt_out_anyone"},
		"Sure, you can come by and see the house":                {"meeting"},
		"I'm driving, can you call me back tomorrow at 5?":       {"callback"},
		"It's a nice day":                                        nil,
		"Let's stop at that price and talk about the roof later": nil,
	} {
		if got := kinds(text); !slices.Equal(got, want) {
			t.Errorf("%q: %v, want %v", text, got, want)
		}
	}
	at := func(text string) time.Time {
		for _, h := range readSignals(text, now, ny, 8, 21) {
			if h.kind == "callback" {
				return h.at.In(ny)
			}
		}
		t.Fatalf("no callback in %q", text)
		return time.Time{}
	}
	for text, want := range map[string]time.Time{
		"call me back tomorrow at 5": time.Date(2026, 11, 19, 17, 0, 0, 0, ny),
		"call me at 9 30 am":         time.Date(2026, 11, 19, 9, 30, 0, 0, ny), // 9:30 today has passed
		"try me in an hour":          time.Date(2026, 11, 18, 15, 0, 0, 0, ny),
		"call me back on friday":     time.Date(2026, 11, 20, 10, 0, 0, 0, ny),
		"call me tomorrow at 11 pm":  time.Date(2026, 11, 20, 8, 0, 0, 0, ny), // past calling hours: the next morning
		"can you call me back later": time.Date(2026, 11, 18, 16, 0, 0, 0, ny),
	} {
		if got := at(text); !got.Equal(want) {
			t.Errorf("%q: %v, want %v", text, got, want)
		}
	}
}

// Step 26, part B: captions run on an answered call when the AI or required captions are on, the lead's words become signals with a
// pre-selected outcome, the agent confirms them, and they reach the CRM's log; without either, the carrier is never asked to caption.
func TestCaptionsSignalsAndTheirOutcome(t *testing.T) {
	e := newEnv(t)
	plain := e.addLead("+15125557101")
	c := e.dial(plain, scenario{Name: "callback", Agent: "Reached"})
	e.sim.mu.Lock()
	asked := slices.ContainsFunc(e.sim.actions, func(a string) bool { return strings.HasSuffix(a, "|transcription_start") })
	e.sim.mu.Unlock()
	if asked || c.Captions {
		t.Fatal("captions ran with the AI and captions off")
	}

	lead := e.addLead("+15125557102")
	e.crm.mu.Lock()
	e.crm.leads[lead].AISuggestions = true
	e.crm.mu.Unlock()
	status, out := e.call("POST", "/api/v1/calls", map[string]any{"lead_id": lead, "scenario": "callback"})
	if status != 200 || out["captions"] != true {
		t.Fatalf("call: %d %v", status, out)
	}
	id := out["id"].(string)
	var seen map[string]any
	for i := 0; i < 50; i++ {
		_, seen = e.call("GET", "/api/v1/calls/"+id+"/captions", nil)
		if len(seen["signals"].([]any)) > 0 || !e.sim.step() {
			break
		}
	}
	if len(seen["captions"].([]any)) != 1 || seen["suggested_outcome"] != "Callback" {
		t.Fatalf("captions and the pre-selected outcome: %v", seen)
	}
	signal := seen["signals"].([]any)[0].(map[string]any)
	if signal["kind"] != "callback" || signal["suggested_at"] == nil {
		t.Fatalf("the callback signal: %v", signal)
	}
	// The lead says more: an opt-out from anyone, which the agent confirms.
	cc := *e.loadCall(id).CallControlID
	e.simCall("/sim/say", map[string]any{"call_control_id": cc, "text": "Actually, stop all these companies calling me"})
	e.sim.step()
	_, seen = e.call("GET", "/api/v1/calls/"+id+"/captions", nil)
	if seen["suggested_outcome"] != "Do not call" {
		t.Fatalf("an opt-out comes first: %v", seen)
	}
	var anyone string
	for _, s := range seen["signals"].([]any) {
		if s := s.(map[string]any); s["kind"] == "opt_out_anyone" {
			anyone = s["id"].(string)
		}
	}
	if anyone == "" {
		t.Fatalf("no opt-out for anyone: %v", seen)
	}
	if status, _ := e.call("POST", "/api/v1/calls/"+id+"/signals/"+anyone, map[string]any{"confirm": true}); status != 200 {
		t.Fatalf("confirm: %d", status)
	}
	e.sim.drain()
	e.settle()
	e.crm.mu.Lock()
	logged := e.crm.logged[id]
	e.crm.mu.Unlock()
	if logged["outcome"] != "Do not call" || logged["dnc_kind"] != "anyone" {
		t.Fatalf("the CRM's log: %v", logged)
	}
	if _, past := e.call("GET", "/api/v1/leads/"+lead+"/signals", nil); len(past["signals"].([]any)) < 3 {
		t.Fatalf("the lead's earlier signals for the next call: %v", past)
	}
	// The agency's keeping time removes older captions (D147).
	if status, _ := e.call("PUT", "/api/v1/calls/keep", map[string]any{"days": 7}); status != 200 {
		t.Fatalf("keep: %d", status)
	}
	ctx := context.Background()
	if _, err := e.s.st.db.Exec(ctx, `UPDATE call_captions SET at = now() - interval '8 days' WHERE call_id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if err := e.s.forgetOldCalls(ctx); err != nil {
		t.Fatal(err)
	}
	if _, seen = e.call("GET", "/api/v1/calls/"+id+"/captions", nil); len(seen["captions"].([]any)) != 0 {
		t.Fatalf("captions past the keeping time: %v", seen)
	}
}
