package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func contactServer(sender Sender) *Server {
	return newServer(nil, sender, true).withContact("team@example.com", []string{"https://callerwhale.com"})
}

func postContact(s *Server, ip, body string, headers ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, contactPath, strings.NewReader(body))
	req.Header.Set("X-Forwarded-For", ip)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	s.mux().ServeHTTP(rec, req)
	return rec
}

const goodContact = `{"name":"Sami","email":"sami@example.com","message":"Do you work on Mac?"}`

func TestContactMessageIsEmailedToTheTeamWithAReplyAddress(t *testing.T) {
	fake := &fakeSender{}
	rec := postContact(contactServer(fake), "203.0.113.7", goodContact)
	if rec.Code != http.StatusAccepted || len(fake.sent) != 1 {
		t.Fatalf("got %d, sent %d", rec.Code, len(fake.sent))
	}
	m := fake.sent[0]
	if m.To != "team@example.com" || m.ReplyTo != "sami@example.com" || !strings.Contains(m.Text, "Do you work on Mac?") {
		t.Fatalf("wrong message: %+v", m)
	}
}

func TestContactTrapFieldLooksLikeSuccessAndSendsNothing(t *testing.T) {
	fake := &fakeSender{}
	rec := postContact(contactServer(fake), "203.0.113.7", `{"name":"x","email":"bot@example.com","message":"buy","website":"http://spam.example"}`)
	if rec.Code != http.StatusAccepted || len(fake.sent) != 0 {
		t.Fatalf("got %d, sent %d", rec.Code, len(fake.sent))
	}
}

func TestContactRefusesWhatIsNotAMessage(t *testing.T) {
	long := strings.Repeat("a", 4001)
	for name, body := range map[string]string{
		"no address":        `{"message":"hi"}`,
		"not an address":    `{"email":"nope","message":"hi"}`,
		"named address":     `{"email":"Sam <sam@example.com>","message":"hi"}`,
		"no message":        `{"email":"sam@example.com","message":"  "}`,
		"message too long":  `{"email":"sam@example.com","message":"` + long + `"}`,
		"name on two lines": `{"name":"a\nb","email":"sam@example.com","message":"hi"}`,
		"not JSON":          `hello`,
	} {
		fake := &fakeSender{}
		if rec := postContact(contactServer(fake), "203.0.113.7", body); rec.Code != http.StatusBadRequest || len(fake.sent) != 0 {
			t.Errorf("%s: got %d, sent %d", name, rec.Code, len(fake.sent))
		}
	}
}

func TestContactIsLimitedPerAddress(t *testing.T) {
	fake := &fakeSender{}
	s := contactServer(fake)
	for i := 0; i < contactPerHour; i++ {
		if rec := postContact(s, "203.0.113.7", goodContact); rec.Code != http.StatusAccepted {
			t.Fatalf("message %d: got %d", i+1, rec.Code)
		}
	}
	if rec := postContact(s, "203.0.113.7", goodContact); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("one more from the same address: got %d", rec.Code)
	}
	if rec := postContact(s, "203.0.113.8", goodContact); rec.Code != http.StatusAccepted {
		t.Fatalf("another address: got %d", rec.Code)
	}
}

func TestContactAnswers503WhenItIsNotSetUp(t *testing.T) {
	if rec := postContact(newServer(nil, &fakeSender{}, true), "203.0.113.7", goodContact); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no inbox: got %d", rec.Code)
	}
	if rec := postContact(newServer(nil, nil, false).withContact("team@example.com", nil), "203.0.113.7", goodContact); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no mail server: got %d", rec.Code)
	}
}

func TestContactDoesNotLeakWhyTheMailServerFailed(t *testing.T) {
	rec := postContact(contactServer(&fakeSender{err: errors.New("login refused for secret-user")}), "203.0.113.7", goodContact)
	if rec.Code != http.StatusBadGateway || strings.Contains(rec.Body.String(), "secret-user") {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestContactAllowsOnlyTheSiteToPostFromABrowser(t *testing.T) {
	s := contactServer(&fakeSender{})
	allowed := postContact(s, "203.0.113.7", goodContact, "Origin", "https://callerwhale.com")
	if allowed.Header().Get("Access-Control-Allow-Origin") != "https://callerwhale.com" {
		t.Fatalf("the site was not allowed: %v", allowed.Header())
	}
	other := postContact(s, "203.0.113.7", goodContact, "Origin", "https://evil.example")
	if other.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("another site was allowed: %v", other.Header())
	}
	preflight := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, contactPath, nil)
	req.Header.Set("Origin", "https://callerwhale.com")
	s.mux().ServeHTTP(preflight, req)
	if preflight.Code != http.StatusNoContent || preflight.Header().Get("Access-Control-Allow-Methods") != "POST" {
		t.Fatalf("preflight: %d %v", preflight.Code, preflight.Header())
	}
}

func TestContactCountsTheRealAddressFromTheGateway(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, contactPath, nil)
	req.RemoteAddr = "10.0.0.5:4444"
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	if got := visitor(req); got != "203.0.113.7" {
		t.Fatalf("got %s", got)
	}
	req.Header.Set("X-Forwarded-For", "not-an-address")
	if got := visitor(req); got != "10.0.0.5" {
		t.Fatalf("got %s", got)
	}
}
