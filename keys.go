package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The access token's contract with every other service (tools/auth-verify, the gateway and every service that checks it): EdDSA (Ed25519), issuer and audience
// below, the claims below, and a key id that is the first 8 bytes of the SHA-256 of the public key.
const (
	tokenIssuer   = "callerwhale-auth"
	tokenAudience = "callerwhale"
)

// claims is what an access token says about the person. Field names are fixed by the token contract.
type claims struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	Tag           string `json:"tag,omitempty"` // the #tag after the name (step 4)
	SID           string `json:"sid"`
	MFA           bool   `json:"mfa"`
	EmailVerified bool   `json:"email_verified"`
	Provider      string `json:"provider"`
	AuthTime      int64  `json:"auth_time"`
	Iss           string `json:"iss"`
	Aud           string `json:"aud"`
	Iat           int64  `json:"iat"`
	Exp           int64  `json:"exp"`
}

// jwt.Claims, so the library checks expiry, issuer and audience for us.
func (c claims) GetExpirationTime() (*jwt.NumericDate, error) {
	return jwt.NewNumericDate(time.Unix(c.Exp, 0)), nil
}
func (c claims) GetIssuedAt() (*jwt.NumericDate, error) {
	return jwt.NewNumericDate(time.Unix(c.Iat, 0)), nil
}
func (c claims) GetNotBefore() (*jwt.NumericDate, error) { return nil, nil }
func (c claims) GetIssuer() (string, error)              { return c.Iss, nil }
func (c claims) GetSubject() (string, error)             { return c.Sub, nil }
func (c claims) GetAudience() (jwt.ClaimStrings, error)  { return jwt.ClaimStrings{c.Aud}, nil }

// person is what a token says about who it is for.
type person struct {
	id, email, name, tag string
	emailVerified   bool
}

type keys struct {
	kid  string
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
	jwks []byte // what /.well-known/jwks.json serves
}

// keysFromBase64 reads AUTH_SIGNING_KEY: base64 of an Ed25519 PKCS#8 key (what `new-key` prints), or of a plain random 32-byte
// secret, which anyone can make with a shell and which is turned into the same kind of key.
func keysFromBase64(text string) (*keys, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil {
		return nil, errors.New("AUTH_SIGNING_KEY is not base64")
	}
	if len(raw) == ed25519.SeedSize {
		return newKeys(ed25519.NewKeyFromSeed(raw)), nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(raw)
	priv, ok := parsed.(ed25519.PrivateKey)
	if err != nil || !ok {
		return nil, errors.New("AUTH_SIGNING_KEY is not an Ed25519 PKCS#8 key")
	}
	return newKeys(priv), nil
}

// generateKeys makes a key for this process only: tokens stop working when it ends.
func generateKeys() (*keys, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return newKeys(priv), nil
}

// newSecretKey is the base64 form of a new key, for AUTH_SIGNING_KEY.
func newSecretKey() (string, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

func newKeys(priv ed25519.PrivateKey) *keys {
	pub := priv.Public().(ed25519.PublicKey)
	sum := sha256.Sum256(pub)
	kid := hex.EncodeToString(sum[:8])
	jwks, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": kid, "x": base64.RawURLEncoding.EncodeToString(pub),
	}}})
	return &keys{kid: kid, priv: priv, pub: pub, jwks: jwks}
}

// sign makes an access token for a person and their session, and says how many seconds it lasts.
func (k *keys) sign(p person, sid string, mfa bool, provider string, authTime, now int64, minutes int) (string, int64, error) {
	lifetime := int64(minutes) * 60
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims{
		Sub: p.id, Email: p.email, Name: p.name, Tag: p.tag, SID: sid, MFA: mfa, EmailVerified: p.emailVerified, Provider: provider,
		AuthTime: authTime, Iss: tokenIssuer, Aud: tokenAudience, Iat: now, Exp: now + lifetime,
	})
	token.Header["kid"] = k.kid
	signed, err := token.SignedString(k.priv)
	return signed, lifetime, err
}

var errBadToken = errors.New("the token is not valid")

// verify checks a token's signature, key id, algorithm, issuer, audience and expiry.
func (k *keys) verify(token string, now time.Time) (claims, error) {
	var c claims
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithIssuer(tokenIssuer),
		jwt.WithAudience(tokenAudience),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	_, err := parser.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		if kid, _ := t.Header["kid"].(string); kid != k.kid {
			return nil, fmt.Errorf("unknown key")
		}
		return k.pub, nil
	})
	if err != nil {
		return claims{}, errBadToken
	}
	return c, nil
}
