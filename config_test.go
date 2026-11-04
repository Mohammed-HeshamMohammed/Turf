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
		"DATABASE_URL": "postgres://test:test@localhost/authz",
		"AUTHZ_TOKENS": "core-api=" + coreToken + ", billing=" + billingToken,
	}
	c, err := loadConfig(env(good))
	if err != nil {
		t.Fatal(err)
	}
	if c.port != "8104" || c.databaseURL != good["DATABASE_URL"] || c.grantSeconds != 60 || !c.requireSecondStep || !c.staffSecondStep {
		t.Errorf("defaults: %+v", c)
	}
	if c.tokens[coreToken] != "core-api" || c.tokens[billingToken] != "billing" {
		t.Errorf("tokens: %v", c.tokens)
	}
	withOwner := map[string]string{"DATABASE_URL": good["DATABASE_URL"], "AUTHZ_TOKENS": "core-api=" + coreToken, "AUTHZ_PLATFORM_OWNER": strings.ToUpper(ownerID)}
	if c, err := loadConfig(env(withOwner)); err != nil || c.platformOwner != ownerID {
		t.Errorf("the owner id is read in lowercase: %q %v", c.platformOwner, err)
	}
	bad := []map[string]string{
		{"DATABASE_URL": good["DATABASE_URL"], "AUTHZ_TOKENS": "core-api=" + coreToken, "AUTHZ_PLATFORM_OWNER": "not-an-id"},
		{"AUTHZ_TOKENS": "core-api=" + coreToken},
		{"DATABASE_URL": good["DATABASE_URL"]},
		{"DATABASE_URL": good["DATABASE_URL"], "AUTHZ_TOKENS": "stranger=" + coreToken},
		{"DATABASE_URL": good["DATABASE_URL"], "AUTHZ_TOKENS": "core-api=short"},
		{"DATABASE_URL": good["DATABASE_URL"], "AUTHZ_TOKENS": "core-api=" + coreToken + ",billing=" + coreToken},
		{"DATABASE_URL": good["DATABASE_URL"], "AUTHZ_TOKENS": "core-api=" + coreToken, "AUTHZ_GRANT_SECONDS": "9999"},
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
