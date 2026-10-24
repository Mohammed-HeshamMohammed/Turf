//! Sign-in with Google and Apple, end to end against real PostgreSQL and a fake provider (tests/common/provider.rs),
//! and the platform administrator's view of every customer.

mod common;

use common::*;
use serde_json::{json, Value};

macro_rules! harness {
    () => {
        match start().await {
            Some(h) => h,
            None => return,
        }
    };
}

/// A browser that keeps cookies but stops at redirects, so a test can read where it is sent.
fn browser(h: &Harness) -> Client {
    Client { http: reqwest::Client::builder().cookie_store(true).redirect(reqwest::redirect::Policy::none()).build().unwrap(), base: h.base.clone() }
}

fn location(response: &reqwest::Response) -> String {
    response.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

fn param(url: &str, name: &str) -> Option<String> {
    reqwest::Url::parse(url).ok()?.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// Starts a sign-in, then comes back from the provider with these claims. `nonce: true` uses the right nonce.
/// Answers where the browser is sent at the end.
async fn sign_in_with(browser: &Client, provider: &str, target: &str, mut claims: Value, user: Option<&str>) -> String {
    let started = browser.http.get(format!("{}/api/v1/auth/oauth/{provider}/start?target={target}", browser.base)).send().await.unwrap();
    assert_eq!(started.status().as_u16(), 303, "start sends the browser to the provider");
    let to = location(&started);
    let state = param(&to, "state").expect("state");
    if claims["nonce"] == json!(true) {
        claims["nonce"] = json!(param(&to, "nonce").expect("nonce"));
    }
    let code = provider::code(claims);
    let back = if provider == "apple" {
        let mut form = vec![("code", code.as_str()), ("state", state.as_str())];
        if let Some(user) = user {
            form.push(("user", user));
        }
        browser.http.post(format!("{}/api/v1/auth/oauth/apple/callback", browser.base)).form(&form).send().await.unwrap()
    } else {
        browser.http.get(format!("{}/api/v1/auth/oauth/google/callback", browser.base)).query(&[("code", code.as_str()), ("state", state.as_str())]).send().await.unwrap()
    };
    assert_eq!(back.status().as_u16(), 303);
    location(&back)
}

#[tokio::test]
async fn google_sign_up_opens_a_trial_and_signs_in_again_later() {
    let h = harness!();
    let anyone = Client::new(&h.base);
    assert_eq!(anyone.get("/api/v1/auth/providers").await.ok(), json!({ "google": true, "apple": true }));

    // The address sent to Google carries PKCE and asks for the right things.
    let b = browser(&h);
    let started = b.http.get(format!("{}/api/v1/auth/oauth/google/start", h.base)).send().await.unwrap();
    let to = location(&started);
    assert!(to.starts_with(&format!("{}/authorize?", h.provider)));
    assert_eq!(param(&to, "code_challenge_method").as_deref(), Some("S256"));
    assert_eq!(param(&to, "redirect_uri"), Some(format!("{}/api/v1/auth/oauth/google/callback", h.base)));

    let claims = json!({ "sub": "g-100", "email": "Mona@Example.com", "email_verified": true, "name": "Mona Adel", "nonce": true });
    let landed = sign_in_with(&b, "google", "website", claims.clone(), None).await;
    assert_eq!(landed, format!("{}/#/account", h.base));
    let me = b.get("/api/v1/me").await.ok();
    assert_eq!(me["user"]["email"], "mona@example.com");
    assert_eq!(me["user"]["name"], "Mona Adel");
    assert_eq!(me["mfa"]["required"], true, "an owner still sets up a sign-in code");
    assert_eq!(b.get("/api/v1/billing").await.status, 401, "and nothing opens until it is set up");
    let secret = b.post("/api/v1/auth/mfa/setup", json!({})).await.ok()["secret"].as_str().unwrap().to_string();
    b.post("/api/v1/auth/mfa/confirm", json!({ "code": totp_now(&secret, "mona@example.com") })).await.ok();
    let account = b.get("/api/v1/billing").await.ok();
    assert_eq!(account["plan"]["key"], "trial");
    assert_eq!(account["email_verified"], true, "Google confirmed the address");

    // A Google-only account has no password that works.
    assert_eq!(anyone.post("/api/v1/auth/login", json!({ "email": "mona@example.com", "password": "!external-sign-in" })).await.status, 403);

    // Signing in again finds the same account and organization, even if Google now reports another address.
    let again = browser(&h);
    let landed = sign_in_with(&again, "google", "app", json!({ "sub": "g-100", "email": "mona.new@example.com", "email_verified": true, "nonce": true }), None).await;
    assert_eq!(landed, "http://app.example/", "a sign-in started in the app returns to the app");
    assert_eq!(again.get("/api/v1/me").await.ok()["organization_id"], me["organization_id"]);
}

#[tokio::test]
async fn apple_links_to_an_existing_account_with_the_same_verified_email() {
    let h = harness!();
    let form = Client::new(&h.base);
    let made = form.post("/api/v1/auth/signup", json!({ "email": "sami@example.com", "display_name": "Sami Nour", "password": PASSWORD })).await.ok();
    let b = browser(&h);
    // Apple sends email_verified as a string, and the name only the first time, in a separate form field.
    let user = r#"{"name":{"firstName":"Sami","lastName":"N"},"email":"sami@example.com"}"#;
    sign_in_with(&b, "apple", "website", json!({ "sub": "a-7", "email": "sami@example.com", "email_verified": "true", "nonce": true }), Some(user)).await;
    let me = b.get("/api/v1/me").await.ok();
    assert_eq!(me["user"]["id"], made["user_id"], "the existing account, not a new one");
    assert_eq!(me["organization_id"], made["organization_id"]);
    assert_eq!(me["user"]["name"], "Sami Nour", "the account keeps its name");
}

#[tokio::test]
async fn forged_stale_or_unverified_sign_ins_are_refused() {
    let h = harness!();
    let refused = |landed: &str| landed.contains("oauth_error=") && landed.ends_with("#/signin");
    let base = |extra: Value| {
        let mut claims = json!({ "sub": "x-1", "email": "eve@example.com", "email_verified": true, "nonce": true });
        claims.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        claims
    };
    // An email the provider has not verified.
    assert!(refused(&sign_in_with(&browser(&h), "google", "website", base(json!({ "email_verified": false })), None).await));
    // A token from another sign-in (wrong nonce), for another app (audience), from another issuer, expired, or edited.
    assert!(refused(&sign_in_with(&browser(&h), "google", "website", base(json!({ "nonce": "someone-elses" })), None).await));
    assert!(refused(&sign_in_with(&browser(&h), "google", "website", base(json!({ "aud": "another-app" })), None).await));
    assert!(refused(&sign_in_with(&browser(&h), "google", "website", base(json!({ "iss": "https://evil.example" })), None).await));
    assert!(refused(&sign_in_with(&browser(&h), "google", "website", base(json!({ "exp": 1000 })), None).await));
    assert!(refused(&sign_in_with(&browser(&h), "google", "website", base(json!({ "tamper": true })), None).await));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&h.owner).await.unwrap();
    assert_eq!(count, 0, "none of them made an account");

    // A state is used once: replaying the provider's answer fails.
    let b = browser(&h);
    let started = b.http.get(format!("{}/api/v1/auth/oauth/google/start", h.base)).send().await.unwrap();
    let to = location(&started);
    let state = param(&to, "state").unwrap();
    let code = provider::code(json!({ "sub": "x-2", "email": "ok@example.com", "email_verified": true, "nonce": param(&to, "nonce").unwrap() }));
    let callback = format!("{}/api/v1/auth/oauth/google/callback", h.base);
    let first = b.http.get(&callback).query(&[("code", code.as_str()), ("state", state.as_str())]).send().await.unwrap();
    assert!(!location(&first).contains("oauth_error"));
    let replay = browser(&h).http.get(&callback).query(&[("code", code.as_str()), ("state", state.as_str())]).send().await.unwrap();
    assert!(location(&replay).contains("oauth_error"));
    // A made-up state or an unknown provider goes nowhere.
    let fake = b.http.get(&callback).query(&[("code", code.as_str()), ("state", "made-up")]).send().await.unwrap();
    assert!(location(&fake).contains("oauth_error"));
    assert_eq!(Client::new(&h.base).get("/api/v1/auth/oauth/facebook/start").await.status, 404);
}

#[tokio::test]
async fn platform_administrators_see_every_customer_and_nobody_else_does() {
    let h = harness!();
    let (owner, answer, secret) = {
        let c = Client::new(&h.base);
        let answer = c.post("/api/v1/auth/signup", json!({ "email": "boss@turf.example", "display_name": "Platform Owner", "password": PASSWORD })).await.ok();
        let setup = c.post("/api/v1/auth/mfa/setup", json!({})).await.ok();
        let secret = setup["secret"].as_str().unwrap().to_string();
        c.post("/api/v1/auth/mfa/confirm", json!({ "code": totp_now(&secret, "boss@turf.example") })).await.ok();
        (c, answer, secret)
    };
    let _ = secret;
    let customer = Client::new(&h.base);
    customer.post("/api/v1/auth/signup", json!({ "email": "client@shop.example", "display_name": "A Customer", "password": PASSWORD })).await.ok();

    // Not yet a platform administrator: refused, like every customer.
    assert_eq!(owner.get("/api/v1/platform/organizations").await.status, 403);
    assert_eq!(customer.get("/api/v1/platform/organizations").await.status, 403);
    sqlx::query("UPDATE users SET platform_admin = true WHERE email = 'boss@turf.example'").execute(&h.owner).await.unwrap();
    assert_eq!(owner.get("/api/v1/me").await.ok()["platform_admin"], true);
    let overview = owner.get("/api/v1/platform/organizations").await.ok();
    assert_eq!(overview["totals"]["organizations"], 2);
    assert_eq!(overview["totals"]["trials"], 2);
    let emails: Vec<&str> = overview["organizations"].as_array().unwrap().iter().map(|o| o["owner_email"].as_str().unwrap()).collect();
    assert!(emails.contains(&"client@shop.example") && emails.contains(&"boss@turf.example"));
    // A trial whose time is up shows as expired, not as still trialing.
    sqlx::query("UPDATE subscriptions SET period_start = now() - interval '8 days', period_end = now() - interval '1 day' WHERE org_id = $1::uuid")
        .bind(answer["organization_id"].as_str().unwrap())
        .execute(&h.owner)
        .await
        .unwrap();
    let overview = owner.get("/api/v1/platform/organizations").await.ok();
    assert_eq!(overview["totals"]["trials"], 1);
    let mine = overview["organizations"].as_array().unwrap().iter().find(|o| o["owner_email"] == "boss@turf.example").unwrap().clone();
    assert_eq!(mine["status"], "expired");

    // The database refuses the overview to anyone else, even if the API were asked directly.
    let api = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap()).await.unwrap();
    let customer_id: String = sqlx::query_scalar("SELECT id::text FROM users WHERE email = 'client@shop.example'").fetch_one(&h.owner).await.unwrap();
    let direct = sqlx::query("SELECT * FROM turf_platform_overview($1::uuid)").bind(customer_id).fetch_all(&api).await;
    assert!(direct.is_err());

    // A platform administrator still needs the second sign-in step on a fresh session.
    let fresh = Client::new(&h.base);
    fresh.post("/api/v1/auth/login", json!({ "email": "boss@turf.example", "password": PASSWORD })).await.ok();
    assert_eq!(fresh.get("/api/v1/platform/organizations").await.status, 401);
}


