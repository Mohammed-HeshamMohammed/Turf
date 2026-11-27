package crm

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestEditsApplyOverTheValuesTheyWereMadeFrom(t *testing.T) {
	current := map[string]any{"stage": "Contacted", "priority": "High", "next_action_at": "2026-10-16T10:00:00+00:00", "value_amount": 100.0}
	if err := checkBase(current, map[string]any{"stage": "Interested", "priority": "High"}, map[string]any{"stage": "Contacted", "priority": "Normal"}); err != nil {
		t.Fatalf("an untouched field and an identical field both apply: %v", err)
	}
	err := checkBase(current, map[string]any{"stage": "Interested"}, map[string]any{"stage": "New"})
	c, ok := err.(conflict)
	if !ok || c["stage"].(map[string]any)["server"] != "Contacted" {
		t.Fatalf("a stale base conflicts: %v", err)
	}
	// The same instant or number spelled another way is not a change.
	if !sameValue("2026-10-16T12:00:00+02:00", "2026-10-16T10:00:00Z") || !sameValue("100.00", 100.0) || !sameValue(nil, "") {
		t.Fatal("equivalent spellings must compare equal")
	}
	if sameValue("a", "b") || sameValue(1.0, 2.0) {
		t.Fatal("different values must not")
	}
}

func TestRepeatRules(t *testing.T) {
	from := time.Date(2026, 1, 31, 9, 0, 0, 0, time.UTC)
	if next, ok := nextOccurrence("FREQ=WEEKLY;INTERVAL=2", from); !ok || next != from.AddDate(0, 0, 14) {
		t.Fatalf("weekly: %v %v", next, ok)
	}
	for _, bad := range []string{"FREQ=YEARLY", "INTERVAL=2", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=999", "nonsense"} {
		if _, ok := nextOccurrence(bad, from); ok {
			t.Fatalf("%q must be refused", bad)
		}
	}
	if !validRecurrence("") {
		t.Fatal("no repeat is valid")
	}
}

func TestCallOutcomes(t *testing.T) {
	if o := findOutcome(" voicemail "); o == nil || o.code != "VM" || o.recallDays != 1 {
		t.Fatalf("voicemail: %v", o)
	}
	if findOutcome("DNC") == nil || findOutcome("Made up") != nil {
		t.Fatal("codes work, unknown outcomes do not")
	}
}

func TestAccessRevisionChangesWithAccessAndNotWithOrder(t *testing.T) {
	a := grantReply{Scopes: []string{"team", "own"}, TeamIDs: []string{"t1"}, Capabilities: []string{"edit", "call"}}
	b := grantReply{Scopes: []string{"own", "team"}, TeamIDs: []string{"t1"}, Capabilities: []string{"call", "edit"}}
	if accessRevision(a) != accessRevision(b) {
		t.Fatal("order must not matter")
	}
	b.Capabilities = append(b.Capabilities, "finance")
	if accessRevision(a) == accessRevision(b) {
		t.Fatal("a new right must change it")
	}
	if accessRevision(b) >= 1<<53 {
		t.Fatal("it must fit a JavaScript number")
	}
}

// Only the numbered setup scripts may change the database's structure.
func TestOnlyMigrationsChangeStructure(t *testing.T) {
	ddl := regexp.MustCompile(`(?i)\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|SCHEMA|VIEW|POLICY|FUNCTION|TRIGGER|ROLE)\b`)
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "db.go" {
			continue
		}
		body, _ := os.ReadFile(f)
		if m := ddl.Find(body); m != nil {
			t.Errorf("%s changes structure (%s); that belongs in a numbered script in migrations/", f, m)
		}
	}
}

func TestOnlyListedPagesMayCallFromABrowser(t *testing.T) {
	origins, err := parseOrigins("https://app.callerwhale.com, https://callerwhale.com")
	if err != nil || !origins["https://app.callerwhale.com"] {
		t.Fatalf("origins: %v %v", origins, err)
	}
	if _, err = parseOrigins("https://app.callerwhale.com/path"); err == nil {
		t.Fatal("an origin is a scheme and a host, nothing more")
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := withCORS(origins, next)
	ask := func(method, origin, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	pre := ask(http.MethodOptions, "https://app.callerwhale.com", "/sync/push")
	if pre.Code != http.StatusNoContent || pre.Header().Get("Access-Control-Allow-Origin") != "https://app.callerwhale.com" ||
		!strings.Contains(pre.Header().Get("Access-Control-Allow-Headers"), "x-callerwhale-org") {
		t.Fatalf("preflight: %d %v", pre.Code, pre.Header())
	}
	if got := ask(http.MethodOptions, "https://app.callerwhale.com", "/api/v1/projects/123"); !strings.Contains(got.Header().Get("Access-Control-Allow-Methods"), "DELETE") {
		t.Fatalf("source-list deletion must be allowed by browser preflight: %v", got.Header())
	}
	if got := ask(http.MethodGet, "https://evil.example", "/sync/snapshot"); got.Header().Get("Access-Control-Allow-Origin") != "" || got.Code != http.StatusTeapot {
		t.Fatalf("a page that is not listed gets no permission: %v", got.Header())
	}
	if got := ask(http.MethodPost, "https://app.callerwhale.com", "/api/v1/public/contact"); got.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("the contact form's headers come from the notification service")
	}
}

func TestTheContactFormIsPassedOnToTheNotificationService(t *testing.T) {
	var got string
	notify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Method + " " + r.URL.Path + " " + r.Header.Get("X-Forwarded-For")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer notify.Close()
	s := &server{cfg: config{notifyURL: notify.URL}, now: time.Now}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/public/contact", strings.NewReader(`{}`))
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted || !strings.HasPrefix(got, "POST /api/v1/public/contact 203.0.113.9") {
		t.Fatalf("contact form: %d %q (the visitor's address must stay first)", rec.Code, got)
	}
}
