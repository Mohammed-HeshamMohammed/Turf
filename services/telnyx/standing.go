package telnyx

// Build step 39: each agency's opt-out and complaint rates over 30 days (D269). Above a line the owner is warned, then texting is
// limited, then suspended until Caller Whale's staff review it (in the CRM's staff view, which this service tells). Each change is
// kept, and the owner can appeal. Starting lines, to be tuned with real traffic: carriers watch opt-outs above a few percent and
// complaints above a tenth of a percent.

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type rateLine struct {
	OptOut    float64 `json:"opt_out"`
	Complaint float64 `json:"complaint"`
}

var thresholds = map[string]any{
	"warned": rateLine{0.03, 0.001}, "limited": rateLine{0.05, 0.003}, "suspended": rateLine{0.08, 0.005},
	"minimum_texts": minTextsJudged, "limited_texts_per_day": limitedTextsPerDay, "calm_days": calmDays,
}

const (
	minTextsJudged     = 100 // fewer texts in 30 days than this are not judged
	limitedTextsPerDay = 100
	calmDays           = 7 // a warning or limit ends after this many days under the warning line
)

var steps = []string{"ok", "warned", "limited", "suspended"}

// complaintWords mark a reply that complains, beyond a plain STOP.
var complaintWords = regexp.MustCompile(`(?i)\b(spam+|spamming|scam+|scammer|harass\w*|reported|report you|reporting you|lawyer|attorney|lawsuit|sue you|fcc|ftc|illegal)\b`)

func isComplaint(text string) bool { return complaintWords.MatchString(text) }

func levelOf(texts, optOuts, complaints int) (int, string) {
	if texts < minTextsJudged {
		return 0, ""
	}
	o, c := float64(optOuts)/float64(texts), float64(complaints)/float64(texts)
	for i := len(steps) - 1; i > 0; i-- {
		line := thresholds[steps[i]].(rateLine)
		if o >= line.OptOut || c >= line.Complaint {
			return i, rateWords(texts, optOuts, complaints)
		}
	}
	return 0, rateWords(texts, optOuts, complaints)
}

func rateWords(texts, optOuts, complaints int) string {
	return strings.Join([]string{
		itoa(optOuts) + " opt-outs (" + percent(optOuts, texts) + ")",
		itoa(complaints) + " complaints (" + percent(complaints, texts) + ")",
		"in " + itoa(texts) + " texts over 30 days",
	}, ", ")
}

type standing struct {
	Step       string     `json:"step"`
	Since      time.Time  `json:"since"`
	Reason     string     `json:"reason"`
	Texts      int        `json:"texts"`
	OptOuts    int        `json:"opt_outs"`
	Complaints int        `json:"complaints"`
	Appeal     string     `json:"appeal"`
	AppealAt   *time.Time `json:"appeal_at"`
	calmSince  *time.Time
}

func (s *server) standingOf(ctx context.Context, org string) (standing, error) {
	st := standing{Step: "ok"}
	err := s.st.db.QueryRow(ctx, `SELECT step, since, reason, texts, opt_outs, complaints, appeal, appeal_at, calm_since FROM texting_standing WHERE org_id = $1`, org).
		Scan(&st.Step, &st.Since, &st.Reason, &st.Texts, &st.OptOuts, &st.Complaints, &st.Appeal, &st.AppealAt, &st.calmSince)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, nil
	}
	return st, err
}

// judge works out one agency's rates and moves its step: up one step at a time, at most once a day; back to ok after calmDays under
// the warning line, except a suspension, which only staff end.
func (s *server) judge(ctx context.Context, org string) error {
	var texts, optOuts, complaints int
	if err := s.st.db.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE direction = 'outgoing' AND status IN ('sent', 'delivered', 'failed')),
			count(*) FILTER (WHERE direction = 'incoming' AND opt_out_question = 'opt_out'),
			count(*) FILTER (WHERE (direction = 'incoming' AND complaint) OR (direction = 'outgoing' AND status = 'failed' AND error ILIKE '%spam%'))
		FROM sms_messages WHERE org_id = $1 AND created_at > now() - interval '30 days'`, org).Scan(&texts, &optOuts, &complaints); err != nil {
		return err
	}
	cur, err := s.standingOf(ctx, org)
	if err != nil {
		return err
	}
	level, why := levelOf(texts, optOuts, complaints)
	now := s.now()
	at := indexOf(steps, cur.Step)
	next, reason := at, cur.Reason
	calm := cur.calmSince
	switch {
	case level > at && (at == 0 || now.Sub(cur.Since) >= 24*time.Hour):
		next, reason, calm = at+1, why, nil
	case level > 0:
		calm = nil
	case calm == nil:
		calm = &now
	case cur.Step != "suspended" && at > 0 && now.Sub(*calm) >= calmDays*24*time.Hour:
		next, reason = 0, "Rates under the warning line for "+itoa(calmDays)+" days."
	}
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	since := cur.Since
	if next != at {
		since = now
		if _, err := tx.Exec(ctx, `INSERT INTO texting_steps (org_id, step, reason) VALUES ($1, $2, $3)`, org, steps[next], reason); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO texting_standing (org_id, step, since, reason, texts, opt_outs, complaints, calm_since, checked_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (org_id) DO UPDATE SET step = EXCLUDED.step, since = EXCLUDED.since, reason = EXCLUDED.reason, texts = EXCLUDED.texts,
			opt_outs = EXCLUDED.opt_outs, complaints = EXCLUDED.complaints, calm_since = EXCLUDED.calm_since, checked_at = now(),
			appeal = CASE WHEN EXCLUDED.step = 'ok' THEN '' ELSE texting_standing.appeal END,
			appeal_at = CASE WHEN EXCLUDED.step = 'ok' THEN NULL ELSE texting_standing.appeal_at END`,
		org, steps[next], since, reason, texts, optOuts, complaints, calm); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if next != at {
		log.Printf("INFO texting standing of %s: %s (%s)", org, steps[next], reason)
	}
	return nil
}

