package main

// Build step 39 (migrations/0045_carrier_standing.sql): the dialer reports each agency's carrier registration and texting standing
// here. The CRM tells the agency's owner when the standing changes, holds imports until the carriers verify the agency when
// CARRIER_CHECK=on (D314), and shows staff every agency's rates with a second step, never lead details (D269, D271). Staff clear a
// step here; the dialer reads it in this route's answer.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) carrierRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/v1/dialer/carrier", s.dialerCarrier)
	mux.Handle("GET /api/v1/platform/carrier", s.user(s.staffCarrier))
	mux.Handle("POST /api/v1/platform/carrier/{org}/clear", s.user(s.staffClearTexting))
}

type carrierReport struct {
	OrgID          string     `json:"org_id"`
	State          string     `json:"state"`
	CheckRequired  bool       `json:"check_required"`
	MayCall        bool       `json:"may_call"`
	MayText        bool       `json:"may_text"`
	BrandIdentity  string     `json:"brand_identity"`
	CampaignStatus string     `json:"campaign_status"`
	Step           string     `json:"step"`
	Since          *time.Time `json:"since"`
	Reason         string     `json:"reason"`
	Texts          int        `json:"texts"`
	OptOuts        int        `json:"opt_outs"`
	Complaints     int        `json:"complaints"`
	Appeal         string     `json:"appeal"`
	AppealAt       *time.Time `json:"appeal_at"`
}

var stepWords = map[string]string{
	"warned":    "Texting warning: too many people are opting out of or complaining about the agency's texts",
	"limited":   "Texting is limited: one text to many leads is off and texts are capped each day",
	"suspended": "Texting is suspended until Caller Whale reviews it",
	"ok":        "Texting is back in good standing",
}

// dialerCarrier is POST /internal/v1/dialer/carrier, the dialer's report; it answers with the staff review.
func (s *server) dialerCarrier(w http.ResponseWriter, r *http.Request) {
	if s.cfg.dialerToken == "" || subtle.ConstantTimeCompare([]byte(bearer(r)), []byte(s.cfg.dialerToken)) != 1 {
		writeError(w, &apiError{http.StatusUnauthorized, "unauthorized", "Only the dialer service may call this."})
		return
	}
	var rep carrierReport
	if err := readJSON(w, r, &rep); err != nil {
		writeError(w, err)
		return
	}
	if !validID(rep.OrgID) || !slices.Contains([]string{"ok", "warned", "limited", "suspended"}, rep.Step) {
		writeError(w, bad("org_id and step are required."))
		return
	}
	ctx := r.Context()
	var before string
	err := s.st.db.QueryRow(ctx, `SELECT step FROM carrier_standing WHERE org_id = $1`, rep.OrgID).Scan(&before)
	if errors.Is(err, pgx.ErrNoRows) {
		before = "ok"
	} else if err != nil {
		writeError(w, err)
		return
	}
	var cleared *time.Time
	var note string
	err = s.st.db.QueryRow(ctx, `INSERT INTO carrier_standing (org_id, state, check_required, may_call, may_text, brand_identity, campaign_status, step, step_since, reason,
			texts, opt_outs, complaints, appeal, appeal_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
		ON CONFLICT (org_id) DO UPDATE SET state = EXCLUDED.state, check_required = EXCLUDED.check_required, may_call = EXCLUDED.may_call,
			may_text = EXCLUDED.may_text, brand_identity = EXCLUDED.brand_identity, campaign_status = EXCLUDED.campaign_status, step = EXCLUDED.step,
			step_since = EXCLUDED.step_since, reason = EXCLUDED.reason, texts = EXCLUDED.texts, opt_outs = EXCLUDED.opt_outs,
			complaints = EXCLUDED.complaints, appeal = EXCLUDED.appeal, appeal_at = EXCLUDED.appeal_at, updated_at = now()
		RETURNING cleared_at, clear_note`,
		rep.OrgID, rep.State, rep.CheckRequired, rep.MayCall, rep.MayText, rep.BrandIdentity, rep.CampaignStatus, rep.Step, rep.Since, rep.Reason,
		rep.Texts, rep.OptOuts, rep.Complaints, rep.Appeal, rep.AppealAt).Scan(&cleared, &note)
	if err != nil {
		writeError(w, err)
		return
	}
	if before != rep.Step {
		s.tellOwners(ctx, rep.OrgID, stepWords[rep.Step]+". "+rep.Reason)
	}
	writeJSON(w, http.StatusOK, map[string]any{"cleared_at": cleared, "clear_note": note})
}

