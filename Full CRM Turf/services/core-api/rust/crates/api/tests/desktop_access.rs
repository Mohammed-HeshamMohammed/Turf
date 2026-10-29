//! Desktop access by invitation (migration 0014): only people Turf's staff invited get a dashboard, the download and a
//! workspace, and their metered usage stays within the monthly credits staff set. Runs against real PostgreSQL.

mod common;

use common::*;
use serde_json::json;

/// The platform owner, set the only way there is: on the server, with the owning database role.
async fn platform_owner(h: &Harness) -> Client {
    let owner = h.firebase_client("owner-uid", "owner@turf.example", Some("App Owner"), true, true);
    owner.get("/api/v1/me").await.ok();
    sqlx::query("UPDATE users SET platform_role = 'owner' WHERE email = 'owner@turf.example'").execute(&h.owner).await.unwrap();
    owner
}

async fn invite(owner: &Client, email: &str, credits: i64) -> String {
    let made = owner.post("/api/v1/platform/invitations", json!({ "email": email, "name": "Sam Lee", "monthly_credits": credits })).await.ok();
    assert_eq!(made["emailed"], false, "no mail server in tests");
    assert!(made["email_error"].as_str().unwrap().contains("TURF_SMTP_HOST"));
    made["invitation"]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn only_invited_people_get_a_dashboard_and_a_workspace() {
    let Some(h) = start_closed().await else { return };
    let owner = platform_owner(&h).await;

    // Someone who just signed up, with nobody's invitation: an account, and nothing else.
    let stranger = h.firebase_client("stranger-uid", "stranger@example.com", Some("Stranger"), false, true);
    let account = stranger.get("/api/v1/account").await.ok();
    assert_eq!(account["access"], json!(null));
    assert_eq!(account["can_download"], false);
    assert_eq!(account["staff"], json!(null));
    assert_eq!(stranger.get("/api/v1/me").await.ok()["organizations"], json!([]));
    assert_eq!(stranger.post("/api/v1/account/download", json!({})).await.status, 403);
    // They cannot open a workspace themselves either, and the staff pages stay shut.
    assert_eq!(stranger.post("/api/v1/organizations/trial", json!({ "organization": "Mine" })).await.status, 403);
    assert_eq!(stranger.get("/api/v1/platform/invitations").await.status, 403);
    assert_eq!(stranger.post("/api/v1/platform/invitations", json!({ "email": "me@example.com", "monthly_credits": 5 })).await.status, 403);

    let id = invite(&owner, "Sam@Example.com", 100).await;
    let listed = owner.get("/api/v1/platform/invitations").await.ok();
    assert_eq!(listed["invitations"][0]["email"], "sam@example.com");
    assert_eq!(listed["invitations"][0]["status"], "invited");
    assert_eq!(listed["invitations"][0]["registered"], false);
    assert_eq!(listed["totals"]["invited"], 1);
    // The same person twice is refused.
    assert_eq!(owner.post("/api/v1/platform/invitations", json!({ "email": "sam@example.com", "monthly_credits": 1 })).await.status, 409);
    assert_eq!(owner.post("/api/v1/platform/invitations", json!({ "email": "not-an-email", "monthly_credits": 1 })).await.status, 400);
    assert_eq!(owner.post("/api/v1/platform/invitations", json!({ "email": "x@example.com", "monthly_credits": -1 })).await.status, 400);

    // Someone made a password account with Sam's address but never confirmed it: the invitation waits.
    let squatter = h.firebase_client("sam-unconfirmed", "sam@example.com", Some("Not Sam"), false, false);
    let waiting = squatter.get("/api/v1/account").await.ok();
    assert_eq!(waiting["access"]["status"], "unverified");
    assert_eq!(waiting["can_download"], false);
    assert_eq!(squatter.get("/api/v1/me").await.ok()["organizations"], json!([]));

    // Once the address is confirmed (a fresh token says so), the invitation opens Sam's own workspace.
    let sam = h.firebase_client("sam-unconfirmed", "sam@example.com", Some("Sam Lee"), false, true);
    let account = sam.get("/api/v1/account").await.ok();
    assert_eq!(account["access"]["status"], "active");
    assert_eq!(account["access"]["monthly_credits"], 100);
    assert_eq!(account["access"]["used_this_month"], 0);
    assert_eq!(account["can_download"], true);
    let me = sam.get("/api/v1/me").await.ok();
    let orgs = me["organizations"].as_array().unwrap();
    assert_eq!(orgs.len(), 1);
    assert_eq!(orgs[0]["name"], "Sam Lee's workspace");
    // Visiting again does not open a second one.
    sam.get("/api/v1/account").await.ok();
    assert_eq!(sam.get("/api/v1/me").await.ok()["organizations"].as_array().unwrap().len(), 1);
    // The workspace works: Sam can use the CRM in it (this server asks owners for their authenticator code).
    let sam = h.firebase_client("sam-unconfirmed", "sam@example.com", Some("Sam Lee"), true, true);
    sam.set_org(orgs[0]["id"].as_str().unwrap());
    assert_eq!(sam.get("/api/v1/leads").await.status, 200);

    let listed = owner.get("/api/v1/platform/invitations").await.ok();
    assert_eq!(listed["invitations"][0]["status"], "active");
    assert_eq!(listed["invitations"][0]["registered"], true);
    // An accepted invitation is suspended, not withdrawn, so its usage is kept.
    assert_eq!(owner.delete(&format!("/api/v1/platform/invitations/{id}")).await.status, 409);
}

#[tokio::test]
async fn credits_are_spent_once_and_never_beyond_the_limit() {
    let Some(h) = start_closed().await else { return };
    let owner = platform_owner(&h).await;
    let id = invite(&owner, "caller@example.com", 100).await;
    let person = h.firebase_client("caller-uid", "caller@example.com", Some("Caller"), false, true);
    person.get("/api/v1/account").await.ok();

    let request = uuid::Uuid::new_v4();
    let spent = person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 60, "request_id": request, "detail": "Tampa list" })).await.ok();
    assert_eq!((spent["used_this_month"].as_i64(), spent["remaining"].as_i64()), (Some(60), Some(40)));
    // The same request again (a retry) is counted once.
    let again = person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 60, "request_id": request })).await.ok();
    assert_eq!(again["used_this_month"], 60);
    // More than what is left is refused, and nothing is spent.
    let over = person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 41, "request_id": uuid::Uuid::new_v4() })).await;
    assert_eq!(over.status, 402);
    assert!(over.body["error"]["message"].as_str().unwrap().contains("40 left"));
    person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 40, "request_id": uuid::Uuid::new_v4() })).await.ok();
    assert_eq!(person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 1, "request_id": uuid::Uuid::new_v4() })).await.status, 402);
    // Nonsense is refused.
    assert_eq!(person.post("/api/v1/credits/use", json!({ "kind": "free_money", "credits": 1, "request_id": uuid::Uuid::new_v4() })).await.status, 400);
    assert_eq!(person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 0, "request_id": uuid::Uuid::new_v4() })).await.status, 400);

    // Staff see the usage, by day and in the latest actions.
    let report = owner.get(&format!("/api/v1/platform/invitations/{id}/usage")).await.ok();
    assert_eq!(report["invitation"]["used_this_month"], 100);
    assert_eq!(report["usage"]["kinds"], json!([{ "kind": "skip_trace", "credits": 100 }]));
    assert_eq!(report["usage"]["recent"].as_array().unwrap().len(), 2);
    assert_eq!(report["usage"]["recent"][1]["detail"], "Tampa list");
    // The person sees the same on their dashboard.
    let account = person.get("/api/v1/account").await.ok();
    assert_eq!((account["access"]["used_this_month"].as_i64(), account["access"]["remaining"].as_i64()), (Some(100), Some(0)));

    // Raising the limit lets them carry on.
    owner.patch(&format!("/api/v1/platform/invitations/{id}"), json!({ "monthly_credits": 150 })).await.ok();
    let more = person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 50, "request_id": uuid::Uuid::new_v4() })).await.ok();
    assert_eq!(more["remaining"], 0);

    // Someone who was not invited this way has no credit limit here (Turf's staff).
    assert_eq!(owner.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 5, "request_id": uuid::Uuid::new_v4() })).await.ok()["limited"], false);
}

