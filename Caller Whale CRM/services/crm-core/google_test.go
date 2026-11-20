package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCalendar stands in for Google: busy times per person, and the events on each "Caller Whale" calendar.
type fakeCalendar struct {
	mu      sync.Mutex
	busyOf  map[string][][2]time.Time    // refresh token -> busy
	events  map[string]map[string]string // calendar -> event id -> description
	revoked []string
	n       int
}

func (f *fakeCalendar) authURL(state string) string { return "https://google.test/auth?state=" + state }
func (f *fakeCalendar) exchange(_ context.Context, code string) (string, error) {
	return "refresh-" + code, nil
}
func (f *fakeCalendar) busy(_ context.Context, refresh string, _, _ time.Time) ([][2]time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.busyOf[refresh], nil
}
func (f *fakeCalendar) makeCalendar(_ context.Context, refresh string) (string, error) {
	return "cal-" + refresh, nil
}
func (f *fakeCalendar) createEvent(_ context.Context, _, calendar string, start, end time.Time, summary, link string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	if f.events[calendar] == nil {
		f.events[calendar] = map[string]string{}
	}
	id := "ev" + strings.Repeat("x", f.n)
	f.events[calendar][id] = summary + " | " + link
	return id, nil
}
func (f *fakeCalendar) deleteEvent(_ context.Context, _, calendar, event string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.events[calendar], event)
	return nil
}
func (f *fakeCalendar) revoke(_ context.Context, refresh string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, refresh)
	return nil
}

func (f *fakeCalendar) on(calendar string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, d := range f.events[calendar] {
		out = append(out, d)
	}
	return out
}

