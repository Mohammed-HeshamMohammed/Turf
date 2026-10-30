//! Who can run Caller Whale, and the admin dashboard's API. Nobody becomes the platform owner or a system administrator by
//! signing up, by an invitation or through the API; the highest a customer can be is the business owner of the
//! workspace they opened. The owner names staff; staff manage customers. Runs against real PostgreSQL.

mod common;

use common::*;
use serde_json::json;

/// A person with a trial workspace of their own, acting in it.
async fn customer(h: &Harness, email: &str, name: &str) -> (Client, String) {
    let c = h.client(email, name, true, true);
    let org = c.post("/api/v1/organizations/trial", json!({ "organization": format!("{name} Homes") })).await.ok()["organization_id"].as_str().unwrap().to_string();
    c.set_org(&org);
    (c, org)
}

/// The platform owner, set the only way there is: on the server, with the owning database role.
async fn platform_owner(h: &Harness) -> (Client, String) {
    let (owner, org) = customer(h, "owner@callerwhale.example", "App Owner").await;
    sqlx::query("UPDATE users SET platform_role = 'owner' WHERE email = 'owner@callerwhale.example'").execute(&h.owner).await.unwrap();
    (owner, org)
}

#[tokio::test]
async fn nobody_can_make_themselves_staff_or_owner() {
    let Some(h) = start().await else { return };
    let (boss, _) = customer(&h, "boss@shop.example", "Shop Boss").await;
    // The person who opened the workspace is its business owner, and that is all.
    let me = boss.get("/api/v1/me").await.ok();
    assert_eq!(me["roles"], json!(["owner"]));
    assert_eq!(me["platform_role"], json!(null));
    assert!(me["capabilities"].as_array().unwrap().contains(&json!("admin")), "the business owner manages access");

    // The API's own database login can never give a platform role, even by writing SQL directly.
    let api = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap()).await.unwrap();
    for role in ["admin", "owner"] {
        let direct = sqlx::query("UPDATE users SET platform_role = $1 WHERE email = 'boss@shop.example'").bind(role).execute(&api).await;
        assert!(direct.is_err(), "{role}");
    }
    // Nor can anyone but the platform owner use the function that names staff.
    let boss_id: uuid::Uuid = uuid::Uuid::parse_str(&boss.id).unwrap();
    assert!(sqlx::query("SELECT callerwhale_platform_set_role($1, $1, 'admin')").bind(boss_id).execute(&api).await.is_err());

    // Inside the workspace: no "System administrator", and the owner role cannot be handed out.
    assert_eq!(boss.post("/api/v1/admin/members", json!({ "email": "a@shop.example", "roles": ["admin"] })).await.status, 400);
    assert_eq!(boss.post("/api/v1/admin/members", json!({ "email": "a@shop.example", "roles": ["owner"] })).await.status, 403);
    assert_eq!(boss.post("/api/v1/admin/members", json!({ "email": "a@shop.example", "roles": ["solo"] })).await.status, 403);
    // No custom role may manage access, and the owner's own role cannot be rewritten.
    assert_eq!(boss.put("/api/v1/admin/roles/deputy", json!({ "capabilities": ["edit", "admin"] })).await.status, 403);
    assert_eq!(boss.put("/api/v1/admin/roles/owner", json!({ "capabilities": ["edit"] })).await.status, 403);
    assert_eq!(boss.put("/api/v1/admin/roles/admin", json!({ "capabilities": ["admin"] })).await.status, 403);
    // The platform dashboard stays shut.
    assert_eq!(boss.get("/api/v1/platform/organizations").await.status, 403);
    assert_eq!(boss.post("/api/v1/platform/staff", json!({ "email": "boss@shop.example", "role": "admin" })).await.status, 403);
}

#[tokio::test]
async fn in_a_business_workspace_only_the_owner_manages_access() {
    let Some(h) = start().await else { return };
    let w = world(&h).await;
    let manager = w.client("manager");
    // The owner cannot be demoted or removed, by anyone.
    let owner_id = w.owner.id.clone();
    assert_eq!(w.owner.patch(&format!("/api/v1/admin/members/{owner_id}"), json!({ "roles": ["caller"] })).await.status, 403);
    // A manager has no access management at all.
    assert_eq!(manager.post("/api/v1/admin/members", json!({ "email": "x@example.com", "roles": ["caller"] })).await.status, 403);
    assert_eq!(manager.patch(&format!("/api/v1/admin/members/{owner_id}"), json!({ "roles": ["caller"] })).await.status, 403);
    // A member cannot be promoted to owner.
    assert_eq!(w.owner.patch(&format!("/api/v1/admin/members/{}", w.id("manager")), json!({ "roles": ["owner"] })).await.status, 403);
    // The owner changes everyone else's roles as before.
    w.owner.patch(&format!("/api/v1/admin/members/{}", w.id("caller")), json!({ "roles": ["closer"] })).await.ok();
}

