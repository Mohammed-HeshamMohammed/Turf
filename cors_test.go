package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestParseOriginsTakesOnlySchemeAndHost(t *testing.T) {
	got, err := parseOrigins(" https://callerwhale.com, https://app.callerwhale.com ,tauri://localhost,")
	if err != nil || len(got) != 3 || !got["https://callerwhale.com"] || !got["tauri://localhost"] {
		t.Fatalf("got %v, %v", got, err)
	}
	if got, err := parseOrigins(""); err != nil || len(got) != 0 {
		t.Fatalf("empty: %v, %v", got, err)
	}
	for _, bad := range []string{"callerwhale.com", "https://callerwhale.com/", "https://callerwhale.com/path", "https://user@callerwhale.com", "https://callerwhale.com?x=1", "*"} {
		if _, err := parseOrigins(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

// corsGateway is a gateway with one route (to `upstream`) that allows pages on https://callerwhale.com to read its own replies.
func corsGateway(t *testing.T, upstream http.Handler) *gateway {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	env := map[string]string{"ROUTES": "auth.example.com=" + server.URL, "CORS_ORIGINS": "https://callerwhale.com"}
	cfg, err := loadConfig(func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	return newGateway(cfg)
}

func serve(g *gateway, host, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/anything", nil)
	req.RemoteAddr = "10.0.0.9:5555"
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	return rec
}

func TestGatewayRefusalsCanBeReadByTheSite(t *testing.T) {
	g := corsGateway(t, http.NotFoundHandler())
	// A host the gateway does not serve is answered by the gateway itself.
	rec := serve(g, "nobody.example.com", "https://callerwhale.com")
	if rec.Code != http.StatusNotFound || rec.Header().Get("Access-Control-Allow-Origin") != "https://callerwhale.com" {
		t.Fatalf("the site cannot read the refusal: %d %v", rec.Code, rec.Header())
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Origin") {
		t.Fatalf("a reply that depends on the origin must say so: %v", rec.Header())
	}
	if rec := serve(g, "nobody.example.com", "https://evil.example"); rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("another site was allowed: %v", rec.Header())
	}
	if rec := serve(g, "nobody.example.com", ""); rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("a request with no origin got the header: %v", rec.Header())
	}
}

func TestGatewayLeavesTheServicesOwnCorsHeadersAlone(t *testing.T) {
	g := corsGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "https://callerwhale.com")
		w.Header().Add("Vary", "Origin")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	rec := serve(g, "auth.example.com", "https://callerwhale.com")
	if got := rec.Header().Values("Access-Control-Allow-Origin"); len(got) != 1 {
		t.Fatalf("a browser refuses two Allow-Origin headers: %v", got)
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("the reply was changed: %q", rec.Body.String())
	}
}

func TestGatewayAddsNothingToServiceRepliesThatNeverSetCors(t *testing.T) {
	// A reply the service chose not to open to this page still gets the gateway's own allowance for the site's own origin: the site is
	// the one origin the operator named. Pages on other origins get nothing.
	g := corsGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }))
	if rec := serve(g, "auth.example.com", "https://evil.example"); rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("another site was allowed: %v", rec.Header())
	}
}

func TestHumanCheckSaysWhyItRefusesAndNeverTheSecret(t *testing.T) {
	const secret = "s3cret-key-value"
	cases := map[string]struct {
		answer string
		want   string
	}{
		"wrong secret":   {`{"success":false,"error-codes":["invalid-input-secret"]}`, "invalid-input-secret"},
		"low score":      {`{"success":true,"score":0.1,"action":"signin","hostname":"callerwhale.com"}`, "score 0.10 is below the minimum 0.50"},
		"wrong action":   {`{"success":true,"score":0.9,"action":"signup","hostname":"callerwhale.com"}`, `action "signup"`},
		"wrong hostname": {`{"success":true,"score":0.9,"action":"signin","hostname":"evil.example"}`, `"evil.example"`},
		"no score":       {`{"success":true,"action":"signin","hostname":"callerwhale.com"}`, "no score"},
		"not JSON":       {`nope`, "could not be read"},
	}
	for name, c := range cases {
		google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(c.answer)) }))
		check := newHumanCheck(humanSettings{siteKey: "site", secret: secret, hostnames: []string{"callerwhale.com"}, minScore: 0.5})
		check.endpoint = google.URL
		var logged bytes.Buffer
		log.SetOutput(&logged)
		ok := check.verify(context.Background(), "a-token", "signin", 0.5)
		log.SetOutput(os.Stderr)
		google.Close()
		if ok {
			t.Errorf("%s: the check passed", name)
		}
		if !strings.Contains(logged.String(), c.want) || strings.Contains(logged.String(), secret) || strings.Contains(logged.String(), "a-token") {
			t.Errorf("%s: the log says %q", name, logged.String())
		}
	}
}

func TestHumanCheckLogsAnEmptyToken(t *testing.T) {
	check := newHumanCheck(humanSettings{secret: "s", hostnames: []string{"callerwhale.com"}})
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	if check.verify(context.Background(), " ", "signin", 0.5) || !strings.Contains(logged.String(), "no usable token") {
		t.Fatalf("log: %q", logged.String())
	}
}
