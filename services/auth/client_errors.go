package main

// Build step 42 (D303): errors in people's browsers (the website and the CRM web app) are written to this service's log, where Loki
// keeps them beside every other runtime log. Only the error's kind, the page's path without ids, where in the code it happened and
// the app's version are kept: never the error's text (it can hold names, numbers or message text), never who it was.

import (
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	errorKind  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,39}$`)
	codeFrame  = regexp.MustCompile(`^[A-Za-z0-9_./@-]{1,120}:\d{1,7}(:\d{1,7})?$`)
	appNames   = map[string]bool{"site": true, "crm": true}
	errorRates = struct {
		sync.Mutex
		seen  map[string]int
		reset time.Time
	}{seen: map[string]int{}}
)

const errorsPerMinute = 20

// errorAllowed keeps one browser address to errorsPerMinute reports a minute.
func errorAllowed(ip string, now time.Time) bool {
	errorRates.Lock()
	defer errorRates.Unlock()
	if now.After(errorRates.reset) {
		errorRates.seen, errorRates.reset = map[string]int{}, now.Add(time.Minute)
	}
	errorRates.seen[ip]++
	return errorRates.seen[ip] <= errorsPerMinute
}

// codeWhere keeps a stack frame's file (its name, without the address or query) and line.
func codeWhere(frame string) string {
	frame = strings.TrimSpace(frame)
	if i := strings.LastIndex(frame, "/"); i >= 0 {
		frame = frame[i+1:]
	}
	if i := strings.IndexAny(frame, "?#"); i >= 0 {
		rest := frame[i:]
		if j := strings.Index(rest, ":"); j >= 0 {
			frame = frame[:i] + rest[j:]
		} else {
			frame = frame[:i]
		}
	}
	if codeFrame.MatchString(frame) {
		return frame
	}
	return ""
}

// clientErrors answers POST /v1/client-errors {app, kind, page, where: [frames], version}; it always answers 204.
func (s *server) clientErrors(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		App     string   `json:"app"`
		Kind    string   `json:"kind"`
		Page    string   `json:"page"`
		Where   []string `json:"where"`
		Version string   `json:"version"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if ip == "" {
		ip = r.RemoteAddr
	}
	if !errorAllowed(ip, time.Now()) {
		w.WriteHeader(http.StatusTooManyRequests)
		return nil
	}
	app := body.App
	if !appNames[app] {
		app = "unknown"
	}
	kind := body.Kind
	if !errorKind.MatchString(kind) {
		kind = "Error"
	}
	version := body.Version
	if !versionShape.MatchString(version) {
		version = ""
	}
	frames := []string{}
	for _, f := range body.Where {
		if where := codeWhere(f); where != "" {
			frames = append(frames, where)
		}
		if len(frames) == 3 {
			break
		}
	}
	log.Printf("WARN client_error app=%s kind=%s page=%s where=%s version=%s", app, kind, cleanPage(body.Page), strings.Join(frames, ","), version)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
