package crm

// Build step 45 (migrations/0048_shared_learning.sql): shared learning by agreement (D324-D327, D146, D349).
//
// What is learned: how often calls reach people by hour of the week and by attempt, as counts. Nothing else, and never a name,
// number, address, client or text. An agency's month of counts is shared only while every gate holds:
//   - SHARED_LEARNING=on, Caller Whale's switch once the lawyer approved the agreement (off until then: nothing is used);
//   - the owner signed the separate agreement of the current version, with their second step, and has not withdrawn;
//   - staff checked the agency's notice to its leads covers this use;
//   - a client's leads count only once that client agreed for its part;
//   - the check passes: every row is a known kind, a bucket of digits and counts, before anything is written.
// An agency that agreed gets the AI discount in billing while it keeps agreeing (D325). Withdrawing stops new counts and the
// discount; what was already learned stays, as the agreement says (D327). Agencies see shared patterns only as totals over at
// least three agencies, so no one agency's work can be read from them.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	learningVersion   = "2026-11-draft" // the agreement's text below; the lawyer's version replaces it
	minAgencies       = 3               // a shared figure is shown only when at least this many agencies make it up
	learningDiscount  = 20              // percent off AI features while the agency agrees (D325); to confirm with the feature's price
	learningLookback  = 90              // days of calls a month's run reads
	learningAgreement = "Caller Whale may learn general patterns from this agency's calls: how often calls reach people at each hour of the week and on each attempt, as counts. No name, number, address, client, recording, caption or text ever leaves the agency. Calls for a client count only once that client agrees. The agency can withdraw at any time: nothing new is used from then and the AI discount stops; patterns already learned stay, because they cannot be traced back to the agency. While the agency agrees, AI features cost less. (Draft: the lawyer's text replaces this.)"
)

var (
	learningKinds = []string{"reach_by_hour", "reach_by_attempt"}
	bucketShape   = regexp.MustCompile(`^[0-9]{1,2}(:[0-9]{1,2})?$`)
)

type patternRow struct {
	Kind, Bucket   string
	Calls, Reached int
}

// checkPatterns is the check that no personal detail remains (D326): only known kinds, digit buckets and counts pass.
func checkPatterns(rows []patternRow) error {
	for _, r := range rows {
		switch {
		case !slices.Contains(learningKinds, r.Kind):
			return fmt.Errorf("unknown kind %q", r.Kind)
		case !bucketShape.MatchString(r.Bucket):
			return fmt.Errorf("a bucket that is not a number: %q", r.Bucket)
		case r.Calls < 0 || r.Reached < 0 || r.Reached > r.Calls:
			return fmt.Errorf("counts out of range in %s %s", r.Kind, r.Bucket)
		}
	}
	return nil
}

func sourceOf(org string) string {
	sum := sha256.Sum256([]byte("callerwhale-shared-learning|" + org))
	return hex.EncodeToString(sum[:])
}

func (s *server) learningRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/learning/agreement", s.member(s.learningAgreement))
	mux.Handle("POST /api/v1/learning/agreement", s.member(s.signLearning))
	mux.Handle("POST /api/v1/learning/agreement/withdraw", s.member(s.withdrawLearning))
	mux.Handle("POST /api/v1/learning/clients/{id}/agree", s.member(s.clientLearning(true)))
	mux.Handle("POST /api/v1/learning/clients/{id}/withdraw", s.member(s.clientLearning(false)))
	mux.Handle("GET /api/v1/learning/shared-patterns", s.member(s.sharedPatterns))
	mux.Handle("GET /api/v1/platform/learning", s.user(s.staffLearning))
	mux.Handle("POST /api/v1/platform/learning/{org}/notice-checked", s.user(s.staffNoticeChecked))
}

type agreement struct {
	Version       string     `json:"version"`
	SignedAt      time.Time  `json:"signed_at"`
	NoticeURL     string     `json:"notice_url"`
	NoticeChecked *time.Time `json:"notice_checked_at"`
	WithdrawnAt   *time.Time `json:"withdrawn_at"`
}

