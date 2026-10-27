//! Google and Apple sign-in, the desktop handoff and email confirmation, end to end against a fake provider
//! (tests/common/provider.rs) that signs ID tokens like the real ones. Moved here from the core API's tests.

mod common;

use axum::{http::StatusCode, Router};
use common::*;
use serde_json::{json, Value};
use turf_auth::config::{Config, Provider};

fn providers(base: &str) -> (Provider, Provider) {
    let endpoints = |client: &str| Provider {
        client_id: client.into(),
        auth_url: format!("{base}/authorize"),
        token_url: format!("{base}/token"),
        jwks_url: format!("{base}/jwks"),
        issuer: base.into(),
        ..Default::default()
    };
    let google = Provider { client_secret: "google-test-secret".into(), ..endpoints("google-test-client") };
    let apple = Provider { team_id: "TEAMTEST01".into(), key_id: "KEYTEST001".into(), private_key: keys::EC_PRIVATE_PEM.into(), ..endpoints("apple-test-client") };
    (google, apple)
}

async fn with_providers(config: Config) -> (Router, String) {
    let base = provider::start().await;
    let (google, apple) = providers(&base);
    (service_with(Config { google, apple, ..config }).await, base)
}

/// Starts a sign-in, comes back from the provider with these claims (`"nonce": true` uses the right nonce), and
/// answers where the browser is sent at the end.
async fn sign_in_with(app: &Router, provider: &str, query: &str, mut claims: Value, apple_user: Option<&str>) -> String {
    let (status, to) = follow(app, get(&format!("/v1/oauth/{provider}/start?{query}"))).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "start sends the browser to the provider");
    let state = param(&to, "state").expect("state");
    if claims["nonce"] == json!(true) {
        claims["nonce"] = json!(param(&to, "nonce").expect("nonce"));
    }
    let code = provider::code(claims);
    let (status, back) = if provider == "apple" {
        let mut pairs = vec![("code", code.as_str()), ("state", state.as_str())];
        if let Some(user) = apple_user {
            pairs.push(("user", user));
        }
        follow(app, form_post("/v1/oauth/apple/callback", &pairs)).await
    } else {
        follow(app, get(&format!("/v1/oauth/google/callback?code={code}&state={state}"))).await
    };
    assert_eq!(status, StatusCode::SEE_OTHER);
    back
}

async fn exchange(app: &Router, code: &str) -> (StatusCode, Value) {
    call(app, "POST", "/v1/oauth/exchange", Some(json!({ "code": code })), None).await
}

fn mona() -> Value {
    json!({ "sub": "g-100", "email": "Mona@Example.com", "email_verified": true, "name": "Mona Adel", "nonce": true })
}

