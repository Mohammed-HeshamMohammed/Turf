//! Shared test helpers. The service runs in-process, on an in-memory SQLite database by default; set
//! AUTH_TEST_DATABASE_URL to run the same tests on PostgreSQL (one at a time: --test-threads=1).

#![allow(dead_code)]

pub mod keys;
pub mod provider;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use turf_auth::{app, config::Config, connect, keys::Keys, migrate, AppState};

pub const PASSWORD: &str = "correct horse battery";

/// A fresh database: in memory, or the PostgreSQL test database emptied.
pub async fn database() -> sqlx::AnyPool {
    let url = std::env::var("AUTH_TEST_DATABASE_URL").unwrap_or_else(|_| "sqlite::memory:".into());
    let db = connect(&url).await.unwrap();
    migrate(&db).await.unwrap();
    migrate(&db).await.unwrap(); // running the migrations again is harmless
    for table in ["outbox", "failed_sign_ins", "recovery_codes", "oauth_handoffs", "oauth_states", "email_verifications", "user_identities", "sessions", "users"] {
        sqlx::query(&format!("DELETE FROM {table}")).execute(&db).await.unwrap();
    }
    db
}

pub async fn service_with(config: Config) -> Router {
    let db = database().await;
    app(AppState { db, keys: Arc::new(Keys::generate().unwrap()), config: Arc::new(config) })
}

pub async fn service() -> Router {
    service_with(Config::for_tests()).await
}

pub async fn call(app: &Router, method: &str, path: &str, body: Option<Value>, bearer: Option<&str>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(token) = bearer {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let req = match body {
        Some(b) => req.header("content-type", "application/json").body(Body::from(b.to_string())).unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// A request whose answer is a redirect: the status and where it sends the browser.
pub async fn follow(app: &Router, req: Request<Body>) -> (StatusCode, String) {
    let res = app.clone().oneshot(req).await.unwrap();
    let to = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    (res.status(), to)
}

pub fn get(path: &str) -> Request<Body> {
    Request::builder().method("GET").uri(path).body(Body::empty()).unwrap()
}

pub fn form_post(path: &str, pairs: &[(&str, &str)]) -> Request<Body> {
    let body = reqwest::Url::parse_with_params("http://x/", pairs).unwrap().query().unwrap_or_default().to_string();
    Request::builder().method("POST").uri(path).header("content-type", "application/x-www-form-urlencoded").body(Body::from(body)).unwrap()
}

pub fn param(url: &str, name: &str) -> Option<String> {
    reqwest::Url::parse(url).ok()?.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

pub async fn sign_up(app: &Router, email: &str) -> Value {
    let (status, body) = call(app, "POST", "/v1/accounts", Some(json!({ "email": email, "password": PASSWORD, "name": "Sami Lee" })), None).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

pub fn token(body: &Value) -> &str {
    body["access_token"].as_str().unwrap()
}

pub fn current_code(secret: &str, email: &str) -> String {
    let bytes = totp_rs::Secret::Encoded(secret.into()).to_bytes().unwrap();
    totp_rs::TOTP::new(totp_rs::Algorithm::SHA1, 6, 1, 30, bytes, Some("Caller Whale".into()), email.into()).unwrap().generate_current().unwrap()
}

/// The claims inside a token, checked with the service's own public keys, as any other service would.
pub async fn claims(app: &Router, access: &str) -> turf_auth_verify::Claims {
    let (_, jwks) = call(app, "GET", "/.well-known/jwks.json", None, None).await;
    turf_auth_verify::Verifier::from_jwks_json(&jwks.to_string()).unwrap().verify(access).unwrap()
}
