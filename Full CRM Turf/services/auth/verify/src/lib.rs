//! Verifies Turf access tokens. The auth service is the one source of truth for who someone is: it signs short-lived
//! EdDSA (Ed25519) tokens and publishes its public keys at `/.well-known/jwks.json`. Every other service builds a
//! [`Verifier`] from those keys once and checks tokens locally, so a signed-in person keeps working while auth restarts.
//! [`FirebaseVerifier`] checks Firebase Authentication's ID tokens the same way, while sign-in moves there
//! (docs/plans/firebase-auth.md).

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
    /// They confirmed their email address (a link, or Google or Apple vouching for it). Absent in older tokens: false.
    #[serde(default)]
    pub email_verified: bool,
    /// How they signed in: "password", "google" or "apple". Absent in older tokens: empty.
    #[serde(default)]
    pub provider: String,
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
        let keys = read_keys(json)?;
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

/// Where Firebase publishes the public keys its ID tokens are signed with. Google rotates them every few hours, so a
/// service fetches them again while it runs (see the core API's key refresher), not only at start.
pub const FIREBASE_JWKS_URL: &str = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/// The issuer of a Firebase project's ID tokens.
pub fn firebase_issuer(project_id: &str) -> String {
    format!("https://securetoken.google.com/{project_id}")
}

/// True for claims that came from Firebase: `sub` is then a Firebase uid, not a Turf user id.
pub fn is_firebase(claims: &Claims) -> bool {
    claims.iss.starts_with("https://securetoken.google.com/")
}

/// A Firebase ID token's own shape, before it is read as [`Claims`].
#[derive(Deserialize)]
struct FirebaseToken {
    sub: String,
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    name: Option<String>,
    auth_time: u64,
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
    firebase: FirebaseDetail,
}

/// Firebase's `sign_in_provider` in Turf's words: "google.com" is "google", "password" stays.
pub fn provider_name(firebase: &str) -> String {
    firebase.strip_suffix(".com").unwrap_or(firebase).to_string()
}

#[derive(Deserialize)]
struct FirebaseDetail {
    #[serde(default)]
    sign_in_provider: String,
    /// Set when the person confirmed a second factor at sign-in: "totp" for an authenticator code.
    sign_in_second_factor: Option<String>,
}

/// Checks Firebase ID tokens for one project.
#[derive(Clone)]
pub struct FirebaseVerifier {
    keys: HashMap<String, DecodingKey>,
    validation: Validation,
}

impl FirebaseVerifier {
    /// From the key set at [`FIREBASE_JWKS_URL`] (RS256 keys).
    pub fn from_jwks_json(project_id: &str, json: &str) -> Result<Self, VerifyError> {
        if project_id.trim().is_empty() {
            return Err(VerifyError::BadKeys("no Firebase project id".into()));
        }
        let keys = read_keys(json)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[firebase_issuer(project_id)]);
        validation.set_audience(&[project_id]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = 30;
        Ok(FirebaseVerifier { keys, validation })
    }

    /// The person behind a Firebase ID token, in the same [`Claims`] a Turf token gives. Firebase has no session id, so
    /// `sid` is the uid and the moment they signed in. `mfa` is true only for an authenticator code. A token without an
    /// email, or claiming a sign-in in the future, is refused.
    pub fn verify(&self, token: &str) -> Result<Claims, VerifyError> {
        let header = decode_header(token).map_err(|_| VerifyError::Invalid)?;
        if header.alg != Algorithm::RS256 {
            return Err(VerifyError::Invalid);
        }
        let key = header.kid.as_deref().and_then(|kid| self.keys.get(kid)).ok_or(VerifyError::UnknownKey)?;
        let t = decode::<FirebaseToken>(token, key, &self.validation).map(|data| data.claims).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => VerifyError::Expired,
            _ => VerifyError::Invalid,
        })?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let email = t.email.filter(|e| !e.trim().is_empty()).ok_or(VerifyError::Invalid)?;
        if t.sub.is_empty() || t.sub.len() > 128 || t.auth_time > now + self.validation.leeway {
            return Err(VerifyError::Invalid);
        }
        let name = t.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| email.split('@').next().unwrap_or_default().to_string());
        Ok(Claims {
            sid: format!("firebase:{}:{}", t.sub, t.auth_time),
            sub: t.sub,
            email,
            name,
            mfa: t.firebase.sign_in_second_factor.as_deref() == Some("totp"),
            provider: provider_name(&t.firebase.sign_in_provider),
            email_verified: t.email_verified,
            iss: t.iss,
            aud: t.aud,
            iat: t.iat,
            exp: t.exp,
        })
    }
}

