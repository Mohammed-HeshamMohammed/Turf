//! The auth service with Firebase as its account store, against a fake Firebase (tests/common/firebase.rs). What it
//! checks: people sign up, sign in, confirm email, change password and use an authenticator through this service only;
//! every token comes from this service; Firebase's tokens never reach a client.

mod common;

use axum::{http::StatusCode, Router};
use common::{firebase::{self, Fake}, *};
use serde_json::{json, Value};
use callerwhale_auth::config::{Config, Provider};

async fn with_firebase() -> (Router, Fake) {
    let fake = firebase::start().await;
    let config = Config {
        firebase: Some(callerwhale_auth::firebase::Firebase::new("test-key", &fake.base, &fake.base)),
        ..Config::for_tests()
    };
    (service_with(config).await, fake)
}

async fn sign_in(app: &Router, email: &str, code: Option<&str>) -> (StatusCode, Value) {
    let mut body = json!({ "email": email, "password": PASSWORD });
    if let Some(code) = code {
        body["code"] = json!(code);
    }
    call(app, "POST", "/v1/sessions", Some(body), None).await
}

#[tokio::test]
async fn sign_up_makes_the_account_in_firebase_and_hands_out_this_services_tokens() {
    let (app, fake) = with_firebase().await;
    let body = sign_up(&app, "Sami@Example.com").await;
    assert_eq!(body["user"]["email"], "sami@example.com");
    // The token is this service's (EdDSA, checked with its keys), not Firebase's, and the refresh token is its own.
    let c = claims(&app, token(&body)).await;
    assert_eq!(c.email, "sami@example.com");
    assert!(!c.mfa && c.auth_time > 0);
    assert!(!token(&body).starts_with("id-"), "a Firebase token reached the client");
    assert!(!body["refresh_token"].as_str().unwrap().starts_with("rt-"));
    assert!(uuid::Uuid::parse_str(body["user"]["id"].as_str().unwrap()).is_ok(), "the person's id is a UUID, not Firebase's uid");
    let w = fake.world.lock().unwrap();
    assert!(w.has_account("sami@example.com"));
    assert_eq!(w.sent_verifications, ["sami@example.com"], "Firebase sends the confirmation email");
    // No password was kept here.
    drop(w);
    let (_, me) = call(&app, "GET", "/v1/me", None, Some(token(&body))).await;
    assert_eq!(me["name"], "Sami Lee");
    assert_eq!(me["email_verified"], false);
}

#[tokio::test]
async fn a_short_password_never_reaches_firebase_and_a_taken_address_is_a_conflict() {
    let (app, fake) = with_firebase().await;
    let (status, _) = call(&app, "POST", "/v1/accounts", Some(json!({ "email": "a@example.com", "password": "short", "name": "A" })), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(fake.world.lock().unwrap().asked("signUp"), 0);
    sign_up(&app, "a@example.com").await;
    let (status, body) = call(&app, "POST", "/v1/accounts", Some(json!({ "email": "a@example.com", "password": PASSWORD, "name": "A" })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::CONFLICT, Some("conflict")));
}

#[tokio::test]
async fn signing_in_checks_firebase_and_wrong_passwords_are_counted() {
    let (app, _) = with_firebase().await;
    sign_up(&app, "sami@example.com").await;
    let (status, body) = sign_in(&app, "sami@example.com", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(claims(&app, token(&body)).await.sub, claims(&app, token(&sign_up_again(&app).await)).await.sub);

    for _ in 0..5 {
        let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": "wrong password!" })), None).await;
        assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("wrong_credentials")));
    }
    // The pause after five failures is this service's, so Firebase is not hammered.
    assert_eq!(sign_in(&app, "sami@example.com", None).await.0, StatusCode::TOO_MANY_REQUESTS);
}

async fn sign_up_again(app: &Router) -> Value {
    // Signing in again as the same person: same id.
    call(app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD })), None).await.1
}