func (s *server) agreementOf(ctx context.Context, org string) (*agreement, error) {
	var a agreement
	err := s.st.db.QueryRow(ctx, `SELECT version, signed_at, notice_url, notice_checked_at, withdrawn_at FROM learning_agreements WHERE org_id = $1`, org).
		Scan(&a.Version, &a.SignedAt, &a.NoticeURL, &a.NoticeChecked, &a.WithdrawnAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &a, err
}

// sharing is whether the agency's counts may be used now, and if not, why.
func (s *server) sharing(a *agreement) (bool, string) {
	switch {
	case !s.cfg.sharedLearning:
		return false, "Shared learning is not open yet: the agreement waits for the lawyer."
	case a == nil || a.WithdrawnAt != nil:
		return false, "The owner has not agreed."
	case a.Version != learningVersion:
		return false, "The agreement changed: the owner agrees to the new version."
	case a.NoticeChecked == nil:
		return false, "Caller Whale has not yet checked the agency's notice to its leads."
	}
	return true, ""
}

// learningAgreement is GET /api/v1/learning/agreement: the text, where the agency stands, and each client's part.
func (s *server) learningAgreement(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the learning agreement.")
	}
	ctx := q.r.Context()
	a, err := s.agreementOf(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	on, why := s.sharing(a)
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	clients, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('client_id', c.id, 'name', c.name, 'agreed', k.agreed_at IS NOT NULL AND k.withdrawn_at IS NULL, 'agreed_at', k.agreed_at)
		FROM clients c LEFT JOIN client_learning_consents k ON k.client_id = c.id ORDER BY c.name`)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"text": learningAgreement, "version": learningVersion, "agreement": a, "sharing": on, "why_not": why,
		"discount_percent": learningDiscount, "clients": clients})
	return nil
}

// signLearning is POST /api/v1/learning/agreement {version, notice_url}: the owner agrees, with their second step.
func (s *server) signLearning(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("Only the owner agrees to shared learning.")
	}
	if !q.sc.secondStep {
		return &apiError{http.StatusForbidden, "second_step_required", "Pass your second sign-in step first."}
	}
	var body struct {
		Version   string `json:"version"`
		NoticeURL string `json:"notice_url"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.Version != learningVersion {
		return bad("Agree to the agreement's current version (" + learningVersion + ").")
	}
	notice := strings.TrimSpace(body.NoticeURL)
	if !strings.HasPrefix(notice, "https://") || len(notice) > 500 {
		return bad("Give the https address of the notice your leads read (your privacy notice), so Caller Whale can check it covers this use.")
	}
	ctx := q.r.Context()
	if _, err := s.st.db.Exec(ctx, `INSERT INTO learning_agreements (org_id, version, signed_by, notice_url) VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id) DO UPDATE SET version = EXCLUDED.version, signed_by = EXCLUDED.signed_by, signed_at = now(),
			notice_checked_at = CASE WHEN learning_agreements.notice_url = EXCLUDED.notice_url THEN learning_agreements.notice_checked_at END,
			notice_url = EXCLUDED.notice_url, withdrawn_at = NULL, withdrawn_by = NULL`, q.sc.orgID, learningVersion, q.sc.userID, notice); err != nil {
		return err
	}
	s.setLearningDiscount(ctx, q.sc.orgID, true)
	return s.learningAgreement(q)
}

// withdrawLearning is POST /api/v1/learning/agreement/withdraw: nothing new is used and the discount stops (D327).
func (s *server) withdrawLearning(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("Only the owner withdraws the agency's agreement.")
	}
	ctx := q.r.Context()
	tag, err := s.st.db.Exec(ctx, `UPDATE learning_agreements SET withdrawn_at = now(), withdrawn_by = $2 WHERE org_id = $1 AND withdrawn_at IS NULL`, q.sc.orgID, q.sc.userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflictErr("The agency has not agreed.")
	}
	s.setLearningDiscount(ctx, q.sc.orgID, false)
	return s.learningAgreement(q)
}

