package main

// The simulator's scenarios, and `dialer-sms scenarios`: a command that plays them against a running dialer in simulate
// mode, acting as the caller (hanging up, transferring, saying how the call went), and prints what the CRM logged.

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type scenario struct {
	Name   string `json:"name"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`             // call, inbound, sms
	Suffix string `json:"suffix,omitempty"` // a dialled number ending in these digits plays this scenario
	Expect string `json:"expect"`           // the CRM outcome (calls) or the text's status (texts)
	Agent  string `json:"agent,omitempty"`  // what the caller does: hangup, transfer, or the outcome they choose
}

// The order is the order `scenarios` runs them in: do-not-call last, because after it the lead can no longer be called.
var catalog = []scenario{
	{"human_answered", "A person answers, talks, and hangs up normally", "call", "0001", "Reached", "Reached"},
	{"voicemail", "An answering machine answers; the dialer hangs up", "call", "0002", "Voicemail", ""},
	{"voicemail_drop", "An answering machine answers; a recorded voicemail is left after the beep", "call", "0012", "Voicemail", ""},
	{"no_answer", "It rings until the ring timeout", "call", "0003", "No answer", ""},
	{"busy", "The line is busy", "call", "0004", "Not available", ""},
	{"disconnected", "The number is not in service", "call", "0005", "Disconnected", ""},
	{"carrier_failure", "The carrier cannot complete the call (503)", "call", "0006", "Dead call", ""},
	{"rejected", "The lead rejects the call", "call", "0007", "Not available", ""},
	{"caller_hangup", "The caller hangs up before it is answered", "call", "0008", "No answer", "hangup"},
	{"dropped", "A person answers, then the call drops", "call", "0009", "Dead call", "auto"},
	{"transfer", "A person answers and is transferred to a closer", "call", "0010", "Transfer", "transfer"},
	{"callback", "A person answers and asks to be called back", "call", "0011", "Callback", "Callback"},
	{"inbound_call", "The lead calls a workspace number", "inbound", "", "Reached", ""},
	{"sms_inbound_reply", "The lead texts the workspace", "sms", "", "received", ""},
	{"sms_delivered", "A text to the lead is delivered", "sms", "", "delivered", ""},
	{"sms_failed", "A text to the lead fails", "sms", "", "failed", ""},
	{"sms_stop", "The lead replies STOP; the next text is refused", "sms", "", "refused", ""},
	{"do_not_call", "A person answers and asks never to be called", "call", "0013", "Do not call", "Do not call"},
}

func findScenario(name string) *scenario {
	for i := range catalog {
		if catalog[i].Name == name {
			return &catalog[i]
		}
	}
	return nil
}

// simScenarioFor picks a dialled call's scenario: the header, else the number's last four digits, else a person answers.
func simScenarioFor(header, to string) string {
	if sc := findScenario(strings.TrimSpace(header)); sc != nil && sc.Kind == "call" {
		return sc.Name
	}
	for _, sc := range catalog {
		if sc.Suffix != "" && strings.HasSuffix(to, sc.Suffix) {
			return sc.Name
		}
	}
	return "human_answered"
}

// ------------------------------------------------------------------------------------------------------------- the command

type runner struct {
	dialer, token, org, lead, phone, number, simKey, closer string
	http                                                    *http.Client
}

func (r *runner) do(method, url string, body, into any, key string) (int, error) {
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	} else {
		req.Header.Set("Authorization", "Bearer "+r.token)
		req.Header.Set("x-callerwhale-org", r.org)
	}
	res, err := r.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if into != nil {
		_ = json.Unmarshal(data, into)
	}
	if res.StatusCode/100 != 2 {
		return res.StatusCode, fmt.Errorf("%s %s: %d %s", method, url, res.StatusCode, strings.TrimSpace(string(data)))
	}
	return res.StatusCode, nil
}

func (r *runner) call(id string) (callRow, error) {
	var c callRow
	_, err := r.do("GET", r.dialer+"/api/v1/calls/"+id, nil, &c, "")
	return c, err
}

