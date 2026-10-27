//! Turf as a paid service, end to end against real PostgreSQL: sign-up onto the trial, the trial's minute limit,
//! paying for Solo or Business through the signed webhook, seats on invitations, and what an expired plan may still do.

mod common;

use common::*;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

macro_rules! harness {
    () => {
        match start().await {
            Some(h) => h,
            None => return,
        }
    };
}

/// Signs up and passes MFA. Returns the client, the sign-up answer and the TOTP secret.
async fn sign_up(h: &Harness, email: &str, name: &str) -> (Client, Value, String) {
    let client = Client::new(&h.base);
    let answer = client.post("/api/v1/auth/signup", json!({ "email": email, "display_name": name, "password": PASSWORD })).await.ok();
    let setup = client.post("/api/v1/auth/mfa/setup", json!({})).await.ok();
    let secret = setup["secret"].as_str().unwrap().to_string();
    client.post("/api/v1/auth/mfa/confirm", json!({ "code": totp_now(&secret, email) })).await.ok();
    (client, answer, secret)
}

async fn verify(client: &Client, answer: &Value) {
    client.post("/api/v1/auth/verify-email", json!({ "token": answer["verification_token"] })).await.ok();
}

async fn webhook(h: &Harness, event: Value) -> Reply {
    let body = serde_json::to_vec(&event).unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(WEBHOOK_SECRET.as_bytes()).unwrap();
    mac.update(&body);
    let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/billing/webhook", h.base))
        .header("content-type", "application/json")
        .header("x-turf-signature", signature)
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    Reply { status, body: response.json().await.unwrap_or(Value::Null) }
}

/// Buys a plan: checkout, then the provider's signed success event.
async fn buy(h: &Harness, client: &Client, plan: &str, seats: i64) -> Value {
    let checkout = client.post("/api/v1/billing/checkout", json!({ "plan": plan, "seats": seats })).await.ok();
    webhook(
        h,
        json!({ "event_id": format!("evt-{}", checkout["payment_id"].as_str().unwrap()), "type": "payment.succeeded",
                "payment_id": checkout["payment_id"], "amount_cents": checkout["amount_cents"], "provider_ref": "ch_test" }),
    )
    .await
    .ok();
    checkout
}

/// Pushes the period's start back, as if the call had lasted that long.
async fn age_call(h: &Harness, call: &Value, seconds: i64) {
    sqlx::query("UPDATE call_sessions SET started_at = now() - make_interval(secs => $2) WHERE id = $1::uuid")
        .bind(call["call_id"].as_str().unwrap())
        .bind(seconds as f64)
        .execute(&h.owner)
        .await
        .unwrap();
}

#[tokio::test]
async fn sign_up_starts_a_ten_minute_trial_that_needs_sign_in() {
    let h = harness!();
    // Nothing works without signing in.
    let stranger = Client::new(&h.base);
    assert_eq!(stranger.get("/api/v1/leads").await.status, 401);
    assert_eq!(stranger.get("/api/v1/billing").await.status, 401);
    assert_eq!(stranger.post("/api/v1/calls/start", json!({})).await.status, 401);

    let plans = stranger.get("/api/v1/plans").await.ok();
    let keys: Vec<&str> = plans.as_array().unwrap().iter().map(|p| p["key"].as_str().unwrap()).collect();
    assert_eq!(keys, ["trial", "solo", "business"]);

    let (owner, answer, _) = sign_up(&h, "new@example.com", "Nadia Farouk").await;
    assert_eq!(answer["plan"], "trial");
    assert_eq!(answer["minutes"], 10);
    assert!(answer["verification_token"].is_string(), "development servers hand the token back");
    let account = owner.get("/api/v1/billing").await.ok();
    assert_eq!(account["plan"]["key"], "trial");
    assert_eq!(account["minutes_left"], 10);
    assert_eq!(account["seats"], 1);
    assert_eq!(account["can_invite"], false);
    assert_eq!(account["email_verified"], false);

    // The same address cannot sign up twice; weak passwords and bad addresses are refused.
    assert_eq!(stranger.post("/api/v1/auth/signup", json!({ "email": "NEW@example.com", "display_name": "X", "password": PASSWORD })).await.status, 409);
    assert_eq!(stranger.post("/api/v1/auth/signup", json!({ "email": "b@example.com", "display_name": "X", "password": "short" })).await.status, 400);
    assert_eq!(stranger.post("/api/v1/auth/signup", json!({ "email": "not-an-email", "display_name": "X", "password": PASSWORD })).await.status, 400);

    // A verification token works once.
    verify(&owner, &answer).await;
    assert_eq!(owner.post("/api/v1/auth/verify-email", json!({ "token": answer["verification_token"] })).await.status, 403);
    assert_eq!(owner.get("/api/v1/billing").await.ok()["email_verified"], true);
}

