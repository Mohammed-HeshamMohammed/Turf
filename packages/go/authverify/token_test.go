package authverify_test

import (
	"callerwhale/authverify/authverifytest"
	"net/http"
	"testing"
	"time"
)

func TestVerifyAcceptsATokenFromAuthWithEveryClaim(t *testing.T) {
	f := authverifytest.NewFixture(t)
	body := f.JWKS("k1")
	keys := authverifytest.ServeKeys(t, &body, nil)
	got, err := keys.Verify(f.Sign("k1", "EdDSA", nil), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Sub != "u-1" || got.Email != "a@example.com" || got.Name != "A" || got.SessionID != "s-1" || !got.SecondFactor ||
		!got.EmailVerified || got.Provider != "password" || got.AuthTime == 0 {
		t.Fatalf("claims lost on the way: %+v", got)
	}
}

func TestVerifyReadsOlderTokensWithoutTheNewerClaims(t *testing.T) {
	f := authverifytest.NewFixture(t)
	body := f.JWKS("k1")
	keys := authverifytest.ServeKeys(t, &body, nil)
	token := f.Sign("k1", "EdDSA", func(c map[string]any) {
		delete(c, "email_verified")
		delete(c, "provider")
		delete(c, "auth_time")
	})
	got, err := keys.Verify(token, time.Now())
	if err != nil || got.EmailVerified || got.Provider != "" || got.AuthTime != 0 {
		t.Fatalf("older token: %+v, %v", got, err)
	}
}

func TestVerifyRefusesWhatIsNotCallerWhales(t *testing.T) {
	f := authverifytest.NewFixture(t)
	body := f.JWKS("k1")
	keys := authverifytest.ServeKeys(t, &body, nil)
	other := authverifytest.NewFixture(t)
	cases := map[string]string{
		"expired":            f.Sign("k1", "EdDSA", func(c map[string]any) { c["exp"] = time.Now().Unix() - 120 }),
		"future":             f.Sign("k1", "EdDSA", func(c map[string]any) { c["iat"] = time.Now().Unix() + 3600 }),
		"wrong issuer":       f.Sign("k1", "EdDSA", func(c map[string]any) { c["iss"] = "someone-else" }),
		"wrong audience":     f.Sign("k1", "EdDSA", func(c map[string]any) { c["aud"] = "other" }),
		"no subject":         f.Sign("k1", "EdDSA", func(c map[string]any) { delete(c, "sub") }),
		"another alg":        f.Sign("k1", "HS256", nil),
		"unknown key id":     f.Sign("k9", "EdDSA", nil),
		"someone else's key": other.Sign("k1", "EdDSA", nil),
		"not a token":        "abc",
	}
	for name, token := range cases {
		if _, err := keys.Verify(token, time.Now()); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestVerifyAcceptsASmallClockSkew(t *testing.T) {
	f := authverifytest.NewFixture(t)
	body := f.JWKS("k1")
	keys := authverifytest.ServeKeys(t, &body, nil)
	token := f.Sign("k1", "EdDSA", func(c map[string]any) { c["exp"] = time.Now().Unix() - 10 })
	if _, err := keys.Verify(token, time.Now()); err != nil {
		t.Fatalf("10 seconds past expiry is within the 30 seconds of leeway: %v", err)
	}
}

func TestVerifyFollowsAKeyRotation(t *testing.T) {
	old, next := authverifytest.NewFixture(t), authverifytest.NewFixture(t)
	body := old.JWKS("k1")
	keys := authverifytest.ServeKeys(t, &body, http.Header{"Cache-Control": {"max-age=3600"}})
	start := time.Now()
	if _, err := keys.Verify(old.Sign("k1", "EdDSA", nil), start); err != nil {
		t.Fatal(err)
	}
	body = next.JWKS("k2")
	// A new key id makes the service fetch the set again, but never more than once every 30 seconds.
	if _, err := keys.Verify(next.Sign("k2", "EdDSA", nil), start.Add(5*time.Second)); err == nil {
		t.Fatal("a second fetch within 30 seconds should not happen")
	}
	if _, err := keys.Verify(next.Sign("k2", "EdDSA", nil), start.Add(31*time.Second)); err != nil {
		t.Fatalf("the rotated key should be picked up: %v", err)
	}
}
