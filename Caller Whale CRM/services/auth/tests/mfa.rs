//! The second step (docs/plans/second-factor.md): authenticator devices (three at most), a code by email, a code by Telegram, and
//! an approval on a device that is already signed in, plus the limits around them. Against a mail sink and a fake Telegram.

mod common;

use axum::{extract::Path, http::StatusCode, routing::post, Json, Router};
use common::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use callerwhale_auth::{config::Config, mail::Mailer, telegram::Telegram};

#[derive(Debug, Default)]
struct Sink(Mutex<Vec<(String, String)>>);

#[async_trait::async_trait]
impl Mailer for Sink {
    async fn send_code(&self, to: &str, code: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().push((to.to_string(), code.to_string()));
        Ok(())
    }
}

impl Sink {
    fn last_code(&self) -> String {
        self.0.lock().unwrap().last().expect("an email was sent").1.clone()
    }
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

/// A fake Telegram: records what the bot was asked to send.
async fn fake_telegram() -> (String, Arc<Mutex<Vec<(String, String)>>>) {
    let sent: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let record = sent.clone();
    let app = Router::new().route(
        "/{bot}/sendMessage",
        post(move |Path(_bot): Path<String>, Json(body): Json<Value>| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push((body["chat_id"].as_str().unwrap_or_default().to_string(), body["text"].as_str().unwrap_or_default().to_string()));
                Json(json!({ "ok": true }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, sent)
}

async fn with_mail() -> (axum::Router, Arc<Sink>) {
    let sink = Arc::new(Sink::default());
    let app = service_with(Config { mailer: Some(sink.clone() as Arc<dyn Mailer>), ..Config::for_tests() }).await;
    (app, sink)
}

/// A new account whose email address is confirmed.
async fn confirmed(app: &axum::Router, email: &str) -> Value {
    let made = sign_up(app, email).await;
    let (status, _) = call(app, "POST", "/v1/email/verify", Some(json!({ "token": made["verification_token"] })), None).await;
    assert_eq!(status, StatusCode::OK);
    made
}

/// Sets up an authenticator for the person and returns its secret.
async fn add_device(app: &axum::Router, access: &str, email: &str, label: &str) -> (String, Value) {
    let (status, setup) = call(app, "POST", "/v1/mfa/totp/setup", None, Some(access)).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let secret = setup["secret"].as_str().unwrap().to_string();
    let (status, done) = call(app, "POST", "/v1/mfa/totp/confirm", Some(json!({ "code": current_code(&secret, email), "label": label })), Some(access)).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    (secret, done)
}

async fn sign_in_with_code(app: &axum::Router, email: &str, code: &str) -> (StatusCode, Value) {
    call(app, "POST", "/v1/sessions", Some(json!({ "email": email, "password": PASSWORD, "code": code })), None).await
}

async fn sign_in_challenge(app: &axum::Router, email: &str) -> Value {
    let (status, body) = call(app, "POST", "/v1/sessions", Some(json!({ "email": email, "password": PASSWORD })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("mfa_required")), "{body}");
    body
}

#[tokio::test]
async fn an_authenticator_may_be_on_three_devices_and_a_fourth_removes_the_oldest() {
    let app = service().await;
    let account = sign_up(&app, "sami@example.com").await;
    let mut secrets = vec![];
    let mut last = Value::Null;
    for n in 1..=4 {
        let (secret, done) = add_device(&app, token(&account), "sami@example.com", &format!("Phone {n}")).await;
        secrets.push(secret);
        last = done;
    }
    assert_eq!(last["removed"], json!(["Phone 1"]), "the fourth device removed the one set up longest ago");
    let (_, factors) = call(&app, "GET", "/v1/mfa/factors", None, Some(token(&account))).await;
    let labels: Vec<&str> = factors["factors"].as_array().unwrap().iter().map(|f| f["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["Phone 2", "Phone 3", "Phone 4"]);
    assert_eq!(factors["max_totp"], 3);
    // The removed device no longer works; the others do, each on its own.
    assert_eq!(sign_in_with_code(&app, "sami@example.com", &current_code(&secrets[0], "sami@example.com")).await.0, StatusCode::UNAUTHORIZED);
    for secret in &secrets[1..] {
        let (status, body) = sign_in_with_code(&app, "sami@example.com", &current_code(secret, "sami@example.com")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(claims(&app, token(&body)).await.mfa);
    }
}

#[tokio::test]
async fn a_code_by_email_answers_the_challenge_once() {
    let (app, sink) = with_mail().await;
    let account = confirmed(&app, "sami@example.com").await;
    add_device(&app, token(&account), "sami@example.com", "Phone").await;

    let challenge = sign_in_challenge(&app, "sami@example.com").await;
    // The session that set the authenticator up passed a second step, so it can approve too.
    assert_eq!(challenge["methods"], json!(["totp", "email", "push"]));
    let ticket = challenge["challenge"].as_str().unwrap();

    // Nothing is sent until asked, and only the ways the person has are allowed.
    assert_eq!(sink.count(), 0);
    let (status, _) = call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "telegram" })), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, sent) = call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "email" })), None).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sink.0.lock().unwrap()[0].0, "sami@example.com");
    // Asking again straight away is refused, not another email.
    assert_eq!(call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "email" })), None).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(sink.count(), 1);

    let code = sink.last_code();
    assert_eq!(code.len(), 6);
    let wrong = if code == "000000" { "000001" } else { "000000" };
    let (status, body) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": wrong })), None).await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("wrong_code")));
    let (status, done) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": code })), None).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert!(claims(&app, token(&done)).await.mfa);
    // The challenge is spent.
    let (status, _) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": code })), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn five_wrong_answers_end_a_challenge_even_if_the_next_is_right() {
    let (app, sink) = with_mail().await;
    let account = confirmed(&app, "sami@example.com").await;
    add_device(&app, token(&account), "sami@example.com", "Phone").await;
    let ticket = sign_in_challenge(&app, "sami@example.com").await["challenge"].as_str().unwrap().to_string();
    call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "email" })), None).await;
    let code = sink.last_code();
    let wrong = if code == "111111" { "222222" } else { "111111" };
    for _ in 0..5 {
        assert_eq!(call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": wrong })), None).await.0, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": code })), None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": code })), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the challenge is gone");
}

