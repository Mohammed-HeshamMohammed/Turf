package main

// The public status page and breach notices (database_setup/0031_status_breach.sql).
//
//   - The public status: each part of Caller Whale (sign-in, the CRM, calls, texts, chats, email) as up, degraded or down, from the
//     incidents staff open and, when STATUS_PROBES is set ("calls=http://dialer-sms:8113/healthz,..."), from the monitoring stack's
//     own health checks (see probeSource; three failed checks in a row mark it down). Anyone may read it; signed-in screens show its banner while something is wrong, and people
//     who chose it get an email when an incident opens and when it ends (D235).
//   - Breach notices: staff record what happened and what to do for each affected agency; its owner is emailed at once, and each notice
//     shows whether it went within 72 hours of Caller Whale knowing (D236). What to tell leads and authorities is the lawyer's, in
//     docs/legal/breach-response-plan.md.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var statusParts = []struct{ id, name string }{
	{"sign_in", "Sign-in"}, {"crm", "Leads and the CRM"}, {"calls", "Calls"}, {"texts", "Texts"}, {"chats", "Chats"}, {"email", "Email"},
}

const breachHours = 72

func statusPart(id string) bool {
	return slices.ContainsFunc(statusParts, func(p struct{ id, name string }) bool { return p.id == id })
}

type incident struct {
	ID         string           `json:"id"`
	Components []string         `json:"components"`
	Severity   string           `json:"severity"`
	Title      string           `json:"title"`
	Message    string           `json:"message"`
	StartedAt  int64            `json:"started_at"`
	ResolvedAt *int64           `json:"resolved_at"`
	Updates    []map[string]any `json:"updates"`
}

func (s *server) incidents(ctx context.Context, where string, args ...any) ([]incident, error) {
	rows, err := s.db.Query(ctx, `SELECT id, components, severity, title, message, started_at, resolved_at, updates FROM status_incidents WHERE `+where+` ORDER BY started_at DESC LIMIT 50`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []incident{}
	for rows.Next() {
		var in incident
		var comps, updates string
		if err := rows.Scan(&in.ID, &comps, &in.Severity, &in.Title, &in.Message, &in.StartedAt, &in.ResolvedAt, &updates); err != nil {
			return nil, err
		}
		in.Components = strings.Split(comps, ",")
		_ = json.Unmarshal([]byte(updates), &in.Updates)
		if in.Updates == nil {
			in.Updates = []map[string]any{}
		}
		out = append(out, in)
	}
	return out, rows.Err()
}

// getStatus is GET /v1/status (open to everyone): each part's state, the incidents still open (the banner), and the last 30 days'.
func (s *server) getStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	open, err := s.incidents(ctx, "resolved_at IS NULL")
	if err != nil {
		return err
	}
	past, err := s.incidents(ctx, "resolved_at IS NOT NULL AND started_at > $1", now()-30*86400)
	if err != nil {
		return err
	}
	state := map[string]string{}
	since := map[string]int64{}
	rank := map[string]int{"up": 0, "degraded": 1, "down": 2}
	set := func(part, st string, at int64) {
		if rank[st] > rank[state[part]] {
			state[part], since[part] = st, at
		}
	}
	for _, p := range statusParts {
		state[p.id] = "up"
	}
	for _, in := range open {
		for _, c := range in.Components {
			set(c, in.Severity, in.StartedAt)
		}
	}
	for part, at := range s.probes.downParts(ctx) {
		set(part, "down", at)
	}
	parts := []map[string]any{}
	for _, p := range statusParts {
		parts = append(parts, map[string]any{"id": p.id, "name": p.name, "state": state[p.id], "since": nilIfZero(since[p.id])})
	}
	var banner any
	if len(open) > 0 {
		banner = map[string]any{"title": open[0].Title, "severity": open[0].Severity, "link": "/status"}
	}
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, http.StatusOK, map[string]any{"parts": parts, "open": open, "past": past, "banner": banner})
	return nil
}

