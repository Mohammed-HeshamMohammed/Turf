package main

// Build step 28, part B: Google Calendar per person (migrations/0036_google_calendar.sql, D158-D160).
//
// Set up with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL (this service's /api/v1/google/callback, as the gateway
// serves it), GOOGLE_TOKEN_KEY (32 random bytes in base64, to encrypt the stored tokens) and APP_URL (the CRM web app, for the link in
// events). Without them connecting answers that it is not set up, and nothing else changes.

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const googleScopes = "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.app.created"

// calendarAPI is what Caller Whale asks of Google; tests use a stand-in.
type calendarAPI interface {
	authURL(state string) string
	exchange(ctx context.Context, code string) (refresh string, err error)
	busy(ctx context.Context, refresh string, from, to time.Time) ([][2]time.Time, error)
	makeCalendar(ctx context.Context, refresh string) (string, error)
	createEvent(ctx context.Context, refresh, calendar string, start, end time.Time, summary, link string) (string, error)
	deleteEvent(ctx context.Context, refresh, calendar, event string) error
	revoke(ctx context.Context, refresh string) error
}

type googleAPI struct {
	clientID, secret, redirect             string
	authBase, tokenURL, apiBase, revokeURL string
	http                                   *http.Client
	mu                                     sync.Mutex
	access                                 map[string]accessToken // refresh token -> access token
}

type accessToken struct {
	token   string
	expires time.Time
}

func newGoogleAPI(clientID, secret, redirect string) *googleAPI {
	return &googleAPI{clientID: clientID, secret: secret, redirect: redirect, authBase: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenURL: "https://oauth2.googleapis.com/token", apiBase: "https://www.googleapis.com/calendar/v3", revokeURL: "https://oauth2.googleapis.com/revoke",
		http: &http.Client{Timeout: 10 * time.Second}, access: map[string]accessToken{}}
}

func (g *googleAPI) authURL(state string) string {
	v := url.Values{"client_id": {g.clientID}, "redirect_uri": {g.redirect}, "response_type": {"code"}, "scope": {googleScopes},
		"access_type": {"offline"}, "prompt": {"consent"}, "include_granted_scopes": {"false"}, "state": {state}}
	return g.authBase + "?" + v.Encode()
}

func (g *googleAPI) token(ctx context.Context, form url.Values) (map[string]any, error) {
	form.Set("client_id", g.clientID)
	form.Set("client_secret", g.secret)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out map[string]any
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK || json.Unmarshal(data, &out) != nil {
		return nil, fmt.Errorf("google token: status %d", res.StatusCode)
	}
	return out, nil
}

func (g *googleAPI) exchange(ctx context.Context, code string) (string, error) {
	out, err := g.token(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {g.redirect}})
	if err != nil {
		return "", err
	}
	refresh, _ := out["refresh_token"].(string)
	if refresh == "" {
		return "", errors.New("google gave no refresh token")
	}
	if at, _ := out["access_token"].(string); at != "" {
		g.mu.Lock()
		g.access[refresh] = accessToken{at, time.Now().Add(50 * time.Minute)}
		g.mu.Unlock()
	}
	return refresh, nil
}

func (g *googleAPI) bearer(ctx context.Context, refresh string) (string, error) {
	g.mu.Lock()
	t, ok := g.access[refresh]
	g.mu.Unlock()
	if ok && time.Now().Before(t.expires) {
		return t.token, nil
	}
	out, err := g.token(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if err != nil {
		return "", err
	}
	at, _ := out["access_token"].(string)
	if at == "" {
		return "", errors.New("google gave no access token")
	}
	g.mu.Lock()
	g.access[refresh] = accessToken{at, time.Now().Add(50 * time.Minute)}
	g.mu.Unlock()
	return at, nil
}

func (g *googleAPI) call(ctx context.Context, refresh, method, path string, body, into any) error {
	at, err := g.bearer(ctx, refresh)
	if err != nil {
		return err
	}
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.apiBase+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+at)
	req.Header.Set("Content-Type", "application/json")
	res, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusGone || (method == http.MethodDelete && res.StatusCode == http.StatusNotFound) {
		return nil // already gone
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("google %s %s: status %d", method, path, res.StatusCode)
	}
	if into != nil {
		return json.Unmarshal(data, into)
	}
	return nil
}

func (g *googleAPI) busy(ctx context.Context, refresh string, from, to time.Time) ([][2]time.Time, error) {
	var out struct {
		Calendars map[string]struct {
			Busy []struct {
				Start time.Time `json:"start"`
				End   time.Time `json:"end"`
			} `json:"busy"`
		} `json:"calendars"`
	}
	if err := g.call(ctx, refresh, http.MethodPost, "/freeBusy", map[string]any{"timeMin": from.UTC().Format(time.RFC3339), "timeMax": to.UTC().Format(time.RFC3339),
		"items": []map[string]string{{"id": "primary"}}}, &out); err != nil {
		return nil, err
	}
	var busy [][2]time.Time
	for _, b := range out.Calendars["primary"].Busy {
		busy = append(busy, [2]time.Time{b.Start, b.End})
	}
	return busy, nil
}

