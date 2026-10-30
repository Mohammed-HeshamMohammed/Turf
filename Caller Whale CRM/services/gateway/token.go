package main

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Firebase ID tokens are RS256 JWTs. The gateway checks the signature with Google's published keys and the claims that
// say the token is for this project and still valid. Everything else (who the person is in Caller Whale, what they may
// do) is the core API's to decide.

type claims struct {
	sub          string
	secondFactor bool // the person confirmed an authenticator code at sign-in
}

type keyset struct {
	url    string
	client *http.Client

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	expires time.Time // when the keys should be fetched again
	tried   time.Time // the last fetch, successful or not
}

func newKeyset(url string) *keyset {
	return &keyset{url: url, client: &http.Client{Timeout: 10 * time.Second}, keys: map[string]*rsa.PublicKey{}}
}

var maxAge = regexp.MustCompile(`max-age=(\d+)`)

// key returns the public key for a key id, fetching the set when it is stale or when the id is new (Google rotates
// keys), at most once every 30 seconds.
func (k *keyset) key(kid string, now time.Time) (*rsa.PublicKey, error) {
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
			Kty, Kid, N, E string
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&set); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, j := range set.Keys {
		if j.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(j.N)
		e, err2 := base64.RawURLEncoding.DecodeString(j.E)
		if err1 != nil || err2 != nil || len(n) == 0 || len(e) == 0 || len(e) > 4 {
			continue
		}
		exp := 0
		for _, b := range e {
			exp = exp<<8 | int(b)
		}
		keys[j.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}
	}
	if len(keys) == 0 {
		return errors.New("key set had no usable keys")
	}
	ttl := time.Hour
	if m := maxAge.FindStringSubmatch(res.Header.Get("Cache-Control")); m != nil {
		if s, err := strconv.Atoi(m[1]); err == nil && s > 0 {
			ttl = time.Duration(s) * time.Second
		}
	}
	k.keys, k.expires = keys, now.Add(ttl)
	return nil
}

// verify checks a token for a Firebase project and returns who it names.
func (k *keyset) verify(token, project string, now time.Time) (claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 8192 {
		return claims{}, errors.New("not a token")
	}
	var head struct{ Alg, Kid string }
	if err := decode(parts[0], &head); err != nil || head.Alg != "RS256" || head.Kid == "" {
		return claims{}, errors.New("bad header")
	}
	key, err := k.key(head.Kid, now)
	if err != nil {
		return claims{}, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return claims{}, errors.New("bad signature")
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig) != nil {
		return claims{}, errors.New("bad signature")
	}
	var body struct {
		Iss      string `json:"iss"`
		Aud      string `json:"aud"`
		Sub      string `json:"sub"`
		Exp      int64  `json:"exp"`
		Iat      int64  `json:"iat"`
		AuthTime int64  `json:"auth_time"`
		Firebase struct {
			SecondFactor string `json:"sign_in_second_factor"`
		} `json:"firebase"`
	}
	if err := decode(parts[1], &body); err != nil {
		return claims{}, errors.New("bad claims")
	}
	switch {
	case body.Iss != "https://securetoken.google.com/"+project, body.Aud != project:
		return claims{}, errors.New("token is for another project")
	case body.Sub == "" || len(body.Sub) > 128:
		return claims{}, errors.New("no subject")
	case now.Unix() >= body.Exp:
		return claims{}, errors.New("expired")
	case body.Iat > now.Unix()+60 || body.AuthTime > now.Unix()+60:
		return claims{}, errors.New("issued in the future")
	}
	return claims{sub: body.Sub, secondFactor: body.Firebase.SecondFactor == "totp"}, nil
}

func decode(part string, into any) error {
	raw, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}
