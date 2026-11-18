package main

// Build step 26, part C: the call's summary afterwards, with a suggested outcome for the agent to confirm (D320, D361). The AI is in
// the assistant service (ASSISTANT_URL, ASSISTANT_TOKEN); it is told the captions and the signals of this call only. The summary is a
// draft kept on the call for its agent; it reaches the lead's record when the agent puts it in the wrap-up's notes (D322). Each summary
// is one use of the assistant, charged to the lead's team and client within the person's daily cap (D323).

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var outcomeLine = regexp.MustCompile(`(?im)^\s*OUTCOME:\s*(.+?)\s*$`)

// splitSummary parts the assistant's answer into the summary and the outcome on its last line (only one of the dispositions).
func splitSummary(answer string) (string, string) {
	outcome := ""
	if m := outcomeLine.FindStringSubmatch(answer); m != nil {
		outcome = validDisposition(strings.Trim(m[1], ". "))
	}
	return strings.TrimSpace(outcomeLine.ReplaceAllString(answer, "")), outcome
}

func (s *server) summarizeCall(ctx context.Context, sc scope, id string) (map[string]any, error) {
	c, err := s.ownCall(ctx, sc, id)
	if err != nil {
		return nil, err
	}
	if s.cfg.assistantURL == "" {
		return nil, &apiError{http.StatusServiceUnavailable, "assistant_off", "The assistant is not switched on for Caller Whale yet."}
	}
	if !c.Suggestions {
		return nil, conflictErr("The AI's suggestions are off for this call.")
	}
	rows, err := s.st.db.Query(ctx, `SELECT text FROM call_captions WHERE call_id = $1 ORDER BY id`, c.ID)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	b.WriteString("Captions (the lead's side):\n")
	lines := 0
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			rows.Close()
			return nil, err
		}
		b.WriteString("- " + line + "\n")
		lines++
	}
	rows.Close()
	if lines == 0 {
		return nil, conflictErr("This call has no captions to summarise.")
	}
	signals, err := s.signalsWhere(ctx, `call_id = $1 AND decision <> 'dismissed'`, `ORDER BY created_at`, c.ID)
	if err != nil {
		return nil, err
	}
	for _, sig := range signals {
		b.WriteString("Signal: " + sig["kind"].(string) + "\n")
	}
	var lead leadInfo
	if c.LeadID != nil {
		if lead, err = s.crm.lead(ctx, sc.orgID, sc.userID, *c.LeadID); err != nil {
			return nil, notFound("The call's lead is outside your access.")
		}
	}
	if s.budget != nil {
		if err := s.budget.use(ctx, usageAsk{OrgID: sc.orgID, Kind: "ai", Amount: 1, RequestID: newUUID(), TeamID: optional(lead.TeamID),
			UserID: optional(sc.userID), ClientID: optional(lead.ClientID)}); err != nil {
			return nil, err
		}
	}
	answer, err := s.askAssistant(ctx, "call_summary", b.String())
	if err != nil {
		return nil, err
	}
	summary, outcome := splitSummary(answer)
	// An opt-out the captions heard comes first; otherwise the AI's outcome is the one pre-selected.
	if _, err = s.st.db.Exec(ctx, `UPDATE calls SET ai_summary = $2, suggested_outcome = CASE WHEN suggested_outcome = 'Do not call' OR $3 = '' THEN suggested_outcome ELSE $3 END,
		updated_at = now() WHERE id = $1`, c.ID, summary, outcome); err != nil {
		return nil, err
	}
	c, err = s.loadCall(ctx, nil, `id = $1`, c.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"summary": summary, "ai_outcome": outcome, "suggested_outcome": c.SuggestedOutcome}, nil
}

var assistantHTTP = &http.Client{Timeout: 45 * time.Second}

func (s *server) askAssistant(ctx context.Context, task, facts string) (string, error) {
	raw, _ := json.Marshal(map[string]any{"task": task, "facts": facts})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.assistantURL+"/v1/agent/complete", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.assistantToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := assistantHTTP.Do(req)
	if err != nil {
		return "", &apiError{http.StatusServiceUnavailable, "unavailable", "The assistant cannot be reached right now. Try again in a moment."}
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out struct {
		Text string `json:"text"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(data, &out) != nil || strings.TrimSpace(out.Text) == "" {
		return "", &apiError{http.StatusBadGateway, "assistant", "The assistant did not answer. Try again in a moment."}
	}
	return out.Text, nil
}
