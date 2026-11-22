package telnyx

// Telnyx, the first carrier (docs/plans/messaging-sms-voice.md, "Carriers, in order"). This file is the only one that knows
// Telnyx's API: the REST calls the dialer makes and the shape and signature of the webhooks Telnyx sends. The simulator
// (sim.go) answers the same requests and sends the same webhooks, so with TELNYX_MODE=simulate every other line of the service
// runs as it would against the real carrier.
//
//   Call Control (Voice API): POST /v2/calls, POST /v2/calls/{call_control_id}/actions/{answer|hangup|transfer|record_start|playback_start}
//   Messaging:                POST /v2/messages
//   Browser calling (WebRTC): POST /v2/telephony_credentials, POST /v2/telephony_credentials/{id}/token
//   Webhooks:                 signed with Ed25519 over "<telnyx-timestamp>|<raw body>", headers telnyx-signature-ed25519 (base64)
//                             and telnyx-timestamp (Unix seconds); the public key is on the Telnyx portal (Keys & Credentials).

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// carrier is what the rest of the service asks of a carrier. Telnyx is the first implementation; a second carrier (Twilio)
// is a second implementation, not a change to the callers.
type carrier interface {
	dial(ctx context.Context, d dialRequest) (dialAnswer, error)
	action(ctx context.Context, callControlID, action string, body map[string]any) error
	sendText(ctx context.Context, from, to, text string) (string, error)
	credential(ctx context.Context, name string) (id, username string, err error)
	webrtcToken(ctx context.Context, credentialID string) (string, error)
}

type dialRequest struct {
	From, To      string
	ClientState   string // our call id; comes back on every webhook for the call
	AMD           string // "", detect, detect_beep, premium
	TimeoutSecs   int
	TimeLimitSecs int
	Scenario      string // simulator only: which scenario to play (ignored by Telnyx; sent as a header only in simulate mode)
	// Joining a live call: the call to join, and how (monitor, whisper, barge).
	SuperviseID, SupervisorRole string
}

type dialAnswer struct {
	CallControlID string `json:"call_control_id"`
	CallLegID     string `json:"call_leg_id"`
	CallSessionID string `json:"call_session_id"`
}

type telnyx struct {
	base, key    string
	connectionID string // the Call Control application (or SIP connection) calls go out on
	sipConnID    string // the credential SIP connection browser callers sign in to
	profileID    string // the messaging profile texts go out on
	webhookURL   string // where Telnyx sends events; empty: the application's own setting on the portal
	simulate     bool
	http         *http.Client
}

var errCarrier = errors.New("the carrier refused the request")

func (t *telnyx) do(ctx context.Context, method, path string, body any, scenario string, into any) error {
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if t.simulate && scenario != "" {
		req.Header.Set("X-Sim-Scenario", scenario)
	}
	res, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("telnyx %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		var e struct {
			Errors []struct{ Code, Title, Detail string } `json:"errors"`
		}
		_ = json.Unmarshal(data, &e)
		detail := strconv.Itoa(res.StatusCode)
		if len(e.Errors) > 0 {
			detail += " " + e.Errors[0].Code + " " + e.Errors[0].Title + ": " + e.Errors[0].Detail
		}
		return fmt.Errorf("%w: %s %s: %s", errCarrier, method, path, detail)
	}
	if into == nil {
		return nil
	}
	if s, ok := into.(*string); ok { // the WebRTC token is plain text
		*s = strings.TrimSpace(string(data))
		return nil
	}
	return json.Unmarshal(data, into)
}

func (t *telnyx) dial(ctx context.Context, d dialRequest) (dialAnswer, error) {
	body := map[string]any{
		"connection_id": t.connectionID, "to": d.To, "from": d.From,
		"client_state": base64.StdEncoding.EncodeToString([]byte(d.ClientState)),
		"timeout_secs": d.TimeoutSecs,
	}
	if d.TimeLimitSecs > 0 {
		body["time_limit_secs"] = d.TimeLimitSecs
	}
	if d.AMD != "" {
		body["answering_machine_detection"] = d.AMD
	}
	if d.SuperviseID != "" {
		body["supervise_call_control_id"], body["supervisor_role"] = d.SuperviseID, d.SupervisorRole
	}
	if t.webhookURL != "" {
		body["webhook_url"] = t.webhookURL
	}
	var out struct {
		Data dialAnswer `json:"data"`
	}
	err := t.do(ctx, http.MethodPost, "/calls", body, d.Scenario, &out)
	return out.Data, err
}

