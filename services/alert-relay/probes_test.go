package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProbesSayWhichServicesAnswerAndSinceWhenOneDoesNot(t *testing.T) {
	asked := 0
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		q := r.URL.Query().Get("query")
		value := map[string]string{"http://crm-core:8107/healthz": "1", "http://dialer-sms:8113/healthz": "0"}
		if strings.Contains(q, "timestamp") {
			value = map[string]string{"http://crm-core:8107/healthz": "1800000900", "http://dialer-sms:8113/healthz": "1800000000"}
		}
		results := []map[string]any{}
		for target, v := range value {
			results = append(results, map[string]any{"metric": map[string]string{"instance": target}, "value": []any{1800001000.0, v}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": results}})
	}))
	defer prom.Close()
	now := time.Unix(1_800_001_000, 0)
	s := &server{cfg: config{prometheus: prom.URL}, http: http.DefaultClient, now: func() time.Time { return now }}

	get := func() map[string]probe {
		rec := httptest.NewRecorder()
		s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probes", nil))
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
		var body struct{ Probes []probe }
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		out := map[string]probe{}
		for _, p := range body.Probes {
			out[p.Target] = p
		}
		return out
	}
	got := get()
	if !got["http://crm-core:8107/healthz"].Up || got["http://crm-core:8107/healthz"].Since != 0 {
		t.Fatalf("crm-core: %+v", got["http://crm-core:8107/healthz"])
	}
	if d := got["http://dialer-sms:8113/healthz"]; d.Up || d.Since != 1_800_000_000 {
		t.Fatalf("dialer-sms: %+v", d)
	}
	// Asked again within 15 seconds: answered from the copy.
	get()
	if asked != 2 {
		t.Fatalf("Prometheus asked %d times, want 2 (one pass, two queries)", asked)
	}
}

func TestProbesWithoutPrometheusSayItCouldNotBeRead(t *testing.T) {
	s := &server{cfg: config{prometheus: "http://127.0.0.1:1"}, http: http.DefaultClient, now: time.Now}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probes", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d", rec.Code)
	}
}