// Step 28, part B: a person connects Google once (the state is theirs and usable once); their busy times are not offered; a booking
// becomes an event holding the time and a link, never the lead's name or number; cancelling removes it; handing the work on moves it to
// the new closer's calendar; disconnecting removes the events and revokes access (D158-D160).
func TestGoogleCalendar(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	cal := &fakeCalendar{busyOf: map[string][][2]time.Time{}, events: map[string]map[string]string{}}
	e.s.calendar = cal
	e.s.cfg.googleKey = []byte(strings.Repeat("k", 32))
	e.s.cfg.appURL = "https://app.callerwhale.test"
	const teamT = "aaaaaaaa-0000-4000-8000-0000000000e1"
	const carl, dana = "55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"
	e.rules.mu.Lock()
	g := e.rules.grants[alice+"|"+orgA]
	g.Roles = []string{"owner"}
	e.rules.grants[alice+"|"+orgA] = g
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T"}}}
	e.rules.roster[orgA] = []member{{UserID: alice, Roles: []string{"owner"}}, {UserID: bob, Roles: []string{"caller"}, TeamIDs: []string{teamT}},
		{UserID: carl, Roles: []string{"closer"}, TeamIDs: []string{teamT}}, {UserID: dana, Roles: []string{"closer"}, TeamIDs: []string{teamT}}}
	e.rules.grants[bob+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call"}, Roles: []string{"caller"}}
	for _, p := range []string{carl, dana} {
		e.rules.grants[p+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"own"}, TeamIDs: []string{teamT}, Capabilities: []string{"edit", "call", "finance"}, Roles: []string{"closer"}}
		e.rules.people_[p] = peopleReply{UserID: p, Workspaces: []workspaceRoles{{OrgID: orgA, Roles: []string{"closer"}}}}
	}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)

	connect := func(user string) string {
		_, out := e.call(user, "", "POST", "/api/v1/me/google/connect", nil)
		u, _ := url.Parse(out["url"].(string))
		state := u.Query().Get("state")
		rec := httptest.NewRecorder()
		e.s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/google/callback?state="+state+"&code="+user[:4], nil))
		if rec.Code != http.StatusFound || !strings.HasSuffix(rec.Header().Get("Location"), "?google=connected") {
			t.Fatalf("callback: %d %s", rec.Code, rec.Header().Get("Location"))
		}
		return state
	}
	state := connect(carl)
	rec := httptest.NewRecorder()
	e.s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/google/callback?state="+state+"&code=again", nil))
	if !strings.HasSuffix(rec.Header().Get("Location"), "?google=refused") {
		t.Fatalf("a state used twice: %s", rec.Header().Get("Location"))
	}
	var sealed []byte
	if err := e.admin.QueryRow(ctx, `SELECT refresh_token FROM crm.google_accounts WHERE user_id = $1`, carl).Scan(&sealed); err != nil || strings.Contains(string(sealed), "refresh-") {
		t.Fatalf("the token is kept encrypted: %v", err)
	}
	connect(dana)

	week := []map[string]any{}
	for d := 0; d < 7; d++ {
		week = append(week, map[string]any{"weekday": d, "from": "00:00", "until": "24:00"})
	}
	e.call(carl, orgA, "PUT", "/api/v1/closers/"+carl+"/hours", map[string]any{"days": week})
	_, before := e.call(bob, orgA, "GET", "/api/v1/teams/"+teamT+"/slots?days=2", nil)
	first := before["slots"].([]any)[0].(map[string]any)
	start, _ := time.Parse(time.RFC3339, first["starts_at"].(string))
	cal.mu.Lock()
	cal.busyOf["refresh-"+carl[:4]] = [][2]time.Time{{start, start.Add(time.Hour)}}
	cal.mu.Unlock()
	_, after := e.call(bob, orgA, "GET", "/api/v1/teams/"+teamT+"/slots?days=2", nil)
	if len(after["slots"].([]any)) >= len(before["slots"].([]any)) || after["slots"].([]any)[0].(map[string]any)["starts_at"] == first["starts_at"] {
		t.Fatal("a busy time on Google is still offered")
	}

	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Pat Private", "phone": "512-555-0701"}), "applied")
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET team_id = $2, assignee_id = $3 WHERE id = $1`, lead, teamT, bob); err != nil {
		t.Fatal(err)
	}
	slot := after["slots"].([]any)[0].(map[string]any)
	status, appt := e.call(bob, orgA, "POST", "/api/v1/appointments", map[string]any{"lead_id": lead, "closer_id": carl, "starts_at": slot["starts_at"]})
	if status != 200 {
		t.Fatalf("book: %d %v", status, appt)
	}
	events := cal.on("cal-refresh-" + carl[:4])
	if len(events) != 1 || strings.Contains(events[0], "Pat") || strings.Contains(events[0], "555") || !strings.Contains(events[0], "org="+orgA) || !strings.Contains(events[0], "lead="+lead) {
		t.Fatalf("the event: %v", events)
	}
	e.call(bob, orgA, "POST", "/api/v1/appointments/"+appt["id"].(string)+"/cancel", nil)
	if len(cal.on("cal-refresh-"+carl[:4])) != 0 {
		t.Fatal("a cancelled appointment stayed on the calendar")
	}

	// Handed on: carl leaves; his appointment and its event go to dana.
	slot = after["slots"].([]any)[1].(map[string]any)
	e.call(bob, orgA, "POST", "/api/v1/appointments", map[string]any{"lead_id": lead, "closer_id": carl, "starts_at": slot["starts_at"]})
	if _, err := e.admin.Exec(ctx, `UPDATE crm.leads SET assignee_id = $2 WHERE id = $1`, lead, carl); err != nil {
		t.Fatal(err)
	}
	gone := time.Now().Unix()
	e.rules.mu.Lock()
	e.rules.roster[orgA][2].SuspendedAt = &gone
	e.rules.mu.Unlock()
	if status, out := e.call(alice, orgA, "POST", "/api/v1/handon/"+carl, map[string]any{"to": dana}); status != 200 {
		t.Fatalf("hand on: %d %v", status, out)
	}
	if len(cal.on("cal-refresh-"+carl[:4])) != 0 || len(cal.on("cal-refresh-"+dana[:4])) != 1 {
		t.Fatalf("the event did not move: carl %v, dana %v", cal.on("cal-refresh-"+carl[:4]), cal.on("cal-refresh-"+dana[:4]))
	}

	// Disconnecting removes the events and revokes access.
	e.call(dana, "", "DELETE", "/api/v1/me/google", nil)
	if len(cal.on("cal-refresh-"+dana[:4])) != 0 || len(cal.revoked) != 1 {
		t.Fatalf("disconnect: %v %v", cal.on("cal-refresh-"+dana[:4]), cal.revoked)
	}
	if _, out := e.call(dana, "", "GET", "/api/v1/me/google", nil); out["connected"] != false {
		t.Fatalf("still connected: %v", out)
	}
}

// The real client's requests, against a stand-in Google server: only the two narrow permissions are asked for, tokens are swapped for
// access, and the calendar calls carry them.
func TestGoogleClientRequests(t *testing.T) {
	var seen []string
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization")+" "+r.Form.Get("grant_type"))
		switch {
		case r.URL.Path == "/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599})
		case r.URL.Path == "/freeBusy":
			writeJSON(w, 200, map[string]any{"calendars": map[string]any{"primary": map[string]any{"busy": []map[string]string{{"start": "2026-11-19T15:00:00Z", "end": "2026-11-19T16:00:00Z"}}}}})
		case r.URL.Path == "/calendars":
			writeJSON(w, 200, map[string]any{"id": "cw-cal"})
		case strings.HasSuffix(r.URL.Path, "/events"):
			writeJSON(w, 200, map[string]any{"id": "ev-1"})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer google.Close()
	g := newGoogleAPI("client", "secret", "https://api.callerwhale.test/api/v1/google/callback")
	g.tokenURL, g.apiBase, g.revokeURL = google.URL+"/token", google.URL, google.URL+"/revoke"
	auth, _ := url.Parse(g.authURL("st"))
	if scopes := auth.Query().Get("scope"); scopes != googleScopes || strings.Contains(scopes, "calendar.events ") || strings.Contains(scopes, "auth/calendar ") {
		t.Fatalf("scopes: %q", scopes)
	}
	ctx := context.Background()
	refresh, err := g.exchange(ctx, "code")
	if err != nil || refresh != "rt-1" {
		t.Fatalf("exchange: %q %v", refresh, err)
	}
	busy, err := g.busy(ctx, refresh, time.Now(), time.Now().Add(48*time.Hour))
	if err != nil || len(busy) != 1 {
		t.Fatalf("busy: %v %v", busy, err)
	}
	if cal, err := g.makeCalendar(ctx, refresh); err != nil || cal != "cw-cal" {
		t.Fatalf("calendar: %q %v", cal, err)
	}
	if ev, err := g.createEvent(ctx, refresh, "cw-cal", time.Now(), time.Now().Add(time.Hour), "Caller Whale appointment", "https://app/x"); err != nil || ev != "ev-1" {
		t.Fatalf("event: %q %v", ev, err)
	}
	if err := g.deleteEvent(ctx, refresh, "cw-cal", "ev-1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(seen, "\n"), "POST /freeBusy Bearer at-1") {
		t.Fatalf("requests: %v", seen)
	}
}
