package crm

// The in-app assistant for the agency's people (D320-D323, D372).
//
//   - A lead's history summarised, a text or email drafted for the agent to edit and send (it never sends on its own), and answers to
//     "how do I" questions. The AI itself is in the assistant service (ASSISTANT_URL, ASSISTANT_TOKEN), which keeps nothing.
//   - Only what the person may see goes, and only what the task needs: the lead's name, stage and notes, its calls and open tasks, never
//     its phone, email or address. A text is never drafted to a number blocked for texts.
//   - What the person asks is private: not stored or shown to anyone (D322). Only a summary or draft they save becomes a note on the lead.
//   - Each use is charged through billing (BILLING_URL, BILLING_TOKEN): about a lead to its team and client, otherwise to the person and
//     the agency's allowance, within budgets and each person's daily cap (D323, D372). Without billing nothing is limited.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *server) assistantRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/assistant/leads/{id}/summary", s.member(s.assistLead("lead_summary")))
	mux.Handle("POST /api/v1/assistant/leads/{id}/draft", s.member(s.assistLead("draft")))
	mux.Handle("POST /api/v1/assistant/leads/{id}/save", s.member(s.saveAssist))
	mux.Handle("POST /api/v1/assistant/ask", s.member(s.assistAsk))
}

var aiHTTP = &http.Client{Timeout: 45 * time.Second}

