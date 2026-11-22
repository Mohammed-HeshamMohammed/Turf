package telnyx

// The CRM (crm-core) over the private network: /internal/v1/dialer/*, with CRM_TOKEN (crm-core's DIALER_TOKEN). See
// services/crm-core/dialer.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type leadInfo struct {
	Found     bool   `json:"found"`
	LeadID    string `json:"lead_id"`
	Name      string `json:"name"`
	Phone     string `json:"phone"`
	Stage     string `json:"stage"`
	Verdict   string `json:"verdict"`
	DoNotCall bool   `json:"do_not_call"`
	MayCall   bool   `json:"may_call"`
	Reason    string `json:"reason"`
	// For the lead's text thread (step 10): who works it, its team's leads and deputies, and the asker's rank toward it.
	AssigneeID      string `json:"assignee_id"`
	TeamID          string `json:"team_id"`
	ClientID        string `json:"client_id"`
	WaitingApproval bool   `json:"waiting_approval"` // its list waits for the client's approval (step 23)
	// The number's blocks (step 25): calls and texts each, with why; and whether its list carries the agency's consent to text (D355).
	BlockedCalls bool   `json:"blocked_calls"`
	BlockedTexts bool   `json:"blocked_texts"`
	BlockReason  string `json:"block_reason"`
	ListConsent  bool   `json:"list_consent"`
	// The AI's call suggestions for the asker on this lead's team, and whether captions must run (step 26, D148).
	AISuggestions    bool     `json:"ai_suggestions"`
	CaptionsRequired bool     `json:"captions_required"`
	TeamLeads        []string `json:"team_leads"`
	TeamDeputies     []string `json:"team_deputies"`
	TeamAgents       []string `json:"team_agents"` // the team's other people, for an incoming call (step 21)
	Rank             string   `json:"rank"`
	ErrMessage       string   `json:"-"`
}

// opAnswer is crm-core's answer to an operation: applied, duplicate (already logged), rejected or conflict.
type opAnswer struct {
	ID      string         `json:"id"`
	Status  string         `json:"status"`
	Message string         `json:"message"`
	Result  map[string]any `json:"result"`
}

type crm interface {
	lead(ctx context.Context, org, user, lead string) (leadInfo, error)
	findLead(ctx context.Context, org, user, phone string) (leadInfo, error)
	recordCall(ctx context.Context, org, user, operationID string, payload map[string]any) (opAnswer, error)
	addRecording(ctx context.Context, org, user, operationID string, payload map[string]any) (opAnswer, error)
	// block puts a number on the agency's block list after the lead's own opt-out reply, or lifts that block on START (step 25).
	block(ctx context.Context, org, user, phone, lead string, payload map[string]any) error
	// carrier tells the CRM an agency's carrier registration and texting standing (step 39); the answer carries a staff review.
	carrier(ctx context.Context, org string, standing map[string]any) (carrierReply, error)
	// erasures are numbers whose calls and texts must go after a person's data request (step 44); erasureDone says they went.
	erasures(ctx context.Context) ([]erasure, error)
	erasureDone(ctx context.Context, id string) error
}

// carrierReply is the CRM's answer: when staff last cleared the agency's texting, and their note.
type carrierReply struct {
	ClearedAt *time.Time `json:"cleared_at"`
	ClearNote string     `json:"clear_note"`
}

func (c *crmClient) carrier(ctx context.Context, org string, standing map[string]any) (carrierReply, error) {
	var out carrierReply
	standing["org_id"] = org
	return out, c.post(ctx, "/internal/v1/dialer/carrier", standing, &out)
}

// errCRMRefused is crm-core saying no for a reason that will not change by asking again (the person or lead is out of reach).
type errCRMRefused struct{ message string }

func (e errCRMRefused) Error() string { return e.message }

type crmClient struct {
	base, token string
	http        *http.Client
}

// get reads one of crm-core's internal answers.
func (c *crmClient) get(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("crm-core: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("crm-core %s: status %d", path, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(into)
}

func (c *crmClient) post(ctx context.Context, path string, body, into any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("crm-core: %w", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	switch {
	case res.StatusCode == http.StatusOK:
		return json.Unmarshal(data, into)
	case res.StatusCode >= 400 && res.StatusCode < 500 && res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusTooManyRequests:
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		return errCRMRefused{e.Error.Message}
	}
	return fmt.Errorf("crm-core %s: status %d", path, res.StatusCode)
}

func (c *crmClient) lead(ctx context.Context, org, user, lead string) (leadInfo, error) {
	var out leadInfo
	err := c.post(ctx, "/internal/v1/dialer/lead", map[string]any{"org_id": org, "user_id": user, "lead_id": lead}, &out)
	out.Found = err == nil
	return out, err
}

func (c *crmClient) findLead(ctx context.Context, org, user, phone string) (leadInfo, error) {
	var out leadInfo
	err := c.post(ctx, "/internal/v1/dialer/find-lead", map[string]any{"org_id": org, "user_id": user, "phone": phone}, &out)
	return out, err
}

func (c *crmClient) recordCall(ctx context.Context, org, user, id string, payload map[string]any) (opAnswer, error) {
	var out opAnswer
	err := c.post(ctx, "/internal/v1/dialer/calls", map[string]any{"org_id": org, "user_id": user, "operation_id": id, "payload": payload}, &out)
	return out, err
}

func (c *crmClient) addRecording(ctx context.Context, org, user, id string, payload map[string]any) (opAnswer, error) {
	var out opAnswer
	err := c.post(ctx, "/internal/v1/dialer/recording", map[string]any{"org_id": org, "user_id": user, "operation_id": id, "payload": payload}, &out)
	return out, err
}

func (c *crmClient) block(ctx context.Context, org, user, phone, lead string, payload map[string]any) error {
	var out map[string]any
	return c.post(ctx, "/internal/v1/dialer/block", map[string]any{"org_id": org, "user_id": user, "phone": phone, "lead_id": lead, "payload": payload}, &out)
}

var errNoCRM = errors.New("CRM_URL is not set")