#[tokio::test]
async fn an_authenticator_is_set_up_and_used_through_firebase() {
    let (app, fake) = with_firebase().await;
    let made = sign_up(&app, "sami@example.com").await;

    let (status, setup) = call(&app, "POST", "/v1/mfa/setup", None, Some(token(&made))).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    assert_eq!(setup["secret"], "JBSWY3DPEHPK3PXP");
    assert!(setup["otpauth_url"].as_str().unwrap().starts_with("otpauth://totp/Caller%20Whale:sami%40example.com"));

    assert_eq!(call(&app, "POST", "/v1/mfa/confirm", Some(json!({ "code": "000000" })), Some(token(&made))).await.0, StatusCode::UNAUTHORIZED);
    let (status, done) = call(&app, "POST", "/v1/mfa/confirm", Some(json!({ "code": firebase::GOOD_CODE })), Some(token(&made))).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["recovery_codes"], json!([]), "Firebase has no recovery codes");
    assert!(fake.world.lock().unwrap().has_mfa("sami@example.com"));

    // Signing in now asks for the code, and the token says it was given.
    let (status, body) = sign_in(&app, "sami@example.com", None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("mfa_required")));
    let (status, body) = sign_in(&app, "sami@example.com", Some("111111")).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("wrong_code")));
    let (status, body) = sign_in(&app, "sami@example.com", Some(firebase::GOOD_CODE)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(claims(&app, token(&body)).await.mfa);
    let (_, me) = call(&app, "GET", "/v1/me", None, Some(token(&body))).await;
    assert_eq!(me["mfa_enrolled"], true);
}

#[tokio::test]
async fn the_password_changes_in_firebase_and_other_sessions_end() {
    let (app, fake) = with_firebase().await;
    let first = sign_up(&app, "sami@example.com").await;
    let second = sign_up_again(&app).await;
    let (status, _) = call(&app, "POST", "/v1/password", Some(json!({ "current": "not the password", "new": "a brand new password" })), Some(token(&second))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = call(&app, "POST", "/v1/password", Some(json!({ "current": PASSWORD, "new": "a brand new password" })), Some(token(&second))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(fake.world.lock().unwrap().password_of("sami@example.com").as_deref(), Some("a brand new password"));
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&first))).await.0, StatusCode::UNAUTHORIZED, "the other session is closed");
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&second))).await.0, StatusCode::OK);
}