// postJSON sends a request to another Caller Whale service and reads its answer; a refusal comes back with its status and message.
func postJSON(ctx context.Context, url, token string, body, into any) error {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := aiHTTP.Do(req)
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "unavailable", "The assistant cannot be reached right now. Try again in a moment."}
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Error   any    `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		msg := e.Message
		if m, ok := e.Error.(map[string]any); ok {
			msg, _ = m["message"].(string)
		} else if m, ok := e.Error.(string); ok && msg == "" {
			msg = m
		}
		if msg == "" {
			msg = "The assistant did not answer. Try again in a moment."
		}
		status := res.StatusCode
		if status != http.StatusPaymentRequired && status != http.StatusTooManyRequests && status != http.StatusServiceUnavailable {
			status = http.StatusBadGateway
		}
		return &apiError{status, "assistant", msg}
	}
	return json.Unmarshal(data, into)
}

// chargeAI checks and charges one use of the assistant: to the lead's team and client when it is about a lead (D323, D372).
func (s *server) chargeAI(ctx context.Context, sc scope, team, client string) error {
	if s.cfg.billingURL == "" {
		return nil
	}
	var out map[string]any
	return postJSON(ctx, s.cfg.billingURL+"/v1/usage", s.cfg.billingToken, map[string]any{"org_id": sc.orgID, "kind": "ai", "amount": 1,
		"request_id": newUUIDString(), "team_id": nullID(team), "user_id": sc.userID, "client_id": nullID(client)}, &out)
}

func (s *server) complete(ctx context.Context, task, facts, request string) (string, error) {
	if s.cfg.assistantURL == "" {
		return "", &apiError{http.StatusServiceUnavailable, "assistant_off", "The assistant is not switched on for Caller Whale yet."}
	}
	var out struct {
		Text string `json:"text"`
	}
	err := postJSON(ctx, s.cfg.assistantURL+"/v1/agent/complete", s.cfg.assistantToken, map[string]any{"task": task, "facts": facts, "request": request}, &out)
	return out.Text, err
}

// leadFacts is what the assistant is told about a lead the person may see: no phone, email or address.
func (s *server) leadFacts(q *req, id string) (string, map[string]any, error) {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback(ctx)
	r := &run{s: s, ctx: ctx, sc: q.sc, tx: tx}
	lead, err := r.lead(id, false)
	if err != nil {
		return "", nil, err
	}
	if lead == nil {
		return "", nil, notFound("The lead was not found, was deleted, or is outside your access.")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Lead: %s\nStage: %s\nVerdict: %s\nNext action: %s\nDo not call: %v\n", asString(lead["name"]), asString(lead["stage"]),
		asString(lead["verdict"]), asString(lead["next_action"]), lead["do_not_call"] == true)
	if blocked, err := numberBlocked(ctx, tx, asString(lead["phone"])); err == nil && (blocked.Calls || blocked.Texts) {
		fmt.Fprintf(&b, "Blocked: calls %v, texts %v\n", blocked.Calls, blocked.Texts)
		lead["blocked_texts"] = blocked.Texts
	}
	if q, ok := lead["qualification"].(map[string]any); ok && len(q) > 0 {
		raw, _ := json.Marshal(q)
		fmt.Fprintf(&b, "Qualification: %s\n", raw)
	}
	rows, err := tx.Query(ctx, `(SELECT 'Call ' || to_char(occurred_at, 'YYYY-MM-DD') || ': ' || outcome || CASE WHEN notes <> '' THEN ' - ' || left(notes, 500) ELSE '' END, occurred_at
			FROM call_events WHERE lead_id = $1 ORDER BY occurred_at DESC LIMIT 20)
		UNION ALL (SELECT 'Note ' || to_char(occurred_at, 'YYYY-MM-DD') || ': ' || left(body, 800), occurred_at FROM notes WHERE lead_id = $1 ORDER BY occurred_at DESC LIMIT 20)
		UNION ALL (SELECT 'Open task: ' || title || coalesce(' due ' || to_char(due_at, 'YYYY-MM-DD'), ''), coalesce(due_at, now()) FROM tasks
			WHERE lead_id = $1 AND done_at IS NULL LIMIT 10)
		ORDER BY 2`, id)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var line string
		var at time.Time
		if err := rows.Scan(&line, &at); err != nil {
			return "", nil, err
		}
		b.WriteString(line + "\n")
	}
	return b.String(), lead, rows.Err()
}

// assistLead is POST /api/v1/assistant/leads/{id}/summary and /draft {kind: text|email, request}.
func (s *server) assistLead(route string) handler {
	return func(q *req) error {
		task := route
		if q.sc.external() {
			return forbidden("The assistant is for the agency's own people.")
		}
		var body struct {
			Kind    string `json:"kind"`
			Request string `json:"request"`
		}
		if q.r.ContentLength != 0 {
			if err := readJSON(q.w, q.r, &body); err != nil {
				return err
			}
		}
		if len([]rune(body.Request)) > 1000 {
			return bad("Keep the request under 1,000 characters.")
		}
		if task == "draft" {
			switch body.Kind {
			case "text", "":
				task = "draft_text"
				if !q.sc.can("message") {
					return forbidden("Your role does not text leads.")
				}
			case "email":
				task = "draft_email"
			default:
				return bad("kind is text or email.")
			}
		}
		id := q.r.PathValue("id")
		if !validID(id) {
			return notFound("No such lead.")
		}
		facts, lead, err := s.leadFacts(q, id)
		if err != nil {
			return err
		}
		if task == "draft_text" && (lead["blocked_texts"] == true || lead["do_not_call"] == true) {
			return &apiError{http.StatusConflict, "blocked", "This lead's number is blocked; no text is drafted to it."}
		}
		ctx := q.r.Context()
		if err := s.chargeAI(ctx, q.sc, asString(lead["team_id"]), asString(lead["client_id"])); err != nil {
			return err
		}
		text, err := s.complete(ctx, task, facts, body.Request)
		if err != nil {
			return err
		}
		writeJSON(q.w, 200, map[string]any{"task": task, "text": text, "saved": false})
		return nil
	}
}

// assistAsk is POST /api/v1/assistant/ask {question}: a "how do I" question, private and not stored, charged to the person (D372).
func (s *server) assistAsk(q *req) error {
	if q.sc.external() {
		return forbidden("The assistant is for the agency's own people.")
	}
	var body struct {
		Question string `json:"question"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	question := strings.TrimSpace(body.Question)
	if question == "" || len([]rune(question)) > 1000 {
		return bad("Ask a question of up to 1,000 characters.")
	}
	ctx := q.r.Context()
	if err := s.chargeAI(ctx, q.sc, "", ""); err != nil {
		return err
	}
	text, err := s.complete(ctx, "howto", "", question)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"text": text})
	return nil
}

// saveAssist is POST /api/v1/assistant/leads/{id}/save {kind: summary|text|email, text}: the person keeps a summary, or the draft they
// sent, as a note on the lead (D322). The text is theirs, edited or not.
func (s *server) saveAssist(q *req) error {
	var body struct {
		Kind string `json:"kind"`
		Text string `json:"text"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	label := map[string]string{"summary": "Assistant summary", "text": "Text drafted with the assistant", "email": "Email drafted with the assistant"}[body.Kind]
	text := strings.TrimSpace(body.Text)
	if label == "" || text == "" || len(text) > 10000 {
		return bad("kind is summary, text or email, with the text (up to 10,000 characters).")
	}
	res, err := s.apply(q.r.Context(), q.sc, op{ID: newUUIDString(), Kind: "note.add", Payload: map[string]any{"lead_id": q.r.PathValue("id"), "body": label + ":\n" + text}})
	if err != nil {
		return err
	}
	if res.Status != "applied" {
		return &apiError{http.StatusConflict, "rejected", res.Message}
	}
	writeJSON(q.w, 200, res.Result)
	return nil
}

// newUUIDString is a random (version 4) id.
func newUUIDString() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