// clientLearning is POST /api/v1/learning/clients/{id}/agree or /withdraw, by a person of that client (D326).
func (s *server) clientLearning(agree bool) handler {
	return func(q *req) error {
		ctx := q.r.Context()
		client := q.r.PathValue("id")
		tx, err := s.st.begin(ctx, q.sc)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		var member bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM client_members WHERE client_id = $1 AND user_id = $2)`, nullID(client), q.sc.userID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return forbidden("Only the client's own people agree for the client.")
		}
		if agree {
			_, err = tx.Exec(ctx, `INSERT INTO client_learning_consents (org_id, client_id, agreed_by) VALUES (cw_org(), $1, $2)
				ON CONFLICT (org_id, client_id) DO UPDATE SET agreed_by = EXCLUDED.agreed_by, agreed_at = now(), withdrawn_at = NULL`, client, q.sc.userID)
		} else {
			_, err = tx.Exec(ctx, `UPDATE client_learning_consents SET withdrawn_at = now() WHERE client_id = $1 AND withdrawn_at IS NULL`, client)
		}
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		writeJSON(q.w, http.StatusOK, map[string]any{"client_id": client, "agreed": agree})
		return nil
	}
}

// patternsOf counts the agency's calls of the last 90 days that may be used: the agency's own work, and clients that agreed.
func patternsOf(ctx context.Context, tx pgx.Tx) ([]patternRow, error) {
	_, _, zone := agencyDay(ctx, tx, time.Now())
	rows, err := tx.Query(ctx, `WITH usable AS (
			SELECT c.lead_id, c.occurred_at, c.meaning = 'reached' AS reached FROM call_events c JOIN leads l ON l.id = c.lead_id
			WHERE c.occurred_at > now() - make_interval(days => $2) AND c.meaning <> ''
				AND (l.client_id IS NULL OR EXISTS (SELECT 1 FROM client_learning_consents k WHERE k.client_id = l.client_id AND k.withdrawn_at IS NULL))),
		numbered AS (SELECT reached, occurred_at, row_number() OVER (PARTITION BY lead_id ORDER BY occurred_at) AS attempt FROM usable)
		SELECT 'reach_by_hour', extract(isodow FROM occurred_at AT TIME ZONE $1)::int || ':' || extract(hour FROM occurred_at AT TIME ZONE $1)::int, count(*), count(*) FILTER (WHERE reached)
			FROM numbered GROUP BY 2
		UNION ALL
		SELECT 'reach_by_attempt', least(attempt, 10)::text, count(*), count(*) FILTER (WHERE reached) FROM numbered GROUP BY 2`, zone.String(), learningLookback)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (patternRow, error) {
		var p patternRow
		var calls, reached int64
		err := r.Scan(&p.Kind, &p.Bucket, &calls, &reached)
		p.Calls, p.Reached = int(calls), int(reached)
		return p, err
	})
}

// contribute replaces this month's counts of one agency, when every gate holds and the check passes.
func (s *server) contribute(ctx context.Context, org string) error {
	a, err := s.agreementOf(ctx, org)
	if err != nil {
		return err
	}
	if ok, _ := s.sharing(a); !ok {
		return nil
	}
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := patternsOf(ctx, tx)
	if err != nil {
		return err
	}
	month := time.Date(s.now().Year(), s.now().Month(), 1, 0, 0, 0, 0, time.UTC)
	if err := checkPatterns(rows); err != nil {
		_, _ = s.st.db.Exec(ctx, `INSERT INTO shared_learning_runs (org_id, month, rows, passed, problem) VALUES ($1, $2, $3, false, $4)`, org, month, len(rows), err.Error())
		return fmt.Errorf("the check stopped the agency's patterns: %w", err)
	}
	src := sourceOf(org)
	if _, err := tx.Exec(ctx, `DELETE FROM shared_patterns WHERE month = $1 AND source = $2`, month, src); err != nil {
		return err
	}
	for _, r := range rows {
		if _, err := tx.Exec(ctx, `INSERT INTO shared_patterns (month, kind, bucket, source, calls, reached) VALUES ($1, $2, $3, $4, $5, $6)`, month, r.Kind, r.Bucket, src, r.Calls, r.Reached); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO shared_learning_runs (org_id, month, rows, passed) VALUES ($1, $2, $3, true)`, org, month, len(rows)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *server) contributeAll(ctx context.Context) {
	if !s.cfg.sharedLearning {
		return
	}
	rows, err := s.st.db.Query(ctx, `SELECT org_id::text FROM learning_agreements WHERE withdrawn_at IS NULL AND notice_checked_at IS NOT NULL`)
	if err != nil {
		log.Printf("WARN shared learning: %v", err)
		return
	}
	orgs, _ := pgx.CollectRows(rows, pgx.RowTo[string])
	for _, org := range orgs {
		if err := s.contribute(ctx, org); err != nil {
			log.Printf("WARN shared learning of %s: %v", org, err)
		}
	}
}