func nilIfZero(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

// openIncident is POST /v1/admin/status/incidents {components, severity, title, message} (staff).
func (s *server) openIncident(w http.ResponseWriter, r *http.Request) error {
	c, err := s.staffActor(r, false)
	if err != nil {
		return err
	}
	var body struct {
		Components []string `json:"components"`
		Severity   string   `json:"severity"`
		Title      string   `json:"title"`
		Message    string   `json:"message"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.Title, body.Message = strings.TrimSpace(body.Title), strings.TrimSpace(body.Message)
	if len(body.Components) == 0 || slices.ContainsFunc(body.Components, func(x string) bool { return !statusPart(x) }) ||
		(body.Severity != "degraded" && body.Severity != "down") || body.Title == "" || utf8.RuneCountInString(body.Title) > 120 || utf8.RuneCountInString(body.Message) > 2000 {
		return bad("Choose the parts (sign_in, crm, calls, texts, chats, email), degraded or down, and a short title.")
	}
	id := uuid.NewString()
	if _, err := s.db.Exec(r.Context(), `INSERT INTO status_incidents (id, components, severity, title, message, started_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, strings.Join(body.Components, ","), body.Severity, body.Title, body.Message, now(), c.Sub); err != nil {
		return err
	}
	s.tellSubscribers(r.Context(), "Caller Whale: "+body.Title, body.Message, "started")
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
	return nil
}

// updateIncident is POST /v1/admin/status/incidents/{id} {message, resolved} (staff): a note on it, or its end.
func (s *server) updateIncident(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	var body struct {
		Message  string `json:"message"`
		Resolved bool   `json:"resolved"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	msg := strings.TrimSpace(body.Message)
	if utf8.RuneCountInString(msg) > 2000 || (msg == "" && !body.Resolved) {
		return bad("Write the update, or mark it resolved.")
	}
	var title, updates string
	err := s.db.QueryRow(r.Context(), `SELECT title, updates FROM status_incidents WHERE id = $1 AND resolved_at IS NULL`, r.PathValue("id")).Scan(&title, &updates)
	if errors.Is(err, pgx.ErrNoRows) {
		return newError(http.StatusNotFound, "not_found", "No open incident under that id.")
	}
	if err != nil {
		return err
	}
	var list []map[string]any
	_ = json.Unmarshal([]byte(updates), &list)
	if msg != "" {
		list = append(list, map[string]any{"at": now(), "message": msg})
	}
	raw, _ := json.Marshal(list)
	var resolved any
	if body.Resolved {
		resolved = now()
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE status_incidents SET updates = $2, resolved_at = $3 WHERE id = $1`, r.PathValue("id"), string(raw), resolved); err != nil {
		return err
	}
	if body.Resolved {
		s.tellSubscribers(r.Context(), "Resolved: "+title, msg, "resolved")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// statusEmails is GET/PUT /v1/me/status-emails {on}: whether the person gets an email when something is down.
func (s *server) statusEmails(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	if r.Method == http.MethodPut {
		var body struct {
			On bool `json:"on"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		if body.On {
			_, err = s.db.Exec(r.Context(), `INSERT INTO status_subscribers (user_id, since) VALUES ($1, $2) ON CONFLICT DO NOTHING`, c.Sub, now())
		} else {
			_, err = s.db.Exec(r.Context(), `DELETE FROM status_subscribers WHERE user_id = $1`, c.Sub)
		}
		if err != nil {
			return err
		}
	}
	var on bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM status_subscribers WHERE user_id = $1)`, c.Sub).Scan(&on); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"on": on})
	return nil
}

// tellSubscribers emails everyone who chose it; a failure is logged and the rest still go.
func (s *server) tellSubscribers(ctx context.Context, title, message, kind string) {
	if s.mail == nil {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT u.email FROM status_subscribers sub JOIN users u ON u.id = sub.user_id WHERE u.email <> ''`)
	if err != nil {
		log.Printf("WARN status emails: %v", err)
		return
	}
	emails, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return
	}
	link := strings.TrimRight(s.cfg.landingURL, "/") + "/status"
	for _, to := range emails {
		if err := s.mail.sendTemplate(ctx, "status", to, map[string]any{"title": title, "message": message, "kind": kind, "link": link}); err != nil {
			log.Printf("WARN status email: %v", err)
		}
	}
}

// probeSource is where the status page learns which parts answer their health check: the monitoring stack, which already checks
// every service every 15 seconds (alert-relay's GET /probes reads it from Prometheus). This service checks nothing itself and calls
// no other service for it. A part is down when every check of the last 45 seconds failed. When the monitoring stack cannot be
// read, the page shows the incidents staff opened only.
type probeSource struct {
	url   string            // STATUS_SOURCE_URL, like http://alert-relay:8121
	parts map[string]string // STATUS_PROBES: part -> its health address, as the monitoring stack names it
	http  *http.Client

	mu     sync.Mutex
	at     time.Time
	down   map[string]int64 // part -> since when (0: not known)
	warned time.Time
}

func newProbeSource(url string, parts map[string]string) *probeSource {
	if url == "" || len(parts) == 0 {
		return nil
	}
	return &probeSource{url: url, parts: parts, http: &http.Client{Timeout: 3 * time.Second}}
}

// downParts answers the parts that are down, from a copy at most 15 seconds old.
func (p *probeSource) downParts(ctx context.Context) map[string]int64 {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.down != nil && time.Since(p.at) < 15*time.Second {
		return p.down
	}
	down, err := p.fetch(ctx)
	if err != nil {
		if time.Since(p.warned) >= 10*time.Minute {
			log.Printf("WARN the status page cannot read the monitoring checks, so it shows incidents only: %v", err)
			p.warned = time.Now()
		}
		return nil
	}
	p.down, p.at = down, time.Now()
	return down
}

func (p *probeSource) fetch(ctx context.Context) (map[string]int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url+"/probes", nil)
	if err != nil {
		return nil, err
	}
	res, err := p.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the monitoring checks answered %d", res.StatusCode)
	}
	var body struct {
		Probes []struct {
			Target string `json:"target"`
			Up     bool   `json:"up"`
			Since  int64  `json:"since"`
		} `json:"probes"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return nil, err
	}
	down := map[string]int64{}
	for part, target := range p.parts {
		for _, pr := range body.Probes {
			if pr.Target == target && !pr.Up {
				down[part] = pr.Since
			}
		}
	}
	return down, nil
}

// parseProbes reads STATUS_PROBES: "calls=http://dialer-sms:8113/healthz,crm=http://crm-core:8107/healthz".
func parseProbes(text string) (map[string]string, error) {
	out := map[string]string{}
	for _, pair := range strings.Split(text, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		part, target, ok := strings.Cut(pair, "=")
		if !ok || !statusPart(part) || !(strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://")) {
			return nil, errors.New("STATUS_PROBES is part=http://address,... with parts sign_in, crm, calls, texts, chats, email")
		}
		out[part] = target
	}
	return out, nil
}

// ---- breach notices (D236) ----

// sendBreachNotice is POST /v1/admin/breach-notices {org_ids, discovered_at, what, to_do} (staff): each agency's owner is emailed now.
func (s *server) sendBreachNotice(w http.ResponseWriter, r *http.Request) error {
	c, err := s.staffActor(r, true)
	if err != nil {
		return err
	}
	var body struct {
		OrgIDs       []string `json:"org_ids"`
		DiscoveredAt int64    `json:"discovered_at"`
		What         string   `json:"what"`
		ToDo         string   `json:"to_do"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.What, body.ToDo = strings.TrimSpace(body.What), strings.TrimSpace(body.ToDo)
	if len(body.OrgIDs) == 0 || len(body.OrgIDs) > 1000 || body.DiscoveredAt <= 0 || body.DiscoveredAt > now() || body.What == "" || body.ToDo == "" ||
		utf8.RuneCountInString(body.What) > 5000 || utf8.RuneCountInString(body.ToDo) > 5000 {
		return bad("Name the agencies, when Caller Whale knew (discovered_at), what happened and what they should do.")
	}
	if s.mail == nil {
		return newError(http.StatusServiceUnavailable, "mail_off", "The notification service is not set up, so no notice can be emailed.")
	}
	out := []map[string]any{}
	for _, org := range body.OrgIDs {
		if _, err := uuid.Parse(org); err != nil {
			return bad("Each org id is an id.")
		}
		id, t := uuid.NewString(), now()
		to, failed := "", ""
		owner, err := s.agencyOwnerEmail(r, org)
		switch {
		case err != nil:
			failed = err.Error()
		default:
			to = owner
			deadline := time.Unix(body.DiscoveredAt, 0).Add(breachHours * time.Hour).UTC().Format("2 January 2006, 15:04 UTC")
			if err := s.mail.sendTemplate(r.Context(), "breach_notice", to, map[string]any{"what": body.What, "to_do": body.ToDo,
				"discovered": time.Unix(body.DiscoveredAt, 0).UTC().Format("2 January 2006, 15:04 UTC"), "deadline": deadline}); err != nil {
				failed = err.Error()
			}
		}
		var sent any
		if failed == "" {
			sent = t
		}
		if _, err := s.db.Exec(r.Context(), `INSERT INTO breach_notices (id, org_id, discovered_at, what, to_do, created_by, created_at, sent_to, sent_at, failed)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, id, org, body.DiscoveredAt, body.What, body.ToDo, c.Sub, t, to, sent, failed); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "org_id": org, "sent": failed == "", "failed": failed,
			"within_72_hours": failed == "" && t-body.DiscoveredAt <= breachHours*3600})
	}
	writeJSON(w, http.StatusOK, map[string]any{"notices": out})
	return nil
}

