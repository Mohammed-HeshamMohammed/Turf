// Package runtimelog logs each HTTP request one line at a time, keeping proxy streaming and upgrades intact. One original
// (packages/go/runtimelog, D383): the Go services import it as callerwhale/runtimelog.
package runtimelog

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

type accessResponse struct {
	http.ResponseWriter
	status int
}

func (w *accessResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *accessResponse) WriteHeader(code int) {
	if w.status == 0 && (code >= 200 || code == 101) {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *accessResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(body)
}
func (w *accessResponse) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *accessResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil && w.status == 0 {
		w.status = http.StatusSwitchingProtocols
	}
	return conn, buffer, err
}
func LogHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		out := &accessResponse{ResponseWriter: w}
		completed := false
		defer func() {
			code := out.status
			if code == 0 {
				code = 200
			}
			if !completed {
				code = 500
			}
			if (r.URL.Path == "/healthz" || r.URL.Path == "/_callerwhale/health") && code < 400 {
				return
			}
			data, _ := json.Marshal(map[string]any{"cw_event": "request", "method": r.Method, "path": r.URL.Path, "status": code, "duration_seconds": time.Since(started).Seconds()})
			fmt.Fprintln(os.Stdout, string(data))
		}()
		next.ServeHTTP(out, r)
		completed = true
	})
}