fn read_keys(json: &str) -> Result<HashMap<String, DecodingKey>, VerifyError> {
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
    Ok(keys)
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
        Claims { sub: "u-1".into(), email: "a@example.com".into(), name: "A".into(), sid: "s-1".into(), mfa: true, email_verified: true, provider: "password".into(), iss: ISSUER.into(), aud: AUDIENCE.into(), iat: now(), exp }
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

    const FIREBASE_PEM: &str = include_str!("../testdata/firebase-test-key.pem");
    const FIREBASE_JWKS: &str = include_str!("../testdata/firebase-test-jwks.json");

    fn firebase_token(claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("firebase-test".into());
        encode(&header, &claims, &EncodingKey::from_rsa_pem(FIREBASE_PEM.as_bytes()).unwrap()).unwrap()
    }

    fn firebase_claims() -> serde_json::Value {
        serde_json::json!({
            "iss": "https://securetoken.google.com/turf-dev", "aud": "turf-dev", "sub": "fbUid123", "email": "a@example.com",
            "email_verified": true, "auth_time": now() - 5, "iat": now() - 5, "exp": now() + 3600,
            "firebase": { "sign_in_provider": "password", "sign_in_second_factor": "totp" }
        })
    }

    #[test]
    fn a_firebase_token_reads_as_turf_claims() {
        let v = FirebaseVerifier::from_jwks_json("turf-dev", FIREBASE_JWKS).unwrap();
        let c = v.verify(&firebase_token(firebase_claims())).unwrap();
        assert_eq!((c.sub.as_str(), c.email.as_str(), c.name.as_str(), c.mfa, c.email_verified, c.provider.as_str()), ("fbUid123", "a@example.com", "a", true, true, "password"));
        assert!(is_firebase(&c));
        assert!(!is_firebase(&claims(now() + 600)));
        // Only an authenticator code counts as the second step.
        let mut sms = firebase_claims();
        sms["firebase"]["sign_in_second_factor"] = "phone".into();
        assert!(!v.verify(&firebase_token(sms)).unwrap().mfa);
        let mut none = firebase_claims();
        none["firebase"] = serde_json::json!({ "sign_in_provider": "google.com" });
        none["name"] = "Ann".into();
        let c = v.verify(&firebase_token(none)).unwrap();
        assert_eq!((c.mfa, c.name.as_str(), c.provider.as_str()), (false, "Ann", "google"));
        assert_eq!(provider_name("apple.com"), "apple");
    }

    #[test]
    fn a_firebase_token_for_another_project_or_unfit_is_refused() {
        let v = FirebaseVerifier::from_jwks_json("turf-dev", FIREBASE_JWKS).unwrap();
        for (field, value) in [
            ("aud", serde_json::json!("turf-prod")),
            ("iss", serde_json::json!("https://securetoken.google.com/turf-prod")),
            ("email", serde_json::Value::Null),
            ("sub", serde_json::json!("")),
            ("auth_time", serde_json::json!(now() + 3600)),
        ] {
            let mut c = firebase_claims();
            c[field] = value;
            assert_eq!(v.verify(&firebase_token(c)), Err(VerifyError::Invalid), "{field}");
        }
        let mut old = firebase_claims();
        old["exp"] = (now() - 120).into();
        assert_eq!(v.verify(&firebase_token(old)), Err(VerifyError::Expired));
        // A Turf token is not a Firebase token, and the other way round.
        let k = key("k1");
        assert_eq!(v.verify(&sign(&k, "k1", &claims(now() + 600))), Err(VerifyError::Invalid));
        assert_eq!(Verifier::from_jwks_json(&k.jwks).unwrap().verify(&firebase_token(firebase_claims())), Err(VerifyError::Invalid));
        assert!(FirebaseVerifier::from_jwks_json("", FIREBASE_JWKS).is_err());
    }

    #[test]
    fn opaque_sessions_and_tokens_are_told_apart() {
        assert!(looks_like_jwt("a.b.c"));
        assert!(!looks_like_jwt("0123456789abcdef"));
        assert!(Verifier::from_jwks_json(r#"{"keys":[]}"#).is_err());
    }
}
