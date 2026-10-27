package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	if code != 200 || body["service"] != "gateway" || body["ok"] != true {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestVersionIsReported(t *testing.T) {
	code, body := get(t, "/version")
	if code != 200 || body["version"] != "0.1.0" {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestUnknownPathsAreNotFound(t *testing.T) {
	if code, _ := get(t, "/nope"); code != 404 {
		t.Fatalf("got %d", code)
	}
}
