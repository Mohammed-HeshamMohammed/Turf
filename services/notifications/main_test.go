package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func get(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return rec.Code, body
}

func TestHealthNamesTheService(t *testing.T) {
	code, body := get(t, "/healthz")
	if code != 200 || body["service"] != "notifications" || body["ok"] != true {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestVersionIsReported(t *testing.T) {
	code, body := get(t, "/version")
	if code != 200 || body["version"] != version {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestUnknownPathsAreNotFound(t *testing.T) {
	if code, _ := get(t, "/nope"); code != 404 {
		t.Fatalf("got %d", code)
	}
}

type fakeSender struct {
	sent []Message
	err  error
}

func (f *fakeSender) Send(m Message) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, m)
	return nil
}

const testToken = "auth-token-with-24-or-more-chars"

func post(t *testing.T, s *Server, token, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/mail", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.mux().ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestMailNeedsAServiceToken(t *testing.T) {
	s := newServer(map[string]string{"auth": testToken}, &fakeSender{}, true)
	for _, token := range []string{"", "wrong-token-wrong-token-wrong"} {
		if code, _ := post(t, s, token, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`); code != 401 {
			t.Fatalf("token %q: got %d", token, code)
		}
	}
}

func TestACodeIsSentThroughTheTemplate(t *testing.T) {
	f := &fakeSender{}
	s := newServer(map[string]string{"auth": testToken}, f, true)
	code, _ := post(t, s, testToken, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`)
	if code != 202 || len(f.sent) != 1 {
		t.Fatalf("got %d, sent %d", code, len(f.sent))
	}
	if f.sent[0].To != "a@example.com" || !strings.HasPrefix(f.sent[0].Text, "123456 is your Caller Whale code") || f.sent[0].Subject != "Your Caller Whale code" {
		t.Fatalf("unexpected message %+v", f.sent[0])
	}
}

func TestAnInvitationHasBothPartsAndEscapesTheName(t *testing.T) {
	f := &fakeSender{}
	s := newServer(map[string]string{"core-api": testToken}, f, true)
	body := `{"template":"invitation","to":"sami@example.com","data":{"name":"<b>Sami</b>","inviter":"Mo","monthly_credits":12500,"link":"https://example.test/signup"}}`
	if code, _ := post(t, s, testToken, body); code != 202 {
		t.Fatalf("got %d", code)
	}
	m := f.sent[0]
	if !strings.Contains(m.Text, "12,500 credits a month") || strings.Contains(m.HTML, "<b>Sami") || !strings.Contains(m.HTML, "&lt;b&gt;Sami") || m.Subject != "Mo invited you to Caller Whale" {
		t.Fatalf("unexpected message %+v", m)
	}
}

func TestBadRequestsAreRefusedBeforeSending(t *testing.T) {
	f := &fakeSender{}
	s := newServer(map[string]string{"auth": testToken}, f, true)
	for _, body := range []string{`not json`, `{"template":"nope","to":"a@example.com"}`, `{"template":"mfa_code","to":"a@example.com","data":{}}`, `{"template":"mfa_code","to":"a@example.com","data":{"code":"12 34"}}`} {
		if code, _ := post(t, s, testToken, body); code != 400 {
			t.Fatalf("%q: got %d", body, code)
		}
	}
	if len(f.sent) != 0 {
		t.Fatal("something was sent")
	}
}

func TestNoMailServerAnswers503(t *testing.T) {
	s := newServer(map[string]string{"auth": testToken}, nil, false)
	if code, _ := post(t, s, testToken, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`); code != 503 {
		t.Fatalf("got %d", code)
	}
}

func TestAMailServerFailureIsA502WithoutTheReason(t *testing.T) {
	s := newServer(map[string]string{"auth": testToken}, &fakeSender{err: errors.New("535 bad login for secret@host")}, true)
	code, body := post(t, s, testToken, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`)
	if code != 502 || strings.Contains(body["error"].(string), "secret") {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestACallerIsLimitedPerMinute(t *testing.T) {
	s := newServer(map[string]string{"auth": testToken}, &fakeSender{}, true)
	var last int
	for i := 0; i < perMinute+1; i++ {
		last, _ = post(t, s, testToken, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`)
	}
	if last != 429 {
		t.Fatalf("got %d", last)
	}
}

func TestTokensShorterThan24AreIgnored(t *testing.T) {
	t.Setenv("NOTIFY_TOKENS", "short=abc,auth="+testToken)
	if cfg := loadConfig(); len(cfg.Tokens) != 1 || cfg.Tokens["auth"] != testToken {
		t.Fatalf("got %v", cfg.Tokens)
	}
}