// tellOwners gives each of the agency's owners a task saying what changed.
func (s *server) tellOwners(ctx context.Context, org, title string) {
	members, err := s.rules.members(ctx, org)
	if err != nil {
		return
	}
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	for _, m := range members {
		if !slices.Contains(m.Roles, "owner") && !slices.Contains(m.Roles, "solo") {
			continue
		}
		var task string
		if tx.QueryRow(ctx, `INSERT INTO tasks (org_id, assignee_id, title, type, priority, due_at) VALUES (cw_org(), $1, $2, 'Task', 'High', now()) RETURNING id::text`,
			m.UserID, truncateText(strings.TrimSpace(title), 300)).Scan(&task) == nil {
			_, _ = tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, op) VALUES (cw_org(), 'task', $1, 'upsert')`, task)
		}
	}
	_ = tx.Commit(ctx)
}

// crossAgencyStaff is the platform owner or cofounder with their second step (D271).
func (s *server) crossAgencyStaff(q *req) error {
	p, err := s.rules.people(q.r.Context(), q.c.Sub)
	if err != nil {
		return err
	}
	if !slices.Contains([]string{"owner", "cofounder"}, p.PlatformRole) {
		return forbidden("Only Caller Whale's owner and cofounder see across agencies.")
	}
	if !q.c.SecondFactor {
		return &apiError{http.StatusForbidden, "second_step_required", "Pass your second sign-in step first."}
	}
	return nil
}

// staffCarrier is GET /api/v1/platform/carrier: every agency's registration and texting rates, worst first. Agency-level numbers only.
func (s *server) staffCarrier(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	rows, err := s.st.db.Query(q.r.Context(), `SELECT jsonb_build_object('org_id', c.org_id, 'agency', coalesce(o.name, ''), 'state', c.state, 'may_call', c.may_call,
			'may_text', c.may_text, 'step', c.step, 'since', c.step_since, 'reason', c.reason, 'texts', c.texts, 'opt_outs', c.opt_outs,
			'complaints', c.complaints, 'opt_out_rate', CASE WHEN c.texts > 0 THEN round(c.opt_outs::numeric / c.texts, 4) END,
			'complaint_rate', CASE WHEN c.texts > 0 THEN round(c.complaints::numeric / c.texts, 4) END,
			'appeal', c.appeal, 'appeal_at', c.appeal_at, 'cleared_at', c.cleared_at, 'clear_note', c.clear_note, 'updated_at', c.updated_at)
		FROM carrier_standing c LEFT JOIN orgs o ON o.id = c.org_id
		ORDER BY array_position(ARRAY['suspended', 'limited', 'warned', 'ok'], c.step), c.complaints DESC, c.opt_outs DESC LIMIT 1000`)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"agencies": list})
	return nil
}

// staffClearTexting is POST /api/v1/platform/carrier/{org}/clear {note}: staff reviewed the agency and end its step; the dialer
// applies it on its next report, and the owner is told.
func (s *server) staffClearTexting(q *req) error {
	if err := s.crossAgencyStaff(q); err != nil {
		return err
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	note := strings.TrimSpace(body.Note)
	if len(note) < 5 || len(note) > 1000 {
		return bad("Say what was reviewed (5 to 1,000 characters).")
	}
	tag, err := s.st.db.Exec(q.r.Context(), `UPDATE carrier_standing SET cleared_at = now(), cleared_by = $2, clear_note = $3 WHERE org_id = $1 AND step <> 'ok'`,
		nullID(q.r.PathValue("org")), q.c.Sub, note)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("That agency's texting is in good standing.")
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// carrierFor is what /api/v1/me says about calling, texting and importing for the agency (D314). Without the check every one is open.
func (s *server) carrierFor(ctx context.Context, org string) map[string]any {
	out := map[string]any{"state": "", "may_call": true, "may_text": true, "may_import": true, "step": "ok"}
	var state, step string
	var call, text bool
	err := s.st.db.QueryRow(ctx, `SELECT state, may_call, may_text, step FROM carrier_standing WHERE org_id = $1`, org).Scan(&state, &call, &text, &step)
	switch {
	case err == nil:
		out["state"], out["may_call"], out["may_text"], out["step"] = state, call, text, step
		if s.cfg.carrierCheck {
			out["may_import"] = call
		}
	case s.cfg.carrierCheck:
		out["state"], out["may_call"], out["may_text"], out["may_import"] = "not_submitted", false, false, false
	}
	return out
}
