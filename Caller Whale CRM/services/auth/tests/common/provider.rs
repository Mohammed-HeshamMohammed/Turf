//! A fake OpenID Connect provider, standing in for both Google and Apple in tests. Its token endpoint signs ID tokens
//! with the test RSA key and publishes the matching public key, like the real ones.
//!
//! The authorization code a test hands back is the claims themselves (base64url JSON), so a test decides what the
//! provider says: who the person is, whether their email is verified, which nonce, and whether to forge something.

use super::keys;
use axum::{extract::State, routing::get, routing::post, Form, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use std::collections::HashMap;

pub async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/jwks", get(jwks)).route("/token", post(token)).with_state(base.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

async fn jwks() -> Json<Value> {
    Json(json!({ "keys": [{ "kty": "RSA", "kid": "test-key", "alg": "RS256", "use": "sig", "n": keys::RSA_N, "e": keys::RSA_E }] }))
}

/// What a test puts in the authorization code.
pub fn code(claims: Value) -> String {
    URL_SAFE_NO_PAD.encode(claims.to_string())
}

async fn token(State(issuer): State<String>, Form(form): Form<HashMap<String, String>>) -> (axum::http::StatusCode, Json<Value>) {
    let refuse = |why: &str| (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": why })));
    let client = form.get("client_id").cloned().unwrap_or_default();
    let secret = form.get("client_secret").cloned().unwrap_or_default();
    // Each provider proves the client its own way: Google a shared secret, Apple a JWT signed with the team's key.
    let proven = match client.as_str() {
        "google-test-client" => secret == "google-test-secret" && form.get("code_verifier").is_some_and(|v| v.len() >= 43),
        "apple-test-client" => jsonwebtoken::decode_header(&secret).is_ok_and(|h| h.alg == Algorithm::ES256 && h.kid.as_deref() == Some("KEYTEST001")),
        _ => false,
    };
    if !proven || form.get("grant_type").map(String::as_str) != Some("authorization_code") {
        return refuse("invalid_client");
    }
    let Some(mut claims) = form.get("code").and_then(|c| URL_SAFE_NO_PAD.decode(c).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
        return refuse("invalid_grant");
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    for (key, value) in [("iss", json!(issuer)), ("aud", json!(client)), ("iat", json!(now)), ("exp", json!(now + 300))] {
        if claims.get(key).is_none() {
            claims[key] = value;
        }
    }
    let tamper = claims.as_object_mut().unwrap().remove("tamper").is_some();
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("test-key".into());
    let mut id_token = jsonwebtoken::encode(&header, &claims, &EncodingKey::from_rsa_pem(keys::RSA_PRIVATE_PEM.as_bytes()).unwrap()).unwrap();
    if tamper {
        // Same signature, different claims: what an attacker who edits a token gets.
        let parts: Vec<&str> = id_token.split('.').collect();
        claims["email"] = json!("attacker@example.com");
        id_token = format!("{}.{}.{}", parts[0], URL_SAFE_NO_PAD.encode(claims.to_string()), parts[2]);
    }
    (axum::http::StatusCode::OK, Json(json!({ "id_token": id_token, "token_type": "Bearer" })))
}