// sharedPatterns is GET /api/v1/learning/shared-patterns: what agencies' calls show together, only where at least three agencies
// make up a figure.
func (s *server) sharedPatterns(q *req) error {
	rows, err := s.st.db.Query(q.r.Context(), `SELECT jsonb_build_object('kind', kind, 'bucket', bucket, 'calls', sum(calls), 'reach_rate', round(sum(reached)::numeric / nullif(sum(calls), 0), 3))
		FROM shared_patterns WHERE month >= date_trunc('month', now() - interval '3 months')
		GROUP BY kind, bucket HAVING count(DISTINCT source) >= $1 ORDER BY kind, bucket`, minAgencies)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"patterns": list, "min_agencies": minAgencies})
	return nil
}

// ---- staff ----

func (s *server) staffLearning(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	rows, err := s.st.db.Query(q.r.Context(), `SELECT jsonb_build_object('org_id', a.org_id, 'agency', coalesce(o.name, ''), 'version', a.version, 'signed_at', a.signed_at,
			'notice_url', a.notice_url, 'notice_checked_at', a.notice_checked_at, 'notice_check_note', a.notice_check_note, 'withdrawn_at', a.withdrawn_at,
			'last_run', (SELECT jsonb_build_object('at', r.at, 'rows', r.rows, 'passed', r.passed, 'problem', r.problem) FROM shared_learning_runs r WHERE r.org_id = a.org_id ORDER BY r.at DESC LIMIT 1))
		FROM learning_agreements a LEFT JOIN orgs o ON o.id = a.org_id ORDER BY (a.notice_checked_at IS NULL AND a.withdrawn_at IS NULL) DESC, a.signed_at DESC`)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"agreements": list})
	return nil
}

// staffNoticeChecked is POST /api/v1/platform/learning/{org}/notice-checked {ok, note}: staff, with the lawyer's guidance, say whether
// the agency's notice to its leads covers this use.
func (s *server) staffNoticeChecked(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	var body struct {
		OK   bool   `json:"ok"`
		Note string `json:"note"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if len(body.Note) > 1000 {
		return bad("Keep the note under 1,000 characters.")
	}
	var checked any
	if body.OK {
		checked = s.now()
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE learning_agreements SET notice_checked_at = $2, notice_checked_by = $3, notice_check_note = $4 WHERE org_id = $1`,
		nullID(q.r.PathValue("org")), checked, q.c.Sub, strings.TrimSpace(body.Note))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("That agency has not agreed.")
	}
	if !body.OK {
		s.tellOwners(q.r.Context(), q.r.PathValue("org"), "Shared learning: your notice to leads needs a change before your calls can count. "+strings.TrimSpace(body.Note))
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": body.OK})
	return nil
}

// setLearningDiscount asks billing to give or end the AI discount (D325). Without billing nothing is charged, so nothing to change.
func (s *server) setLearningDiscount(ctx context.Context, org string, on bool) {
	if s.cfg.billingURL == "" {
		return
	}
	percent := 0
	if on {
		percent = learningDiscount
	}
	var out map[string]any
	if err := putJSON(ctx, s.cfg.billingURL+"/v1/orgs/"+org+"/discounts/shared_learning", s.cfg.billingToken, map[string]any{"kind": "ai", "percent": percent}, &out); err != nil {
		log.Printf("WARN the shared-learning discount of %s: %v", org, err)
	}
}

// putJSON sets something in another Caller Whale service.
func putJSON(ctx context.Context, url, token string, body, into any) error {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := aiHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(into)
}