#[tokio::test]
async fn email_is_not_offered_without_a_confirmed_address_or_a_mail_server() {
    let (app, _) = with_mail().await;
    let account = sign_up(&app, "sami@example.com").await; // not confirmed
    add_device(&app, token(&account), "sami@example.com", "Phone").await;
    assert_eq!(sign_in_challenge(&app, "sami@example.com").await["methods"], json!(["totp", "push"]));

    let bare = service().await; // no mail server
    let account = confirmed(&bare, "lee@example.com").await;
    add_device(&bare, token(&account), "lee@example.com", "Phone").await;
    assert_eq!(sign_in_challenge(&bare, "lee@example.com").await["methods"], json!(["totp", "push"]));
}

#[tokio::test]
async fn a_session_that_has_set_nothing_up_steps_up_with_an_email_code() {
    let (app, sink) = with_mail().await;
    confirmed(&app, "staff@example.com").await;
    // Signing in asks for nothing (nothing is set up), and the token says no second step yet.
    let (_, signed) = call(&app, "POST", "/v1/sessions", Some(json!({ "email": "staff@example.com", "password": PASSWORD })), None).await;
    assert!(!claims(&app, token(&signed)).await.mfa);

    let (status, start) = call(&app, "POST", "/v1/mfa/challenge/start", None, Some(token(&signed))).await;
    assert_eq!(status, StatusCode::OK, "{start}");
    assert_eq!(start["methods"], json!(["email"]));
    let ticket = start["challenge"].as_str().unwrap();
    call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "email" })), None).await;
    let (status, stepped) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "email", "code": sink.last_code() })), None).await;
    assert_eq!(status, StatusCode::OK, "{stepped}");
    let c = claims(&app, stepped["access_token"].as_str().unwrap()).await;
    assert!(c.mfa);
    assert_eq!(c.auth_time, claims(&app, token(&signed)).await.auth_time, "it is still the same sign-in");
    // The session keeps saying so when it refreshes.
    let (_, refreshed) = call(&app, "POST", "/v1/sessions/refresh", Some(json!({ "refresh_token": signed["refresh_token"] })), None).await;
    assert!(claims(&app, token(&refreshed)).await.mfa);
}

