package main

// The Telnyx simulator: Telnyx's REST API (the parts the dialer uses) and the webhooks Telnyx would send, signed the same way,
// so the dialer's real code path can be tried before any minute is bought. Which scenario a call plays comes from the
// X-Sim-Scenario header the dialer sends in simulate mode (the API or CLI picker), or else from the last four digits of the
// number dialled (scenarios.go), or else "human_answered".
//
// It runs inside the dialer (TELNYX_MODE=simulate, mounted at /telnyx-sim/) or on its own (`dialer-sms sim`). Time runs at
// SIM_SPEED times real time; the tests run it with speed 0, where nothing happens until drain() plays the steps in order.
// Dupes sends every webhook twice; Reorder reverses webhooks that happen together and holds each call's call.initiated back
// until after the next one, as Telnyx may.

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type simulator struct {
	key     ed25519.PrivateKey
	apiKey  string
	webhook string
	client  *http.Client
	speed   float64 // 0: manual (drain)
	now     func() time.Time

	mu    sync.Mutex
	calls map[string]*simCall
	// Step 21: the calls joined (call|role) and the plain actions asked for (call|action), for tests to read.
	supervisors []string
	actions     []string
	pending     []simStep
	seq         int64
	Dupes       bool
	Reorder     bool
	journal     []simEntry
	brands      map[string]string // 10DLC brands (step 39): id -> display name
}

type simStep struct {
	at  time.Time
	seq int64
	c   *simCall
	fn  func()
}

type simEntry struct {
	At        time.Time `json:"at"`
	EventType string    `json:"event_type"`
	Call      string    `json:"call_control_id,omitempty"`
	Message   string    `json:"message_id,omitempty"`
	Status    int       `json:"status"`
	Attempt   int       `json:"attempt"`
}

type simCall struct {
	ccid, leg, session, from, to, state, direction, scenario, amdMode string
	timeout                                                           int
	t, start                                                          time.Time
	answered, ended, recording, captioning                            bool
	recStart                                                          time.Time
	transferred                                                       *simCall
	parent                                                            *simCall
	held                                                              [][]byte
}

func newSimulator(key ed25519.PrivateKey, apiKey, webhook string, speed float64) *simulator {
	return &simulator{key: key, apiKey: apiKey, webhook: webhook, speed: speed, now: time.Now, calls: map[string]*simCall{},
		client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *simulator) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v2/calls", s.auth(s.dial))
	mux.HandleFunc("POST /v2/calls/{id}/actions/{action}", s.auth(s.action))
	mux.HandleFunc("POST /v2/messages", s.auth(s.message))
	mux.HandleFunc("POST /v2/telephony_credentials", s.auth(func(w http.ResponseWriter, r *http.Request) {
		id := newUUID()
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"id": id, "record_type": "credential", "sip_username": "gencred" + strings.ReplaceAll(id[:13], "-", "")}})
	}))
	mux.HandleFunc("POST /v2/telephony_credentials/{id}/token", s.auth(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("sim." + base64.RawURLEncoding.EncodeToString([]byte(r.PathValue("id"))) + ".token"))
	}))
	mux.HandleFunc("POST /v2/10dlc/brand", s.auth(s.brand))
	mux.HandleFunc("GET /v2/10dlc/brand/{id}", s.auth(s.brand))
	mux.HandleFunc("POST /v2/10dlc/campaignBuilder", s.auth(s.campaign))
	mux.HandleFunc("GET /v2/10dlc/campaign/{id}", s.auth(s.campaign))
	mux.HandleFunc("POST /v2/10dlc/phone_number_campaigns", s.auth(func(w http.ResponseWriter, r *http.Request) {
		var ask struct{ PhoneNumber, CampaignID string }
		_ = json.NewDecoder(r.Body).Decode(&ask)
		writeJSON(w, http.StatusOK, map[string]any{"phoneNumber": ask.PhoneNumber, "campaignId": ask.CampaignID, "assignmentStatus": "ASSIGNED"})
	}))
	mux.HandleFunc("POST /sim/inbound-call", s.auth(s.inboundCall))
	mux.HandleFunc("POST /sim/inbound-sms", s.auth(s.inboundText))
	mux.HandleFunc("POST /sim/say", s.auth(s.say))
	mux.HandleFunc("POST /sim/settings", s.auth(func(w http.ResponseWriter, r *http.Request) {
		var ask struct{ Dupes, Reorder *bool }
		_ = json.NewDecoder(r.Body).Decode(&ask)
		s.mu.Lock()
		if ask.Dupes != nil {
			s.Dupes = *ask.Dupes
		}
		if ask.Reorder != nil {
			s.Reorder = *ask.Reorder
		}
		out := map[string]any{"dupes": s.Dupes, "reorder": s.Reorder}
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, out)
	}))
	mux.HandleFunc("GET /sim/log", s.auth(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		out := append([]simEntry{}, s.journal...)
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"webhooks": out})
	}))
	mux.HandleFunc("GET /sim/scenarios", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"scenarios": catalog})
	})
	return mux
}

