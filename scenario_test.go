package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Every call scenario, played through the real path (the dialer's carrier client -> the simulator's REST API -> signed
// webhooks -> the webhook handler -> settling -> the CRM), three ways: as Telnyx usually sends them, with every webhook sent
// twice, and with webhooks that happen together reversed and call.initiated held back. The CRM must log the same one call.
func TestEveryCallScenarioLogsTheRightOutcomeOnceWhateverTheWebhookOrder(t *testing.T) {
	for _, variant := range []string{"plain", "dupes", "reorder", "dupes+reorder"} {
		t.Run(variant, func(t *testing.T) {
			e := newEnv(t)
			e.sim.Dupes = strings.Contains(variant, "dupes")
			e.sim.Reorder = strings.Contains(variant, "reorder")
			for _, sc := range catalog {
				if sc.Kind != "call" {
					continue
				}
				t.Run(sc.Name, func(t *testing.T) {
					lead := e.addLead(fmt.Sprintf("(512) 555-%s", sc.Suffix))
					c := e.dial(lead, sc)
					payload := e.crm.logged[c.ID]
					if payload == nil {
						t.Fatalf("not logged: state %s %s %s", c.ReportState, c.CRMStatus, c.CRMMessage)
					}
					if payload["outcome"] != sc.Expect || c.Outcome != sc.Expect || c.ReportState != "reported" {
						t.Fatalf("want %s, got %v (call says %s, %s) %v", sc.Expect, payload["outcome"], c.Outcome, c.ReportState, payload["details"])
					}
					d := payload["details"].(map[string]any)
					switch sc.Name {
					case "human_answered":
						if d["talk_seconds"] != 45 || d["recording_url"] == nil || payload["recording_started_at"] == nil {
							t.Fatalf("talk time and recording: %v", d)
						}
					case "voicemail":
						if d["machine_detection"] != "machine" || d["voicemail_dropped"] != false {
							t.Fatalf("machine: %v", d)
						}
					case "voicemail_drop":
						if d["voicemail_dropped"] != true {
							t.Fatalf("voicemail not dropped: %v", d)
						}
					case "callback":
						if payload["callback_at"] == nil {
							t.Fatal("callback without a time")
						}
					case "transfer":
						if d["transferred_to"] != "+15550109999" {
							t.Fatalf("transfer: %v", d)
						}
					case "disconnected":
						if d["sip_code"] != "404" {
							t.Fatalf("sip: %v", d)
						}
					}
					if payload["source"] != "telnyx-sim" || payload["phone"] != e164(e.crm.leads[lead].Phone) {
						t.Fatalf("source and phone: %v", payload)
					}
				})
			}
			// One report per call: a repeated webhook never makes a second one.
			if e.crm.reports != len(e.crm.logged) {
				t.Fatalf("%d reports for %d calls", e.crm.reports, len(e.crm.logged))
			}
		})
	}
}

// dial places a call to the lead and acts as the caller would in the scenario, then lets everything settle.
func (e *env) dial(lead string, sc scenario) *callRow {
	e.t.Helper()
	ask := map[string]any{"lead_id": lead, "record": sc.Name == "human_answered"}
	if sc.Name == "voicemail_drop" {
		ask["voicemail_drop_url"] = "https://sim.callerwhale.invalid/vm.mp3"
	}
	status, out := e.call("POST", "/api/v1/calls", ask)
	if status != 200 {
		e.t.Fatalf("dial: %d %v", status, out)
	}
	id := out["id"].(string)
	stepUntil := func(done func(*callRow) bool) {
		for !done(e.loadCall(id)) {
			if !e.sim.step() {
				e.t.Fatal("the simulator ran out of steps")
			}
		}
	}
	switch sc.Agent {
	case "":
	case "hangup":
		stepUntil(func(c *callRow) bool { return c.CallControlID != nil && c.InitiatedAt != nil })
		if status, out := e.call("POST", "/api/v1/calls/"+id+"/hangup", map[string]any{}); status != 200 {
			e.t.Fatalf("hangup: %d %v", status, out)
		}
	case "transfer":
		stepUntil(func(c *callRow) bool { return c.AnsweredAt != nil })
		if status, out := e.call("POST", "/api/v1/calls/"+id+"/transfer", map[string]any{"to": "+15550109999"}); status != 200 {
			e.t.Fatalf("transfer: %d %v", status, out)
		}
	default:
		wrap := map[string]any{"outcome": sc.Agent}
		if sc.Agent == "Callback" {
			wrap["callback_at"] = e.now().Add(24 * time.Hour).Format(time.RFC3339)
		}
		if status, out := e.call("POST", "/api/v1/calls/"+id+"/disposition", wrap); status != 200 {
			e.t.Fatalf("disposition: %d %v", status, out)
		}
	}
	e.sim.drain()
	e.settle()
	return e.loadCall(id)
}

func TestAPersonAnsweredCallWaitsForTheCallerThenLogsReachedAfterTheWrapUpTime(t *testing.T) {
	e := newEnv(t)
	lead := e.addLead("+15125550001")
	c := e.dial(lead, scenario{Name: "human_answered"})
	if c.ReportState != "wrapup" || len(e.crm.logged) != 0 {
		t.Fatalf("should wait for the caller: %s", c.ReportState)
	}
	e.advance(11 * time.Minute)
	e.s.settleDue(context.Background())
	if c = e.loadCall(c.ID); e.crm.logged[c.ID]["outcome"] != "Reached" {
		t.Fatalf("after the wrap-up time: %s %v", c.ReportState, e.crm.logged[c.ID])
	}
	// Saying how it went after it was logged is refused, not logged twice.
	if status, _ := e.call("POST", "/api/v1/calls/"+c.ID+"/disposition", map[string]any{"outcome": "Not interested"}); status != 409 {
		t.Fatalf("late wrap-up: %d", status)
	}
}

func TestTheScenarioComesFromTheNumberWhenNotChosen(t *testing.T) {
	if got := simScenarioFor("", "+15125550004"); got != "busy" {
		t.Fatal(got)
	}
	if got := simScenarioFor("rejected", "+15125550004"); got != "rejected" {
		t.Fatal(got)
	}
	if got := simScenarioFor("nonsense", "+15125557777"); got != "human_answered" {
		t.Fatal(got)
	}
}

func TestADoNotCallLeadIsNotDialled(t *testing.T) {
	e := newEnv(t)
	lead := e.addLead("+15125550013")
	e.crm.leads[lead].DoNotCall = true
	if status, out := e.call("POST", "/api/v1/calls", map[string]any{"lead_id": lead}); status != 409 {
		t.Fatalf("dialled a do-not-call lead: %d %v", status, out)
	}
}

func TestAnInboundCallIsAnsweredAndLoggedOnTheLeadWhoCalled(t *testing.T) {
	for _, reorder := range []bool{false, true} {
		e := newEnv(t)
		e.sim.Reorder, e.sim.Dupes = reorder, reorder
		lead := e.addLead("+15125551234")
		if status, out := e.simCall("/sim/inbound-call", map[string]any{"from": "+15125551234", "to": e.number}); status != 200 {
			t.Fatalf("inbound: %d %v", status, out)
		}
		e.sim.drain()
		e.settle()
		if len(e.crm.logged) != 1 {
			t.Fatalf("reorder %v: logged %v", reorder, e.crm.logged)
		}
		for _, p := range e.crm.logged {
			if p["outcome"] != "Reached" || p["lead_id"] != lead || p["details"].(map[string]any)["direction"] != "incoming" {
				t.Fatalf("inbound log: %v", p)
			}
		}
	}
}

func TestACallToANumberNoWorkspaceHasIsIgnored(t *testing.T) {
	e := newEnv(t)
	e.simCall("/sim/inbound-call", map[string]any{"from": "+15125551234", "to": "+15125559999"})
	e.sim.drain()
	e.settle()
	if len(e.crm.logged) != 0 {
		t.Fatal("logged a call to a number nobody has")
	}
}

func TestTextsAreConversationsDeliveryMovesForwardAndStopIsObeyed(t *testing.T) {
	for _, variant := range []string{"plain", "dupes+reorder"} {
		t.Run(variant, func(t *testing.T) {
			e := newEnv(t)
			e.sim.Dupes, e.sim.Reorder = variant != "plain", variant != "plain"
			lead := e.addLead("+15125552222")
			send := func(scenario string) (int, map[string]any) {
				return e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Hello", "scenario": scenario})
			}
			if status, _ := send(""); status != 409 {
				t.Fatalf("cold text was not refused: %d", status)
			}
			e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125552222", "to": e.number, "text": "Hi, who is this?"})
			e.sim.drain()
			status, ok := send("sms_delivered")
			_, failed := send("sms_failed")
			if status != 200 {
				t.Fatalf("reply: %d %v", status, ok)
			}
			e.sim.drain()
			_, thread := e.call("GET", "/api/v1/sms?lead_id="+lead, nil)
			msgs := thread["messages"].([]any)
			if len(msgs) != 3 {
				t.Fatalf("thread: %v", msgs)
			}
			want := map[string]string{ok["id"].(string): "delivered", failed["id"].(string): "failed"}
			for _, m := range msgs {
				m := m.(map[string]any)
				if w, mine := want[m["id"].(string)]; mine && m["status"] != w {
					t.Fatalf("status: %v", m)
				}
				if m["direction"] == "incoming" && m["lead_id"] != lead {
					t.Fatalf("the reply is not on the lead: %v", m)
				}
			}
			e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125552222", "to": e.number, "text": "STOP"})
			e.sim.drain()
			if status, _ := send(""); status != 409 {
				t.Fatalf("texted after STOP: %d", status)
			}
			e.simCall("/sim/inbound-sms", map[string]any{"from": "+15125552222", "to": e.number, "text": "start"})
			e.sim.drain()
			if status, _ := send(""); status != 200 {
				t.Fatalf("START did not allow texts again: %d", status)
			}
		})
	}
}

func TestConsentOnAFormAllowsTheFirstText(t *testing.T) {
	e := newEnv(t)
	lead := e.addLead("+15125553333")
	if status, _ := e.call("POST", "/api/v1/sms/consent", map[string]any{"lead_id": lead, "source": "form"}); status != 200 {
		t.Fatal(status)
	}
	if status, out := e.call("POST", "/api/v1/sms", map[string]any{"lead_id": lead, "text": "Thanks for your form"}); status != 200 {
		t.Fatalf("%d %v", status, out)
	}
}

func TestWebhooksNotSignedByTheCarrierAreRefused(t *testing.T) {
	e := newEnv(t)
	body := []byte(`{"data":{"id":"x","event_type":"call.hangup","payload":{}}}`)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	for name, sign := range map[string]func() (string, string){
		"another key": func() (string, string) { return signWebhook(other, body, e.now()) },
		"too old":     func() (string, string) { return signWebhook(e.sim.key, body, e.now().Add(-10*time.Minute)) },
		"no header":   func() (string, string) { return "", "" },
	} {
		sig, ts := sign()
		req, _ := http.NewRequest("POST", e.ts.URL+"/webhooks/telnyx", strings.NewReader(string(body)))
		req.Header.Set("telnyx-signature-ed25519", sig)
		req.Header.Set("telnyx-timestamp", ts)
		if status, _ := e.send(req); status != 401 {
			t.Fatalf("%s: %d", name, status)
		}
	}
}

func TestTheBrowserGetsACallingTokenAndNeverTheAccountKey(t *testing.T) {
	e := newEnv(t)
	status, out := e.call("POST", "/api/v1/calls/token", map[string]any{})
	if status != 200 || !strings.HasPrefix(out["token"].(string), "sim.") || strings.Contains(fmt.Sprint(out), "sim-key") {
		t.Fatalf("%d %v", status, out)
	}
}

// The `scenarios` command, against a dialer whose simulator runs on its own clock (50 times real time) with the real timers:
// what the owner runs to try everything.
func TestTheScenariosCommandPassesAgainstARunningDialer(t *testing.T) {
	e := newEnv(t)
	e.s.now, e.sim.now = time.Now, time.Now
	e.s.cfg.noTimers, e.s.cfg.settleDelay = false, 100*time.Millisecond
	e.sim.speed = 50
	lead := e.addLead("+15125557777")
	token := e.fx.sign("k1", "EdDSA", func(m map[string]any) { m["sub"] = e.user })
	code := runScenarios([]string{"-dialer", e.ts.URL, "-token", token, "-org", e.org, "-lead", lead, "-phone", "+15125557777", "-sim-key", "sim-key"})
	if code != 0 {
		t.Fatalf("scenarios exited %d", code)
	}
	if len(e.crm.logged) != 14 { // 13 dialled calls and the inbound one
		t.Fatalf("logged %d calls", len(e.crm.logged))
	}
}
