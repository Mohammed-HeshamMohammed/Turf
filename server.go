package main

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var version = "dev"

var (
	uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	nonDigits   = regexp.MustCompile(`\D`)
)

func validID(id string) bool { return uuidPattern.MatchString(id) }

type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

func bad(message string) error         { return &apiError{http.StatusBadRequest, "bad_request", message} }
func forbidden(message string) error   { return &apiError{http.StatusForbidden, "forbidden", message} }
func notFound(message string) error    { return &apiError{http.StatusNotFound, "not_found", message} }
func conflictErr(message string) error { return &apiError{http.StatusConflict, "refused", message} }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, err error) {
	var api *apiError
	switch {
	case errors.As(err, &api):
	case errors.Is(err, errUnavailable), errors.Is(err, errNoCaller):
		log.Printf("ERROR %v", err)
		api = &apiError{http.StatusServiceUnavailable, "unavailable", "Caller Whale cannot check your access right now. Try again in a moment."}
	default:
		log.Printf("ERROR %v", err)
		api = &apiError{http.StatusInternalServerError, "internal", "Something went wrong on our side."}
	}
	writeJSON(w, api.status, map[string]any{"error": map[string]any{"code": api.code, "message": api.message}})
}

func readJSON(w http.ResponseWriter, r *http.Request, into any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		return bad("Send a valid JSON body.")
	}
	return nil
}

type server struct {
	cfg        config
	st         *store
	keys       *keyset
	rules      rules
	carrier    carrier
	crm        crm
	webhookKey ed25519.PublicKey
	sim        *simulator // simulate mode: the fake Telnyx this service talks to
	now        func() time.Time
}

type req struct {
	w  http.ResponseWriter
	r  *http.Request
	sc scope
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if s.st.ping(ctx) != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "service": "dialer-sms"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "dialer-sms", "carrier": s.route()})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"service": "dialer-sms", "version": version, "carrier": s.route()})
	})
	mux.HandleFunc("POST /webhooks/telnyx", s.webhook)

	mux.Handle("POST /api/v1/calls", s.member(func(q *req) error {
		var ask dialAsk
		if err := readJSON(q.w, q.r, &ask); err != nil {
			return err
		}
		c, err := s.placeCall(q.r.Context(), q.sc, ask)
		if err == nil {
			writeJSON(q.w, http.StatusOK, c)
		}
		return err
	}))
	mux.Handle("GET /api/v1/calls", s.member(s.listCalls))
	mux.Handle("GET /api/v1/calls/{id}", s.member(func(q *req) error {
		c, err := s.ownCall(q.r.Context(), q.sc, q.r.PathValue("id"))
		if err == nil {
			writeJSON(q.w, http.StatusOK, c)
		}
		return err
	}))
	mux.Handle("POST /api/v1/calls/{id}/hangup", s.member(func(q *req) error {
		c, err := s.hangupCall(q.r.Context(), q.sc, q.r.PathValue("id"))
		if err == nil {
			writeJSON(q.w, http.StatusOK, c)
		}
		return err
	}))
	mux.Handle("POST /api/v1/calls/{id}/transfer", s.member(func(q *req) error {
		var ask struct {
			To string `json:"to"`
		}
		if err := readJSON(q.w, q.r, &ask); err != nil {
			return err
		}
		c, err := s.transferCall(q.r.Context(), q.sc, q.r.PathValue("id"), ask.To)
		if err == nil {
			writeJSON(q.w, http.StatusOK, c)
		}
		return err
	}))
	mux.Handle("POST /api/v1/calls/{id}/disposition", s.member(func(q *req) error {
		var ask wrapAsk
		if err := readJSON(q.w, q.r, &ask); err != nil {
			return err
		}
		c, err := s.wrapUp(q.r.Context(), q.sc, q.r.PathValue("id"), ask)
		if err == nil {
			writeJSON(q.w, http.StatusOK, c)
		}
		return err
	}))
	mux.Handle("POST /api/v1/calls/token", s.member(s.callingToken))

	mux.Handle("POST /api/v1/sms", s.member(func(q *req) error {
		var ask textAsk
		if err := readJSON(q.w, q.r, &ask); err != nil {
			return err
		}
		m, err := s.sendText(q.r.Context(), q.sc, ask)
		if err == nil {
			writeJSON(q.w, http.StatusOK, m)
		}
		return err
	}))
	mux.Handle("GET /api/v1/sms", s.member(func(q *req) error {
		msgs, err := s.textThread(q.r.Context(), q.sc, q.r.URL.Query().Get("lead_id"))
		if err == nil {
			writeJSON(q.w, http.StatusOK, map[string]any{"messages": msgs})
		}
		return err
	}))
	mux.Handle("POST /api/v1/sms/consent", s.member(func(q *req) error {
		var ask struct {
			LeadID string `json:"lead_id"`
			Source string `json:"source"`
		}
		if err := readJSON(q.w, q.r, &ask); err != nil {
			return err
		}
		err := s.textConsent(q.r.Context(), q.sc, ask.LeadID, ask.Source)
		if err == nil {
			writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
		}
		return err
	}))

	// Lead threads (step 10): one sender, takeover by rank, notes, and the unanswered-text wait.
	mux.Handle("GET /api/v1/sms/threads/{lead}", s.member(func(q *req) error {
		view, err := s.threadView(q.r.Context(), q.sc, q.r.PathValue("lead"))
		if err == nil {
			writeJSON(q.w, http.StatusOK, view)
		}
		return err
	}))
	mux.Handle("POST /api/v1/sms/threads/{lead}/{action}", s.member(func(q *req) error {
		var body struct {
			Body string `json:"body"`
		}
		if q.r.PathValue("action") == "notes" {
			if err := readJSON(q.w, q.r, &body); err != nil {
				return err
			}
		}
		view, err := s.threadAction(q.r.Context(), q.sc, q.r.PathValue("lead"), q.r.PathValue("action"), body.Body)
		if err == nil {
			writeJSON(q.w, http.StatusOK, view)
		}
		return err
	}))
	mux.Handle("GET /api/v1/sms/alerts", s.member(func(q *req) error {
		list, err := s.myAlerts(q.r.Context(), q.sc)
		if err == nil {
			writeJSON(q.w, http.StatusOK, map[string]any{"alerts": list})
		}
		return err
	}))
	mux.Handle("POST /api/v1/sms/alerts/{id}/seen", s.member(func(q *req) error {
		err := s.seenAlert(q.r.Context(), q.sc, q.r.PathValue("id"))
		if err == nil {
			writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
		}
		return err
	}))
	mux.Handle("PUT /api/v1/sms/settings", s.member(func(q *req) error {
		var body struct {
			WaitMinutes int `json:"wait_minutes"`
		}
		if err := readJSON(q.w, q.r, &body); err != nil {
			return err
		}
		err := s.putTextSettings(q.r.Context(), q.sc, body.WaitMinutes)
		if err == nil {
			writeJSON(q.w, http.StatusOK, map[string]any{"wait_minutes": body.WaitMinutes})
		}
		return err
	}))

	mux.Handle("GET /api/v1/numbers", s.member(s.listNumbers))
	mux.Handle("PUT /api/v1/numbers/{phone}", s.member(s.putNumber))

	if s.sim != nil {
		mux.Handle("/telnyx-sim/", http.StripPrefix("/telnyx-sim", s.sim.handler()))
	}
	return logHTTP(withCORS(s.cfg.origins, mux))
}