// agencyOwnerEmail is the email of an agency's owner, as authz knows who owns it.
func (s *server) agencyOwnerEmail(r *http.Request, org string) (string, error) {
	var listed struct {
		Members []member `json:"members"`
	}
	if _, err := s.authzCall(r, http.MethodGet, "/v1/orgs/"+org+"/members", nil, &listed); err != nil {
		return "", errors.New("the agency's people could not be read")
	}
	for _, m := range listed.Members {
		if slices.Contains(m.Roles, "owner") || slices.Contains(m.Roles, "solo") {
			var email string
			if err := s.db.QueryRow(r.Context(), `SELECT email FROM users WHERE id = $1`, m.UserID).Scan(&email); err == nil && email != "" {
				return email, nil
			}
		}
	}
	return "", errors.New("the agency has no owner with an email")
}

// breachNotices is GET /v1/admin/breach-notices (staff): every notice, whether it went, and whether within 72 hours.
func (s *server) breachNotices(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, org_id, discovered_at, sent_to, sent_at, failed, created_at FROM breach_notices ORDER BY created_at DESC LIMIT 500`)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, org, to, failed string
		var discovered, created int64
		var sent *int64
		if err := rows.Scan(&id, &org, &discovered, &to, &sent, &failed, &created); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "org_id": org, "discovered_at": discovered, "due_by": discovered + breachHours*3600, "sent_to": to,
			"sent_at": sent, "failed": failed, "within_72_hours": sent != nil && *sent-discovered <= breachHours*3600})
	}
	writeJSON(w, http.StatusOK, map[string]any{"notices": out})
	return rows.Err()
}