#[tokio::test]
async fn google_sign_up_then_sign_in_again_as_the_same_person() {
    let (app, base) = with_providers(Config::for_tests()).await;
    assert_eq!(call(&app, "GET", "/v1/providers", None, None).await.1, json!({ "google": true, "apple": true }));

    // The address sent to Google carries PKCE and comes back to this service.
    let (_, to) = follow(&app, get("/v1/oauth/google/start")).await;
    assert!(to.starts_with(&format!("{base}/authorize?")));
    assert_eq!(param(&to, "code_challenge_method").as_deref(), Some("S256"));
    assert_eq!(param(&to, "redirect_uri").as_deref(), Some("http://auth.example/v1/oauth/google/callback"));

    let landed = sign_in_with(&app, "google", "", mona(), None).await;
    assert!(landed.starts_with("http://website.example/?turf_code="), "{landed}");
    assert!(landed.ends_with("#/account"));
    let code = param(&landed, "turf_code").unwrap();
    let (status, first) = exchange(&app, &code).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["user"]["email"], "mona@example.com");
    assert_eq!(first["user"]["name"], "Mona Adel");
    assert!(claims(&app, token(&first)).await.email_verified, "Google confirmed the email");

    // The code works once.
    assert_eq!(exchange(&app, &code).await.0, StatusCode::FORBIDDEN);

    // Signing in again is the same account, even if the email Google reports changed.
    let again = sign_in_with(&app, "google", "target=app", json!({ "sub": "g-100", "email": "mona.new@example.com", "email_verified": true, "nonce": true }), None).await;
    assert!(again.starts_with("http://app.example/?turf_code="), "{again}");
    let (_, second) = exchange(&app, &param(&again, "turf_code").unwrap()).await;
    assert_eq!(second["user"]["id"], first["user"]["id"]);
    // A password does not work for an account made with Google.
    let (status, _) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "mona@example.com", "password": "!external-sign-in" })), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn google_links_an_existing_password_account_and_confirms_its_email() {
    let (app, _) = with_providers(Config::for_tests()).await;
    let made = sign_up(&app, "mona@example.com").await;
    assert!(!claims(&app, token(&made)).await.email_verified);

    let landed = sign_in_with(&app, "google", "", mona(), None).await;
    let (_, linked) = exchange(&app, &param(&landed, "turf_code").unwrap()).await;
    assert_eq!(linked["user"]["id"], made["user"]["id"]);
    assert!(claims(&app, token(&linked)).await.email_verified);
    // The password still works too.
    assert_eq!(call(&app, "POST", "/v1/sessions", Some(json!({ "email": "mona@example.com", "password": PASSWORD })), None).await.0, StatusCode::OK);
}

