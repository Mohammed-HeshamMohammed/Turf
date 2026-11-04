package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Source of truth: tools/auth-verify/token.go. Copied into each Go service that checks sign-in tokens by
// tools/auth-verify/sync.mjs; change it there, not in the copy.
//
// Caller Whale's access tokens are made by the auth service: EdDSA (Ed25519) JWTs whose public keys it publishes at
// /.well-known/jwks.json. A service checks the signature with those keys and the claims that say the token is
// Caller Whale's and still valid, locally, so a signed-in person keeps working while auth restarts. It never sees an
// identity provider: how the person proved who they are is the auth service's business. What the person may do (roles,
// organization, revocation) is the authorization service's to decide.

const (
	tokenIssuer   = "callerwhale-auth"
	tokenAudience = "callerwhale"
)

// claims is what an access token says about the person.
type claims struct {
	sub           string // the person's id, the same in every service
	email         string
	name          string
	sessionID     string // the session the token belongs to; revoking it stops new tokens
	secondFactor  bool   // the person confirmed an authenticator code (or a recovery code) when they signed in
	emailVerified bool   // absent in older tokens: false
	provider      string // how they signed in: password, google or apple; absent in older tokens: empty
	authTime      int64  // when they signed in (Unix seconds), the session's start; absent in older tokens: 0
}

type keyset struct {
	url    string
	client *http.Client

	mu      sync.Mutex
	keys    map[string]ed25519.PublicKey
	expires time.Time // when the keys should be fetched again
	tried   time.Time // the last fetch, successful or not
}

func newKeyset(url string) *keyset {
	return &keyset{url: url, client: &http.Client{Timeout: 10 * time.Second}, keys: map[string]ed25519.PublicKey{}}
}

var maxAge = regexp.MustCompile(`max-age=(\d+)`)

// key returns the public key for a key id, fetching the set when it is stale or when the id is new (the auth service
// rotates its key), at most once every 30 seconds.
func (k *keyset) key(kid string, now time.Time) (ed25519.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if key := k.keys[kid]; key != nil && now.Before(k.expires) {
		return key, nil
	}
	if now.Sub(k.tried) >= 30*time.Second {
		k.tried = now
		if err := k.fetch(now); err != nil && k.keys[kid] == nil {
			return nil, err
		}
	}
	if key := k.keys[kid]; key != nil {
		return key, nil
	}
	return nil, errors.New("unknown key")
}

func (k *keyset) fetch(now time.Time) error {
	res, err := k.client.Get(k.url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("key set answered " + strconv.Itoa(res.StatusCode))
	}
	var set struct {
		Keys []struct {
			Kty, Crv, Kid, X string
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&set); err != nil {
		return err
	}
	keys := map[string]ed25519.PublicKey{}
	for _, j := range set.Keys {
		if j.Kty != "OKP" || j.Crv != "Ed25519" {
			continue
		}
		x, err := base64.RawURLEncoding.DecodeString(j.X)
		if err != nil || len(x) != ed25519.PublicKeySize {
			continue
		}
		keys[j.Kid] = ed25519.PublicKey(x)
	}
	if len(keys) == 0 {
		return errors.New("key set had no usable keys")
	}
	ttl := 5 * time.Minute
	if m := maxAge.FindStringSubmatch(res.Header.Get("Cache-Control")); m != nil {
		if s, err := strconv.Atoi(m[1]); err == nil && s > 0 {
			ttl = time.Duration(s) * time.Second
		}
	}
	k.keys, k.expires = keys, now.Add(ttl)
	return nil
}

// verify checks a token (shape, key, signature, issuer, audience, time) and returns who it names.
func (k *keyset) verify(token string, now time.Time) (claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 8192 {
		return claims{}, errors.New("not a token")
	}
	var head struct{ Alg, Kid string }
	if err := decode(parts[0], &head); err != nil || head.Alg != "EdDSA" || head.Kid == "" {
		return claims{}, errors.New("bad header")
	}
	key, err := k.key(head.Kid, now)
	if err != nil {
		return claims{}, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), sig) {
		return claims{}, errors.New("bad signature")
	}
	var body struct {
		Iss           string `json:"iss"`
		Aud           string `json:"aud"`
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		Name          string `json:"name"`
		Sid           string `json:"sid"`
		Exp           int64  `json:"exp"`
		Iat           int64  `json:"iat"`
		Mfa           bool   `json:"mfa"`
		EmailVerified bool   `json:"email_verified"`
		Provider      string `json:"provider"`
		AuthTime      int64  `json:"auth_time"`
	}
	if err := decode(parts[1], &body); err != nil {
		return claims{}, errors.New("bad claims")
	}
	switch {
	case body.Iss != tokenIssuer || body.Aud != tokenAudience:
		return claims{}, errors.New("token is not Caller Whale's")
	case body.Sub == "" || len(body.Sub) > 128:
		return claims{}, errors.New("no subject")
	case now.Unix() >= body.Exp+30:
		return claims{}, errors.New("expired")
	case body.Iat > now.Unix()+60:
		return claims{}, errors.New("issued in the future")
	}
	return claims{sub: body.Sub, email: body.Email, name: body.Name, sessionID: body.Sid, secondFactor: body.Mfa,
		emailVerified: body.EmailVerified, provider: body.Provider, authTime: body.AuthTime}, nil
}

func decode(part string, into any) error {
	raw, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}
