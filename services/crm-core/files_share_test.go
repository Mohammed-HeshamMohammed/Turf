package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeScanner finds the test virus string and passes everything else.
type fakeScanner struct{}

func (fakeScanner) scan(_ context.Context, body []byte) (bool, string, error) {
	if bytes.Contains(body, []byte("EICAR")) {
		return false, "Eicar-Test-Signature", nil
	}
	return true, "", nil
}

// Step 38: the clamd client speaks INSTREAM and reads OK and FOUND.
func TestClamdInstream(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				cmd := make([]byte, len("zINSTREAM\x00"))
				_, _ = io.ReadFull(c, cmd)
				var got []byte
				size := make([]byte, 4)
				for {
					if _, err := io.ReadFull(c, size); err != nil {
						return
					}
					n := binary.BigEndian.Uint32(size)
					if n == 0 {
						break
					}
					chunk := make([]byte, n)
					_, _ = io.ReadFull(c, chunk)
					got = append(got, chunk...)
				}
				if string(cmd) != "zINSTREAM\x00" {
					_, _ = c.Write([]byte("UNKNOWN COMMAND\x00"))
				} else if bytes.Contains(got, []byte("EICAR")) {
					_, _ = c.Write([]byte("stream: Eicar-Test-Signature FOUND\x00"))
				} else {
					_, _ = c.Write([]byte("stream: OK\x00"))
				}
			}(c)
		}
	}()
	c := clamd{addr: ln.Addr().String()}
	big := bytes.Repeat([]byte("a"), 200000)
	if ok, _, err := c.scan(context.Background(), big); err != nil || !ok {
		t.Fatalf("clean: %v %v", ok, err)
	}
	if ok, found, err := c.scan(context.Background(), append(big, "EICAR"...)); err != nil || ok || found != "Eicar-Test-Signature" {
		t.Fatalf("found: %v %q %v", ok, found, err)
	}
}

