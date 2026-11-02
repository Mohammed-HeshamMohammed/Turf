package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccessWrapperPreservesStatusBodyAndFlush(t *testing.T) {
	target := httptest.NewRecorder()
	wrapped := &accessResponse{ResponseWriter: target}
	wrapped.WriteHeader(202)
	wrapped.Write([]byte("body"))
	wrapped.Flush()
	if wrapped.status != 202 || target.Code != 202 || target.Body.String() != "body" || !target.Flushed {
		t.Fatal("response changed")
	}
	if wrapped.Unwrap() != target {
		t.Fatal("ResponseController cannot unwrap writer")
	}
}
func TestAccessMiddlewarePassesThrough(t *testing.T) {
	target := httptest.NewRecorder()
	handler := logHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "kept")
		w.WriteHeader(418)
		w.Write([]byte("same response"))
	}))
	handler.ServeHTTP(target, httptest.NewRequest("GET", "/test?secret=omitted", nil))
	if target.Code != 418 || target.Header().Get("X-Test") != "kept" || target.Body.String() != "same response" {
		t.Fatal("middleware changed response")
	}
}
func TestCombinedStreamKeepsServiceIdentity(t *testing.T) {
	var out bytes.Buffer
	p := &printer{out: &out, service: "Fallback", combined: true}
	p.line("| [OK] | Auth | HTTP request | GET | 200 | 0.001 s | /v1/providers")
	if !strings.Contains(out.String(), "Auth") || strings.Contains(out.String(), "Fallback") {
		t.Fatal("source identity lost")
	}
}