#[tokio::test]
async fn email_is_confirmed_with_the_link_firebase_sent() {
    let (app, fake) = with_firebase().await;
    let made = sign_up(&app, "sami@example.com").await;
    // A link that is not Firebase's is refused.
    let (status, _) = call(&app, "POST", "/v1/email/verify", Some(json!({ "token": "nonsense" })), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = call(&app, "POST", "/v1/email/verify", Some(json!({ "token": "confirm-sami@example.com" })), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(fake.world.lock().unwrap().verified("sami@example.com"));
    let (_, me) = call(&app, "GET", "/v1/me", None, Some(token(&made))).await;
    assert_eq!(me["email_verified"], true);
    // Asking again for a link sends one through Firebase, until confirmed.
    let other = sign_up(&app, "lee@example.com").await;
    let before = fake.world.lock().unwrap().sent_verifications.len();
    let (status, _) = call(&app, "POST", "/v1/email/resend", None, Some(token(&other))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fake.world.lock().unwrap().sent_verifications.len(), before + 1);
}

fn google_providers(base: &str) -> Provider {
    Provider { client_id: "google-test-client".into(), client_secret: "google-test-secret".into(), auth_url: format!("{base}/authorize"), token_url: format!("{base}/token"), jwks_url: format!("{base}/jwks"), issuer: base.into(), ..Default::default() }
}

async fn google_app() -> (Router, Fake) {
    let fake = firebase::start().await;
    let base = provider::start().await;
    let config = Config {
        firebase: Some(callerwhale_auth::firebase::Firebase::new("test-key", &fake.base, &fake.base)),
        google: google_providers(&base),
        ..Config::for_tests()
    };
    (service_with(config).await, fake)
}

async fn google(app: &Router) -> (StatusCode, Value) {
    let (status, to) = follow(app, get("/v1/oauth/google/start?target=app")).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let (state, nonce) = (param(&to, "state").unwrap(), param(&to, "nonce").unwrap());
    let claims = json!({ "sub": "g-100", "email": "Mona@Example.com", "email_verified": true, "name": "Mona Adel", "nonce": nonce });
    let (_, back) = follow(app, get(&format!("/v1/oauth/google/callback?code={}&state={state}", provider::code(claims)))).await;
    let code = param(&back, "callerwhale_code").unwrap_or_else(|| panic!("no code in {back}"));
    call(app, "POST", "/v1/oauth/exchange", Some(json!({ "code": code })), None).await
}

#[tokio::test]
async fn google_goes_through_firebase_and_comes_back_as_this_services_session() {
    let (app, fake) = google_app().await;
    let (status, body) = google(&app).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(claims(&app, token(&body)).await.provider, "google");
    assert_eq!(fake.world.lock().unwrap().asked("signInWithIdp"), 1);
    assert!(fake.world.lock().unwrap().has_account("mona@example.com"));
    // The same person again: the same account.
    let (_, again) = google(&app).await;
    assert_eq!(body["user"]["id"], again["user"]["id"]);
}

#[tokio::test]
async fn a_google_sign_in_steps_up_with_the_authenticator_code_from_firebase() {
    let (app, fake) = google_app().await;
    // Mona has a password account with an authenticator, made through this service.
    let made = sign_up(&app, "mona@example.com").await;
    call(&app, "POST", "/v1/mfa/setup", None, Some(token(&made))).await;
    call(&app, "POST", "/v1/mfa/confirm", Some(json!({ "code": firebase::GOOD_CODE })), Some(token(&made))).await;
    assert!(fake.world.lock().unwrap().has_mfa("mona@example.com"));

    let (status, g) = google(&app).await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert!(!claims(&app, token(&g)).await.mfa, "Google does not pass the second step");
    assert_eq!(call(&app, "POST", "/v1/mfa/verify", Some(json!({ "code": "000000" })), Some(token(&g))).await.0, StatusCode::UNAUTHORIZED);
    let (status, stepped) = call(&app, "POST", "/v1/mfa/verify", Some(json!({ "code": firebase::GOOD_CODE })), Some(token(&g))).await;
    assert_eq!(status, StatusCode::OK, "{stepped}");
    assert!(claims(&app, stepped["access_token"].as_str().unwrap()).await.mfa);
}

#[tokio::test]
async fn apple_is_not_offered_while_firebase_is_the_account_store() {
    let fake = firebase::start().await;
    let base = provider::start().await;
    let apple = Provider { team_id: "TEAMTEST01".into(), key_id: "KEYTEST001".into(), private_key: keys::EC_PRIVATE_PEM.into(), client_id: "apple-test-client".into(), token_url: format!("{base}/token"), jwks_url: format!("{base}/jwks"), issuer: base.clone(), auth_url: format!("{base}/authorize"), ..Default::default() };
    let config = Config { firebase: Some(callerwhale_auth::firebase::Firebase::new("test-key", &fake.base, &fake.base)), apple, google: google_providers(&base), ..Config::for_tests() };
    let app = service_with(config).await;
    let (_, providers) = call(&app, "GET", "/v1/providers", None, None).await;
    assert_eq!(providers, json!({ "google": true, "apple": false }));
}

#[tokio::test]
async fn without_a_firebase_key_the_service_keeps_its_own_accounts() {
    let app = service().await;
    let made = sign_up(&app, "sami@example.com").await;
    assert!(token(&made).contains('.'));
    assert_eq!(claims(&app, token(&made)).await.provider, "password");
}