#[tokio::test]
async fn a_sign_in_is_approved_on_a_device_that_is_already_signed_in() {
    let app = service().await;
    let account = sign_up(&app, "sami@example.com").await;
    let (secret, _) = add_device(&app, token(&account), "sami@example.com", "Phone").await;
    // The first device signs in with its code.
    let (_, first) = sign_in_with_code(&app, "sami@example.com", &current_code(&secret, "sami@example.com")).await;
    assert!(claims(&app, token(&first)).await.mfa);

    // A second device signs in with the password: it may ask the first to approve.
    let challenge = sign_in_challenge(&app, "sami@example.com").await;
    assert_eq!(challenge["methods"], json!(["totp", "push"]));
    let ticket = challenge["challenge"].as_str().unwrap();
    let (status, _) = call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "push", "device": "Chrome on Windows" })), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, state) = call(&app, "POST", "/v1/mfa/challenge/status", Some(json!({ "challenge": ticket })), None).await;
    assert_eq!(state["push"], "pending");
    // Not approved yet: answering fails.
    assert_eq!(call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "push" })), None).await.0, StatusCode::UNAUTHORIZED);

    // The first device sees the request, with what asked, and approves it.
    let (status, waiting) = call(&app, "GET", "/v1/mfa/approvals", None, Some(token(&first))).await;
    assert_eq!(status, StatusCode::OK, "{waiting}");
    assert_eq!(waiting["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(waiting["approvals"][0]["device"], "Chrome on Windows");
    let id = waiting["approvals"][0]["id"].as_str().unwrap();
    assert_eq!(call(&app, "POST", &format!("/v1/mfa/approvals/{id}"), Some(json!({ "approve": true })), Some(token(&first))).await.0, StatusCode::OK);
    assert_eq!(call(&app, "POST", &format!("/v1/mfa/approvals/{id}"), Some(json!({ "approve": true })), Some(token(&first))).await.0, StatusCode::FORBIDDEN, "once");

    let (_, state) = call(&app, "POST", "/v1/mfa/challenge/status", Some(json!({ "challenge": ticket })), None).await;
    assert_eq!(state["push"], "approved");
    let (status, second) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "push" })), None).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert!(claims(&app, token(&second)).await.mfa);
}

#[tokio::test]
async fn a_denied_approval_opens_nothing_and_a_device_without_a_second_step_cannot_approve() {
    let app = service().await;
    let account = sign_up(&app, "sami@example.com").await;
    let (secret, _) = add_device(&app, token(&account), "sami@example.com", "Phone").await;
    let (_, first) = sign_in_with_code(&app, "sami@example.com", &current_code(&secret, "sami@example.com")).await;
    let ticket = sign_in_challenge(&app, "sami@example.com").await["challenge"].as_str().unwrap().to_string();
    call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "push" })), None).await;
    let (_, waiting) = call(&app, "GET", "/v1/mfa/approvals", None, Some(token(&first))).await;
    let id = waiting["approvals"][0]["id"].as_str().unwrap().to_string();

    // `account` signed up and added a device, but its own token never passed a second step: it can neither list nor decide.
    assert_eq!(call(&app, "GET", "/v1/mfa/approvals", None, Some(token(&account))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&app, "POST", &format!("/v1/mfa/approvals/{id}"), Some(json!({ "approve": true })), Some(token(&account))).await.0, StatusCode::FORBIDDEN);

    assert_eq!(call(&app, "POST", &format!("/v1/mfa/approvals/{id}"), Some(json!({ "approve": false })), Some(token(&first))).await.0, StatusCode::OK);
    let (status, body) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "push" })), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}

