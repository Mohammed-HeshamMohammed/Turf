package telnyx

// Reading a lead's reply for an opt-out (D207-D209, D351).
//
//   - A reply that is only an opt-out blocks at once, for this agency: "stop texting me" texts, "stop calling me" calls, and "stop",
//     "leave me alone" or "never call me again" both (when unclear, both). The CRM keeps the block on the agency's list; the thread shows
//     the reply as the opt-out. The agent cannot undo it; the owner or an admin lifts it in the CRM, with a reason (D207), and the lead
//     texting START lifts a block their own reply made.
//   - A reply that uses an opt-out word inside a normal sentence ("let's stop at that price") waits for the person who sends in the
//     thread to choose "opt-out" or "not an opt-out"; nothing else is sent to the lead until then, and the choice is kept (D208).
//   - The carrier answers STOP with its own confirmation on registered (10DLC) numbers; Caller Whale does not send a second one.
//   - "No calls from anyone" never comes from a text alone: the agent confirms it in the CRM (D351).

import (
	"context"
	"regexp"
	"slices"
	"strings"
)

var (
	optOutTexts = []string{"stop texting me", "stop texting", "stop sending texts", "stop sending me texts", "stop messaging me", "no more texts",
		"dont text me", "do not text me", "dont text me again", "do not text me again", "stop text"}
	optOutCalls = []string{"stop calling me", "stop calling", "dont call me", "do not call me", "dont call me again", "do not call me again",
		"no more calls", "stop calling this number"}
	optOutBoth = []string{"stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out",
		"leave me alone", "never call me again", "never contact me again", "never contact me", "do not contact me", "dont contact me",
		"stop contacting me", "remove me", "remove me from your list", "take me off your list", "take me off your list", "remove my number",
		"wrong number stop", "not interested stop", "stop it"}
	// Words that may be an opt-out inside a longer message.
	optOutHints = []string{"stop", "unsubscribe", "opt out", "optout", "remove me", "leave me alone", "dont call", "dont text", "do not call",
		"do not text", "dont contact", "do not contact", "take me off", "never call", "never text"}
	notLetters = regexp.MustCompile(`[^a-z ]+`)
	spaces     = regexp.MustCompile(` +`)
)

// plainWords is a reply in lower-case words only: punctuation, digits and apostrophes go ("don't" is "dont").
func plainWords(text string) string {
	t := strings.ToLower(strings.NewReplacer("'", "", "’", "", "-", " ").Replace(text))
	t = notLetters.ReplaceAllString(t, " ")
	return strings.TrimSpace(spaces.ReplaceAllString(t, " "))
}

type optOutReading struct {
	clear, unclear bool
	calls, texts   bool
}

// readOptOut reads a reply: clear when it is only an opt-out (with what it stops), unclear when it only mentions one.
func readOptOut(text string) optOutReading {
	w := plainWords(text)
	for _, polite := range []string{"please ", "pls "} {
		w = strings.TrimPrefix(w, polite)
	}
	for _, polite := range []string{" please", " pls", " thanks", " thank you", " now"} {
		w = strings.TrimSuffix(w, polite)
	}
	switch {
	case w == "":
		return optOutReading{}
	case slices.Contains(optOutTexts, w):
		return optOutReading{clear: true, texts: true}
	case slices.Contains(optOutCalls, w):
		return optOutReading{clear: true, calls: true}
	case slices.Contains(optOutBoth, w):
		return optOutReading{clear: true, calls: true, texts: true}
	}
	padded := " " + w + " "
	for _, h := range optOutHints {
		if strings.Contains(padded, " "+h+" ") {
			return optOutReading{unclear: true}
		}
	}
	return optOutReading{}
}

// optedOut blocks a number after a clear opt-out or the agent's choice: texts here at once, and the agency's block in the CRM (which
// stops calls too when asked). The CRM's part is retried by nothing: a failure is logged, and the texts block holds meanwhile.
func (s *server) optedOut(ctx context.Context, org, user, lead, phone string, calls, texts bool, said string) error {
	if texts {
		if _, err := s.st.db.Exec(ctx, `INSERT INTO sms_opt_outs (org_id, phone_number, keyword) VALUES ($1, $2, $3)
			ON CONFLICT (org_id, phone_number) DO UPDATE SET keyword = EXCLUDED.keyword, at = now()`, org, phone, truncate(said, 100)); err != nil {
			return err
		}
	}
	return s.crm.block(ctx, org, user, phone, lead, map[string]any{"calls": calls, "texts": texts, "note": "Replied: " + truncate(said, 200)})
}

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// chooseOptOut is POST /api/v1/sms/{id}/opt-out {opt_out}: the person who sends in the lead's thread answers a reply that waits for
// their choice (D208).
func (s *server) chooseOptOut(ctx context.Context, sc scope, id string, optOut bool) error {
	if !validID(id) {
		return notFound("No such text.")
	}
	var lead, from, body string
	err := s.st.db.QueryRow(ctx, `SELECT coalesce(lead_id::text, ''), from_number, body FROM sms_messages
		WHERE id = $1 AND org_id = $2 AND direction = 'incoming' AND opt_out_question = 'waiting'`, id, sc.orgID).Scan(&lead, &from, &body)
	if err != nil {
		return notFound("No reply waits for a choice under that id.")
	}
	_, thread, err := s.leadThread(ctx, sc, lead)
	if err != nil {
		return err
	}
	if err := thread.mustBeSender(sc.userID); err != nil {
		return err
	}
	answer := "not_opt_out"
	if optOut {
		answer = "opt_out"
		if err := s.optedOut(ctx, sc.orgID, sc.userID, lead, from, true, true, body); err != nil {
			return err
		}
	}
	_, err = s.st.db.Exec(ctx, `UPDATE sms_messages SET opt_out_question = $2, opt_out_by = $3, opt_out_at = now(), updated_at = now() WHERE id = $1`, id, answer, sc.userID)
	return err
}