// Step 38: files are checked for type and content, scanned before opening, held to the plan's storage; team leads, admins and the
// owner share them with clients or by a link that expires; shares are withdrawn and every opening is recorded (D256-D258).
func TestFilesSharedScannedAndLimited(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	const teamT, dave = "aaaaaaaa-0000-4000-8000-000000003801", "44444444-4444-4444-8444-444444444444"
	e.rules.mu.Lock()
	e.rules.teamList = map[string][]authzTeam{orgA: {{TeamID: teamT, Name: "T"}}}
	e.rules.grants[dave+"|"+orgA] = grantReply{Allowed: true, Scopes: []string{"team", "own"}, TeamIDs: []string{teamT}, TeamScopeIDs: []string{teamT}, ManagedTeamIDs: []string{teamT}, Capabilities: []string{"edit", "assign", "call"}, Roles: []string{"manager"}}
	e.rules.mu.Unlock()
	e.call(alice, orgA, "GET", "/api/v1/admin/teams", nil)
	e.s.cfg.emailPublicURL = "https://gate.test"
	lead := newID(t)
	e.want(e.op(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Files lead", "team_id": teamT, "assignee_id": bob}), "applied")
	pdf := http.Header{"Content-Type": {"application/pdf"}}
	upload := func(user, query string, body string, h http.Header) (int, map[string]any) {
		status, raw := e.raw(user, orgA, "POST", "/api/v1/leads/"+lead+"/files?"+query, []byte(body), h)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return status, out
	}

	if status, _ := upload(bob, "name=x.pdf", "MZ\x90\x00 a program", pdf); status != 400 {
		t.Fatalf("a program named as a PDF: %d", status)
	}
	if status, _ := upload(bob, "name=x.csv", "a,b", http.Header{"Content-Type": {"text/csv"}}); status != 400 {
		t.Fatalf("a CSV: %d", status)
	}
	// The caller holding the lead uploads, but does not share.
	if status, _ := upload(bob, "name=x.pdf&visibility=shared", "%PDF-1.7 x", pdf); status != 403 {
		t.Fatalf("a caller shares at upload: %d", status)
	}
	status, file := upload(bob, "name=offer.pdf", "%PDF-1.7 offer", pdf)
	if status != 201 || file["scan"] != "clean" {
		t.Fatalf("upload: %d %v", status, file)
	}
	id := file["id"].(string)
	if status, _ := e.call(bob, orgA, "PATCH", "/api/v1/files/"+id, map[string]any{"visibility": "shared"}); status != 403 {
		t.Fatalf("a caller shares: %d", status)
	}
	if status, _ := e.call(dave, orgA, "PATCH", "/api/v1/files/"+id, map[string]any{"visibility": "shared"}); status != 200 {
		t.Fatalf("the team's lead shares: %d", status)
	}

	// A harmful file is never served.
	_, bad := upload(bob, "name=bad.pdf", "%PDF-1.7 EICAR", pdf)
	if bad["scan"] != "infected" {
		t.Fatalf("harmful: %v", bad)
	}
	if status, _ := e.raw(bob, orgA, "GET", "/api/v1/files/"+bad["id"].(string), nil, nil); status != 410 {
		t.Fatalf("a harmful file opened: %d", status)
	}
	// Without a scanner the file waits, unopened, and is scanned when the scanner is back.
	e.s.scanner = nil
	_, waiting := upload(bob, "name=later.pdf", "%PDF-1.7 later", pdf)
	if status, _ := e.raw(bob, orgA, "GET", "/api/v1/files/"+waiting["id"].(string), nil, nil); waiting["scan"] != "waiting" || status != 409 {
		t.Fatalf("an unscanned file opened: %v %d", waiting["scan"], status)
	}
	e.s.scanner = fakeScanner{}
	if err := e.s.scanWaiting(ctx); err != nil {
		t.Fatal(err)
	}
	if status, _ := e.raw(bob, orgA, "GET", "/api/v1/files/"+waiting["id"].(string), nil, nil); status != 200 {
		t.Fatalf("after the scan: %d", status)
	}

	// The plan's storage.
	e.s.storageLimitFn = func(context.Context, string) (int64, error) { return 60, nil }
	if status, _ := upload(bob, "name=big.pdf", "%PDF-1.7 "+strings.Repeat("x", 40), pdf); status != 402 {
		t.Fatalf("past the storage: %d", status)
	}
	_, storage := e.call(alice, orgA, "GET", "/api/v1/files/storage", nil)
	if storage["limit_bytes"] != 60.0 || storage["used_bytes"].(float64) < 20 {
		t.Fatalf("storage: %v", storage)
	}
	e.s.storageLimitFn = nil

	// A link for someone outside: opened, recorded, withdrawn; an expired one is gone.
	if status, _ := e.call(bob, orgA, "POST", "/api/v1/files/"+id+"/links", map[string]any{"for": "Title Co"}); status != 403 {
		t.Fatalf("a caller makes a link: %d", status)
	}
	_, link := e.call(alice, orgA, "POST", "/api/v1/files/"+id+"/links", map[string]any{"for": "Title Co", "days": 3})
	url, _ := link["url"].(string)
	if !strings.HasPrefix(url, "https://gate.test/api/v1/public/files/") {
		t.Fatalf("link: %v", link)
	}
	open := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", strings.TrimPrefix(url, "https://gate.test"), nil)
		r.Header.Set("X-Forwarded-For", "203.0.113.38")
		rec := httptest.NewRecorder()
		e.s.handler().ServeHTTP(rec, r)
		return rec
	}
	if rec := open(); rec.Code != 200 || rec.Body.String() != "%PDF-1.7 offer" {
		t.Fatalf("open link: %d %s", rec.Code, rec.Body)
	}
	_, activity := e.call(dave, orgA, "GET", "/api/v1/files/"+id+"/activity", nil)
	opens := activity["opens"].([]any)
	if len(activity["shares"].([]any)) != 2 || len(opens) != 1 || opens[0].(map[string]any)["who"] != "Title Co" || opens[0].(map[string]any)["network"] != "203.0.113.38" {
		t.Fatalf("activity: %v", activity)
	}
	e.call(alice, orgA, "DELETE", "/api/v1/files/"+id+"/shares/"+link["id"].(string), nil)
	if rec := open(); rec.Code != 410 {
		t.Fatalf("a withdrawn link: %d", rec.Code)
	}
	_, link = e.call(alice, orgA, "POST", "/api/v1/files/"+id+"/links", map[string]any{"for": "Lender"})
	url = link["url"].(string)
	if _, err := e.admin.Exec(ctx, `UPDATE crm.file_shares SET expires_at = $2 WHERE id = $1`, link["id"], time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if rec := open(); rec.Code != 410 {
		t.Fatalf("an expired link: %d", rec.Code)
	}
	r := httptest.NewRequest("GET", "/api/v1/public/files/"+strings.ReplaceAll(orgB, "-", "")+".00000000000000000000", nil)
	rec := httptest.NewRecorder()
	e.s.handler().ServeHTTP(rec, r)
	if rec.Code != 404 {
		t.Fatalf("a made-up link: %d", rec.Code)
	}
	// Unshared with clients: the share is closed.
	e.call(dave, orgA, "PATCH", "/api/v1/files/"+id, map[string]any{"visibility": "internal"})
	var open1 int
	_ = e.admin.QueryRow(ctx, `SELECT count(*) FROM crm.file_shares WHERE file_id = $1 AND kind = 'clients' AND withdrawn_at IS NULL`, id).Scan(&open1)
	if open1 != 0 {
		t.Fatal("the clients' share stayed open")
	}
}
