package crm

// Keys for outside tools (D233) and outgoing events (D234).
//
// A key reads "cwk_<agency>.<random>": the agency part lets the CRM enter that agency's rows, the rest is checked against a hash. The
// routes a key reaches are under /api/v1/tools/, which the gateway lets through to the CRM, and nothing there calls, texts or spends.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

var keyScopes = []string{"leads:add", "leads:read", "deals:read"}

func (s *server) keyRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/keys", s.member(s.listKeys))
	mux.Handle("POST /api/v1/keys", s.member(s.makeKey))
	mux.Handle("POST /api/v1/keys/{id}/off", s.member(s.switchKey(false)))
	mux.Handle("POST /api/v1/keys/{id}/on", s.member(s.switchKey(true)))
	mux.Handle("GET /api/v1/keys/{id}/uses", s.member(s.keyUses))
	mux.Handle("GET /api/v1/hooks", s.member(s.listHooks))
	mux.Handle("POST /api/v1/hooks", s.member(s.makeHook))
	mux.Handle("POST /api/v1/hooks/{id}/off", s.member(s.hookOff))
	mux.HandleFunc("POST /api/v1/tools/leads", s.tool("leads:add", s.toolAddLeads))
	mux.HandleFunc("GET /api/v1/tools/leads/{id}", s.tool("leads:read", s.toolLead))
	mux.HandleFunc("GET /api/v1/tools/deals/{id}", s.tool("deals:read", s.toolDeal))
}

func keyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// ---- keys (D233) ----

func (s *server) makeKey(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner or an admin makes keys for outside tools.")
	}
	var body struct {
		Name      string   `json:"name"`
		Scopes    []string `json:"scopes"`
		TeamID    string   `json:"team_id"`
		ProjectID string   `json:"project_id"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 80 || len(body.Scopes) == 0 || slices.ContainsFunc(body.Scopes, func(x string) bool { return !slices.Contains(keyScopes, x) }) {
		return bad("Name the tool and choose what it may do: leads:add, leads:read, deals:read. Nothing else can be given, and nothing spends money.")
	}
	if (body.TeamID != "" && !validID(body.TeamID)) || (body.ProjectID != "" && !validID(body.ProjectID)) {
		return bad("team_id and project_id are ids.")
	}
	if slices.Contains(body.Scopes, "leads:add") && body.TeamID == "" {
		return bad("A key that adds leads names the team they go to (team_id), and the list if they belong to a client (project_id).")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	key := "cwk_" + orgToken(q.sc.orgID)
	rows, err := queryJSON(ctx, tx, `INSERT INTO api_keys (org_id, name, key_hash, scopes, team_id, project_id, created_by) VALUES (cw_org(), $1, $2, $3, $4, $5, $6)
		RETURNING jsonb_build_object('id', id, 'name', name, 'scopes', scopes, 'team_id', team_id, 'project_id', project_id, 'created_at', created_at)`,
		name, keyHash(key), body.Scopes, nullID(body.TeamID), nullID(body.ProjectID), q.sc.userID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	var out map[string]any
	_ = json.Unmarshal(rows[0], &out)
	out["key"] = key
	out["note"] = "This key is shown once. Keep it in the tool's settings; it can be switched off here at any time."
	writeJSON(q.w, 200, out)
	return nil
}

func (s *server) listKeys(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the agency's keys.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', id, 'name', name, 'scopes', scopes, 'team_id', team_id, 'project_id', project_id, 'created_by', created_by,
		'created_at', created_at, 'off', off_at IS NOT NULL, 'last_used_at', last_used_at, 'uses', uses) FROM api_keys ORDER BY created_at DESC`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"keys": rows})
	return nil
}

func (s *server) switchKey(on bool) handler {
	return func(q *req) error {
		if !manages(q.sc) {
			return forbidden("The owner or an admin switches keys.")
		}
		ctx := q.r.Context()
		tx, err := s.st.begin(ctx, q.sc)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		tag, err := tx.Exec(ctx, `UPDATE api_keys SET off_at = CASE WHEN $2 THEN NULL ELSE coalesce(off_at, now()) END WHERE id = $1`, nullID(q.r.PathValue("id")), on)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return notFound("No such key.")
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		writeJSON(q.w, 200, map[string]any{"off": !on})
		return nil
	}
}

func (s *server) keyUses(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see a key's uses.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('action', action, 'items', items, 'status', status, 'at', at) FROM api_key_uses WHERE key_id = $1 ORDER BY at DESC LIMIT 500`,
		nullID(q.r.PathValue("id")))
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"uses": rows})
	return nil
}