func (g *googleAPI) makeCalendar(ctx context.Context, refresh string) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	err := g.call(ctx, refresh, http.MethodPost, "/calendars", map[string]any{"summary": "Caller Whale", "description": "Appointments booked in Caller Whale."}, &out)
	return out.ID, err
}

func (g *googleAPI) createEvent(ctx context.Context, refresh, calendar string, start, end time.Time, summary, link string) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	err := g.call(ctx, refresh, http.MethodPost, "/calendars/"+url.PathEscape(calendar)+"/events", map[string]any{"summary": summary,
		"description": "Open in Caller Whale: " + link, "start": map[string]string{"dateTime": start.UTC().Format(time.RFC3339)},
		"end": map[string]string{"dateTime": end.UTC().Format(time.RFC3339)}, "source": map[string]string{"title": "Caller Whale", "url": link}}, &out)
	return out.ID, err
}

func (g *googleAPI) deleteEvent(ctx context.Context, refresh, calendar, event string) error {
	return g.call(ctx, refresh, http.MethodDelete, "/calendars/"+url.PathEscape(calendar)+"/events/"+url.PathEscape(event), nil, nil)
}

func (g *googleAPI) revoke(ctx context.Context, refresh string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.revokeURL, strings.NewReader(url.Values{"token": {refresh}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := g.http.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

// ---- stored tokens, encrypted ----

func sealToken(key []byte, plain string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plain), nil), nil
}

func openToken(key, sealed []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", errors.New("sealed token too short")
	}
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
	return string(plain), err
}

func parseTokenKey(text string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil || len(key) != 32 {
		return nil, errors.New("GOOGLE_TOKEN_KEY must be 32 random bytes in base64")
	}
	return key, nil
}

type googleAccount struct {
	refresh, calendar string
}

// account is a person's Google connection; nil when they have none.
func (s *server) googleAccount(ctx context.Context, user string) (*googleAccount, error) {
	if s.calendar == nil {
		return nil, nil
	}
	var sealed []byte
	var cal string
	err := s.st.db.QueryRow(ctx, `SELECT refresh_token, calendar_id FROM google_accounts WHERE user_id = $1`, user).Scan(&sealed, &cal)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	refresh, err := openToken(s.cfg.googleKey, sealed)
	if err != nil {
		return nil, err
	}
	return &googleAccount{refresh: refresh, calendar: cal}, nil
}

// ---- connecting ----

func (s *server) googleRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/me/google/connect", s.user(s.googleConnect))
	mux.Handle("GET /api/v1/me/google", s.user(s.googleStatus))
	mux.Handle("DELETE /api/v1/me/google", s.user(s.googleDisconnect))
	mux.HandleFunc("GET /api/v1/google/callback", s.googleCallback)
}

func (s *server) googleOff() error {
	return &apiError{http.StatusServiceUnavailable, "google_off", "Google Calendar is not set up for Caller Whale yet."}
}

