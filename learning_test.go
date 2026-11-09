package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestShapesKeepNothingThatIdentifiesAPerson(t *testing.T) {
	h := hasher{key: bytes.Repeat([]byte{7}, 32)}
	if !bytes.Equal(h.phone("(512) 555-0100"), h.phone("+1 512 555 0100")) {
		t.Fatal("the same phone written two ways must hash the same")
	}
	if bytes.Equal(h.phone("5125550100"), h.email("5125550100")) || h.phone("123") != nil || h.email("nobody") != nil {
		t.Fatal("kinds must not collide, and a non-phone or non-email has no hash")
	}
	if bytes.Equal(h.phone("5125550100"), (hasher{key: bytes.Repeat([]byte{8}, 32)}).phone("5125550100")) {
		t.Fatal("a different key must give a different hash")
	}
	for in, want := range map[string]string{"Pat Q Owner": "person:3", "Sunrise Holdings LLC": "company", "": "", "The Smith Family Trust": "company"} {
		if got := nameShape(in); got != want {
			t.Errorf("nameShape(%q) = %q, want %q", in, got, want)
		}
	}
	if zip5("78701-1234") != "78701" || zip5("787") != "" {
		t.Fatal("zip5")
	}
	// Only listed property facts get through, and nothing that looks like a phone or an email.
	got := cleanDetails(map[string]string{"bedrooms": "3", "owner_notes": "call Pat", "year_built": "5125550100", "vacant": "a@b.co", "property_type": "Single family"})
	if len(got) != 2 || got["bedrooms"] != "3" || got["property_type"] != "Single family" {
		t.Fatalf("details: %v", got)
	}
	if f := cleanFlags(map[string]string{"stage": "Contacted", "note": "x", "verdict": strings.Repeat("a", 50)}); len(f) != 1 || f["stage"] != "Contacted" {
		t.Fatalf("flags: %v", f)
	}
}

func TestConfigNeedsTheKeysAndStartsSwitchedOff(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://x", "LEARNING_TOKEN": strings.Repeat("t", 32), "LEARNING_HASH_KEY": strings.Repeat("ab", 32)}
	get := func(k string) string { return env[k] }
	c, err := loadConfig(get)
	if err != nil || c.enabled || c.retention != 730*24*time.Hour {
		t.Fatalf("config: %+v %v", c, err)
	}
	env["LEARNING_HASH_KEY"] = "short"
	if _, err = loadConfig(get); err == nil {
		t.Fatal("a short key must be refused")
	}
}

