package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Step 42, D303: a browser error is logged with its kind, the page without ids, where in the code and the version, never its text;
// one address is limited.
func TestClientErrorsAreLoggedWithoutPersonalData(t *testing.T) {
	var out bytes.Buffer
	log.SetOutput(&out)
	defer log.SetOutput(os.Stderr)
	s := &server{}
	send := func(body string) int {
		r := httptest.NewRequest("POST", "/v1/client-errors", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", "203.0.113.42")
		w := httptest.NewRecorder()
		serve(s.clientErrors).ServeHTTP(w, r)
		return w.Code
	}
	code := send(`{"app":"crm","kind":"TypeError","message":"Cannot read Pat Seller 512-555-0101","page":"https://app.callerwhale.com/leads/0b7c2a3e-1f2d-4c5b-8a9e-112233445566?q=pat","where":["https://app.callerwhale.com/assets/index-abc.js?v=1:12:345","at <anonymous>"],"version":"1.4.2"}`)
	line := out.String()
	if code != http.StatusNoContent || !strings.Contains(line, "client_error app=crm kind=TypeError page=/leads/:id where=index-abc.js:12:345 version=1.4.2") {
		t.Fatalf("logged: %d %q", code, line)
	}
	if strings.Contains(line, "Pat") || strings.Contains(line, "555") || strings.Contains(line, "q=") {
		t.Fatalf("personal data in the log: %q", line)
	}
	if !errorAllowed("198.51.100.9", time.Now()) {
		t.Fatal("a new address is refused")
	}
	last := 0
	for i := 0; i < errorsPerMinute+1; i++ {
		last = send(`{"app":"site","kind":"Error"}`)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("a flood: %d", last)
	}
}