#[tokio::test]
async fn trial_minutes_run_out_and_calls_are_timed_by_the_server() {
    let h = harness!();
    let (owner, _, _) = sign_up(&h, "trial@example.com", "Omar Said").await;
    let call = owner.post("/api/v1/calls/start", json!({})).await.ok();
    assert_eq!(call["max_seconds"], 600, "ten minutes left");
    // While that call is open its ten minutes are spoken for.
    let second = owner.post("/api/v1/calls/start", json!({})).await;
    assert_eq!(second.status, 402, "{}", second.body);
    // The call lasted four minutes and a bit; the client cannot say otherwise.
    age_call(&h, &call, 250).await;
    let ended = owner.post(&format!("/api/v1/calls/{}/end", call["call_id"].as_str().unwrap()), json!({ "seconds": 1 })).await.ok();
    assert_eq!(ended["billed_minutes"], 5);
    let again = owner.post(&format!("/api/v1/calls/{}/end", call["call_id"].as_str().unwrap()), json!({})).await.ok();
    assert_eq!(again["already_ended"], true, "ending twice counts once");
    assert_eq!(owner.get("/api/v1/billing").await.ok()["minutes_left"], 5);

    // A call cannot run past what is left: an hour-long call is billed as the five minutes it was allowed.
    let long = owner.post("/api/v1/calls/start", json!({})).await.ok();
    assert_eq!(long["max_seconds"], 300);
    age_call(&h, &long, 3600).await;
    let ended = owner.post(&format!("/api/v1/calls/{}/end", long["call_id"].as_str().unwrap()), json!({})).await.ok();
    assert_eq!(ended["billed_minutes"], 5);
    let account = owner.get("/api/v1/billing").await.ok();
    assert_eq!(account["minutes_left"], 0);
    let refused = owner.post("/api/v1/calls/start", json!({})).await;
    assert_eq!(refused.status, 402);
    assert_eq!(refused.body["error"]["code"], "payment_required");
}

#[tokio::test]
async fn an_ended_trial_locks_the_crm_but_not_billing() {
    let h = harness!();
    let (owner, answer, _) = sign_up(&h, "late@example.com", "Laila Adel").await;
    assert_eq!(owner.get("/api/v1/leads").await.status, 200);
    sqlx::query("UPDATE subscriptions SET period_start = now() - interval '8 days', period_end = now() - interval '1 day' WHERE org_id = $1::uuid")
        .bind(answer["organization_id"].as_str().unwrap())
        .execute(&h.owner)
        .await
        .unwrap();
    let locked = owner.get("/api/v1/leads").await;
    assert_eq!(locked.status, 402);
    assert!(locked.body["error"]["message"].as_str().unwrap().contains("trial has ended"));
    // The owner can still see the account and pay.
    let account = owner.get("/api/v1/billing").await.ok();
    assert_eq!(account["usable"], false);
    verify(&owner, &answer).await;
    buy(&h, &owner, "solo", 1).await;
    assert_eq!(owner.get("/api/v1/leads").await.status, 200, "paying unlocks it at once");
}

#[tokio::test]
async fn solo_gets_five_thousand_minutes_and_cannot_invite() {
    let h = harness!();
    let (owner, answer, _) = sign_up(&h, "solo@example.com", "Sami Nour").await;
    // Paying needs a confirmed address.
    assert_eq!(owner.post("/api/v1/billing/checkout", json!({ "plan": "solo" })).await.status, 403);
    verify(&owner, &answer).await;
    let checkout = buy(&h, &owner, "solo", 1).await;
    assert_eq!(checkout["amount_cents"], 14900);
    assert!(checkout["checkout_url"].as_str().unwrap().starts_with("https://pay.example/checkout?payment="));
    let account = owner.get("/api/v1/billing").await.ok();
    assert_eq!(account["plan"]["key"], "solo");
    assert_eq!(account["status"], "active");
    assert_eq!(account["minutes_left"], 5000);
    assert_eq!(account["account_kind"], "solo");
    assert_eq!(account["payments"][0]["status"], "paid");
    let invite = owner.post("/api/v1/admin/members", json!({ "email": "friend@example.com", "roles": ["caller"] })).await;
    assert_eq!(invite.status, 402);
    assert!(invite.body["error"]["message"].as_str().unwrap().contains("Business"));
    // Solo is one seat.
    assert_eq!(owner.post("/api/v1/billing/checkout", json!({ "plan": "solo", "seats": 2 })).await.status, 400);
}