func (t *telnyx) action(ctx context.Context, id, action string, body map[string]any) error {
	if body == nil {
		body = map[string]any{}
	}
	return t.do(ctx, http.MethodPost, "/calls/"+id+"/actions/"+action, body, "", nil)
}

func (t *telnyx) sendText(ctx context.Context, from, to, text string) (string, error) {
	body := map[string]any{"from": from, "to": to, "text": text}
	if t.profileID != "" {
		body["messaging_profile_id"] = t.profileID
	}
	if t.webhookURL != "" {
		body["webhook_url"] = t.webhookURL
	}
	var out struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	err := t.do(ctx, http.MethodPost, "/messages", body, scenarioFrom(ctx), &out)
	return out.Data.ID, err
}

func (t *telnyx) credential(ctx context.Context, name string) (string, string, error) {
	var out struct {
		Data struct {
			ID          string `json:"id"`
			SIPUsername string `json:"sip_username"`
		} `json:"data"`
	}
	err := t.do(ctx, http.MethodPost, "/telephony_credentials", map[string]any{"connection_id": t.sipConnID, "name": name}, "", &out)
	return out.Data.ID, out.Data.SIPUsername, err
}

func (t *telnyx) webrtcToken(ctx context.Context, id string) (string, error) {
	var token string
	err := t.do(ctx, http.MethodPost, "/telephony_credentials/"+id+"/token", nil, "", &token)
	return token, err
}

// ------------------------------------------------------------------------------------------------------------- webhooks

// event is one Telnyx webhook: {"data": {"id", "event_type", "occurred_at", "payload": {...}}, "meta": {...}}.
type event struct {
	ID         string         `json:"id"`
	EventType  string         `json:"event_type"`
	OccurredAt time.Time      `json:"occurred_at"`
	Payload    map[string]any `json:"payload"`
}

func (e event) str(name string) string {
	switch v := e.Payload[name].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// clientState is the call id the dialer put on the call when it dialled (base64 in the payload).
func (e event) clientState() string {
	raw, err := base64.StdEncoding.DecodeString(e.str("client_state"))
	if err != nil {
		return ""
	}
	return string(raw)
}

// phone reads a number that Telnyx sends either as a string or as {"phone_number": ...} (texts), or a list of those (texts' "to").
func (e event) phone(name string) string {
	switch v := e.Payload[name].(type) {
	case string:
		return v
	case map[string]any:
		s, _ := v["phone_number"].(string)
		return s
	case []any:
		if len(v) > 0 {
			if m, ok := v[0].(map[string]any); ok {
				s, _ := m["phone_number"].(string)
				return s
			}
		}
	}
	return ""
}

func (e event) time(name string) *time.Time {
	s := e.str(name)
	if s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	return &t
}

var (
	errSignature = errors.New("the webhook signature is not Telnyx's")
	errStale     = errors.New("the webhook is too old or from the future")
)

// verifyWebhook checks a webhook's Ed25519 signature and that it was signed within the last five minutes (a replayed old
// webhook is refused even with a good signature).
func verifyWebhook(public ed25519.PublicKey, body []byte, signature, timestamp string, now time.Time) error {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(sig) != ed25519.SignatureSize || len(public) != ed25519.PublicKeySize {
		return errSignature
	}
	ts, err := strconv.ParseInt(strings.TrimSpace(timestamp), 10, 64)
	if err != nil {
		return errSignature
	}
	if d := now.Unix() - ts; d > 300 || d < -300 {
		return errStale
	}
	if !ed25519.Verify(public, append([]byte(timestamp+"|"), body...), sig) {
		return errSignature
	}
	return nil
}

// signWebhook is what Telnyx does to a webhook; the simulator uses it.
func signWebhook(private ed25519.PrivateKey, body []byte, now time.Time) (signature, timestamp string) {
	timestamp = strconv.FormatInt(now.Unix(), 10)
	return base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte(timestamp+"|"), body...))), timestamp
}

func parsePublicKey(text string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("TELNYX_PUBLIC_KEY must be the base64 Ed25519 public key from the Telnyx portal (32 bytes)")
	}
	return ed25519.PublicKey(raw), nil
}