#[tokio::test]
async fn someone_elses_approval_is_not_yours_to_give() {
    let app = service().await;
    let sami = sign_up(&app, "sami@example.com").await;
    let (sami_secret, _) = add_device(&app, token(&sami), "sami@example.com", "Phone").await;
    let (_, sami_in) = sign_in_with_code(&app, "sami@example.com", &current_code(&sami_secret, "sami@example.com")).await;
    let lee = sign_up(&app, "lee@example.com").await;
    let (lee_secret, _) = add_device(&app, token(&lee), "lee@example.com", "Phone").await;
    let (_, lee_in) = sign_in_with_code(&app, "lee@example.com", &current_code(&lee_secret, "lee@example.com")).await;

    let ticket = sign_in_challenge(&app, "sami@example.com").await["challenge"].as_str().unwrap().to_string();
    call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "push" })), None).await;
    let (_, waiting) = call(&app, "GET", "/v1/mfa/approvals", None, Some(token(&sami_in))).await;
    let id = waiting["approvals"][0]["id"].as_str().unwrap();
    assert_eq!(call(&app, "GET", "/v1/mfa/approvals", None, Some(token(&lee_in))).await.1["approvals"], json!([]));
    assert_eq!(call(&app, "POST", &format!("/v1/mfa/approvals/{id}"), Some(json!({ "approve": true })), Some(token(&lee_in))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_code_by_telegram_after_linking_the_chat() {
    let (base, sent) = fake_telegram().await;
    let config = Config { telegram: Some(Telegram::new("TOKEN", "@caller_whale_bot", &base)), telegram_webhook_secret: "hook".into(), ..Config::for_tests() };
    let app = service_with(config).await;
    let account = sign_up(&app, "sami@example.com").await;
    let (secret, _) = add_device(&app, token(&account), "sami@example.com", "Phone").await;
    let (_, signed) = sign_in_with_code(&app, "sami@example.com", &current_code(&secret, "sami@example.com")).await;

    // Linking needs a session that passed a second step, and gives a one-time link to the bot.
    assert_eq!(call(&app, "POST", "/v1/mfa/telegram/link", None, Some(token(&account))).await.0, StatusCode::FORBIDDEN);
    let (status, link) = call(&app, "POST", "/v1/mfa/telegram/link", None, Some(token(&signed))).await;
    assert_eq!(status, StatusCode::OK, "{link}");
    let url = link["url"].as_str().unwrap();
    assert!(url.starts_with("https://t.me/caller_whale_bot?start="), "{url}");
    let code = url.split("start=").nth(1).unwrap();

    // Only Telegram, with the secret in the address, may report who opened it.
    let update = |text: &str| json!({ "update_id": 1, "message": { "chat": { "id": 777 }, "text": text } });
    assert_eq!(call(&app, "POST", "/v1/mfa/telegram/webhook/wrong", Some(update(&format!("/start {code}"))), None).await.0, StatusCode::FORBIDDEN);
    call(&app, "POST", "/v1/mfa/telegram/webhook/hook", Some(update("/start not-a-real-code")), None).await;
    let (_, factors) = call(&app, "GET", "/v1/mfa/factors", None, Some(token(&signed))).await;
    assert!(factors["factors"].as_array().unwrap().iter().all(|f| f["kind"] != "telegram"));
    assert_eq!(call(&app, "POST", "/v1/mfa/telegram/webhook/hook", Some(update(&format!("/start {code}"))), None).await.0, StatusCode::OK);
    // The link works once.
    call(&app, "POST", "/v1/mfa/telegram/webhook/hook", Some(json!({ "message": { "chat": { "id": 999 }, "text": format!("/start {code}") } })), None).await;
    let (_, factors) = call(&app, "GET", "/v1/mfa/factors", None, Some(token(&signed))).await;
    assert_eq!(factors["factors"].as_array().unwrap().iter().filter(|f| f["kind"] == "telegram").count(), 1);

    // Now a sign-in may ask for the code there.
    let challenge = sign_in_challenge(&app, "sami@example.com").await;
    assert!(challenge["methods"].as_array().unwrap().contains(&json!("telegram")));
    let ticket = challenge["challenge"].as_str().unwrap();
    let (status, _) = call(&app, "POST", "/v1/mfa/challenge/send", Some(json!({ "challenge": ticket, "method": "telegram" })), None).await;
    assert_eq!(status, StatusCode::OK);
    let (chat, text) = sent.lock().unwrap().last().cloned().unwrap();
    assert_eq!(chat, "777");
    let code: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    let (status, done) = call(&app, "POST", "/v1/mfa/challenge/answer", Some(json!({ "challenge": ticket, "method": "telegram", "code": code })), None).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert!(claims(&app, token(&done)).await.mfa);
}

#[tokio::test]
async fn telegram_is_not_offered_without_a_bot() {
    let app = service().await;
    let account = sign_up(&app, "sami@example.com").await;
    let (secret, _) = add_device(&app, token(&account), "sami@example.com", "Phone").await;
    let (_, signed) = sign_in_with_code(&app, "sami@example.com", &current_code(&secret, "sami@example.com")).await;
    assert_eq!(call(&app, "POST", "/v1/mfa/telegram/link", None, Some(token(&signed))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&app, "POST", "/v1/mfa/telegram/webhook/anything", Some(json!({})), None).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_way_is_removed_only_after_a_second_step_and_only_your_own() {
    let app = service().await;
    let account = sign_up(&app, "sami@example.com").await;
    let (secret, _) = add_device(&app, token(&account), "sami@example.com", "Phone").await;
    let (_, signed) = sign_in_with_code(&app, "sami@example.com", &current_code(&secret, "sami@example.com")).await;
    let (_, factors) = call(&app, "GET", "/v1/mfa/factors", None, Some(token(&signed))).await;
    let id = factors["factors"][0]["id"].as_str().unwrap().to_string();

    let other = sign_up(&app, "lee@example.com").await;
    assert_eq!(call(&app, "DELETE", &format!("/v1/mfa/factors/{id}"), None, Some(token(&other))).await.0, StatusCode::FORBIDDEN, "no second step on that session");
    assert_eq!(call(&app, "DELETE", &format!("/v1/mfa/factors/{id}"), None, Some(token(&account))).await.0, StatusCode::FORBIDDEN);
    let (status, gone) = call(&app, "DELETE", &format!("/v1/mfa/factors/{id}"), None, Some(token(&signed))).await;
    assert_eq!((status, gone["removed"].as_i64()), (StatusCode::OK, Some(1)));
    // With nothing left, a password is enough again.
    assert_eq!(call(&app, "POST", "/v1/sessions", Some(json!({ "email": "sami@example.com", "password": PASSWORD })), None).await.0, StatusCode::OK);
}
