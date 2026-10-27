//! Signing in with the auth service (services/auth), the one source of truth for who someone is. The API checks
//! the token with auth's public keys and never calls auth. Runs against real PostgreSQL like the other end-to-end
//! tests, and skips itself without TEST_DATABASE_URL.

mod common;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use common::*;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::json;
use turf_auth_verify::{Claims, AUDIENCE, ISSUER};

struct AuthKey {
    pkcs8: Vec<u8>,
    jwks: String,
}

fn auth_key() -> AuthKey {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap().as_ref().to_vec();
    let public = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap().public_key().as_ref().to_vec();
    let jwks = json!({ "keys": [{ "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": "test", "x": URL_SAFE_NO_PAD.encode(public) }] });
    AuthKey { pkcs8, jwks: jwks.to_string() }
}

fn token(key: &AuthKey, sub: &str, email: &str, mfa: bool) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let claims = Claims { sub: sub.into(), email: email.into(), name: "From auth".into(), sid: "s-1".into(), mfa, iss: ISSUER.into(), aud: AUDIENCE.into(), iat: now, exp: now + 600 };
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some("test".into());
    encode(&header, &claims, &EncodingKey::from_ed_der(&key.pkcs8)).unwrap()
}

async fn get(base: &str, path: &str, bearer: &str, org: Option<&str>) -> (u16, serde_json::Value) {
    let mut req = reqwest::Client::new().get(format!("{base}{path}")).bearer_auth(bearer);
    if let Some(org) = org {
        req = req.header("x-turf-org", org);
    }
    let res = req.send().await.unwrap();
    (res.status().as_u16(), res.json().await.unwrap_or_default())
}

#[tokio::test]
async fn an_auth_token_opens_the_api_for_the_same_person() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;
    let caller = w.id("caller");
    let t = token(&key, &caller, "caller@example.com", false);

    // Without an organization the person is known, with no organization open.
    let (status, me) = get(&h.base, "/api/v1/me", &t, None).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["user"]["id"], caller.as_str());
    assert!(me["organization_id"].is_null());

    // With x-turf-org, their roles in that organization apply, exactly as with a session of this server.
    let (status, me) = get(&h.base, "/api/v1/me", &t, Some(&w.org)).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["organization_id"], w.org.as_str());
    assert_eq!(me["roles"], json!(["caller"]));
    assert_eq!(get(&h.base, "/api/v1/leads", &t, Some(&w.org)).await.0, 200);
}

#[tokio::test]
async fn auth_tokens_are_refused_when_they_should_be() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;

    // A person auth knows but this server does not.
    let stranger = token(&key, &uuid::Uuid::new_v4().to_string(), "stranger@example.com", false);
    assert_eq!(get(&h.base, "/api/v1/me", &stranger, None).await.0, 401);

    // A token signed by some other key.
    let other = auth_key();
    assert_eq!(get(&h.base, "/api/v1/me", &token(&other, &w.id("caller"), "caller@example.com", false), None).await.0, 401);

    // An organization the person is not in opens nothing.
    let t = token(&key, &w.id("caller"), "caller@example.com", false);
    let (status, me) = get(&h.base, "/api/v1/me", &t, Some(&uuid::Uuid::new_v4().to_string())).await;
    assert_eq!(status, 200);
    assert!(me["organization_id"].is_null());
    assert_eq!(get(&h.base, "/api/v1/me", &t, Some("not-an-id")).await.0, 400);
}

#[tokio::test]
async fn the_api_still_accepts_its_own_sessions_alongside_auth_tokens() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;
    assert_eq!(w.client("caller").get("/api/v1/me").await.status, 200);
}