func (s *simulator) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if s.apiKey == "" || !constantEqual(strings.TrimSpace(token), s.apiKey) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"errors": []map[string]any{{"code": "10009", "title": "Authentication failed", "detail": "The API key is not the simulator's."}}})
			return
		}
		h(w, r)
	}
}

func telnyxError(w http.ResponseWriter, status int, code, title, detail string) {
	writeJSON(w, status, map[string]any{"errors": []map[string]any{{"code": code, "title": title, "detail": detail}}})
}

// ------------------------------------------------------------------------------------------------------------- time

// after runs fn at the call's time plus d: in real time divided by speed, or, in manual mode, when drain gets to it.
func (s *simulator) after(c *simCall, d time.Duration, fn func()) {
	s.mu.Lock()
	at := c.t.Add(d)
	s.seq++
	if s.speed <= 0 {
		s.pending = append(s.pending, simStep{at: at, seq: s.seq, c: c, fn: fn})
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	time.AfterFunc(time.Duration(float64(d)/s.speed), func() {
		s.mu.Lock()
		if at.After(c.t) {
			c.t = at
		}
		s.mu.Unlock()
		fn()
	})
}

// step plays the next waiting step (manual mode); false when none is left.
func (s *simulator) step() bool {
	s.mu.Lock()
	if len(s.pending) == 0 {
		s.mu.Unlock()
		return false
	}
	sort.SliceStable(s.pending, func(a, b int) bool {
		if !s.pending[a].at.Equal(s.pending[b].at) {
			return s.pending[a].at.Before(s.pending[b].at)
		}
		return s.pending[a].seq < s.pending[b].seq
	})
	st := s.pending[0]
	s.pending = s.pending[1:]
	if st.at.After(st.c.t) {
		st.c.t = st.at
	}
	s.mu.Unlock()
	st.fn()
	return true
}

// drain plays every waiting step in time order, including the steps the dialer's commands add, until none is left.
func (s *simulator) drain() {
	for i := 0; i < 10000; i++ {
		if !s.step() {
			return
		}
	}
	log.Print("WARN simulator: drain stopped after 10000 steps")
}

// ------------------------------------------------------------------------------------------------------------- webhooks

func (s *simulator) callPayload(c *simCall, extra map[string]any) map[string]any {
	p := map[string]any{
		"call_control_id": c.ccid, "call_leg_id": c.leg, "call_session_id": c.session, "connection_id": "sim-connection",
		"direction": c.direction, "from": c.from, "to": c.to, "state": "parked",
	}
	if c.state != "" {
		p["client_state"] = c.state
	}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func (s *simulator) envelope(eventType string, at time.Time, payload map[string]any) []byte {
	b, _ := json.Marshal(map[string]any{
		"data": map[string]any{"record_type": "event", "id": newUUID(), "event_type": eventType, "occurred_at": at.UTC().Format(time.RFC3339Nano), "payload": payload},
		"meta": map[string]any{"attempt": 1, "delivered_to": s.webhook},
	})
	return b
}

// callEvents sends webhooks for a call that happen at the same moment.
func (s *simulator) callEvents(c *simCall, events ...[2]any) {
	s.mu.Lock()
	batch := make([][]byte, 0, len(events))
	held := false
	for _, e := range events {
		typ := e[0].(string)
		extra, _ := e[1].(map[string]any)
		body := s.envelope(typ, c.t, s.callPayload(c, extra))
		// An inbound call waits for the dialer to answer it, so its call.initiated is never held back.
		if s.Reorder && typ == "call.initiated" && c.direction == "outgoing" {
			c.held = append(c.held, body)
			held = true
			continue
		}
		batch = append(batch, body)
	}
	if !held && len(c.held) > 0 {
		// The held call.initiated goes out with this batch, and (reversed) after it.
		batch = append(append([][]byte{}, c.held...), batch...)
		c.held = nil
	}
	s.mu.Unlock()
	s.send(batch)
}

func (s *simulator) send(batch [][]byte) {
	s.mu.Lock()
	reorder, dupes := s.Reorder, s.Dupes
	s.mu.Unlock()
	if reorder {
		for i, j := 0, len(batch)-1; i < j; i, j = i+1, j-1 {
			batch[i], batch[j] = batch[j], batch[i]
		}
	}
	for _, body := range batch {
		s.post(body, 1)
		if dupes {
			s.post(body, 2)
		}
	}
}

func (s *simulator) post(body []byte, attempt int) {
	sig, ts := signWebhook(s.key, body, s.now())
	status := 0
	req, err := http.NewRequest(http.MethodPost, s.webhook, bytes.NewReader(body))
	if err == nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("telnyx-signature-ed25519", sig)
		req.Header.Set("telnyx-timestamp", ts)
		var res *http.Response
		if res, err = s.client.Do(req); err == nil {
			status = res.StatusCode
			res.Body.Close()
		}
	}
	if err != nil {
		log.Printf("WARN simulator: webhook not delivered: %v", err)
	}
	var env struct {
		Data struct {
			EventType string         `json:"event_type"`
			Payload   map[string]any `json:"payload"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &env)
	entry := simEntry{At: s.now(), EventType: env.Data.EventType, Status: status, Attempt: attempt}
	entry.Call, _ = env.Data.Payload["call_control_id"].(string)
	if strings.HasPrefix(entry.EventType, "message.") {
		entry.Message, _ = env.Data.Payload["id"].(string)
	}
	s.mu.Lock()
	s.journal = append(s.journal, entry)
	if len(s.journal) > 500 {
		s.journal = s.journal[len(s.journal)-500:]
	}
	s.mu.Unlock()
}

func ev(eventType string, extra map[string]any) [2]any { return [2]any{eventType, extra} }

// ------------------------------------------------------------------------------------------------------------- calls

func (s *simulator) newCall(direction, from, to, state, scenario string) *simCall {
	c := &simCall{ccid: "v3:sim-" + newUUID(), leg: newUUID(), session: newUUID(), from: from, to: to, state: state,
		direction: direction, scenario: scenario, t: s.now()}
	c.start = c.t
	s.mu.Lock()
	s.calls[c.ccid] = c
	s.mu.Unlock()
	return c
}

func (s *simulator) dial(w http.ResponseWriter, r *http.Request) {
	var ask struct {
		To          string `json:"to"`
		From        string `json:"from"`
		Connection  string `json:"connection_id"`
		ClientState string `json:"client_state"`
		AMD         string `json:"answering_machine_detection"`
		Timeout     int    `json:"timeout_secs"`
		Supervise   string `json:"supervise_call_control_id"`
		Role        string `json:"supervisor_role"`
	}
	_ = json.NewDecoder(r.Body).Decode(&ask)
	// Joining a live call: a browser login that answers and listens, whispers or barges into the call (step 21).
	if ask.Supervise != "" && strings.HasPrefix(ask.To, "sip:") && ask.Connection != "" {
		s.mu.Lock()
		target := s.calls[ask.Supervise]
		s.mu.Unlock()
		if target == nil || s.isEnded(target) {
			telnyxError(w, http.StatusUnprocessableEntity, "90018", "Call has already ended", "The call to supervise is not active")
			return
		}
		leg := s.newCall("outgoing", ask.From, ask.To, ask.ClientState, "supervisor")
		s.mu.Lock()
		s.supervisors = append(s.supervisors, ask.Supervise+"|"+ask.Role)
		s.mu.Unlock()
		s.after(leg, 0, func() { s.callEvents(leg, ev("call.initiated", nil)) })
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"call_control_id": leg.ccid, "call_leg_id": leg.leg, "call_session_id": leg.session, "is_alive": true, "record_type": "call"}})
		return
	}
	if e164(ask.To) == "" || ask.From == "" || ask.Connection == "" {
		telnyxError(w, http.StatusUnprocessableEntity, "90015", "Invalid parameters", "to, from and connection_id are required")
		return
	}
	scenario := simScenarioFor(r.Header.Get("X-Sim-Scenario"), ask.To)
	c := s.newCall("outgoing", ask.From, ask.To, ask.ClientState, scenario)
	c.amdMode, c.timeout = ask.AMD, ask.Timeout
	if c.timeout <= 0 {
		c.timeout = 30
	}
	s.play(c)
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"call_control_id": c.ccid, "call_leg_id": c.leg, "call_session_id": c.session, "is_alive": true, "record_type": "call"}})
}

func (s *simulator) hangup(c *simCall, cause, source, sip string) {
	s.mu.Lock()
	if c.ended {
		s.mu.Unlock()
		return
	}
	c.ended = true
	rec, recStart, start, end, transferred := c.recording, c.recStart, c.start, c.t, c.transferred
	s.mu.Unlock()
	events := [][2]any{ev("call.hangup", map[string]any{"hangup_cause": cause, "hangup_source": source, "sip_hangup_cause": sip,
		"start_time": start.UTC().Format(time.RFC3339Nano), "end_time": end.UTC().Format(time.RFC3339Nano)})}
	if rec {
		url := "https://sim.callerwhale.invalid/recordings/" + c.leg + ".mp3"
		events = append(events, ev("call.recording.saved", map[string]any{"recording_urls": map[string]any{"mp3": url}, "public_recording_urls": map[string]any{"mp3": url},
			"recording_started_at": recStart.UTC().Format(time.RFC3339Nano), "recording_ended_at": end.UTC().Format(time.RFC3339Nano), "channels": "single"}))
	}
	s.callEvents(c, events...)
	// A transferred lead's closer leg ends with it.
	if t := transferred; t != nil {
		s.hangup(t, "normal_clearing", "callee", "200")
	}
}

func (s *simulator) isEnded(c *simCall) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return c.ended
}

func (s *simulator) answer(c *simCall, amd string) {
	s.mu.Lock()
	if c.ended || c.answered {
		s.mu.Unlock()
		return
	}
	c.answered = true
	mode := c.amdMode
	s.mu.Unlock()
	events := [][2]any{ev("call.answered", nil)}
	if mode != "" && amd != "" {
		typ, result := "call.machine.detection.ended", amd
		if mode == "premium" {
			typ = "call.machine.premium.detection.ended"
			if amd == "human" {
				result = "human_residence"
			}
		}
		events = append(events, ev(typ, map[string]any{"result": result}))
	}
	s.callEvents(c, events...)
}

// play runs a dialled call's scenario.
func (s *simulator) play(c *simCall) {
	s.after(c, 0, func() { s.callEvents(c, ev("call.initiated", nil)) })
	talk := map[string]time.Duration{"human_answered": 45 * time.Second, "callback": 30 * time.Second, "do_not_call": 20 * time.Second, "dropped": 12 * time.Second}
	switch c.scenario {
	case "human_answered", "callback", "do_not_call", "dropped":
		s.after(c, 4*time.Second, func() {
			s.answer(c, "human")
			// What the lead says, heard by captions when the dialer started them (step 26).
			if line := scenarioLines[c.scenario]; line != "" {
				s.after(c, 5*time.Second, func() { s.speakLine(c, line) })
			}
			s.after(c, talk[c.scenario], func() {
				if c.scenario == "dropped" {
					s.hangup(c, "unspecified", "unknown", "")
				} else {
					s.hangup(c, "normal_clearing", "callee", "200")
				}
			})
		})
	case "transfer":
		s.after(c, 4*time.Second, func() {
			s.answer(c, "human")
			s.after(c, 2*time.Minute, func() { // nobody transferred: the lead gives up
				s.mu.Lock()
				transferred := c.transferred != nil
				s.mu.Unlock()
				if !transferred {
					s.hangup(c, "normal_clearing", "callee", "200")
				}
			})
		})
	case "voicemail", "voicemail_drop":
		s.after(c, 5*time.Second, func() {
			s.answer(c, "machine")
			if c.amdMode == "detect_beep" || c.amdMode == "premium" || c.amdMode == "greeting_end" {
				typ := "call.machine.greeting.ended"
				if c.amdMode == "premium" {
					typ = "call.machine.premium.greeting.ended"
				}
				s.after(c, 8*time.Second, func() {
					if !s.isEnded(c) {
						s.callEvents(c, ev(typ, map[string]any{"result": "beep_detected"}))
					}
				})
			}
			s.after(c, 90*time.Second, func() { s.hangup(c, "normal_clearing", "callee", "200") }) // the machine stops recording
		})
	case "no_answer":
		s.after(c, time.Duration(c.timeout)*time.Second, func() { s.hangup(c, "timeout", "unknown", "480") })
	case "caller_hangup":
		s.after(c, time.Duration(c.timeout)*time.Second, func() { s.hangup(c, "timeout", "unknown", "480") })
	case "busy":
		s.after(c, 2*time.Second, func() { s.hangup(c, "user_busy", "callee", "486") })
	case "disconnected":
		s.after(c, time.Second, func() { s.hangup(c, "unallocated_number", "unknown", "404") })
	case "carrier_failure":
		s.after(c, time.Second, func() { s.hangup(c, "unspecified", "unknown", "503") })
	case "rejected":
		s.after(c, 3*time.Second, func() { s.hangup(c, "call_rejected", "callee", "603") })
	default: // unknown: a person answers
		s.after(c, 4*time.Second, func() {
			s.answer(c, "human")
			s.after(c, 45*time.Second, func() { s.hangup(c, "normal_clearing", "callee", "200") })
		})
	}
}

// action is a Call Control command from the dialer.
func (s *simulator) action(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	c := s.calls[r.PathValue("id")]
	s.mu.Unlock()
	if c == nil {
		telnyxError(w, http.StatusNotFound, "10005", "Resource not found", "No call with that call_control_id")
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if s.isEnded(c) {
		telnyxError(w, http.StatusUnprocessableEntity, "90018", "Call has already ended", "This call is no longer active")
		return
	}
	if cs, _ := body["client_state"].(string); cs != "" && r.PathValue("action") == "answer" {
		s.mu.Lock()
		c.state = cs
		s.mu.Unlock()
	}
	switch r.PathValue("action") {
	case "answer":
		s.after(c, 300*time.Millisecond, func() {
			s.answer(c, "")
			s.after(c, 20*time.Second, func() { s.hangup(c, "normal_clearing", "caller", "200") })
		})
	case "hangup":
		s.after(c, 200*time.Millisecond, func() {
			s.mu.Lock()
			answered := c.answered
			s.mu.Unlock()
			if answered {
				s.hangup(c, "normal_clearing", "caller", "200")
			} else {
				s.hangup(c, "originator_cancel", "caller", "487")
			}
		})
	case "record_start":
		s.mu.Lock()
		c.recording, c.recStart = true, c.t
		s.mu.Unlock()
	case "playback_start":
		s.after(c, 300*time.Millisecond, func() { s.callEvents(c, ev("call.playback.started", map[string]any{"media_url": body["audio_url"]})) })
		s.after(c, 6*time.Second, func() {
			if !s.isEnded(c) {
				s.callEvents(c, ev("call.playback.ended", map[string]any{"media_url": body["audio_url"], "status": "completed"}))
			}
		})
	case "transfer":
		to, _ := body["to"].(string)
		state, _ := body["client_state"].(string)
		leg := s.newCall("outgoing", c.to, to, state, "closer")
		leg.parent, leg.t, leg.start = c, c.t, c.t
		s.mu.Lock()
		c.transferred = leg
		s.mu.Unlock()
		s.after(leg, 0, func() { s.callEvents(leg, ev("call.initiated", nil)) })
		s.after(leg, 3*time.Second, func() {
			s.answer(leg, "")
			s.callEvents(c, ev("call.bridged", nil))
			s.after(leg, 90*time.Second, func() { s.hangup(c, "normal_clearing", "callee", "200") })
		})
	case "transcription_start", "transcription_stop":
		s.mu.Lock()
		c.captioning = r.PathValue("action") == "transcription_start"
		s.actions = append(s.actions, c.ccid+"|"+r.PathValue("action"))
		s.mu.Unlock()
	case "speak", "record_stop", "playback_stop", "bridge", "record_pause", "record_resume":
		s.mu.Lock()
		s.actions = append(s.actions, c.ccid+"|"+r.PathValue("action"))
		s.mu.Unlock()
	default:
		telnyxError(w, http.StatusUnprocessableEntity, "90015", "Invalid parameters", "Unknown action "+r.PathValue("action"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"result": "ok"}})
}

// inboundCall is a lead calling a workspace number: {"from": "+1...", "to": "+1..."}.
func (s *simulator) inboundCall(w http.ResponseWriter, r *http.Request) {
	var ask struct{ From, To string }
	if err := json.NewDecoder(r.Body).Decode(&ask); err != nil || e164(ask.From) == "" || e164(ask.To) == "" {
		telnyxError(w, http.StatusUnprocessableEntity, "90015", "Invalid parameters", "from and to are phone numbers")
		return
	}
	c := s.newCall("incoming", e164(ask.From), e164(ask.To), "", "inbound_call")
	s.after(c, 0, func() { s.callEvents(c, ev("call.initiated", nil)) })
	s.after(c, 30*time.Second, func() { // nobody answered: the caller gives up
		s.mu.Lock()
		answered := c.answered
		s.mu.Unlock()
		if !answered {
			s.hangup(c, "originator_cancel", "caller", "487")
		}
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"call_control_id": c.ccid}})
}

// ------------------------------------------------------------------------------------------------------------- texts

func (s *simulator) message(w http.ResponseWriter, r *http.Request) {
	var ask struct{ From, To, Text string }
	if err := json.NewDecoder(r.Body).Decode(&ask); err != nil || e164(ask.To) == "" || ask.From == "" || ask.Text == "" {
		telnyxError(w, http.StatusUnprocessableEntity, "40001", "Invalid parameters", "from, to and text are required")
		return
	}
	id := newUUID()
	fail := r.Header.Get("X-Sim-Scenario") == "sms_failed" || strings.HasSuffix(ask.To, "0099")
	c := &simCall{t: s.now()}
	base := func(status string) map[string]any {
		return map[string]any{"id": id, "record_type": "message", "direction": "outbound", "type": "SMS", "text": ask.Text,
			"from": map[string]any{"phone_number": ask.From}, "to": []any{map[string]any{"phone_number": ask.To, "status": status}}}
	}
	s.after(c, time.Second, func() { s.send([][]byte{s.envelope("message.sent", c.t, base("sent"))}) })
	s.after(c, 3*time.Second, func() {
		p := base("delivered")
		if fail {
			p = base("delivery_failed")
			p["errors"] = []any{map[string]any{"code": "40300", "title": "Blocked as spam", "detail": "The destination carrier blocked the message (simulated)."}}
		}
		s.send([][]byte{s.envelope("message.finalized", c.t, p)})
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": base("queued")})
}

// inboundText is a lead texting a workspace number: {"from", "to", "text"}.
func (s *simulator) inboundText(w http.ResponseWriter, r *http.Request) {
	var ask struct{ From, To, Text string }
	if err := json.NewDecoder(r.Body).Decode(&ask); err != nil || e164(ask.From) == "" || e164(ask.To) == "" || ask.Text == "" {
		telnyxError(w, http.StatusUnprocessableEntity, "40001", "Invalid parameters", "from, to and text are required")
		return
	}
	id := newUUID()
	c := &simCall{t: s.now()}
	p := map[string]any{"id": id, "record_type": "message", "direction": "inbound", "type": "SMS", "text": ask.Text,
		"from": map[string]any{"phone_number": e164(ask.From)}, "to": []any{map[string]any{"phone_number": e164(ask.To), "status": "webhook_delivered"}}}
	s.after(c, 0, func() { s.send([][]byte{s.envelope("message.received", c.t, p)}) })
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"id": id}})
}

func (s *simulator) String() string {
	return fmt.Sprintf("simulator(webhook=%s speed=%v)", s.webhook, s.speed)
}

// scenarioLines is what the lead says in a scenario, for captions.
var scenarioLines = map[string]string{
	"human_answered": "How much would you offer for the house?",
	"callback":       "I'm driving, can you call me back tomorrow at 5?",
	"do_not_call":    "Please stop calling me.",
}

// speakLine sends one finished caption line of the lead, when the dialer asked for captions.
func (s *simulator) speakLine(c *simCall, text string) {
	s.mu.Lock()
	on := c.captioning && !c.ended
	s.mu.Unlock()
	if on {
		s.callEvents(c, ev("call.transcription", map[string]any{"transcription_data": map[string]any{"transcript": text, "is_final": true, "confidence": 0.93}}))
	}
}

// say is the lead saying a line on a live call: {"call_control_id", "text"}.
func (s *simulator) say(w http.ResponseWriter, r *http.Request) {
	var ask struct {
		CallControlID string `json:"call_control_id"`
		Text          string `json:"text"`
	}
	_ = json.NewDecoder(r.Body).Decode(&ask)
	s.mu.Lock()
	c := s.calls[ask.CallControlID]
	s.mu.Unlock()
	if c == nil || s.isEnded(c) {
		telnyxError(w, http.StatusNotFound, "10005", "Resource not found", "No live call with that call_control_id")
		return
	}
	s.after(c, 0, func() { s.speakLine(c, ask.Text) })
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// brand answers 10DLC brand registration and reading (step 39): pending when created, verified when read, refused when the display
// name says "Refused".
func (s *simulator) brand(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.brands == nil {
		s.brands = map[string]string{}
	}
	if r.Method == http.MethodPost {
		var ask struct{ DisplayName, EntityType string }
		if err := json.NewDecoder(r.Body).Decode(&ask); err != nil || ask.DisplayName == "" || ask.EntityType == "" {
			telnyxError(w, http.StatusBadRequest, "10001", "Invalid brand", "entityType and displayName are required")
			return
		}
		id := "B" + strings.ToUpper(newUUID()[:6])
		s.brands[id] = ask.DisplayName
		writeJSON(w, http.StatusOK, map[string]any{"brandId": id, "identityStatus": "UNVERIFIED", "status": "REGISTRATION_PENDING"})
		return
	}
	name, ok := s.brands[r.PathValue("id")]
	switch {
	case !ok:
		telnyxError(w, http.StatusNotFound, "10004", "Not found", "no such brand")
	case strings.Contains(name, "Refused"):
		writeJSON(w, http.StatusOK, map[string]any{"brandId": r.PathValue("id"), "identityStatus": "UNVERIFIED", "status": "REGISTRATION_FAILED", "failureReasons": "The EIN does not match the legal name (simulated)."})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"brandId": r.PathValue("id"), "identityStatus": "VERIFIED", "status": "OK"})
	}
}

// campaign answers 10DLC campaigns: pending when created, provisioned when read.
func (s *simulator) campaign(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var ask struct{ BrandID, Usecase, Description string }
		if err := json.NewDecoder(r.Body).Decode(&ask); err != nil || ask.BrandID == "" || ask.Usecase == "" || ask.Description == "" {
			telnyxError(w, http.StatusBadRequest, "10002", "Invalid campaign", "brandId, usecase and description are required")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"campaignId": newUUID(), "brandId": ask.BrandID, "campaignStatus": "TCR_PENDING"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaignId": r.PathValue("id"), "campaignStatus": "MNO_PROVISIONED"})
}
