//! Signing in with Firebase Authentication (docs/plans/firebase-auth.md, phase 1). Its ID tokens carry a Firebase uid;
//! this server keeps its own ids and finds people by users.firebase_uid. Runs against real PostgreSQL.

mod common;

use common::*;
use serde_json::json;

async fn firebase_uid_of(h: &Harness, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT firebase_uid FROM users WHERE id = $1::uuid").bind(id).fetch_one(&h.owner).await.unwrap()
}

#[tokio::test]
async fn a_firebase_sign_in_is_a_person_here() {
    let Some(h) = start().await else { return };
    let ann = h.firebase_client("fbAnn0001", "Ann@Example.com", Some("Ann Lee"), false, true);
    let me = ann.get("/api/v1/me").await.ok();
    assert_eq!((me["user"]["email"].as_str(), me["user"]["name"].as_str()), (Some("ann@example.com"), Some("Ann Lee")));
    let id = me["user"]["id"].as_str().unwrap().to_string();
    assert_eq!(firebase_uid_of(&h, &id).await.as_deref(), Some("fbAnn0001"));
    // The same uid is the same person on every later request.
    assert_eq!(ann.get("/api/v1/me").await.ok()["user"]["id"], id.as_str());
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    assert!(verified);

    // No name in the token (an email and password account): the start of the email.
    let bob = h.firebase_client("fbBob0001", "bob@example.com", None, false, false);
    assert_eq!(bob.get("/api/v1/me").await.ok()["user"]["name"], "bob");

    // Without access a Firebase account opens nothing, like any other account.
    assert_eq!(ann.get("/api/v1/me").await.ok()["organizations"], json!([]));
    assert_eq!(ann.get("/api/v1/leads").await.status, 400);
}

#[tokio::test]
async fn an_account_moved_from_the_auth_service_keeps_its_id_and_workspace() {
    let Some(h) = start().await else { return };
    let w = world(&h).await;
    let id = w.id("caller");
    let email: String = sqlx::query_scalar("SELECT email::text FROM users WHERE id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    // Imported into Firebase with their id as their uid: the first Firebase sign-in links them.
    let moved = h.firebase_client(&id, &email, Some("Caller"), false, true);
    moved.set_org(&w.org);
    assert_eq!(moved.get("/api/v1/me").await.ok()["user"]["id"], id.as_str());
    assert_eq!(moved.get("/api/v1/leads").await.status, 200);
    assert_eq!(firebase_uid_of(&h, &id).await.as_deref(), Some(id.as_str()));
    // The old token still works until the switch-over.
    assert_eq!(w.client("caller").get("/api/v1/leads").await.status, 200);
}

#[tokio::test]
async fn a_new_uid_cannot_take_over_an_existing_email() {
    let Some(h) = start().await else { return };
    let w = world(&h).await;
    let id = w.id("caller");
    let email: String = sqlx::query_scalar("SELECT email::text FROM users WHERE id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    let other = h.firebase_client("fbSomeoneElse", &email, Some("Not The Caller"), true, true);
    assert_eq!(other.get("/api/v1/me").await.status, 409);
    assert_eq!(firebase_uid_of(&h, &id).await, None, "not linked to the stranger");
    // Nor can a uid shaped like someone's id claim it once that account is linked to another uid.
    sqlx::query("UPDATE users SET firebase_uid = 'fbRealCaller' WHERE id = $1::uuid").bind(&id).execute(&h.owner).await.unwrap();
    let squatter = h.firebase_client(&id, "squatter@example.com", None, true, true);
    let me = squatter.get("/api/v1/me").await.ok();
    assert_ne!(me["user"]["id"], id.as_str());
}

#[tokio::test]
async fn staff_signed_in_with_firebase_still_need_the_authenticator_code() {
    let Some(h) = start_without_mfa().await else { return };
    let staff = h.firebase_client("fbStaff0001", "staff@turf.example", Some("Staff"), false, true);
    staff.get("/api/v1/me").await.ok();
    sqlx::query("UPDATE users SET platform_role = 'admin' WHERE firebase_uid = 'fbStaff0001'").execute(&h.owner).await.unwrap();
    assert_eq!(staff.get("/api/v1/platform/organizations").await.body["error"]["code"], "mfa_required");
    let with_code = h.firebase_client("fbStaff0001", "staff@turf.example", Some("Staff"), true, true);
    assert_eq!(with_code.get("/api/v1/platform/organizations").await.status, 200);
}

#[tokio::test]
async fn a_broken_firebase_token_is_refused() {
    let Some(h) = start().await else { return };
    let token = firebase_token("fbAnn0001", "ann@example.com", None, false, true);
    let mut parts: Vec<&str> = token.split('.').collect();
    parts[2] = "AAAA";
    let status = reqwest::Client::new().get(format!("{}/api/v1/me", h.base)).bearer_auth(parts.join(".")).send().await.unwrap().status();
    assert_eq!(status, 401);
}
