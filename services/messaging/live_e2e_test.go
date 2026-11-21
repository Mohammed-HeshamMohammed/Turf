package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// TestARealLiveServerDeliversTheOutbox runs against a real Centrifugo, set up as services/live/config.json says, reading this
// service's outbox with the read-only login (CI starts one; see .github/workflows/ci.yml). A person listens on their own channel
// and hears a message the moment it is saved, and the queue is left empty.
//
// LIVE_E2E_URL is Centrifugo's address (http://localhost:8000), LIVE_E2E_ADMIN_URL a superuser on the database Centrifugo reads
// (its own, so the other tests' queues are not taken from under them). Centrifugo must have the unidirectional SSE transport on and
// LIVE_E2E_SECRET as its token secret.
func TestARealLiveServerDeliversTheOutbox(t *testing.T) {
	liveURL, adminURL, secret := os.Getenv("LIVE_E2E_URL"), os.Getenv("LIVE_E2E_ADMIN_URL"), os.Getenv("LIVE_E2E_SECRET")
	if liveURL == "" || adminURL == "" || secret == "" {
		t.Skip("set LIVE_E2E_URL, LIVE_E2E_ADMIN_URL and LIVE_E2E_SECRET to run against a real live server")
	}
	e := newEnvAt(t, adminURL, adminURL)
	org := newID()
	alice, bob := newID(), newID()
	e.rules.join(org, alice, bob)
	id := e.must(201, alice, org, "POST", "/conversations", map[string]any{"kind": "direct", "member_ids": []string{bob}})["id"].(string)

	// Bob listens on his own channel, as the app does, with a token signed like the service's own (plus the channel to join).
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	now := time.Now()
	head := enc(map[string]string{"alg": "HS256", "typ": "JWT"})
	body := enc(map[string]any{"sub": bob, "iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "channels": []string{channelPrefix + bob}})
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(head + "." + body))
	token := head + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	connect, _ := json.Marshal(map[string]string{"token": token})

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, liveURL+"/connection/uni_sse?cf_connect="+url.QueryEscape(string(connect)), nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("the live server refused the connection: %d", res.StatusCode)
	}
	lines := make(chan string)
	go func() {
		scan := bufio.NewScanner(res.Body)
		scan.Buffer(make([]byte, 1<<16), 1<<20)
		for scan.Scan() {
			lines <- scan.Text()
		}
		close(lines)
	}()
	// Connected (and subscribed) once the first event arrives.
	if !waitFor(t, lines, `"connect"`) {
		t.Fatal("no connect reply from the live server")
	}

	sent := time.Now()
	e.send(alice, org, id, "heard live")
	if !waitFor(t, lines, "heard live") {
		t.Fatal("the message never reached the live server's listener")
	}
	t.Logf("delivered %s after it was saved", time.Since(sent).Round(time.Millisecond))
	// What was delivered leaves the queue (Centrifugo deletes it in the same transaction it reads it in).
	deadline := time.Now().Add(10 * time.Second)
	for len(e.outbox()) != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%d updates still queued after delivery", len(e.outbox()))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// waitFor reads events until one contains want, or the stream ends.
func waitFor(t *testing.T, lines <-chan string, want string) bool {
	t.Helper()
	timeout := time.After(45 * time.Second) // the live server backs off up to 5 s after the other tests remade the schema
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				return false
			}
			if strings.HasPrefix(line, "data:") && strings.Contains(line, want) {
				return true
			}
		case <-timeout:
			return false
		}
	}
}
