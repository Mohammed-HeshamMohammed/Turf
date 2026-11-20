// runtime-log is a presentation adapter around a container's original command.
// It forwards shutdown signals and exit codes and never changes HTTP traffic.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

var widths = []int{10, 18, 24, 7, 4, 11}
var ansi = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var email = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
var credential = regexp.MustCompile(`(?i)(password|secret|token|authorization|cookie|api[_-]?key)([" ]*[:=][" ]*)[^\s,;"}]+`)
var bearer = regexp.MustCompile(`(?i)Bearer\s+\S+`)
var userinfo = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@`)
var query = regexp.MustCompile(`\?[^\s"']+`)
var logDate = regexp.MustCompile(`^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d `)

func safe(s string) string {
	s = ansi.ReplaceAllString(s, "")
	s = bearer.ReplaceAllString(s, "Bearer [redacted]")
	s = credential.ReplaceAllString(s, "${1}${2}[redacted]")
	s = email.ReplaceAllString(s, "[email]")
	s = userinfo.ReplaceAllString(s, "${1}[redacted]@")
	s = query.ReplaceAllString(s, "?[omitted]")
	return strings.NewReplacer("\r", `\r`, "\n", `\n`, "\t", `\t`, "|", "/").Replace(s)
}
func cell(s string, n int) string {
	r := []rune(safe(s))
	if len(r) > n {
		r = append(r[:n-1], '~')
	}
	return fmt.Sprintf("%-*s", n, string(r))
}

type printer struct {
	mu       sync.Mutex
	out      io.Writer
	service  string
	combined bool
}

func (p *printer) header() {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprint(p.out, "+-")
	for i, n := range widths {
		if i > 0 {
			fmt.Fprint(p.out, "-+-")
		}
		fmt.Fprint(p.out, strings.Repeat("-", n))
	}
	fmt.Fprintln(p.out, "-+------------------------------")
	fmt.Fprintf(p.out, "| %s | %s | %s | %s | %s | %s | DETAIL / PATH\n", cell("RESULT", 10), cell("SERVICE", 18), cell("PAGE / EVENT", 24), cell("METHOD", 7), cell("HTTP", 4), cell("TIME (SEC)", 11))
}
func result(code int) string {
	switch {
	case code >= 500:
		return "[ERROR]"
	case code >= 400:
		return "[REJECTED]"
	case code >= 300:
		return "[REDIRECT]"
	default:
		return "[OK]"
	}
}
func (p *printer) row(level, event, method, status, duration, detail string) {
	p.rowFor(p.service, level, event, method, status, duration, detail)
}
func (p *printer) rowFor(service, level, event, method, status, duration, detail string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintf(p.out, "| %s | %s | %s | %s | %s | %11s | %s\n", cell(level, 10), cell(service, 18), cell(event, 24), cell(method, 7), cell(status, 4), safe(duration), safe(detail))
}
func text(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func (p *printer) line(line string) {
	line = strings.TrimSpace(logDate.ReplaceAllString(line, ""))
	if line == "" {
		return
	}
	// Existing nginx tables are parsed and rendered once using the shared widths.
	if strings.HasPrefix(line, "+-") || strings.HasPrefix(line, "| RESULT") {
		return
	}
	if strings.HasPrefix(line, "| ") {
		cols := strings.SplitN(line, "|", 8)
		if len(cols) == 8 {
			for i := range cols {
				cols[i] = strings.TrimSpace(cols[i])
			}
			service := p.service
			if p.combined {
				service = cols[2]
			}
			p.rowFor(service, cols[1], cols[3], cols[4], cols[5], cols[6], cols[7])
			return
		}
	}
	var record map[string]any
	if json.Unmarshal([]byte(line), &record) == nil {
		if text(record["cw_event"]) == "request" {
			path := strings.SplitN(strings.SplitN(text(record["path"]), "?", 2)[0], "#", 2)[0]
			code, _ := strconv.Atoi(text(record["status"]))
			seconds, _ := strconv.ParseFloat(text(record["duration_seconds"]), 64)
			if path == "/healthz" && code < 400 {
				return
			}
			duration := fmt.Sprintf("%.3f s", seconds)
			if len(duration) > 11 {
				duration = ">99999 s"
			}
			event := text(record["event"])
			if event == "" {
				event = "HTTP request"
			}
			if i := strings.Index(path, "/webhook/"); i >= 0 {
				path = path[:i+9] + "[redacted]"
			}
			p.row(result(code), event, text(record["method"]), strconv.Itoa(code), duration, path)
			return
		}
		level := strings.ToUpper(text(record["level"]))
		if level == "WARNING" {
			level = "WARN"
		}
		if level == "" {
			level = "INFO"
		}
		message := text(record["msg"])
		if message == "" {
			message = text(record["message"])
		}
		if fields, ok := record["fields"].(map[string]any); ok && message == "" {
			message = text(fields["message"])
		}
		// Keep useful fields without repeating the message or serializer metadata.
		keys := make([]string, 0, len(record))
		for key := range record {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := []string{message}
		for _, key := range keys {
			switch key {
			case "msg", "message", "level", "time", "timestamp", "ts", "t":
				continue
			}
			parts = append(parts, key+": "+text(record[key]))
		}
		p.row("["+level+"]", "Service event", "-", "-", "-", strings.Join(parts, "; "))
		return
	}
	line = logDate.ReplaceAllString(line, "")
	level, event := "[INFO]", "Service event"
	for _, tag := range []string{"CHECK", "PASS", "START", "FAILED"} {
		if strings.HasPrefix(line, "["+tag+"]") {
			level = "[" + tag + "]"
			event = "Startup"
			line = strings.TrimSpace(strings.TrimPrefix(line, "["+tag+"]"))
			break
		}
	}
	if event != "Startup" {
		lower := strings.ToLower(line)
		switch {
		case strings.Contains(lower, "error"), strings.Contains(lower, "fatal"), strings.Contains(lower, "panic"), strings.Contains(lower, "failed"), strings.Contains(lower, "not sent"):
			level = "[ERROR]"
		case strings.Contains(lower, "warn"), strings.Contains(lower, "not set"), strings.Contains(lower, "is empty"):
			level = "[WARN]"
		}
	}
	p.row(level, event, "-", "-", "-", line)
}

// Each child stream owns a writer. A mutex in printer makes complete rows atomic.
// Split extremely large lines into bounded chunks rather than silently dropping them.
type stream struct {
	p       *printer
	pending []byte
}

func (s *stream) Write(data []byte) (int, error) {
	n := len(data)
	s.pending = append(s.pending, data...)
	for {
		i := bytes.IndexByte(s.pending, '\n')
		if i < 0 || i > 65536 {
			if len(s.pending) > 65536 {
				s.p.line(string(s.pending[:65536]) + " [continued]")
				s.pending = s.pending[65536:]
				continue
			}
			break
		}
		s.p.line(string(s.pending[:i]))
		s.pending = s.pending[i+1:]
	}
	return n, nil
}
func (s *stream) flush() {
	if len(s.pending) > 0 {
		s.p.line(string(s.pending))
		s.pending = nil
	}
}
func run(args []string, out, errOut io.Writer) int {
	if len(args) < 1 {
		fmt.Fprintln(errOut, "runtime-log: missing command")
		return 2
	}
	if args[0] == "--stdin" {
		service := os.Getenv("CALLERWHALE_LOG_SERVICE")
		if service == "" {
			service = "External stream"
		}
		p := &printer{out: out, service: service, combined: true}
		p.header()
		sink := &stream{p: p}
		_, err := io.Copy(sink, os.Stdin)
		sink.flush()
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		return 0
	}
	// Explicit maintenance commands must keep their normal stdout (e.g. new-key).
	for _, arg := range args[1:] {
		if arg == "health" || arg == "new-key" || arg == "setup-database" {
			cmd := exec.Command(args[0], args[1:]...)
			cmd.Stdout = out
			cmd.Stderr = errOut
			cmd.Stdin = os.Stdin
			if err := cmd.Run(); err != nil {
				if e, ok := err.(*exec.ExitError); ok {
					return e.ExitCode()
				}
				return 1
			}
			return 0
		}
	}
	service := os.Getenv("CALLERWHALE_LOG_SERVICE")
	if service == "" {
		service = "Service"
	}
	p := &printer{out: out, service: service}
	p.header()
	p.row("[START]", "Process", "-", "-", "-", "Starting container command")
	cmd := exec.Command(args[0], args[1:]...)
	stdout, stderr := &stream{p: p}, &stream{p: p}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Start(); err != nil {
		p.row("[ERROR]", "Process", "-", "-", "-", err.Error())
		return 1
	}
	signals := make(chan os.Signal, 8)
	done := make(chan struct{})
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		for {
			select {
			case sig := <-signals:
				_ = cmd.Process.Signal(sig)
			case <-done:
				return
			}
		}
	}()
	err := cmd.Wait()
	signal.Stop(signals)
	close(done)
	stdout.flush()
	stderr.flush()
	if err != nil {
		p.row("[ERROR]", "Process exit", "-", "-", "-", err.Error())
		if e, ok := err.(*exec.ExitError); ok {
			code := e.ExitCode()
			if code < 0 {
				if status, ok := e.Sys().(syscall.WaitStatus); ok && status.Signaled() {
					return 128 + int(status.Signal())
				}
				return 1
			}
			return code
		}
		return 1
	}
	p.row("[STOP]", "Process exit", "-", "-", "-", "Container command finished")
	return 0
}
func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }
