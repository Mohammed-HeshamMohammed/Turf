//! The auth service end to end, in-process. On SQLite by default; AUTH_TEST_DATABASE_URL runs it on PostgreSQL.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::json;
use turf_auth::{config::Config, keys::Keys};
use turf_auth_verify::Verifier;

#[tokio::test]
async fn health_and_version() {
    let app = service().await;
    assert_eq!(call(&app, "GET", "/healthz", None, None).await, (StatusCode::OK, json!({ "ok": true, "service": "auth" })));
    assert_eq!(call(&app, "GET", "/version", None, None).await.1["version"], "0.1.0");
}

#[tokio::test]
async fn a_new_account_gets_a_token_any_service_can_verify() {
    let app = service().await;
    let body = sign_up(&app, "Sami@Example.com").await;
    assert_eq!(body["user"]["email"], "sami@example.com");
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["expires_in"], 900);

    // Another service only has the public keys, and checks the token with them.
    let (status, jwks) = call(&app, "GET", "/.well-known/jwks.json", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let claims = Verifier::from_jwks_json(&jwks.to_string()).unwrap().verify(token(&body)).unwrap();
    assert_eq!(claims.sub, body["user"]["id"].as_str().unwrap());
    assert_eq!(claims.email, "sami@example.com");
    assert!(!claims.mfa);

    let (status, me) = call(&app, "GET", "/v1/me", None, Some(token(&body))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["name"], "Sami Lee");
    assert_eq!(me["mfa_enrolled"], false);
}

#[tokio::test]
async fn sign_up_is_checked() {
    let app = service().await;
    sign_up(&app, "sami@example.com").await;
    let (status, body) = call(&app, "POST", "/v1/accounts", Some(json!({ "email": "SAMI@example.com", "password": PASSWORD, "name": "Again" })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::CONFLICT, Some("conflict")));
    let (status, _) = call(&app, "POST", "/v1/accounts", Some(json!({ "email": "new@example.com", "password": "short", "name": "N" })), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&app, "POST", "/v1/accounts", Some(json!({ "email": "not-an-email", "password": PASSWORD, "name": "N" })), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn sign_in_and_the_five_failure_pause() {
    let app = service().await;
    sign_up(&app, "sami@example.com").await;
    let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "SAMI@example.com", "password": PASSWORD })), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["refresh_token"].as_str().unwrap().len() == 64);

    for _ in 0..5 {
        let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": "wrong password!!" })), None).await;
        assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("wrong_credentials")));
    }
    // Even the right password waits now.
    let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many_attempts")));
    // An unknown email reads the same as a wrong password.
    let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "nobody@example.com", "password": PASSWORD })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("wrong_credentials")));
}

#[tokio::test]
async fn refresh_tokens_change_on_every_use_and_a_reused_one_ends_the_session() {
    let app = service().await;
    let first = sign_up(&app, "sami@example.com").await;
    let old = first["refresh_token"].as_str().unwrap().to_string();

    let (status, second) = call(&app, "POST", "/v1/sessions/refresh", Some(json!({ "refresh_token": old })), None).await;
    assert_eq!(status, StatusCode::OK);
    let new = second["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(new, old);

    // The old one again: someone copied it. The whole session ends, including the new token.
    let (status, _) = call(&app, "POST", "/v1/sessions/refresh", Some(json!({ "refresh_token": old })), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "POST", "/v1/sessions/refresh", Some(json!({ "refresh_token": new })), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "GET", "/v1/me", None, Some(token(&second))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn signing_out_and_closing_other_sessions() {
    let app = service().await;
    let laptop = sign_up(&app, "sami@example.com").await;
    let (_, desktop) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD, "kind": "desktop" })), None).await;

    let (status, list) = call(&app, "GET", "/v1/sessions", None, Some(token(&laptop))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["sessions"].as_array().unwrap().len(), 2);

    let (status, body) = call(&app, "POST", "/v1/sessions/revoke", Some(json!({ "others": true })), Some(token(&laptop))).await;
    assert_eq!((status, body["closed"].as_u64()), (StatusCode::OK, Some(1)));
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&desktop))).await.0, StatusCode::UNAUTHORIZED);

    assert_eq!(call(&app, "POST", "/v1/sessions/sign-out", None, Some(token(&laptop))).await.0, StatusCode::OK);
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&laptop))).await.0, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "POST", "/v1/sessions/refresh", Some(json!({ "refresh_token": laptop["refresh_token"] })), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_bad_or_missing_token_is_refused() {
    let app = service().await;
    assert_eq!(call(&app, "GET", "/v1/me", None, None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&app, "GET", "/v1/me", None, Some("a.b.c")).await.0, StatusCode::UNAUTHORIZED);
    // A token from another auth service (another key) is refused.
    let other = service().await;
    let theirs = sign_up(&other, "other@example.com").await;
    sign_up(&app, "sami@example.com").await;
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&theirs))).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn two_step_sign_in_with_a_code_or_a_recovery_code() {
    let app = service().await;
    let account = sign_up(&app, "sami@example.com").await;
    let (status, setup) = call(&app, "POST", "/v1/mfa/setup", None, Some(token(&account))).await;
    assert_eq!(status, StatusCode::OK);
    let secret = setup["secret"].as_str().unwrap().to_string();
    assert!(setup["otpauth_url"].as_str().unwrap().starts_with("otpauth://totp/"));

    let (status, _) = call(&app, "POST", "/v1/mfa/confirm", Some(json!({ "code": "000000" })), Some(token(&account))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, confirmed) = call(&app, "POST", "/v1/mfa/confirm", Some(json!({ "code": current_code(&secret, "sami@example.com") })), Some(token(&account))).await;
    assert_eq!(status, StatusCode::OK);
    let recovery: Vec<String> = confirmed["recovery_codes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    assert_eq!(recovery.len(), 10);

    // A password alone is no longer enough.
    let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("mfa_required")));
    let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD, "code": "123456" })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("wrong_code")));

    let (status, signed) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD, "code": current_code(&secret, "sami@example.com") })), None).await;
    assert_eq!(status, StatusCode::OK, "{signed}");
    let (_, jwks) = call(&app, "GET", "/.well-known/jwks.json", None, None).await;
    assert!(Verifier::from_jwks_json(&jwks.to_string()).unwrap().verify(token(&signed)).unwrap().mfa);

    // A recovery code works once.
    let (status, _) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD, "code": recovery[0] })), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD, "code": recovery[0] })), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = call(&app, "POST", "/v1/mfa/setup", None, Some(token(&signed))).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn changing_the_password_closes_other_sessions() {
    let app = service().await;
    let here = sign_up(&app, "sami@example.com").await;
    let (_, there) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD })), None).await;

    let (status, _) = call(&app, "POST", "/v1/password", Some(json!({ "current": "wrong password!!", "new": "a brand new password" })), Some(token(&here))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "POST", "/v1/password", Some(json!({ "current": PASSWORD, "new": "a brand new password" })), Some(token(&here))).await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&here))).await.0, StatusCode::OK);
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&there))).await.0, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": "a brand new password" })), None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn sign_up_can_be_closed() {
    let app = service_with(Config { public_signup: false, ..Config::for_tests() }).await;
    let (status, _) = call(&app, "POST", "/v1/accounts", Some(json!({ "email": "a@example.com", "password": PASSWORD, "name": "A" })), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_signing_key_survives_a_restart() {
    let secret = Keys::new_secret().unwrap();
    let a = Keys::from_base64(&secret).unwrap();
    let b = Keys::from_base64(&secret).unwrap();
    assert_eq!(a.kid, b.kid);
    let person = turf_auth::keys::Person { id: "u".into(), email: "e@example.com".into(), name: "N".into(), email_verified: false };
    let (token, _) = a.sign(&person, "s", false, turf_auth::now(), 15).unwrap();
    assert!(b.verifier.verify(&token).is_ok());
    assert!(Keys::from_base64("not a key").is_err());
}
