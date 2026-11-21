package main

import (
	"context"
	"testing"
)

// A property saved before 0050 has no stored address key; the background fill works it out ('' for an address without one), and a new
// or changed address gets its key from the trigger.
func TestPropertyAddressKeysAreFilledAndKept(t *testing.T) {
	e := newEnv(t)
	e.seed()
	ctx := context.Background()
	e.call(alice, orgA, "GET", "/sync/snapshot?limit=1", nil)
	var keyed, keyless string
	if err := e.admin.QueryRow(ctx, `INSERT INTO crm.properties (org_id, address, postal_code) VALUES ($1, '12 Oak St', '78701-1234') RETURNING id::text`, orgA).Scan(&keyed); err != nil {
		t.Fatal(err)
	}
	if err := e.admin.QueryRow(ctx, `INSERT INTO crm.properties (org_id, address, postal_code) VALUES ($1, 'Oak Street', '') RETURNING id::text`, orgA).Scan(&keyless); err != nil {
		t.Fatal(err)
	}
	var key string
	if err := e.admin.QueryRow(ctx, `SELECT addr_key FROM crm.properties WHERE id = $1`, keyed).Scan(&key); err != nil || key == "" {
		t.Fatalf("the trigger left no key on a new address: %q %v", key, err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE crm.properties SET addr_key = NULL WHERE org_id = $1`, orgA); err != nil { // as before 0050
		t.Fatal(err)
	}
	filled, err := e.s.fillAddressKeys(ctx)
	if err != nil || filled != 2 {
		t.Fatalf("filled %d keys: %v", filled, err)
	}
	var want, got, none string
	_ = e.admin.QueryRow(ctx, `SELECT importing.addr_key(address, postal_code), addr_key FROM crm.properties WHERE id = $1`, keyed).Scan(&want, &got)
	_ = e.admin.QueryRow(ctx, `SELECT addr_key FROM crm.properties WHERE id = $1`, keyless).Scan(&none)
	if got != want || none != "" {
		t.Fatalf("filled keys: %q (want %q), keyless %q", got, want, none)
	}
	if again, err := e.s.fillAddressKeys(ctx); err != nil || again != 0 {
		t.Fatalf("a second fill found %d: %v", again, err)
	}
	if _, err := e.admin.Exec(ctx, `UPDATE crm.properties SET address = '14 Oak St' WHERE id = $1`, keyed); err != nil {
		t.Fatal(err)
	}
	_ = e.admin.QueryRow(ctx, `SELECT importing.addr_key(address, postal_code), addr_key FROM crm.properties WHERE id = $1`, keyed).Scan(&want, &got)
	if got != want {
		t.Fatalf("a changed address kept its old key: %q, want %q", got, want)
	}
}