// The database test needs a disposable PostgreSQL: LEARNING_TEST_URL (an ordinary login on an empty database). Without it, it is skipped.
func TestTheStoreHoldsHashesAndShapesAndHonoursErasure(t *testing.T) {
	url := os.Getenv("LEARNING_TEST_URL")
	if url == "" {
		t.Skip("set LEARNING_TEST_URL to run the database test")
	}
	ctx := context.Background()
	st, err := openStore(ctx, url, hasher{key: bytes.Repeat([]byte{9}, 32)}, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer st.db.Close()
	if _, err = st.db.Exec(ctx, `TRUNCATE learning.leads, learning.workspaces, learning.mappings, learning.audit`); err != nil {
		t.Fatal(err)
	}
	s := &server{st: st, token: strings.Repeat("t", 32), enabled: true}
	ts := httptest.NewServer(s.handler())
	defer ts.Close()
	call := func(method, path string, body any, token string) (int, map[string]any) {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, ts.URL+path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out := map[string]any{}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	good := strings.Repeat("t", 32)
	org, job := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	batch := map[string]any{"org_id": org, "job_id": job, "mapping": []map[string]string{{"header": "Owner 1 First Name", "field": "name"}},
		"rows": []map[string]any{{"row_no": 1, "name": "Pat Quincy Zephyrin", "phone": "(512) 555-0100", "email": "Pat.Owner@Example.com", "address": "1234 Maple Street", "unit": "4B",
			"city": "Austin", "region": "TX", "zip": "78701-1234", "details": map[string]string{"bedrooms": "3", "owner_notes": "Pat is nice"}}}}

	if status, _ := call("POST", "/v1/ingest", batch, "wrong"); status != 401 {
		t.Fatalf("wrong token: %d", status)
	}
	if _, out := call("POST", "/v1/ingest", batch, good); out["stored"] != float64(1) {
		t.Fatalf("ingest: %v", out)
	}
	if _, out := call("POST", "/v1/ingest", batch, good); out["stored"] != float64(0) {
		t.Fatalf("a retry must store nothing more: %v", out)
	}

	// Law first: nothing a person could be recognised by is in the database, in any table.
	var dump, maps string
	if err = st.db.QueryRow(ctx, `SELECT coalesce(string_agg(l::text, ' '), '') FROM learning.leads l`).Scan(&dump); err != nil {
		t.Fatal(err)
	}
	_ = st.db.QueryRow(ctx, `SELECT coalesce(string_agg(m::text, ' '), '') FROM learning.mappings m`).Scan(&maps)
	dump += " " + maps
	for _, secret := range []string{"Pat", "Quincy", "Zephyrin", "5125550100", "555-0100", "example.com", "Maple", "nice"} {
		if strings.Contains(strings.ToLower(dump), strings.ToLower(secret)) {
			t.Fatalf("the store holds %q: %s", secret, dump)
		}
	}
	var shape, zip string
	if err = st.db.QueryRow(ctx, `SELECT name_shape, zip5 FROM learning.leads`).Scan(&shape, &zip); err != nil || shape != "person:3" || zip != "78701" {
		t.Fatalf("shape %q zip %q %v", shape, zip, err)
	}

	// Flags land on the lead found by its hashed phone, and only whitelisted flags.
	if _, out := call("POST", "/v1/outcomes", map[string]any{"org_id": org, "phone": "+1 512 555 0100", "flags": map[string]string{"stage": "Interested", "secret": "x"}}, good); out["updated"] != float64(1) {
		t.Fatalf("outcome: %v", out)
	}
	var flags string
	_ = st.db.QueryRow(ctx, `SELECT flags::text FROM learning.leads`).Scan(&flags)
	if !strings.Contains(flags, "Interested") || strings.Contains(flags, "secret") {
		t.Fatalf("flags: %s", flags)
	}

	// Erasing one person removes their rows.
	if _, out := call("POST", "/v1/erase-person", map[string]any{"org_id": org, "email": "pat.owner@example.com"}, good); out["erased"] != float64(1) {
		t.Fatalf("erase person: %v", out)
	}

	// Opting out removes the workspace's rows and nothing more is taken from it; opting back in allows it again.
	batch["rows"] = []map[string]any{{"row_no": 2, "phone": "5125550111"}}
	call("POST", "/v1/ingest", batch, good)
	if _, out := call("POST", "/v1/workspaces/"+org+"/opt-out", nil, good); out["erased"] != float64(1) {
		t.Fatalf("opt out: %v", out)
	}
	if _, out := call("POST", "/v1/ingest", batch, good); out["stored"] != float64(0) || out["skipped"] == nil {
		t.Fatalf("after opting out: %v", out)
	}
	call("POST", "/v1/workspaces/"+org+"/opt-in", nil, good)
	if _, out := call("POST", "/v1/ingest", batch, good); out["stored"] != float64(1) {
		t.Fatalf("after opting back in: %v", out)
	}

	// Rows are removed when their time is up, and every erasure or purge leaves a count in the audit table.
	if _, err = st.db.Exec(ctx, `UPDATE learning.leads SET expires_at = now() - interval '1 day'`); err != nil {
		t.Fatal(err)
	}
	if n, err := st.purge(ctx); err != nil || n != 1 {
		t.Fatalf("purge: %d %v", n, err)
	}
	var audits int
	_ = st.db.QueryRow(ctx, `SELECT count(*) FROM learning.audit`).Scan(&audits)
	if audits < 3 {
		t.Fatalf("audit rows: %d", audits)
	}

	// Switched off, it takes nothing in, but erasure still works.
	s.enabled = false
	if status, _ := call("POST", "/v1/ingest", batch, good); status != http.StatusServiceUnavailable {
		t.Fatalf("switched off: %d", status)
	}
	if status, _ := call("DELETE", "/v1/workspaces/"+org, nil, good); status != 200 {
		t.Fatalf("erase while off: %d", status)
	}
}