// googleConnect is POST /api/v1/me/google/connect: the address of Google's consent page for this person.
func (s *server) googleConnect(q *req) error {
	if s.calendar == nil {
		return s.googleOff()
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	state := hex.EncodeToString(b)
	if _, err := s.st.db.Exec(q.r.Context(), `INSERT INTO google_states (state, user_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, state, q.c.Sub); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"url": s.calendar.authURL(state)})
	return nil
}

// googleCallback is where Google sends the person back. The state, made for them a moment ago and usable once, says who they are; the
// page then returns to the CRM.
func (s *server) googleCallback(w http.ResponseWriter, r *http.Request) {
	back := func(result string) { http.Redirect(w, r, s.cfg.appURL+"/?google="+result, http.StatusFound) }
	if s.calendar == nil {
		back("off")
		return
	}
	ctx := r.Context()
	var user string
	err := s.st.db.QueryRow(ctx, `DELETE FROM google_states WHERE state = $1 AND expires_at > now() RETURNING user_id::text`, r.URL.Query().Get("state")).Scan(&user)
	if err != nil || r.URL.Query().Get("code") == "" {
		back("refused")
		return
	}
	refresh, err := s.calendar.exchange(ctx, r.URL.Query().Get("code"))
	if err != nil {
		log.Printf("WARN google connect: %v", err)
		back("failed")
		return
	}
	var cal string
	if old, _ := s.googleAccount(ctx, user); old != nil {
		cal = old.calendar
	}
	if cal == "" {
		if cal, err = s.calendar.makeCalendar(ctx, refresh); err != nil {
			log.Printf("WARN google calendar: %v", err)
			back("failed")
			return
		}
	}
	sealed, err := sealToken(s.cfg.googleKey, refresh)
	if err == nil {
		_, err = s.st.db.Exec(ctx, `INSERT INTO google_accounts (user_id, refresh_token, calendar_id) VALUES ($1, $2, $3)
			ON CONFLICT (user_id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, calendar_id = EXCLUDED.calendar_id, connected_at = now()`, user, sealed, cal)
	}
	if err != nil {
		log.Printf("WARN google store: %v", err)
		back("failed")
		return
	}
	back("connected")
}

func (s *server) googleStatus(q *req) error {
	var at *time.Time
	err := s.st.db.QueryRow(q.r.Context(), `SELECT connected_at FROM google_accounts WHERE user_id = $1`, q.c.Sub).Scan(&at)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"set_up": s.calendar != nil, "connected": at != nil, "connected_at": at})
	return nil
}

// googleDisconnect is DELETE /api/v1/me/google: the person's coming appointments leave their calendar, Google's access is revoked and
// the token forgotten.
func (s *server) googleDisconnect(q *req) error {
	ctx := q.r.Context()
	acct, err := s.googleAccount(ctx, q.c.Sub)
	if err != nil || acct == nil {
		if err == nil {
			writeJSON(q.w, 200, map[string]any{"connected": false})
		}
		return err
	}
	if err := s.removeEvents(ctx, `user_id = $1`, q.c.Sub); err != nil {
		log.Printf("WARN google disconnect: %v", err)
	}
	_ = s.calendar.revoke(ctx, acct.refresh)
	if _, err := s.st.db.Exec(ctx, `DELETE FROM google_accounts WHERE user_id = $1`, q.c.Sub); err != nil {
		return err
	}
	writeJSON(q.w, 200, map[string]any{"connected": false})
	return nil
}

// ---- busy times and events ----

// googleBusy is each connected closer's busy times; a closer whose Google cannot be read is shown as free there (and it is logged).
func (s *server) googleBusy(ctx context.Context, closers []string, from, to time.Time) map[string][][2]time.Time {
	out := map[string][][2]time.Time{}
	for _, c := range closers {
		acct, err := s.googleAccount(ctx, c)
		if err != nil || acct == nil {
			continue
		}
		busy, err := s.calendar.busy(ctx, acct.refresh, from, to)
		if err != nil {
			log.Printf("WARN google busy times of %s: %v", c, err)
			continue
		}
		out[c] = busy
	}
	return out
}

// removeEvents takes events off the calendars they are on and forgets them: those of a person, or of some appointments.
func (s *server) removeEvents(ctx context.Context, where string, args ...any) error {
	if s.calendar == nil {
		return nil
	}
	rows, err := s.st.db.Query(ctx, `DELETE FROM google_events WHERE `+where+` RETURNING user_id::text, event_id`, args...)
	if err != nil {
		return err
	}
	type ev struct{ user, event string }
	var evs []ev
	for rows.Next() {
		var e ev
		if err := rows.Scan(&e.user, &e.event); err != nil {
			rows.Close()
			return err
		}
		evs = append(evs, e)
	}
	rows.Close()
	for _, e := range evs {
		acct, err := s.googleAccount(ctx, e.user)
		if err != nil || acct == nil {
			continue
		}
		if err := s.calendar.deleteEvent(ctx, acct.refresh, acct.calendar, e.event); err != nil {
			log.Printf("WARN google event %s: %v", e.event, err)
		}
	}
	return nil
}

// addEvent puts an appointment on its closer's Caller Whale calendar: the time and a link to the lead in the agency, nothing more (D159).
func (s *server) addEvent(ctx context.Context, org, appointment, closer, lead string, start, end time.Time) {
	acct, err := s.googleAccount(ctx, closer)
	if err != nil || acct == nil {
		return
	}
	link := s.cfg.appURL + "/?org=" + url.QueryEscape(org) + "&lead=" + url.QueryEscape(lead)
	id, err := s.calendar.createEvent(ctx, acct.refresh, acct.calendar, start, end, "Caller Whale appointment", link)
	if err != nil {
		log.Printf("WARN google event for appointment %s: %v", appointment, err)
		return
	}
	if _, err := s.st.db.Exec(ctx, `INSERT INTO google_events (appointment_id, org_id, user_id, event_id) VALUES ($1, $2, $3, $4)
		ON CONFLICT (appointment_id) DO UPDATE SET user_id = EXCLUDED.user_id, event_id = EXCLUDED.event_id`, appointment, org, closer, id); err != nil {
		log.Printf("WARN google event for appointment %s: %v", appointment, err)
	}
}

// moveAppointments puts handed-on appointments on their new closer's calendar (D160): off the old one, onto the new one's if connected.
func (s *server) moveAppointments(ctx context.Context, org string, moved []movedAppointment) {
	if s.calendar == nil || len(moved) == 0 {
		return
	}
	ids := make([]string, len(moved))
	for i, m := range moved {
		ids[i] = m.id
	}
	if err := s.removeEvents(ctx, `appointment_id = ANY($1::uuid[])`, ids); err != nil {
		log.Printf("WARN google events of handed-on appointments: %v", err)
	}
	for _, m := range moved {
		if m.closer != "" {
			s.addEvent(ctx, org, m.id, m.closer, m.lead, m.start, m.end)
		}
	}
}

type movedAppointment struct {
	id, closer, lead string
	start, end       time.Time
}