#[tokio::test]
async fn the_owner_names_staff_and_staff_cannot_name_more() {
    let Some(h) = start().await else { return };
    let (owner, _) = platform_owner(&h).await;
    let (helper, _) = customer(&h, "helper@callerwhale.example", "Support Person").await;
    let (_shop, _) = customer(&h, "shop@client.example", "Client Shop").await;

    assert_eq!(owner.get("/api/v1/platform/organizations").await.ok()["you"], "owner");
    assert_eq!(owner.post("/api/v1/platform/staff", json!({ "email": "nobody@example.com", "role": "admin" })).await.status, 404);
    assert_eq!(owner.post("/api/v1/platform/staff", json!({ "email": "helper@callerwhale.example", "role": "owner" })).await.status, 403, "the owner role is never given");
    owner.post("/api/v1/platform/staff", json!({ "email": "Helper@callerwhale.example", "role": "admin" })).await.ok();
    assert_eq!(helper.get("/api/v1/me").await.ok()["platform_role"], "admin");
    assert_eq!(helper.get("/api/v1/platform/organizations").await.ok()["you"], "admin");

    // A system administrator cannot name staff, set plans, or touch the owner.
    assert_eq!(helper.post("/api/v1/platform/staff", json!({ "email": "shop@client.example", "role": "admin" })).await.status, 403);
    let staff = helper.get("/api/v1/platform/staff").await.ok();
    assert_eq!(staff["staff"].as_array().unwrap().len(), 2);
    assert_eq!(helper.post(&format!("/api/v1/platform/people/{}/access", owner.id), json!({ "disabled": true })).await.status, 403);
    assert_eq!(owner.post(&format!("/api/v1/platform/people/{}/access", owner.id), json!({ "disabled": true })).await.status, 400);

    // The owner removes staff again.
    owner.post("/api/v1/platform/staff", json!({ "email": "helper@callerwhale.example", "role": null })).await.ok();
    assert_eq!(helper.get("/api/v1/platform/organizations").await.status, 403);
    let events = owner.get("/api/v1/platform/activity").await.ok();
    let actions: Vec<&str> = events["events"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert_eq!(actions, ["staff.removed", "staff.added"]);
}

#[tokio::test]
async fn staff_manage_customer_workspaces_and_people() {
    let Some(h) = start().await else { return };
    let (owner, _) = platform_owner(&h).await;
    let (helper, _) = customer(&h, "helper@callerwhale.example", "Support Person").await;
    owner.post("/api/v1/platform/staff", json!({ "email": "helper@callerwhale.example", "role": "admin" })).await.ok();
    let (shop, shop_org) = customer(&h, "shop@client.example", "Client Shop").await;

    // Suspending a workspace shuts it for its people at once; reactivating opens it again.
    helper.post(&format!("/api/v1/platform/organizations/{shop_org}/suspend"), json!({ "suspended": true, "reason": "chargeback" })).await.ok();
    assert_eq!(shop.get("/api/v1/leads").await.status, 403);
    assert_eq!(shop.get("/api/v1/billing").await.status, 403);
    let overview = helper.get("/api/v1/platform/organizations").await.ok();
    assert_eq!(overview["totals"]["suspended"], 1);
    helper.post(&format!("/api/v1/platform/organizations/{shop_org}/suspend"), json!({ "suspended": false })).await.ok();
    assert_eq!(shop.get("/api/v1/leads").await.status, 200);

    // Staff can extend an expired trial; only the owner sets a plan or removes the limits.
    sqlx::query("UPDATE subscriptions SET period_start = now() - interval '8 days', period_end = now() - interval '1 day' WHERE org_id = $1::uuid")
        .bind(&shop_org)
        .execute(&h.owner)
        .await
        .unwrap();
    assert_eq!(shop.get("/api/v1/leads").await.status, 402);
    helper.post(&format!("/api/v1/platform/organizations/{shop_org}/subscription"), json!({ "action": "extend", "days": 7 })).await.ok();
    assert_eq!(shop.get("/api/v1/leads").await.status, 200);
    assert_eq!(helper.post(&format!("/api/v1/platform/organizations/{shop_org}/subscription"), json!({ "action": "unlimited" })).await.status, 403);
    assert_eq!(helper.post(&format!("/api/v1/platform/organizations/{shop_org}/subscription"), json!({ "action": "set", "plan": "business", "seats": 5, "days": 30 })).await.status, 403);
    owner.post(&format!("/api/v1/platform/organizations/{shop_org}/subscription"), json!({ "action": "set", "plan": "business", "seats": 5, "days": 30 })).await.ok();
    let billing = shop.get("/api/v1/billing").await.ok();
    assert_eq!((billing["plan"]["key"].as_str(), billing["seats"].as_i64()), (Some("business"), Some(5)));
    owner.post(&format!("/api/v1/platform/organizations/{shop_org}/subscription"), json!({ "action": "unlimited" })).await.ok();
    assert_eq!(helper.get("/api/v1/platform/organizations").await.ok()["organizations"].as_array().unwrap().iter().find(|o| o["id"] == shop_org.as_str()).unwrap()["plan"], json!(null));

    // Turning a customer's access off refuses them everywhere here.
    let found = helper.get("/api/v1/platform/people?q=client.example").await.ok();
    assert_eq!(found["people"].as_array().unwrap().len(), 1);
    assert_eq!(found["people"][0]["workspaces"][0]["roles"], json!(["owner"]));
    helper.post(&format!("/api/v1/platform/people/{}/access", shop.id), json!({ "disabled": true })).await.ok();
    assert_eq!(shop.get("/api/v1/me").await.status, 401);
    helper.post(&format!("/api/v1/platform/people/{}/access", shop.id), json!({ "disabled": false })).await.ok();
    assert_eq!(shop.get("/api/v1/me").await.status, 200);
    // But not another member of staff's: only the owner can do that.
    assert_eq!(helper.post(&format!("/api/v1/platform/people/{}/access", helper.id), json!({ "disabled": true })).await.status, 400);
}

#[tokio::test]
async fn staff_get_a_workspace_without_limits() {
    let Some(h) = start().await else { return };
    let (owner, _) = platform_owner(&h).await;
    let staffer = h.client("team@callerwhale.example", "Caller Whale Team", true, true);
    staffer.get("/api/v1/me").await.ok();
    owner.post("/api/v1/platform/staff", json!({ "email": "team@callerwhale.example", "role": "admin" })).await.ok();

    let org = staffer.post("/api/v1/platform/workspace", json!({ "organization": "Caller Whale Calling Floor" })).await.ok()["organization_id"].as_str().unwrap().to_string();
    staffer.set_org(&org);
    assert_eq!(staffer.post("/api/v1/platform/workspace", json!({ "organization": "Again" })).await.status, 409);
    let billing = staffer.get("/api/v1/billing").await.ok();
    assert_eq!(billing["plan"], json!(null), "no plan, so no limits: {billing}");
    // As many callers as they like: more than any plan's seats would allow.
    let team = staffer.get("/api/v1/admin/teams").await.ok()[0]["id"].as_str().unwrap().to_string();
    for n in 0..6 {
        let email = format!("caller{n}@callerwhale.example");
        let invite = staffer.post("/api/v1/admin/members", json!({ "email": email, "roles": ["caller"], "team_ids": [team] })).await.ok();
        h.client(&email, "Caller", false, true).post("/api/v1/invitations/join", json!({ "token": invite["token"] })).await.ok();
    }
    assert_eq!(staffer.get("/api/v1/admin/members").await.ok()["members"].as_array().unwrap().len(), 7);
    assert_eq!(staffer.post("/api/v1/calls/start", json!({})).await.status, 200, "no minute limit either");

    // A customer cannot open one.
    let (shop, _) = customer(&h, "shop@client.example", "Client Shop").await;
    assert_eq!(shop.post("/api/v1/platform/workspace", json!({ "organization": "Free stuff" })).await.status, 403);
}

#[tokio::test]
async fn staff_always_need_the_authenticator_code() {
    // Even on a server that asks nobody else for one.
    let Some(h) = start_without_mfa().await else { return };
    let (owner, _) = platform_owner(&h).await;
    owner.reissue(false, true);
    for path in ["/api/v1/platform/organizations", "/api/v1/platform/people", "/api/v1/platform/payments", "/api/v1/platform/staff", "/api/v1/platform/activity"] {
        assert_eq!(owner.get(path).await.body["error"]["code"], "mfa_required", "{path}");
    }
    assert_eq!(owner.post("/api/v1/platform/staff", json!({ "email": "x@example.com", "role": "admin" })).await.status, 401);
    assert_eq!(owner.get("/api/v1/leads").await.body["error"]["code"], "mfa_required", "also in their own workspace");
    owner.reissue(true, true);
    assert_eq!(owner.get("/api/v1/platform/organizations").await.status, 200);
}

#[tokio::test]
async fn whoami_answers_only_for_staff() {
    let Some(h) = start_without_mfa().await else { return };
    let (owner, _) = platform_owner(&h).await;
    let (helper, _) = customer(&h, "helper@callerwhale.example", "Support Person").await;
    let (boss, _) = customer(&h, "boss@shop.example", "Shop Boss").await;
    owner.post("/api/v1/platform/staff", json!({ "email": "helper@callerwhale.example", "role": "admin" })).await.ok();

    // No organization is needed: the login proxy only knows the person.
    owner.clear_org();
    let me = owner.get("/api/v1/platform/whoami").await.ok();
    assert_eq!(me, json!({ "id": owner.id, "email": "owner@callerwhale.example", "name": "App Owner", "role": "owner" }));
    assert_eq!(helper.get("/api/v1/platform/whoami").await.ok()["role"], "admin");

    // A business owner is not staff, and nobody without a token is anyone.
    assert_eq!(boss.get("/api/v1/platform/whoami").await.status, 403);
    assert_eq!(h.anonymous().get("/api/v1/platform/whoami").await.status, 401);

    // Staff without the authenticator step are refused, even on a server that asks nobody else for it.
    helper.reissue(false, true);
    assert_eq!(helper.get("/api/v1/platform/whoami").await.body["error"]["code"], "mfa_required");
    helper.reissue(true, true);

    // Turned off, or no longer staff: refused at once.
    owner.post(&format!("/api/v1/platform/people/{}/access", helper.id), json!({ "disabled": true })).await.ok();
    assert!(helper.get("/api/v1/platform/whoami").await.status >= 401);
    owner.post(&format!("/api/v1/platform/people/{}/access", helper.id), json!({ "disabled": false })).await.ok();
    assert_eq!(helper.get("/api/v1/platform/whoami").await.status, 200);
    owner.post("/api/v1/platform/staff", json!({ "email": "helper@callerwhale.example", "role": null })).await.ok();
    assert_eq!(helper.get("/api/v1/platform/whoami").await.status, 403);
}

#[tokio::test]
async fn a_members_access_can_have_an_end_date() {
    let Some(h) = start().await else { return };
    let w = world(&h).await;
    let caller = w.client("caller");
    let id = w.id("caller");
    assert_eq!(caller.get("/api/v1/leads").await.status, 200);

    // A period from now: still open, and shown on the member.
    w.owner.patch(&format!("/api/v1/admin/members/{id}"), json!({ "access_days": 14 })).await.ok();
    let members = w.owner.get("/api/v1/admin/members").await.ok();
    let row = members["members"].as_array().unwrap().iter().find(|m| m["user_id"] == id.as_str()).unwrap().clone();
    assert!(row["expires_at"].is_string() && row["expired"] == false);
    assert_eq!(caller.get("/api/v1/leads").await.status, 200);

    // Once it is over, the workspace opens nothing for them and does not list them as a member of it.
    sqlx::query("UPDATE memberships SET expires_at = now() - interval '1 minute' WHERE user_id = $1::uuid").bind(&id).execute(&h.owner).await.unwrap();
    assert_eq!(caller.get("/api/v1/leads").await.status, 400);
    assert_eq!(caller.get("/api/v1/me").await.ok()["organizations"], json!([]));
    let members = w.owner.get("/api/v1/admin/members").await.ok();
    assert!(members["members"].as_array().unwrap().iter().any(|m| m["user_id"] == id.as_str() && m["expired"] == true));

    // The owner extends it, or removes the end date.
    w.owner.patch(&format!("/api/v1/admin/members/{id}"), json!({ "access_days": 30 })).await.ok();
    assert_eq!(caller.get("/api/v1/leads").await.status, 200);
    w.owner.patch(&format!("/api/v1/admin/members/{id}"), json!({ "access_days": 0 })).await.ok();
    let none: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar("SELECT expires_at FROM memberships WHERE user_id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    assert!(none.is_none());
    assert_eq!(w.owner.patch(&format!("/api/v1/admin/members/{id}"), json!({ "access_days": 99999 })).await.status, 400);
    // The owner has no end date.
    assert_eq!(w.owner.patch(&format!("/api/v1/admin/members/{}", w.owner.id), json!({ "access_days": 5 })).await.status, 403);

    // An invitation can carry a period that starts when it is accepted.
    let invite = w.owner.post("/api/v1/admin/members", json!({ "email": "temp@example.com", "roles": ["caller"], "team_ids": [w.team], "access_days": 7 })).await.ok();
    assert_eq!(w.owner.post("/api/v1/admin/members", json!({ "email": "bad@example.com", "roles": ["caller"], "access_days": 0 })).await.status, 400);
    let temp = h.client("temp@example.com", "Temp Caller", false, true);
    temp.post("/api/v1/invitations/join", json!({ "token": invite["token"] })).await.ok();
    let days: f64 = sqlx::query_scalar("SELECT extract(epoch FROM expires_at - now())::float8 / 86400 FROM memberships WHERE user_id = $1::uuid").bind(&temp.id).fetch_one(&h.owner).await.unwrap();
    assert!((6.9..=7.1).contains(&days), "{days}");
}

#[tokio::test]
async fn staff_see_every_payment_and_customers_do_not() {
    let Some(h) = start().await else { return };
    let (owner, _) = platform_owner(&h).await;
    let (shop, shop_org) = customer(&h, "shop@client.example", "Client Shop").await;
    for (status, cents) in [("paid", 14900), ("paid", 25800), ("pending", 12900), ("failed", 14900)] {
        sqlx::query("INSERT INTO payments (org_id, plan_key, seats, amount_cents, status, provider, created_by) VALUES ($1::uuid, 'business', 2, $2, $3, 'test', $4::uuid)")
            .bind(&shop_org)
            .bind(cents)
            .bind(status)
            .bind(&shop.id)
            .execute(&h.owner)
            .await
            .unwrap();
    }
    let all = owner.get("/api/v1/platform/payments").await.ok();
    assert_eq!(all["payments"].as_array().unwrap().len(), 4);
    assert_eq!(all["totals"], json!({ "paid_cents": 40700, "pending_cents": 12900, "failed_cents": 14900, "refunded_cents": 0 }));
    assert_eq!(all["payments"][0]["organization"], "Client Shop Homes");
    assert_eq!(all["payments"][0]["payer_email"], "shop@client.example");
    assert_eq!(shop.get("/api/v1/platform/payments").await.status, 403);
    // The database refuses it to the API's own login for anyone who is not staff.
    let api = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap()).await.unwrap();
    assert!(sqlx::query("SELECT * FROM callerwhale_platform_payments($1::uuid)").bind(&shop.id).fetch_all(&api).await.is_err());
}

#[tokio::test]
async fn only_people_given_access_get_in() {
    let Some(h) = start_closed().await else { return };
    // A new account opens nothing by itself: no trial, no workspace, and the apps are told so.
    let stranger = h.client("stranger@example.com", "Stranger", true, true);
    assert_eq!(stranger.post("/api/v1/organizations/trial", json!({ "organization": "Mine" })).await.status, 403);
    assert_eq!(stranger.get("/api/v1/me").await.ok()["organizations"], json!([]));
    assert_eq!(stranger.get("/api/v1/leads").await.status, 400);
    assert_eq!(stranger.get("/api/v1/auth/service").await.ok()["signup"], false);

    // Staff open a workspace for a customer; it has no members until its owner accepts.
    let staff = h.client("staff@callerwhale.example", "Caller Whale Staff", true, true);
    staff.get("/api/v1/me").await.ok();
    sqlx::query("UPDATE users SET platform_role = 'admin' WHERE email = 'staff@callerwhale.example'").execute(&h.owner).await.unwrap();
    assert_eq!(stranger.post("/api/v1/platform/customers", json!({ "organization": "X", "email": "stranger@example.com" })).await.status, 403);
    assert_eq!(staff.post("/api/v1/platform/customers", json!({ "organization": "Shop", "email": "nope" })).await.status, 400);
    let opened = staff.post("/api/v1/platform/customers", json!({ "organization": "Client Shop", "email": "Boss@Shop.example" })).await.ok();
    let org = opened["organization_id"].as_str().unwrap().to_string();

    // Only the person it was sent to can accept it, and they become the business owner.
    assert_eq!(stranger.post("/api/v1/invitations/join", json!({ "token": opened["token"] })).await.status, 403);
    let boss = h.client("boss@shop.example", "Shop Boss", true, true);
    boss.post("/api/v1/invitations/join", json!({ "token": opened["token"] })).await.ok();
    boss.set_org(&org);
    let me = boss.get("/api/v1/me").await.ok();
    assert_eq!(me["roles"], json!(["owner"]));
    assert_eq!(boss.get("/api/v1/leads").await.status, 200);
}