// judgeAll judges every agency that texted in the last 30 days or is not in good standing, and tells the CRM.
func (s *server) judgeAll(ctx context.Context) {
	rows, err := s.st.db.Query(ctx, `SELECT DISTINCT org_id::text FROM sms_messages WHERE created_at > now() - interval '30 days'
		UNION SELECT org_id::text FROM texting_standing WHERE step <> 'ok' UNION SELECT org_id::text FROM carrier_registrations`)
	if err != nil {
		log.Printf("WARN texting standing: %v", err)
		return
	}
	orgs, _ := pgx.CollectRows(rows, pgx.RowTo[string])
	for _, org := range orgs {
		if err := s.judge(ctx, org); err != nil {
			log.Printf("WARN texting standing of %s: %v", org, err)
			continue
		}
		s.tellCRM(ctx, org)
	}
}

func (s *server) carrierPeriodically(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.onlyOne(ctx, "carrier", func(ctx context.Context) {
				s.advanceAll(ctx)
				s.judgeAll(ctx)
			})
		}
	}
}

// erasePeriodically removes, every ten minutes, the numbers the CRM lists as deleted on a person's request (step 44).
func (s *server) erasePeriodically(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.onlyOne(ctx, "erasures", s.eraseRequested)
		}
	}
}

// tellCRM sends the agency's carrier state and texting standing to the CRM, for the import check, the owner's notices and the staff
// view (D271, D314). Its answer carries a staff review: a suspension staff cleared ends here.
func (s *server) tellCRM(ctx context.Context, org string) {
	r, err := s.loadRegistration(ctx, org)
	if err != nil {
		return
	}
	st, err := s.standingOf(ctx, org)
	if err != nil {
		return
	}
	reply, err := s.crm.carrier(ctx, org, map[string]any{"state": r.state(), "check_required": s.cfg.carrierCheck,
		"may_call": !s.cfg.carrierCheck || r.mayCall(), "may_text": !s.cfg.carrierCheck || r.mayText(),
		"brand_identity": r.BrandIdentity, "campaign_status": r.CampaignStatus, "step": st.Step, "since": st.Since, "reason": st.Reason,
		"texts": st.Texts, "opt_outs": st.OptOuts, "complaints": st.Complaints, "appeal": st.Appeal, "appeal_at": st.AppealAt})
	if err != nil {
		log.Printf("WARN telling the CRM the carrier standing of %s: %v", org, err)
		return
	}
	// Staff reviewed the agency after this step began: back to good standing, recorded.
	if reply.ClearedAt != nil && st.Step != "ok" && reply.ClearedAt.After(st.Since) {
		tx, err := s.st.db.Begin(ctx)
		if err != nil {
			return
		}
		defer tx.Rollback(ctx)
		_, _ = tx.Exec(ctx, `UPDATE texting_standing SET step = 'ok', since = $2, reason = 'Reviewed by Caller Whale.', calm_since = NULL, appeal = '', appeal_at = NULL WHERE org_id = $1`, org, *reply.ClearedAt)
		_, _ = tx.Exec(ctx, `INSERT INTO texting_steps (org_id, step, reason, by_whom, note) VALUES ($1, 'ok', 'Reviewed by Caller Whale.', 'staff', $2)`, org, reply.ClearNote)
		if tx.Commit(ctx) == nil {
			s.tellCRM(ctx, org)
		}
	}
}

// appealTexting is POST /api/v1/carrier/appeal {note}: the owner explains, once per step; staff see it with the rates.
func (s *server) appealTexting(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner appeals the agency's texting standing.")
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	note := strings.TrimSpace(body.Note)
	if len(note) < 10 || len(note) > 2000 {
		return bad("Explain in 10 to 2,000 characters.")
	}
	ctx := q.r.Context()
	tag, err := s.st.db.Exec(ctx, `UPDATE texting_standing SET appeal = $2, appeal_at = now() WHERE org_id = $1 AND step <> 'ok' AND appeal_at IS NULL`, q.sc.orgID, note)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflictErr("There is nothing to appeal, or this step was already appealed.")
	}
	_, _ = s.st.db.Exec(ctx, `INSERT INTO texting_steps (org_id, step, reason, by_whom, note) SELECT org_id, step, 'Appealed by the owner.', 'appeal', $2 FROM texting_standing WHERE org_id = $1`, q.sc.orgID, note)
	s.tellCRM(ctx, q.sc.orgID)
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func indexOf(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return 0
}

func itoa(n int) string { return strconv.Itoa(n) }

func percent(n, of int) string {
	if of == 0 {
		return "0%"
	}
	p := float64(n) * 100 / float64(of)
	whole := int(p)
	tenths := int((p - float64(whole)) * 10)
	return itoa(whole) + "." + itoa(tenths) + "%"
}
