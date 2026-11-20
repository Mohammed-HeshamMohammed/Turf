package runtimelog

import (
	"net/http"
	"net/http/httptest"
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
	handler := LogHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "kept")
		w.WriteHeader(418)
		w.Write([]byte("same response"))
	}))
	handler.ServeHTTP(target, httptest.NewRequest("GET", "/test?secret=omitted", nil))
	if target.Code != 418 || target.Header().Get("X-Test") != "kept" || target.Body.String() != "same response" {
		t.Fatal("middleware changed response")
	}
}