// waitCall polls a call until want says yes, for up to five minutes.
func (r *runner) waitCall(id string, want func(callRow) bool) (callRow, error) {
	deadline := time.Now().Add(5 * time.Minute)
	for {
		c, err := r.call(id)
		if err == nil && want(c) {
			return c, nil
		}
		if time.Now().After(deadline) {
			return c, fmt.Errorf("gave up waiting (state %s)", c.ReportState)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func logged(c callRow) bool {
	return c.ReportState == "reported" || c.ReportState == "failed" || c.ReportState == "skipped"
}

func (r *runner) runCall(sc scenario) (string, string) {
	ask := map[string]any{"lead_id": r.lead, "scenario": sc.Name, "record": sc.Name == "human_answered"}
	if sc.Name == "voicemail_drop" {
		ask["voicemail_drop_url"] = "https://sim.callerwhale.invalid/voicemail.mp3"
	}
	var c callRow
	if _, err := r.do("POST", r.dialer+"/api/v1/calls", ask, &c, ""); err != nil {
		return "", err.Error()
	}
	switch sc.Agent {
	case "":
	case "hangup":
		if _, err := r.waitCall(c.ID, func(c callRow) bool { return c.InitiatedAt != nil }); err != nil {
			return "", err.Error()
		}
		if _, err := r.do("POST", r.dialer+"/api/v1/calls/"+c.ID+"/hangup", map[string]any{}, nil, ""); err != nil {
			return "", err.Error()
		}
	case "transfer":
		if _, err := r.waitCall(c.ID, func(c callRow) bool { return c.AnsweredAt != nil }); err != nil {
			return "", err.Error()
		}
		if _, err := r.do("POST", r.dialer+"/api/v1/calls/"+c.ID+"/transfer", map[string]any{"to": r.closer}, nil, ""); err != nil {
			return "", err.Error()
		}
	default:
		wrap := map[string]any{"outcome": sc.Agent, "notes": "Simulated: " + sc.Title}
		if sc.Agent == "Callback" {
			wrap["callback_at"] = time.Now().Add(24 * time.Hour).Format(time.RFC3339)
		}
		if _, err := r.do("POST", r.dialer+"/api/v1/calls/"+c.ID+"/disposition", wrap, nil, ""); err != nil {
			return "", err.Error()
		}
	}
	c, err := r.waitCall(c.ID, logged)
	if err != nil {
		return c.Outcome, err.Error()
	}
	return c.Outcome, c.ReportState + " " + c.CRMStatus + " " + c.CRMMessage
}

func (r *runner) runInbound() (string, string) {
	if r.phone == "" || r.number == "" {
		return "", "needs -phone (the lead's number) and a workspace number (-number, or one set up with PUT /api/v1/numbers)"
	}
	started := time.Now().Add(-time.Second)
	if _, err := r.do("POST", r.dialer+"/telnyx-sim/sim/inbound-call", map[string]any{"from": r.phone, "to": r.number}, nil, r.simKey); err != nil {
		return "", err.Error()
	}
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		var list struct{ Calls []callRow }
		if _, err := r.do("GET", r.dialer+"/api/v1/calls", nil, &list, ""); err == nil {
			for _, c := range list.Calls {
				if c.Direction == "incoming" && c.CreatedAt.After(started) && logged(c) {
					return c.Outcome, c.ReportState + " " + c.CRMStatus + " " + c.CRMMessage
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return "", "gave up waiting for the inbound call"
}

func (r *runner) runText(sc scenario) (string, string) {
	inbound := func(text string) error {
		if r.phone == "" || r.number == "" {
			return fmt.Errorf("needs -phone and a workspace number")
		}
		_, err := r.do("POST", r.dialer+"/telnyx-sim/sim/inbound-sms", map[string]any{"from": r.phone, "to": r.number, "text": text}, nil, r.simKey)
		time.Sleep(2 * time.Second)
		return err
	}
	send := func(scenarioName string) (smsRow, int, error) {
		var m smsRow
		status, err := r.do("POST", r.dialer+"/api/v1/sms", map[string]any{"lead_id": r.lead, "text": "Simulated text (" + sc.Name + ")", "scenario": scenarioName}, &m, "")
		return m, status, err
	}
	waitText := func(id string) string {
		for i := 0; i < 600; i++ {
			var thread struct{ Messages []smsRow }
			_, _ = r.do("GET", r.dialer+"/api/v1/sms?lead_id="+r.lead, nil, &thread, "")
			for _, m := range thread.Messages {
				if m.ID == id && (m.Status == "delivered" || m.Status == "failed") {
					return m.Status + " " + m.Error
				}
			}
			time.Sleep(500 * time.Millisecond)
		}
		return "no delivery report"
	}
	switch sc.Name {
	case "sms_inbound_reply":
		if err := inbound("Hi, yes I might sell. Call me."); err != nil {
			return "", err.Error()
		}
		return "received", "the reply is in the lead's thread (GET /api/v1/sms?lead_id=)"
	case "sms_delivered", "sms_failed":
		m, _, err := send(sc.Name)
		if err != nil {
			return "", err.Error()
		}
		got := waitText(m.ID)
		return strings.Fields(got + " ")[0], got
	case "sms_stop":
		if err := inbound("STOP"); err != nil {
			return "", err.Error()
		}
		_, status, err := send("sms_delivered")
		result := "sent anyway"
		if status == http.StatusConflict {
			result = "refused"
		}
		_ = inbound("START") // so the lead can be texted again
		if err != nil {
			return result, err.Error()
		}
		return result, ""
	}
	return "", "unknown"
}

func runScenarios(args []string) int {
	fs := flag.NewFlagSet("scenarios", flag.ExitOnError)
	r := &runner{http: &http.Client{Timeout: 30 * time.Second}}
	only := fs.String("only", "", "run one scenario (see -list)")
	list := fs.Bool("list", false, "list the scenarios")
	fs.StringVar(&r.dialer, "dialer", envOr("DIALER_URL", "http://localhost:8113"), "the dialer's address")
	fs.StringVar(&r.token, "token", os.Getenv("CALLERWHALE_TOKEN"), "a sign-in token (from the CRM in the browser)")
	fs.StringVar(&r.org, "org", os.Getenv("CALLERWHALE_ORG"), "the workspace id")
	fs.StringVar(&r.lead, "lead", "", "the lead to call (its id)")
	fs.StringVar(&r.phone, "phone", "", "the lead's phone number, for the inbound call and texts")
	fs.StringVar(&r.number, "number", "", "the workspace number the lead calls and texts (default: the workspace's first)")
	fs.StringVar(&r.simKey, "sim-key", os.Getenv("TELNYX_API_KEY"), "the simulator's API key (TELNYX_API_KEY)")
	fs.StringVar(&r.closer, "closer", "+15550109999", "the closer's number for the transfer scenario")
	_ = fs.Parse(args)
	if *list {
		for _, sc := range catalog {
			fmt.Printf("%-18s %-8s %-14s %s\n", sc.Name, sc.Kind, sc.Expect, sc.Title)
		}
		return 0
	}
	r.dialer = strings.TrimRight(r.dialer, "/")
	if r.token == "" || !validID(r.org) || !validID(r.lead) {
		fmt.Fprintln(os.Stderr, "Set -token, -org and -lead (see -h).")
		return 2
	}
	if r.number == "" {
		var nums struct {
			Numbers []struct {
				PhoneNumber string `json:"phone_number"`
			} `json:"numbers"`
		}
		if _, err := r.do("GET", r.dialer+"/api/v1/numbers", nil, &nums, ""); err == nil && len(nums.Numbers) > 0 {
			r.number = nums.Numbers[0].PhoneNumber
		}
	}
	failed := 0
	for _, sc := range catalog {
		if *only != "" && sc.Name != *only {
			continue
		}
		var got, detail string
		switch sc.Kind {
		case "call":
			got, detail = r.runCall(sc)
		case "inbound":
			got, detail = r.runInbound()
		case "sms":
			got, detail = r.runText(sc)
		}
		mark := "PASS"
		if got != sc.Expect {
			mark, failed = "FAIL", failed+1
		}
		fmt.Printf("%s  %-18s expected %-14s got %-14s %s\n", mark, sc.Name, sc.Expect, got, strings.TrimSpace(detail))
	}
	if failed > 0 {
		fmt.Printf("%d scenario(s) did not end as expected\n", failed)
		return 1
	}
	fmt.Println("Every scenario ended as expected. Open the lead in the CRM to see the calls, its stage and flags, and the Team page for the numbers.")
	return 0
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}