#[tokio::test]
async fn business_seats_limit_invitations_and_roles_set_privileges() {
    let h = harness!();
    let (owner, answer, _) = sign_up(&h, "boss@example.com", "Hana Mostafa").await;
    verify(&owner, &answer).await;
    assert_eq!(owner.post("/api/v1/billing/checkout", json!({ "plan": "business", "seats": 1 })).await.status, 400, "Business starts at two seats");
    let checkout = buy(&h, &owner, "business", 3).await;
    assert_eq!(checkout["amount_cents"], 3 * 12900);
    let account = owner.get("/api/v1/billing").await.ok();
    assert_eq!(account["minutes_included"], 3 * 4000);
    assert_eq!(account["seats_taken"], 1);

    // Two invitations fill the three seats; a third is refused.
    let caller = owner.post("/api/v1/admin/members", json!({ "email": "caller@example.com", "roles": ["caller"] })).await.ok();
    let researcher = owner.post("/api/v1/admin/members", json!({ "email": "researcher@example.com", "roles": ["researcher"] })).await.ok();
    let full = owner.post("/api/v1/admin/members", json!({ "email": "extra@example.com", "roles": ["caller"] })).await;
    assert_eq!(full.status, 402);
    assert!(full.body["error"]["message"].as_str().unwrap().contains("3 seats"));

    let agent = Client::new(&h.base);
    agent.post("/api/v1/auth/invitations/accept", json!({ "token": caller["token"], "display_name": "Maya Chen", "password": PASSWORD })).await.ok();
    let analyst = Client::new(&h.base);
    analyst.post("/api/v1/auth/invitations/accept", json!({ "token": researcher["token"], "display_name": "Ben Carter", "password": PASSWORD })).await.ok();

    // Privileges follow the role: a caller can call but not manage the plan; a researcher cannot call.
    assert_eq!(agent.post("/api/v1/billing/checkout", json!({ "plan": "business", "seats": 5 })).await.status, 403);
    assert_eq!(agent.get("/api/v1/billing").await.ok()["payments"], json!([]), "amounts are for owners and administrators");
    let call = agent.post("/api/v1/calls/start", json!({})).await.ok();
    assert_eq!(call["max_seconds"], 4 * 3600, "a call is capped at four hours");
    assert_eq!(analyst.post("/api/v1/calls/start", json!({})).await.status, 403);
    // Someone else's call cannot be ended (or billed) by another member.
    assert_eq!(analyst.post(&format!("/api/v1/calls/{}/end", call["call_id"].as_str().unwrap()), json!({})).await.status, 404);

    // Fewer seats than members is refused.
    assert_eq!(owner.post("/api/v1/billing/checkout", json!({ "plan": "business", "seats": 2 })).await.status, 400);
}

#[tokio::test]
async fn webhooks_must_be_signed_matching_and_count_once() {
    let h = harness!();
    let (owner, answer, _) = sign_up(&h, "pay@example.com", "Karim Fathy").await;
    verify(&owner, &answer).await;
    let checkout = owner.post("/api/v1/billing/checkout", json!({ "plan": "solo" })).await.ok();
    let event = json!({ "event_id": "evt-1", "type": "payment.succeeded", "payment_id": checkout["payment_id"], "amount_cents": 14900 });

    // Unsigned or wrongly signed: refused, nothing changes.
    let unsigned = reqwest::Client::new().post(format!("{}/api/v1/billing/webhook", h.base)).json(&event).send().await.unwrap();
    assert_eq!(unsigned.status().as_u16(), 403);
    let forged = reqwest::Client::new()
        .post(format!("{}/api/v1/billing/webhook", h.base))
        .header("x-turf-signature", "sha256=00ff")
        .json(&event)
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status().as_u16(), 403);
    // A wrong amount is refused.
    let cheap = webhook(&h, json!({ "event_id": "evt-0", "type": "payment.succeeded", "payment_id": checkout["payment_id"], "amount_cents": 100 })).await;
    assert_eq!(cheap.status, 400);
    assert_eq!(owner.get("/api/v1/billing").await.ok()["plan"]["key"], "trial");

    assert_eq!(webhook(&h, event.clone()).await.ok()["status"], "paid");
    assert_eq!(webhook(&h, event).await.ok()["duplicate"], true, "a retried event acts once");
    assert_eq!(owner.get("/api/v1/billing").await.ok()["plan"]["key"], "solo");
}

#[tokio::test]
async fn organizations_never_see_each_others_billing() {
    let h = harness!();
    let (first, answer, _) = sign_up(&h, "first@example.com", "First Owner").await;
    verify(&first, &answer).await;
    let checkout = buy(&h, &first, "solo", 1).await;
    let (second, _, _) = sign_up(&h, "second@example.com", "Second Owner").await;
    let account = second.get("/api/v1/billing").await.ok();
    assert_eq!(account["plan"]["key"], "trial");
    assert_eq!(account["payments"], json!([]));
    let call = first.post("/api/v1/calls/start", json!({})).await.ok();
    // Another organization's call is invisible to it.
    assert_eq!(second.post(&format!("/api/v1/calls/{}/end", call["call_id"].as_str().unwrap()), json!({})).await.status, 404);
    let _ = checkout;
}