// toolKey is the key a tool's request carries, as the CRM keeps it.
type toolKey struct {
	id, org, name, createdBy string
	team, project            string
}

// tool runs a key's request: a valid key that is on, has the scope, and whose maker is still the agency's owner or an admin; the use is
// recorded, refused or not.
func (s *server) tool(scopeNeeded string, h func(w http.ResponseWriter, r *http.Request, k toolKey, sc scope) (int, int, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(bearer(r), "cwk_")
		org := tokenOrg(raw)
		fail := func(status int, msg string) {
			writeError(w, &apiError{status, "key", msg})
		}
		if org == "" || !strings.HasPrefix(bearer(r), "cwk_") {
			fail(http.StatusUnauthorized, "Send the tool's key as Authorization: Bearer cwk_...")
			return
		}
		ctx := r.Context()
		var k toolKey
		var scopes []string
		var off bool
		var team, project *string
		err := s.inOrg(ctx, raw, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id::text, name, created_by::text, scopes, off_at IS NOT NULL, team_id::text, project_id::text FROM api_keys WHERE key_hash = $1`,
				keyHash(bearer(r))).Scan(&k.id, &k.name, &k.createdBy, &scopes, &off, &team, &project)
		})
		if err != nil {
			fail(http.StatusUnauthorized, "This key is not valid.")
			return
		}
		k.org, k.team, k.project = org, deref(team), deref(project)
		record := func(status, items int, action string) {
			_ = s.inOrg(context.WithoutCancel(ctx), raw, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `INSERT INTO api_key_uses (org_id, key_id, action, items, status) VALUES (cw_org(), $1, $2, $3, $4)`, k.id, action, items, status); err != nil {
					return err
				}
				_, err := tx.Exec(ctx, `UPDATE api_keys SET uses = uses + 1, last_used_at = now() WHERE id = $1`, k.id)
				return err
			})
		}
		action := r.Method + " " + r.URL.Path
		switch {
		case off:
			record(http.StatusForbidden, 0, action)
			fail(http.StatusForbidden, "This key is switched off.")
			return
		case !slices.Contains(scopes, scopeNeeded):
			record(http.StatusForbidden, 0, action)
			fail(http.StatusForbidden, "This key may not do that.")
			return
		}
		// The key acts with its maker's standing: a maker no longer the owner or an admin stops their keys.
		g, err := s.rules.grant(ctx, k.createdBy, org, false)
		if err != nil || !g.Allowed || !(slices.Contains(g.Scopes, "organization") && slices.Contains(g.Capabilities, "admin")) {
			record(http.StatusForbidden, 0, action)
			fail(http.StatusForbidden, "The person who made this key can no longer give it rights here.")
			return
		}
		sc := scope{userID: k.createdBy, orgID: org, label: "Key: " + k.name, scopes: []string{"organization"}, caps: []string{"edit", "import", "finance"}}
		status, items, err := h(w, r, k, sc)
		if err != nil {
			var ae *apiError
			if errors.As(err, &ae) {
				status = ae.status
			} else {
				status = http.StatusInternalServerError
			}
			writeError(w, err)
		}
		record(status, items, action)
	}
}

// toolAddLeads is POST /api/v1/tools/leads {leads: [{name, phone, email, note}]}: up to 500 new leads, unassigned in the key's team
// (and list). Blocked numbers come in as do-not-call, as with any new lead.
func (s *server) toolAddLeads(w http.ResponseWriter, r *http.Request, k toolKey, sc scope) (int, int, error) {
	var body struct {
		Leads []struct {
			Name  string `json:"name"`
			Phone string `json:"phone"`
			Email string `json:"email"`
			Note  string `json:"note"`
		} `json:"leads"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return 0, 0, err
	}
	if len(body.Leads) == 0 || len(body.Leads) > 500 {
		return 0, 0, bad("Send 1 to 500 leads.")
	}
	ctx := r.Context()
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)
	ids := []string{}
	for i, l := range body.Leads {
		name, phone, email := strings.TrimSpace(l.Name), strings.TrimSpace(l.Phone), strings.TrimSpace(l.Email)
		if name == "" || len(name) > 200 || len(phone) > 40 || len(email) > 200 || len(l.Note) > 2000 || (phone == "" && email == "") {
			return 0, 0, bad(fmt.Sprintf("Lead %d needs a name and a phone or an email.", i+1))
		}
		if email != "" {
			if _, err := mail.ParseAddress(email); err != nil {
				return 0, 0, bad(fmt.Sprintf("Lead %d's email is not an address.", i+1))
			}
		}
		var id string
		if err := tx.QueryRow(ctx, `INSERT INTO leads (org_id, team_id, project_id, name, phone, email, source, stage) VALUES (cw_org(), $1, $2, $3, $4, $5, $6, 'New') RETURNING id::text`,
			nullID(k.team), nullID(k.project), name, phone, email, "Key: "+k.name).Scan(&id); err != nil {
			return 0, 0, err
		}
		if note := strings.TrimSpace(l.Note); note != "" {
			if _, err := tx.Exec(ctx, `INSERT INTO notes (org_id, lead_id, author_label, body) VALUES (cw_org(), $1, $2, $3)`, id, "Key: "+k.name, note); err != nil {
				return 0, 0, err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), 'lead', $1, $1, 'upsert')`, id); err != nil {
			return 0, 0, err
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	writeJSON(w, 200, map[string]any{"ids": ids})
	return 200, len(ids), nil
}

// keyReaches limits a key to its team and list.
func keyReaches(k toolKey) (string, []any) {
	return `($2::uuid IS NULL OR l.team_id = $2) AND ($3::uuid IS NULL OR l.project_id = $3)`, []any{nullID(k.team), nullID(k.project)}
}

// toolLead is GET /api/v1/tools/leads/{id}: one lead inside the key's reach, as the tool needs it after an event.
func (s *server) toolLead(w http.ResponseWriter, r *http.Request, k toolKey, sc scope) (int, int, error) {
	ctx := r.Context()
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)
	where, args := keyReaches(k)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'stage', l.stage, 'verdict', l.verdict,
		'do_not_call', l.do_not_call, 'team_id', l.team_id, 'project_id', l.project_id, 'created_at', l.created_at)
		FROM leads l WHERE l.id = $1 AND l.deleted_at IS NULL AND `+where, append([]any{nullID(r.PathValue("id"))}, args...)...)
	if err != nil {
		return 0, 0, err
	}
	if len(rows) == 0 {
		return 0, 0, notFound("No such lead within this key's reach.")
	}
	writeJSON(w, 200, rows[0])
	return 200, 1, nil
}

