//! Verifies Turf access tokens. The auth service is the one source of truth for who someone is: it signs short-lived
//! EdDSA (Ed25519) tokens and publishes its public keys at `/.well-known/jwks.json`. Every other service builds a
//! [`Verifier`] from those keys once and checks tokens locally, so a signed-in person keeps working while auth restarts.

use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Who issues Turf access tokens, and who they are for.
pub const ISSUER: &str = "turf-auth";
pub const AUDIENCE: &str = "turf";

/// What an access token says about the person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    /// The person's id. The same id in every service.
    pub sub: String,
    pub email: String,
    pub name: String,
    /// The session the token belongs to; revoking it stops new tokens.
    pub sid: String,
    /// They confirmed a two-step code (or a recovery code) when they signed in.
    pub mfa: bool,
    pub iss: String,
    pub aud: String,
    pub iat: u64,
    pub exp: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VerifyError {
    #[error("the token is not valid")]
    Invalid,
    #[error("the token has expired")]
    Expired,
    #[error("the token was signed with a key this service does not know")]
    UnknownKey,
    #[error("the public keys could not be read: {0}")]
    BadKeys(String),
}

/// Checks tokens against a set of public keys (several during a key rotation).
#[derive(Clone)]
pub struct Verifier {
    keys: HashMap<String, DecodingKey>,
    validation: Validation,
}

impl Verifier {
    /// From the JSON the auth service serves at `/.well-known/jwks.json`.
    pub fn from_jwks_json(json: &str) -> Result<Self, VerifyError> {
        let set: JwkSet = serde_json::from_str(json).map_err(|e| VerifyError::BadKeys(e.to_string()))?;
        let mut keys = HashMap::new();
        for jwk in &set.keys {
            let kid = jwk.common.key_id.clone().ok_or_else(|| VerifyError::BadKeys("a key has no kid".into()))?;
            let key = DecodingKey::from_jwk(jwk).map_err(|e| VerifyError::BadKeys(e.to_string()))?;
            keys.insert(kid, key);
        }
        if keys.is_empty() {
            return Err(VerifyError::BadKeys("no keys".into()));
        }
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[AUDIENCE]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = 30;
        Ok(Verifier { keys, validation })
    }

    /// The person behind a token, or why it is refused.
    pub fn verify(&self, token: &str) -> Result<Claims, VerifyError> {
        let header = decode_header(token).map_err(|_| VerifyError::Invalid)?;
        if header.alg != Algorithm::EdDSA {
            return Err(VerifyError::Invalid);
        }
        let key = header.kid.as_deref().and_then(|kid| self.keys.get(kid)).ok_or(VerifyError::UnknownKey)?;
        decode::<Claims>(token, key, &self.validation).map(|data| data.claims).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => VerifyError::Expired,
            _ => VerifyError::Invalid,
        })
    }
}

/// True for something shaped like a signed token (three dot-separated parts), as opposed to an opaque session token.
pub fn looks_like_jwt(token: &str) -> bool {
    token.split('.').count() == 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use ring::signature::{Ed25519KeyPair, KeyPair};

    struct Key {
        pkcs8: Vec<u8>,
        jwks: String,
    }

    fn key(kid: &str) -> Key {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap().as_ref().to_vec();
        let public = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap().public_key().as_ref().to_vec();
        let jwks = serde_json::json!({ "keys": [{ "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": kid, "x": URL_SAFE_NO_PAD.encode(public) }] });
        Key { pkcs8, jwks: jwks.to_string() }
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    }

    fn claims(exp: u64) -> Claims {
        Claims { sub: "u-1".into(), email: "a@example.com".into(), name: "A".into(), sid: "s-1".into(), mfa: true, iss: ISSUER.into(), aud: AUDIENCE.into(), iat: now(), exp }
    }

    fn sign(key: &Key, kid: &str, claims: &Claims) -> String {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(kid.into());
        encode(&header, claims, &EncodingKey::from_ed_der(&key.pkcs8)).unwrap()
    }

    #[test]
    fn a_token_signed_by_auth_is_accepted() {
        let k = key("k1");
        let c = claims(now() + 600);
        assert_eq!(Verifier::from_jwks_json(&k.jwks).unwrap().verify(&sign(&k, "k1", &c)).unwrap(), c);
    }

    #[test]
    fn an_expired_token_is_refused() {
        let k = key("k1");
        let token = sign(&k, "k1", &claims(now() - 120));
        assert_eq!(Verifier::from_jwks_json(&k.jwks).unwrap().verify(&token), Err(VerifyError::Expired));
    }

    #[test]
    fn a_token_from_another_key_is_refused() {
        let ours = key("k1");
        let theirs = key("k1");
        let token = sign(&theirs, "k1", &claims(now() + 600));
        assert_eq!(Verifier::from_jwks_json(&ours.jwks).unwrap().verify(&token), Err(VerifyError::Invalid));
        let unknown = sign(&ours, "k2", &claims(now() + 600));
        assert_eq!(Verifier::from_jwks_json(&ours.jwks).unwrap().verify(&unknown), Err(VerifyError::UnknownKey));
    }

    #[test]
    fn the_wrong_issuer_or_audience_is_refused() {
        let k = key("k1");
        let v = Verifier::from_jwks_json(&k.jwks).unwrap();
        let mut c = claims(now() + 600);
        c.iss = "someone-else".into();
        assert_eq!(v.verify(&sign(&k, "k1", &c)), Err(VerifyError::Invalid));
        let mut c = claims(now() + 600);
        c.aud = "another-app".into();
        assert_eq!(v.verify(&sign(&k, "k1", &c)), Err(VerifyError::Invalid));
    }

    #[test]
    fn a_tampered_token_is_refused() {
        let k = key("k1");
        let token = sign(&k, "k1", &claims(now() + 600));
        let mut parts: Vec<String> = token.split('.').map(String::from).collect();
        let forged = serde_json::to_vec(&Claims { sub: "admin".into(), ..claims(now() + 600) }).unwrap();
        parts[1] = URL_SAFE_NO_PAD.encode(forged);
        assert_eq!(Verifier::from_jwks_json(&k.jwks).unwrap().verify(&parts.join(".")), Err(VerifyError::Invalid));
    }

    #[test]
    fn opaque_sessions_and_tokens_are_told_apart() {
        assert!(looks_like_jwt("a.b.c"));
        assert!(!looks_like_jwt("0123456789abcdef"));
        assert!(Verifier::from_jwks_json(r#"{"keys":[]}"#).is_err());
    }
}