// webhook takes one Telnyx webhook. Anything not signed by Telnyx (or, in simulate mode, by the simulator) is refused. A
// failure to save answers 500, so Telnyx sends it again; everything else answers 200, a repeat included.
func (s *server) webhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, bad("Unreadable body."))
		return
	}
	if err = verifyWebhook(s.webhookKey, body, r.Header.Get("telnyx-signature-ed25519"), r.Header.Get("telnyx-timestamp"), s.now()); err != nil {
		log.Printf("WARN webhook refused: %v", err)
		writeError(w, &apiError{http.StatusUnauthorized, "signature", err.Error()})
		return
	}
	var envelope struct {
		Data event `json:"data"`
	}
	if err = json.Unmarshal(body, &envelope); err != nil || envelope.Data.ID == "" || envelope.Data.EventType == "" {
		writeError(w, bad("Not a Telnyx event."))
		return
	}
	ev := envelope.Data
	ctx := r.Context()
	switch {
	case strings.HasPrefix(ev.EventType, "call."):
		call, isNew, err := s.callEvent(ctx, ev)
		if err != nil {
			writeError(w, err)
			return
		}
		if isNew && call != nil {
			s.react(context.WithoutCancel(ctx), ev, call)
		}
	case strings.HasPrefix(ev.EventType, "message."):
		if err := s.textEvent(ctx, ev); err != nil {
			writeError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) member(h func(*req) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, err := s.enter(w, r)
		if err == nil {
			err = h(q)
		}
		if err != nil {
			writeError(w, err)
		}
	})
}

func (s *server) enter(w http.ResponseWriter, r *http.Request) (*req, error) {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	c, err := s.keys.verify(strings.TrimSpace(token), s.now())
	if err != nil || !validID(c.sub) {
		return nil, &apiError{http.StatusUnauthorized, "unauthorized", "Sign in again."}
	}
	org := r.Header.Get("x-callerwhale-org")
	if !validID(org) {
		return nil, bad("Choose a workspace (x-callerwhale-org).")
	}
	g, err := s.rules.grant(r.Context(), c.sub, org, c.secondFactor)
	if err != nil {
		return nil, err
	}
	if !g.Allowed {
		status := http.StatusForbidden
		if g.Code == "payment_required" {
			status = http.StatusPaymentRequired
		}
		return nil, &apiError{status, g.Code, g.Reason}
	}
	return &req{w: w, r: r, sc: scope{userID: c.sub, orgID: org, scopes: g.Scopes, caps: g.Capabilities}}, nil
}