// toolDeal is GET /api/v1/tools/deals/{id}: one deal inside the key's reach.
func (s *server) toolDeal(w http.ResponseWriter, r *http.Request, k toolKey, sc scope) (int, int, error) {
	ctx := r.Context()
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)
	where, args := keyReaches(k)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', d.id, 'lead_id', d.lead_id, 'stage', d.stage, 'amount', d.amount, 'fee', d.fee, 'currency', d.currency,
		'closed_at', d.closed_at) FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.id = $1 AND `+where, append([]any{nullID(r.PathValue("id"))}, args...)...)
	if err != nil {
		return 0, 0, err
	}
	if len(rows) == 0 {
		return 0, 0, notFound("No such deal within this key's reach.")
	}
	writeJSON(w, 200, rows[0])
	return 200, 1, nil
}

// ---- outgoing events (D234) ----

func (s *server) makeHook(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner chooses where events go.")
	}
	var body struct {
		URL    string   `json:"url"`
		Events []string `json:"events"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimSpace(body.URL))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(body.URL) > 500 || len(body.Events) == 0 ||
		slices.ContainsFunc(body.Events, func(e string) bool { return e != "lead.booked" && e != "deal.won" }) {
		return bad("Give an https address of yours and the events: lead.booked, deal.won.")
	}
	secret := make([]byte, 24)
	_, _ = rand.Read(secret)
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO event_hooks (org_id, url, events, secret, created_by) VALUES (cw_org(), $1, $2, $3, $4) RETURNING id::text`,
		u.String(), body.Events, hex.EncodeToString(secret), q.sc.userID).Scan(&id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"id": id, "url": u.String(), "events": body.Events, "secret": hex.EncodeToString(secret),
		"note": "Each message is signed: X-CallerWhale-Signature is sha256=HMAC(secret, timestamp + \".\" + body), with X-CallerWhale-Timestamp. The secret is shown once."})
	return nil
}

func (s *server) listHooks(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see where events go.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', h.id, 'url', h.url, 'events', h.events, 'off', h.off_at IS NOT NULL, 'created_at', h.created_at,
		'recent', (SELECT coalesce(jsonb_agg(jsonb_build_object('at', d.created_at, 'status', d.last_status, 'delivered', d.delivered_at IS NOT NULL, 'given_up', d.given_up_at IS NOT NULL) ORDER BY d.created_at DESC), '[]')
			FROM (SELECT * FROM event_deliveries WHERE hook_id = h.id ORDER BY created_at DESC LIMIT 20) d))
		FROM event_hooks h ORDER BY h.created_at`)
	if err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"hooks": rows})
	return nil
}