#[tokio::test]
async fn sign_ins_that_do_not_check_out_are_refused() {
    let (app, _) = with_providers(Config::for_tests()).await;
    let error = |landed: &str| param(landed, "oauth_error");

    let unconfirmed = sign_in_with(&app, "google", "", json!({ "sub": "g-1", "email": "a@example.com", "email_verified": false, "nonce": true }), None).await;
    assert!(error(&unconfirmed).unwrap().contains("no confirmed email"), "{unconfirmed}");
    assert!(unconfirmed.ends_with("#/signin"));

    let wrong_nonce = sign_in_with(&app, "google", "", json!({ "sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": "someone-elses" }), None).await;
    assert!(error(&wrong_nonce).unwrap().contains("not for this sign-in"));

    let tampered = sign_in_with(&app, "google", "", json!({ "sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": true, "tamper": true }), None).await;
    assert!(error(&tampered).unwrap().contains("did not check out"));

    let wrong_audience = sign_in_with(&app, "google", "", json!({ "sub": "g-1", "email": "a@example.com", "email_verified": true, "nonce": true, "aud": "another-app" }), None).await;
    assert!(error(&wrong_audience).is_some());

    // A made-up state, or one used already, trusts nothing.
    let (_, landed) = follow(&app, get("/v1/oauth/google/callback?code=x&state=made-up")).await;
    assert!(error(&landed).unwrap().contains("expired"));

    // Cancelled at the provider.
    let (_, to) = follow(&app, get("/v1/oauth/google/start?target=app")).await;
    let (_, landed) = follow(&app, get(&format!("/v1/oauth/google/callback?error=access_denied&state={}", param(&to, "state").unwrap()))).await;
    assert!(landed.starts_with("http://app.example/?oauth_error="), "{landed}");

    // Nobody was signed up by any of that.
    assert_eq!(call(&app, "POST", "/v1/oauth/exchange", Some(json!({ "code": "nothing" })), None).await.0, StatusCode::FORBIDDEN);
    let (status, body) = call(&app, "GET", "/v1/oauth/facebook/start", None, None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request")));
}

#[tokio::test]
async fn apple_posts_back_with_a_name_the_first_time() {
    let (app, base) = with_providers(Config::for_tests()).await;
    let (_, to) = follow(&app, get("/v1/oauth/apple/start")).await;
    assert!(to.starts_with(&format!("{base}/authorize?")));
    assert_eq!(param(&to, "response_mode").as_deref(), Some("form_post"));
    assert_eq!(param(&to, "code_challenge"), None, "Apple's flow takes no PKCE");

    // Apple sends the email as "true" (a string), and the name only once, in a form field.
    let claims_in = json!({ "sub": "a-7", "email": "sami@example.com", "email_verified": "true", "nonce": true });
    let landed = sign_in_with(&app, "apple", "", claims_in, Some(r#"{"name":{"firstName":"Sami","lastName":"Lee"}}"#)).await;
    let (status, body) = exchange(&app, &param(&landed, "turf_code").unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["user"]["name"], "Sami Lee");
}

#[tokio::test]
async fn the_desktop_app_collects_its_sign_in_on_this_computer_only() {
    let (app, _) = with_providers(Config::for_tests()).await;
    // Without a port there is nowhere safe to send the result.
    assert_eq!(call(&app, "GET", "/v1/oauth/google/start?target=desktop", None, None).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&app, "GET", "/v1/oauth/google/start?target=desktop&port=80", None, None).await.0, StatusCode::BAD_REQUEST);

    let landed = sign_in_with(&app, "google", "target=desktop&port=48123", mona(), None).await;
    assert!(landed.starts_with("http://127.0.0.1:48123/turf-sign-in?code="), "{landed}");
    let (status, tokens) = exchange(&app, &param(&landed, "code").unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = call(&app, "GET", "/v1/sessions", None, Some(token(&tokens))).await;
    assert_eq!(list["sessions"][0]["kind"], "desktop");

    let failed = sign_in_with(&app, "google", "target=desktop&port=48123", json!({ "sub": "g-9", "email": "x@example.com", "email_verified": false, "nonce": true }), None).await;
    assert!(failed.starts_with("http://127.0.0.1:48123/turf-sign-in?error="), "{failed}");
}

#[tokio::test]
async fn a_closed_server_signs_in_known_people_but_makes_no_new_accounts() {
    let (app, _) = with_providers(Config { public_signup: false, ..Config::for_tests() }).await;
    let landed = sign_in_with(&app, "google", "", mona(), None).await;
    assert!(param(&landed, "oauth_error").unwrap().contains("new sign-ups"), "{landed}");
}

#[tokio::test]
async fn confirming_an_email_address() {
    let app = service().await;
    let made = sign_up(&app, "sami@example.com").await;
    let link = made["verification_token"].as_str().expect("development tokens are on in tests").to_string();
    let (_, me) = call(&app, "GET", "/v1/me", None, Some(token(&made))).await;
    assert_eq!(me["email_verified"], false);

    // Asking again straight away is refused; the first link is still on its way.
    assert_eq!(call(&app, "POST", "/v1/email/resend", None, Some(token(&made))).await.0, StatusCode::BAD_REQUEST);

    let (status, body) = call(&app, "POST", "/v1/email/verify", Some(json!({ "token": link })), None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "email_verified": true })));
    assert_eq!(call(&app, "POST", "/v1/email/verify", Some(json!({ "token": link })), None).await.0, StatusCode::FORBIDDEN, "a link works once");
    assert_eq!(call(&app, "GET", "/v1/me", None, Some(token(&made))).await.1["email_verified"], true);

    // The next token says so, for every other service to see.
    let (_, fresh) = call(&app, "POST", "/v1/sessions/refresh", Some(json!({ "refresh_token": made["refresh_token"] })), None).await;
    assert!(claims(&app, token(&fresh)).await.email_verified);
    assert_eq!(call(&app, "POST", "/v1/email/resend", None, Some(token(&fresh))).await.1, json!({ "email_verified": true }));
}

#[tokio::test]
async fn confirmation_links_are_not_shown_outside_development() {
    let app = service_with(Config { dev_tokens: false, ..Config::for_tests() }).await;
    let made = sign_up(&app, "sami@example.com").await;
    assert!(made.get("verification_token").is_none());
}
