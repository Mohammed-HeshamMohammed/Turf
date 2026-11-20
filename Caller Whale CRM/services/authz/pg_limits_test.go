package main

import (
	"context"
	"os"
	"testing"
)

// Step 35: the access limits table, against PostgreSQL.
func TestPostgresAccessLimits(t *testing.T) {
	url := os.Getenv("AUTHZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set AUTHZ_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	p, err := newPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	org := "aaaaaaaa-0000-4000-8000-00000000a035"
	if err := p.setAccessLimits(ctx, org, []string{"US"}, []string{"203.0.113.0/24"}); err != nil {
		t.Fatal(err)
	}
	c, n, err := p.accessLimits(ctx, org)
	if err != nil || len(c) != 1 || c[0] != "US" || n[0] != "203.0.113.0/24" {
		t.Fatalf("%v %v %v", c, n, err)
	}
	if c, n, err := p.accessLimits(ctx, "aaaaaaaa-0000-4000-8000-00000000b035"); err != nil || len(c) != 0 || len(n) != 0 {
		t.Fatalf("an agency with none: %v %v %v", c, n, err)
	}
}