func (s *server) hookOff(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner switches events off.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE event_hooks SET off_at = coalesce(off_at, now()) WHERE id = $1`, nullID(q.r.PathValue("id"))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"off": true})
	return nil
}

// emitEvent queues an event for every hook that wants it, in the caller's transaction: only the event, the object's id and the time.
func emitEvent(ctx context.Context, tx pgx.Tx, s *server, event, objectID, leadID string) error {
	rows, err := tx.Query(ctx, `INSERT INTO event_deliveries (org_id, hook_id, body)
		SELECT cw_org(), id, jsonb_build_object('event', $1::text, 'id', $2::text, 'lead_id', $3::text, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
		FROM event_hooks WHERE off_at IS NULL AND $1 = ANY(events) RETURNING id::text, org_id::text`, event, objectID, leadID)
	if err != nil {
		return err
	}
	type due struct{ id, org string }
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.org); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	rows.Close()
	for _, d := range list {
		if _, err := tx.Exec(ctx, `INSERT INTO event_due (delivery_id, org_id, next_at) VALUES ($1, $2, now())`, d.id, d.org); err != nil {
			return err
		}
	}
	return nil
}

// publicOnly refuses connections to private, loopback and link-local addresses, so an event address cannot reach inside.
func publicOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return fmt.Errorf("%s is not a public address", host)
	}
	return nil
}

var hookClient = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DialContext: (&net.Dialer{Timeout: 5 * time.Second, Control: publicOnly}).DialContext},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// eventRetry is when a failed delivery is tried again: 1, 5, 30 minutes, 2 and 6 hours, then given up.
var eventRetry = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour}

// sendDueEvents delivers what is due, signed, and plans retries.
func (s *server) sendDueEvents(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `SELECT delivery_id::text, org_id::text FROM event_due WHERE next_at <= $1 LIMIT 200`, s.now())
	if err != nil {
		return err
	}
	type due struct{ id, org string }
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.org); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	rows.Close()
	// Up to eight at a time, so one customer's slow server (10 seconds at most each) does not hold up everyone else's.
	slots := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, d := range list {
		slots <- struct{}{}
		wg.Go(func() {
			defer func() { <-slots }()
			if err := s.deliverEvent(ctx, d.org, d.id); err != nil {
				log.Printf("WARN event %s: %v", d.id, err)
			}
		})
	}
	wg.Wait()
	return nil
}

func (s *server) deliverEvent(ctx context.Context, org, id string) error {
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var target, secret string
	var body []byte
	var attempts int
	var off bool
	if err := tx.QueryRow(ctx, `SELECT h.url, h.secret, d.body::text, d.attempts, h.off_at IS NOT NULL FROM event_deliveries d JOIN event_hooks h ON h.id = d.hook_id WHERE d.id = $1`, id).
		Scan(&target, &secret, &body, &attempts, &off); err != nil || off {
		_, _ = s.st.db.Exec(ctx, `DELETE FROM event_due WHERE delivery_id = $1`, id)
		return nil
	}
	ts := strconv.FormatInt(s.now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + string(body)))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "CallerWhale-Events/1")
	req.Header.Set("X-CallerWhale-Timestamp", ts)
	req.Header.Set("X-CallerWhale-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	client := s.hookHTTP
	if client == nil {
		client = hookClient
	}
	status := 0
	if res, err := client.Do(req); err == nil {
		status = res.StatusCode
		res.Body.Close()
	}
	attempts++
	ok := status >= 200 && status < 300
	switch {
	case ok:
		_, err = tx.Exec(ctx, `UPDATE event_deliveries SET attempts = $2, last_status = $3, delivered_at = now() WHERE id = $1`, id, attempts, status)
		if err == nil {
			_, err = s.st.db.Exec(ctx, `DELETE FROM event_due WHERE delivery_id = $1`, id)
		}
	case attempts > len(eventRetry):
		_, err = tx.Exec(ctx, `UPDATE event_deliveries SET attempts = $2, last_status = $3, given_up_at = now() WHERE id = $1`, id, attempts, status)
		if err == nil {
			_, err = s.st.db.Exec(ctx, `DELETE FROM event_due WHERE delivery_id = $1`, id)
		}
	default:
		_, err = tx.Exec(ctx, `UPDATE event_deliveries SET attempts = $2, last_status = $3 WHERE id = $1`, id, attempts, status)
		if err == nil {
			_, err = s.st.db.Exec(ctx, `UPDATE event_due SET next_at = $2 WHERE delivery_id = $1`, id, s.now().Add(eventRetry[attempts-1]))
		}
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
