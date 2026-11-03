//! The website's waitlist and contact form: open to anyone, no token, and nothing more than that. Runs against real PostgreSQL.

mod common;

use common::*;
use serde_json::json;

#[tokio::test]
async fn anyone_can_join_the_waitlist_and_the_answer_never_says_who_is_on_it() {
    let Some(h) = start().await else { return };
    let anyone = h.anonymous();
    let first = anyone.post("/api/v1/public/waitlist", json!({ "email": " Sami@Example.com ", "name": "Sami", "company": "Homes", "tier": "duo" })).await;
    assert_eq!(first.status, 200);
    assert_eq!(first.body, json!({ "ok": true }));
    // Again, with different details and case: one row, and the same answer.
    let again = anyone.post("/api/v1/public/waitlist", json!({ "email": "sami@example.com", "name": "Other", "tier": "nonsense" })).await;
    assert_eq!((again.status, again.body), (200, json!({ "ok": true })));
    let rows: Vec<(String, String, String, String)> = sqlx::query_as("SELECT email::text, name, company, tier FROM landing_waitlist").fetch_all(&h.owner).await.unwrap();
    assert_eq!(rows, vec![("sami@example.com".to_string(), "Sami".to_string(), "Homes".to_string(), "duo".to_string())], "the first sign-up is kept");
    // An unknown tier is stored as none.
    anyone.post("/api/v1/public/waitlist", json!({ "email": "x@example.com", "tier": "gold" })).await;
    let tier: String = sqlx::query_scalar("SELECT tier FROM landing_waitlist WHERE email = 'x@example.com'").fetch_one(&h.owner).await.unwrap();
    assert_eq!(tier, "");
}

#[tokio::test]
async fn the_waitlist_refuses_bad_input_and_drops_bots() {
    let Some(h) = start().await else { return };
    let anyone = h.anonymous();
    for body in [json!({}), json!({ "email": "nope" }), json!({ "email": 5 }), json!({ "email": "a b@c.co" })] {
        let reply = anyone.post("/api/v1/public/waitlist", body.clone()).await;
        assert_eq!(reply.status, 400, "{body}");
        assert_eq!(reply.body["error"]["message"], json!("Enter a valid email address."));
    }
    // The hidden field: answered as a success, nothing stored.
    let bot = anyone.post("/api/v1/public/waitlist", json!({ "email": "bot@example.com", "website": "http://spam.example" })).await;
    assert_eq!((bot.status, bot.body), (200, json!({ "ok": true })));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM landing_waitlist").fetch_one(&h.owner).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn the_database_itself_refuses_a_waitlist_row_that_is_not_valid() {
    let Some(h) = start().await else { return };
    let api = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap()).await.unwrap();
    assert!(sqlx::query("INSERT INTO landing_waitlist (email, tier) VALUES ('a@example.com', 'gold')").execute(&api).await.is_err());
    assert!(sqlx::query("INSERT INTO landing_waitlist (email) VALUES ('a@example.com')").execute(&api).await.is_ok());
    // The API's login can add and read, never change or remove.
    assert!(sqlx::query("UPDATE landing_waitlist SET name = 'x'").execute(&api).await.is_err());
    assert!(sqlx::query("DELETE FROM landing_waitlist").execute(&api).await.is_err());
    let _ = h;
}

#[tokio::test]
async fn a_contact_message_is_refused_when_it_cannot_be_sent_and_bad_ones_before_that() {
    let Some(h) = start().await else { return };
    let anyone = h.anonymous();
    // No notification service is set in the tests: a good message is told to try again, never silently dropped.
    let good = anyone.post("/api/v1/public/contact", json!({ "email": "a@example.com", "name": "A", "message": "Hello there" })).await;
    assert_eq!(good.status, 503);
    assert_eq!(good.body["error"]["code"], json!("unavailable"));
    for body in [json!({ "email": "nope", "message": "Hello there" }), json!({ "email": "a@example.com", "message": "hi" }), json!({ "message": "Hello there" })] {
        assert_eq!(anyone.post("/api/v1/public/contact", body.clone()).await.status, 400, "{body}");
    }
    let bot = anyone.post("/api/v1/public/contact", json!({ "email": "a@example.com", "message": "Hello there", "website": "x" })).await;
    assert_eq!((bot.status, bot.body), (200, json!({ "ok": true })));
}

#[tokio::test]
async fn only_staff_read_the_waitlist() {
    let Some(h) = start().await else { return };
    h.anonymous().post("/api/v1/public/waitlist", json!({ "email": "lead@example.com", "name": "Lead", "tier": "solo" })).await;
    assert_eq!(h.anonymous().get("/api/v1/platform/waitlist").await.status, 401);
    let boss = h.client("boss@shop.example", "Shop Boss", true, true);
    boss.post("/api/v1/organizations/trial", json!({ "organization": "Shop Homes" })).await.ok();
    assert_eq!(boss.get("/api/v1/platform/waitlist").await.status, 403, "a customer is not staff");
    sqlx::query("UPDATE users SET platform_role = 'owner' WHERE email = 'boss@shop.example'").execute(&h.owner).await.unwrap();
    let list = boss.get("/api/v1/platform/waitlist").await.ok();
    assert_eq!(list["waitlist"][0]["email"], json!("lead@example.com"));
    assert_eq!(list["waitlist"][0]["tier"], json!("solo"));
}

#[tokio::test]
async fn a_contact_message_is_handed_to_the_notification_service_with_the_inbox_and_the_writer() {
    use std::sync::{Arc, Mutex};
    let Some(mut config) = config(false) else { return };
    let seen: Arc<Mutex<Option<(String, serde_json::Value)>>> = Arc::new(Mutex::new(None));
    let sink = seen.clone();
    let app = axum::Router::new().route(
        "/v1/mail",
        axum::routing::post(move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<serde_json::Value>| {
            let sink = sink.clone();
            async move {
                *sink.lock().unwrap() = Some((headers.get("authorization").unwrap().to_str().unwrap().to_string(), body));
                (axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "ok": true })))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    config.notify_url = format!("http://{}", listener.local_addr().unwrap());
    config.notify_token = "a-token-for-the-test".into();
    // Not set yet: refused before anything is sent.
    assert!(callerwhale_api::mail::send_contact(&config, "Sami", "sami@example.com", "Hello there").await.is_err());
    config.contact_inbox = "hello@example.com".into();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    callerwhale_api::mail::send_contact(&config, "Sami", "sami@example.com", "Hello there").await.unwrap();
    let (auth, body) = seen.lock().unwrap().take().expect("the notification service was called");
    assert_eq!(auth, "Bearer a-token-for-the-test");
    assert_eq!(body, json!({ "template": "contact", "to": "hello@example.com", "data": { "name": "Sami", "email": "sami@example.com", "message": "Hello there" } }));
}
