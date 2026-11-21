package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestAlignedRequestsAndRedaction(t *testing.T) {
	var out bytes.Buffer
	p := &printer{out: &out, service: "Notifications"}
	p.header()
	p.line(`{"cw_event":"request","event":"Privacy page","method":"GET","status":200,"duration_seconds":0.001,"path":"/privacy?token=secret"}`)
	p.line(`{"cw_event":"request","event":"A much longer event name than fits","method":"OPTIONS","status":403,"duration_seconds":12.5,"path":"/v1/mfa/telegram/webhook/private-secret"}`)
	rows := strings.Split(strings.TrimSpace(out.String()), "\n")
	for _, line := range rows[1:] {
		parts := strings.Split(line, "|")
		if len(parts) != 8 {
			t.Fatalf("invalid table row: %q", line)
		}
		for i, w := range widths {
			if len([]rune(parts[i+1])) != w+2 {
				t.Fatalf("column %d is misaligned in %q", i, line)
			}
		}
	}
	if strings.Contains(out.String(), "secret") {
		t.Fatal("sensitive path was logged")
	}
	if !strings.Contains(out.String(), "12.500 s") {
		t.Fatal("duration lost")
	}
}
func TestNativeTablesAreRenderedOnce(t *testing.T) {
	var out bytes.Buffer
	p := &printer{out: &out, service: "Website"}
	p.line("| RESULT | SERVICE | PAGE / FILE | METHOD | HTTP | TIME | PATH")
	p.line("+-----+-----+")
	p.line("| [OK] | Website | Privacy page | GET | 200 | 0.000 s | /privacy")
	if strings.Count(out.String(), "Privacy page") != 1 || strings.Contains(out.String(), "RESULT") {
		t.Fatal(out.String())
	}
}
func TestEventsSafeAndHealthFailuresVisible(t *testing.T) {
	var out bytes.Buffer
	p := &printer{out: &out, service: "Auth"}
	p.line(`{"level":"ERROR","message":"failed","token":"abc123","email":"me@example.com","url":"postgres://user:password@host/db?secret=abc"}`)
	p.line(`{"cw_event":"request","method":"GET","status":200,"path":"/healthz","duration_seconds":0}`)
	p.line(`{"cw_event":"request","method":"GET","status":503,"path":"/healthz","duration_seconds":0}`)
	s := out.String()
	for _, secret := range []string{"abc123", "me@example.com", "user:password", "secret=abc"} {
		if strings.Contains(s, secret) {
			t.Fatalf("leaked %q: %s", secret, s)
		}
	}
	if strings.Count(s, "/healthz") != 1 || !strings.Contains(s, "503") {
		t.Fatal(s)
	}
}
func TestConcurrentStreamsAndTail(t *testing.T) {
	var out bytes.Buffer
	p := &printer{out: &out, service: "Worker"}
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := &stream{p: p}
			for j := 0; j < 10; j++ {
				s.Write([]byte("event\n"))
			}
			s.Write([]byte("tail"))
			s.flush()
		}()
	}
	wg.Wait()
	if len(strings.Split(strings.TrimSpace(out.String()), "\n")) != 55 {
		t.Fatal("lost/interleaved lines")
	}
}
func TestChild(t *testing.T) {
	if os.Getenv("CW_CHILD_TEST") != "1" {
		return
	}
	fmt.Fprintln(os.Stdout, "child stdout")
	fmt.Fprint(os.Stderr, "child stderr tail")
	os.Exit(7)
}
func TestExitCodeAndBothStreams(t *testing.T) {
	t.Setenv("CW_CHILD_TEST", "1")
	var out bytes.Buffer
	code := run([]string{os.Args[0], "-test.run=^TestChild$"}, &out, &out)
	if code != 7 || !strings.Contains(out.String(), "child stdout") || !strings.Contains(out.String(), "child stderr tail") {
		t.Fatalf("code %d, output %s", code, out.String())
	}
}

func TestEmbeddedSeparatorsStayReadable(t *testing.T) {
	if got := safe("Preparing | configuration"); got != "Preparing / configuration" {
		t.Fatal(got)
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
