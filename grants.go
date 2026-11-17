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
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// grantIssuer is who signs grants. The audience is the calling service, so a grant made for one service is refused by another.
const grantIssuer = "callerwhale-authz"

// grantClaims is what a signed grant says: who, where, which action, and the database rights and record scope to use.
type grantClaims struct {
	Org          string   `json:"org,omitempty"`
	Action       string   `json:"action"`
	DBRole       string   `json:"db_role"`
	Scopes       []string `json:"scopes,omitempty"`
	TeamIDs      []string `json:"team_ids,omitempty"`
	// TeamScopeIDs are the teams whose records the "team" scope shows: teams led or deputised, and their own teams only when a
	// role other than team lead gives the team scope. A caller who deputises another team sees that team, not all of their own.
	TeamScopeIDs []string `json:"team_scope_ids,omitempty"`
	ProjectIDs   []string `json:"project_ids,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	jwt.RegisteredClaims
}

type keys struct {
	kid  string
	priv ed25519.PrivateKey
	jwks []byte
}

// keysFromBase64 reads AUTHZ_SIGNING_KEY: base64 of an Ed25519 PKCS#8 key (what `new-key` prints) or of a 32-byte seed.
func keysFromBase64(text string) (*keys, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil {
		return nil, errors.New("AUTHZ_SIGNING_KEY is not base64")
	}
	if len(raw) == ed25519.SeedSize {
		return newKeys(ed25519.NewKeyFromSeed(raw)), nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(raw)
	priv, ok := parsed.(ed25519.PrivateKey)
	if err != nil || !ok {
		return nil, errors.New("AUTHZ_SIGNING_KEY is not an Ed25519 PKCS#8 key")
	}
	return newKeys(priv), nil
}

// generateKeys makes a key for this process only: grants it signs stop verifying when it ends.
func generateKeys() (*keys, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return newKeys(priv), nil
}

// newSecretKey is the base64 form of a new key, for AUTHZ_SIGNING_KEY.
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
	return &keys{kid: kid, priv: priv, jwks: jwks}
}

// sign makes a grant for one caller, lasting the given number of seconds.
func (k *keys) sign(caller, user, org, action string, d decision, now time.Time, seconds int) (string, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return "", err
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, grantClaims{
		Org: org, Action: action, DBRole: d.DBRole, Scopes: d.Scopes, TeamIDs: d.TeamIDs, TeamScopeIDs: d.TeamScopeIDs, ProjectIDs: d.ProjectIDs, Capabilities: d.Capabilities,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: grantIssuer, Audience: jwt.ClaimStrings{caller}, Subject: user, ID: hex.EncodeToString(id),
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(seconds) * time.Second)),
		},
	})
	token.Header["kid"] = k.kid
	return token.SignedString(k.priv)
}

// verify checks a grant the way a calling service must: signature, algorithm, issuer, audience and expiry.
func (k *keys) verify(grant, caller string, now time.Time) (grantClaims, error) {
	var c grantClaims
	_, err := jwt.ParseWithClaims(grant, &c, func(*jwt.Token) (any, error) { return k.priv.Public(), nil },
		jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithIssuer(grantIssuer), jwt.WithAudience(caller), jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }))
	return c, err
}