#[tokio::test]
async fn the_desktop_app_collects_its_sign_in_once_through_a_code_on_this_computer() {
    let h = harness!();
    let b = browser(&h);
    // Only an unprivileged port is accepted, and only ever as 127.0.0.1.
    assert_eq!(b.http.get(format!("{}/api/v1/auth/oauth/google/start?target=desktop", h.base)).send().await.unwrap().status().as_u16(), 400);
    assert_eq!(b.http.get(format!("{}/api/v1/auth/oauth/google/start?target=desktop&port=80", h.base)).send().await.unwrap().status().as_u16(), 400);
    let started = b.http.get(format!("{}/api/v1/auth/oauth/google/start?target=desktop&port=51234", h.base)).send().await.unwrap();
    let to = location(&started);
    let code = provider::code(json!({ "sub": "d-1", "email": "desk@example.com", "email_verified": true, "nonce": param(&to, "nonce").unwrap() }));
    let back = b
        .http
        .get(format!("{}/api/v1/auth/oauth/google/callback", h.base))
        .query(&[("code", code.as_str()), ("state", param(&to, "state").unwrap().as_str())])
        .send()
        .await
        .unwrap();
    let landed = location(&back);
    assert!(landed.starts_with("http://127.0.0.1:51234/turf-sign-in?code="), "{landed}");
    assert!(back.headers().get("set-cookie").is_none(), "the browser is not signed in; the app is");
    let one_time = param(&landed, "code").unwrap();

    // The app trades the code for its own session, once.
    let app = Client::new(&h.base);
    assert_eq!(app.get("/api/v1/me").await.status, 401);
    app.post("/api/v1/auth/oauth/exchange", json!({ "code": one_time })).await.ok();
    assert_eq!(app.get("/api/v1/me").await.ok()["user"]["email"], "desk@example.com");
    assert_eq!(Client::new(&h.base).post("/api/v1/auth/oauth/exchange", json!({ "code": one_time })).await.status, 403);
    assert_eq!(Client::new(&h.base).post("/api/v1/auth/oauth/exchange", json!({ "code": "made-up" })).await.status, 403);

    // A cancelled sign-in comes back to the app as an error, with no code.
    let started = b.http.get(format!("{}/api/v1/auth/oauth/google/start?target=desktop&port=51234", h.base)).send().await.unwrap();
    let state = param(&location(&started), "state").unwrap();
    let cancelled = b.http.get(format!("{}/api/v1/auth/oauth/google/callback", h.base)).query(&[("error", "access_denied"), ("state", state.as_str())]).send().await.unwrap();
    let landed = location(&cancelled);
    assert!(landed.starts_with("http://127.0.0.1:51234/turf-sign-in?error=") && !landed.contains("code="), "{landed}");
}

#[tokio::test]
async fn without_required_mfa_owners_go_straight_in() {
    let h = match start_without_mfa().await {
        Some(h) => h,
        None => return,
    };
    let owner = Client::new(&h.base);
    let answer = owner.post("/api/v1/auth/signup", json!({ "email": "quick@example.com", "display_name": "Quick Owner", "password": PASSWORD })).await.ok();
    assert_eq!(answer["mfa_required"], false);
    assert_eq!(owner.get("/api/v1/me").await.ok()["mfa"]["required"], false);
    assert_eq!(owner.get("/api/v1/billing").await.ok()["plan"]["key"], "trial", "no code needed");
    let again = Client::new(&h.base);
    assert_eq!(again.post("/api/v1/auth/login", json!({ "email": "quick@example.com", "password": PASSWORD })).await.ok()["mfa_required"], false);
    assert_eq!(again.get("/api/v1/leads").await.status, 200);
    // The platform page follows the same setting.
    sqlx::query("UPDATE users SET platform_admin = true WHERE email = 'quick@example.com'").execute(&h.owner).await.unwrap();
    assert_eq!(again.get("/api/v1/platform/organizations").await.status, 200);
}