#[tokio::test]
async fn suspending_someone_shuts_them_out_at_once() {
    let Some(h) = start_closed().await else { return };
    let owner = platform_owner(&h).await;
    let id = invite(&owner, "temp@example.com", 10).await;
    // Not accepted yet: it can only be withdrawn.
    assert_eq!(owner.patch(&format!("/api/v1/platform/invitations/{id}"), json!({ "status": "active" })).await.status, 400);
    let person = h.firebase_client("temp-uid", "temp@example.com", None, false, true);
    person.get("/api/v1/account").await.ok();

    let suspended = owner.patch(&format!("/api/v1/platform/invitations/{id}"), json!({ "status": "suspended" })).await.ok();
    assert_eq!(suspended["invitation"]["status"], "suspended");
    // Every request they make is refused now: the website, the desktop app and its credits alike.
    assert_eq!(person.get("/api/v1/account").await.status, 401);
    assert_eq!(person.get("/api/v1/me").await.status, 401);
    assert_eq!(person.post("/api/v1/credits/use", json!({ "kind": "skip_trace", "credits": 1, "request_id": uuid::Uuid::new_v4() })).await.status, 401);
    // Resending to a suspended person is refused.
    assert_eq!(owner.post(&format!("/api/v1/platform/invitations/{id}/resend"), json!({})).await.status, 400);

    owner.patch(&format!("/api/v1/platform/invitations/{id}"), json!({ "status": "active" })).await.ok();
    assert_eq!(person.get("/api/v1/account").await.ok()["access"]["status"], "active");

    // Staff's changes are kept in the activity log.
    let activity = owner.get("/api/v1/platform/activity").await.ok();
    let actions: Vec<&str> = activity["events"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert!(actions.contains(&"access.invited") && actions.contains(&"access.changed"), "{actions:?}");
}

#[tokio::test]
async fn an_invitation_not_yet_accepted_can_be_withdrawn() {
    let Some(h) = start_closed().await else { return };
    let owner = platform_owner(&h).await;
    let id = invite(&owner, "maybe@example.com", 10).await;
    owner.delete(&format!("/api/v1/platform/invitations/{id}")).await.ok();
    // They sign up later: nothing is waiting for them.
    let person = h.firebase_client("maybe-uid", "maybe@example.com", None, false, true);
    assert_eq!(person.get("/api/v1/account").await.ok()["access"], json!(null));
}

#[tokio::test]
async fn staff_need_the_authenticator_code() {
    let Some(h) = start_closed().await else { return };
    platform_owner(&h).await;
    // The owner, signed in again without the authenticator step.
    let owner = h.firebase_client("owner-uid", "owner@turf.example", Some("App Owner"), false, true);
    let refused = owner.get("/api/v1/platform/invitations").await;
    assert_eq!((refused.status, refused.body["error"]["code"].as_str()), (401, Some("mfa_required")));
    // Their dashboard says they are staff, and that the code is still needed.
    let account = owner.get("/api/v1/account").await.ok();
    assert_eq!(account["staff"]["role"], "owner");
    assert_eq!(account["staff"]["mfa_passed"], false);
}

#[tokio::test]
async fn staff_get_a_workspace_of_their_own_the_first_time_they_sign_in() {
    let Some(h) = start_closed().await else { return };
    let owner = platform_owner(&h).await;
    // Staff are never invited: their first visit opens a workspace with no plan, which the desktop app then opens.
    owner.get("/api/v1/account").await.ok();
    let me = owner.get("/api/v1/me").await.ok();
    let orgs = me["organizations"].as_array().unwrap();
    assert_eq!(orgs.len(), 1);
    assert_eq!(orgs[0]["name"], "App Owner's workspace");
    // Coming back (the website, then the app) never makes a second one.
    owner.get("/api/v1/account").await.ok();
    assert_eq!(owner.get("/api/v1/me").await.ok()["organizations"].as_array().unwrap().len(), 1);
    owner.set_org(orgs[0]["id"].as_str().unwrap());
    assert_eq!(owner.get("/api/v1/leads").await.status, 200);
    // Someone who is not staff and not invited still gets nothing.
    let stranger = h.firebase_client("nobody-uid", "nobody@example.com", None, false, true);
    stranger.get("/api/v1/account").await.ok();
    assert_eq!(stranger.get("/api/v1/me").await.ok()["organizations"], json!([]));
}