func (s *server) listCalls(q *req) error {
	lead := q.r.URL.Query().Get("lead_id")
	sql := `SELECT * FROM calls WHERE org_id = $1 AND ($2 OR user_id = $3) AND ($4 = '' OR lead_id::text = $4) ORDER BY created_at DESC LIMIT 100`
	rows, err := s.st.db.Query(q.r.Context(), sql, q.sc.orgID, q.sc.wide(), q.sc.userID, lead)
	if err != nil {
		return err
	}
	calls, err := pgx.CollectRows(rows, pgx.RowToStructByName[callRow])
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"calls": calls})
	return nil
}

func (s *server) listNumbers(q *req) error {
	rows, err := s.st.db.Query(q.r.Context(), `SELECT jsonb_build_object('phone_number', phone_number, 'user_id', user_id, 'calls', calls, 'texts', texts)
		FROM numbers WHERE org_id = $1 ORDER BY created_at`, q.sc.orgID)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		out = append(out, raw)
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"numbers": out})
	return rows.Err()
}

// putNumber gives one of the workspace's carrier numbers to a person (who takes its inbound calls and texts). Renting the
// number is done on the carrier's side first; a number another workspace has is refused.
func (s *server) putNumber(q *req) error {
	if !q.sc.can("admin") {
		return forbidden("Only a workspace admin can set up phone numbers.")
	}
	phone := e164(q.r.PathValue("phone"))
	var ask struct {
		UserID string `json:"user_id"`
		Calls  *bool  `json:"calls"`
		Texts  *bool  `json:"texts"`
	}
	if err := readJSON(q.w, q.r, &ask); err != nil {
		return err
	}
	if phone == "" || !validID(ask.UserID) {
		return bad("Send the number in the address and the person (user_id) who takes it.")
	}
	g, err := s.rules.grant(q.r.Context(), ask.UserID, q.sc.orgID, false)
	if err != nil {
		return err
	}
	if !g.Allowed {
		return bad("That person is not in this workspace.")
	}
	calls, texts := ask.Calls == nil || *ask.Calls, ask.Texts == nil || *ask.Texts
	tag, err := s.st.db.Exec(q.r.Context(), `INSERT INTO numbers (phone_number, org_id, user_id, calls, texts) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (phone_number) DO UPDATE SET user_id = EXCLUDED.user_id, calls = EXCLUDED.calls, texts = EXCLUDED.texts WHERE numbers.org_id = EXCLUDED.org_id`,
		phone, q.sc.orgID, ask.UserID, calls, texts)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return conflictErr("That number belongs to another workspace.")
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"phone_number": phone, "user_id": ask.UserID, "calls": calls, "texts": texts})
	return nil
}

// callingToken is the short-lived login the browser's calling kit uses (Telnyx WebRTC). The account key never leaves the
// server: the browser gets only this token.
func (s *server) callingToken(q *req) error {
	if !q.sc.can("call") {
		return forbidden("Your role does not allow calls.")
	}
	if s.cfg.sipConnectionID == "" && !s.cfg.simulate {
		return conflictErr("Browser calling is not set up (TELNYX_SIP_CONNECTION_ID).")
	}
	ctx := q.r.Context()
	var credID string
	err := s.st.db.QueryRow(ctx, `SELECT credential_id FROM agent_credentials WHERE user_id = $1`, q.sc.userID).Scan(&credID)
	if err != nil {
		id, username, err := s.carrier.credential(ctx, "callerwhale-"+q.sc.userID)
		if err != nil {
			log.Printf("WARN making a calling login: %v", err)
			return &apiError{502, "carrier", "The carrier did not make a calling login. Try again in a moment."}
		}
		if _, err = s.st.db.Exec(ctx, `INSERT INTO agent_credentials (user_id, credential_id, sip_username) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
			q.sc.userID, id, username); err != nil {
			return err
		}
		if err = s.st.db.QueryRow(ctx, `SELECT credential_id FROM agent_credentials WHERE user_id = $1`, q.sc.userID).Scan(&credID); err != nil {
			return err
		}
	}
	token, err := s.carrier.webrtcToken(ctx, credID)
	if err != nil {
		log.Printf("WARN issuing a calling token: %v", err)
		return &apiError{502, "carrier", "The carrier did not issue a calling token. Try again in a moment."}
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"token": token, "carrier": "telnyx", "simulated": s.cfg.simulate})
	return nil
}

// constantEqual compares two secrets without leaking where they differ.
func constantEqual(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
