package main

import (
	"strings"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestConfig(t *testing.T) {
	good := map[string]string{
		"SPICEDB_PRESHARED_KEY": "key",
		"AUTHZ_TOKENS":          "core-api=" + coreToken + ", billing=" + billingToken,
	}
	c, err := loadConfig(env(good))
	if err != nil {
		t.Fatal(err)
	}
	if c.port != "8104" || c.spicedbEndpoint != "spicedb:50051" || c.grantSeconds != 60 || !c.requireSecondStep || !c.staffSecondStep {
		t.Errorf("defaults: %+v", c)
	}
	if c.tokens[coreToken] != "core-api" || c.tokens[billingToken] != "billing" {
		t.Errorf("tokens: %v", c.tokens)
	}
	bad := []map[string]string{
		{"AUTHZ_TOKENS": "core-api=" + coreToken},
		{"SPICEDB_PRESHARED_KEY": "k"},
		{"SPICEDB_PRESHARED_KEY": "k", "AUTHZ_TOKENS": "stranger=" + coreToken},
		{"SPICEDB_PRESHARED_KEY": "k", "AUTHZ_TOKENS": "core-api=short"},
		{"SPICEDB_PRESHARED_KEY": "k", "AUTHZ_TOKENS": "core-api=" + coreToken + ",billing=" + coreToken},
		{"SPICEDB_PRESHARED_KEY": "k", "AUTHZ_TOKENS": "core-api=" + coreToken, "AUTHZ_GRANT_SECONDS": "9999"},
	}
	for i, values := range bad {
		if _, err := loadConfig(env(values)); err == nil {
			t.Errorf("case %d should be refused", i)
		}
	}
}

func TestSigningKeys(t *testing.T) {
	text, err := newSecretKey()
	if err != nil {
		t.Fatal(err)
	}
	k, err := keysFromBase64(text)
	if err != nil || !strings.Contains(string(k.jwks), k.kid) {
		t.Fatalf("a printed key reads back: %v", err)
	}
	if _, err := keysFromBase64("not base64!"); err == nil {
		t.Error("bad key accepted")
	}
}
