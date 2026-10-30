//! Caller Whale as a paid service: the trial workspace, plans, checkout, the payment provider's webhook, and the call-minute
//! ledger. Accounts and email confirmation are the auth service's. Seats and minutes are enforced here and in admin invitations.
//!
//! Money never moves through this API. Checkout records a pending payment and hands the browser to the provider; only
//! the provider's signed webhook marks it paid and changes the plan.

use crate::{
    auth::{self, Ctx},
    db::{self, Scope},
    error::{ApiError, ApiResult},
    record::{record, Change},
    routes::identity::seed_organization,
    state::AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/plans", get(plans))
        .route("/billing", get(account))
        .route("/billing/checkout", post(checkout))
        .route("/billing/webhook", post(webhook))
        .route("/calls/start", post(start_call))
        .route("/calls/{id}/end", post(end_call))
}

// --- Abuse limits -------------------------------------------------------------------------------------------------

/// New trial workspaces across the whole server: at most this many in ten minutes. A proxy in front (nginx) limits per address.
const SIGNUPS_PER_WINDOW: usize = 30;
static SIGNUPS: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

fn signup_allowed() -> bool {
    let mut recent = SIGNUPS.lock().unwrap();
    while recent.front().is_some_and(|at| at.elapsed() > Duration::from_secs(600)) {
        recent.pop_front();
    }
    if recent.len() >= SIGNUPS_PER_WINDOW {
        return false;
    }
    recent.push_back(Instant::now());
    true
}

// --- Plans --------------------------------------------------------------------------------------------------------

#[derive(sqlx::FromRow, Clone, Debug)]
pub struct Plan {
    pub key: String,
    pub name: String,
    pub price_cents: i32,
    pub per_seat: bool,
    pub included_minutes: i32,
    pub min_seats: i32,
    pub max_seats: i32,
    pub can_invite: bool,
    pub period_days: i32,
}

impl Plan {
    pub fn to_json(&self) -> Value {
        json!({ "key": self.key, "name": self.name, "price_cents": self.price_cents, "per_seat": self.per_seat,
                "included_minutes": self.included_minutes, "min_seats": self.min_seats, "max_seats": self.max_seats,
                "can_invite": self.can_invite, "period_days": self.period_days })
    }
    pub fn amount_cents(&self, seats: i32) -> i32 {
        if self.per_seat { self.price_cents * seats } else { self.price_cents }
    }
    pub fn minutes(&self, seats: i32) -> i32 {
        if self.per_seat { self.included_minutes * seats } else { self.included_minutes }
    }
}

const PLAN_COLUMNS: &str = "key, name, price_cents, per_seat, included_minutes, min_seats, max_seats, can_invite, period_days";

async fn plan(conn: &mut sqlx::PgConnection, key: &str) -> ApiResult<Plan> {
    sqlx::query_as(&format!("SELECT {PLAN_COLUMNS} FROM plans WHERE key = $1 AND available"))
        .bind(key)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| ApiError::bad("Choose one of Caller Whale's plans"))
}

async fn plans(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<Plan> = sqlx::query_as(&format!("SELECT {PLAN_COLUMNS} FROM plans WHERE available ORDER BY array_position(ARRAY['trial', 'solo', 'business'], key)")).fetch_all(&state.db).await?;
    Ok(Json(json!(rows.iter().map(Plan::to_json).collect::<Vec<_>>())))
}

// --- Seats and minutes, read inside a transaction scoped to the organization ----------------------------------------

/// The organization's plan, seats and this period's minutes. `None`: a self-hosted organization without limits.
pub struct Standing {
    pub plan: Plan,
    pub status: String,
    pub seats: i32,
    pub minutes_included: i32,
    pub minutes_used: i64,
    pub period_start: chrono::DateTime<chrono::Utc>,
    pub period_end: chrono::DateTime<chrono::Utc>,
}

impl Standing {
    pub fn minutes_left(&self) -> i64 {
        (self.minutes_included as i64 - self.minutes_used).max(0)
    }
}

/// Reads the standing; `lock` holds the subscription row until the transaction ends, so two calls or two invitations
/// cannot both take the last minute or seat.
pub async fn standing(tx: &mut db::Tx, lock: bool) -> ApiResult<Option<Standing>> {
    let row: Option<(String, String, i32, i32, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(&format!(
        "SELECT plan_key, status, seats, minutes_included, period_start, period_end FROM subscriptions WHERE org_id = callerwhale_org(){}",
        if lock { " FOR UPDATE" } else { "" }
    ))
    .fetch_optional(&mut **tx)
    .await?;
    let Some((plan_key, status, seats, minutes_included, period_start, period_end)) = row else { return Ok(None) };
    let plan = plan(&mut **tx, &plan_key).await?;
    let minutes_used: i64 = sqlx::query_scalar("SELECT coalesce(sum(billed_minutes), 0)::bigint FROM usage_events WHERE org_id = callerwhale_org() AND period_start = $1")
        .bind(period_start)
        .fetch_one(&mut **tx)
        .await?;
    Ok(Some(Standing { plan, status, seats, minutes_included, minutes_used, period_start, period_end }))
}

/// Members plus invitations still open: every one of them holds a seat.
pub async fn seats_taken(tx: &mut db::Tx) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM memberships WHERE org_id = callerwhale_org()) \
              + (SELECT count(*) FROM invitations WHERE org_id = callerwhale_org() AND accepted_at IS NULL AND expires_at > now())",
    )
    .fetch_one(&mut **tx)
    .await?)
}

/// Refuses an invitation the plan has no room for. Called with the subscription locked by the invitation's transaction.
pub async fn check_invite(tx: &mut db::Tx) -> ApiResult<()> {
    let Some(standing) = standing(tx, true).await? else { return Ok(()) };
    if !standing.plan.can_invite {
        return Err(ApiError::PaymentRequired(format!("The {} plan is for one person. Move to Business to invite your team.", standing.plan.name)));
    }
    let taken = seats_taken(tx).await?;
    if taken >= standing.seats as i64 {
        return Err(ApiError::PaymentRequired(format!("All {} seats are taken. Add seats to invite someone else.", standing.seats)));
    }
    Ok(())
}

/// Refuses joining an organization that is already full (an invitation can outlive a reduction in seats).
pub async fn check_join(tx: &mut db::Tx) -> ApiResult<()> {
    let Some(standing) = standing(tx, true).await? else { return Ok(()) };
    let members: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE org_id = callerwhale_org()").fetch_one(&mut **tx).await?;
    if members >= standing.seats as i64 {
        return Err(ApiError::PaymentRequired("This organization has no free seat. Ask its owner to add one.".into()));
    }
    Ok(())
}

/// Stored as the password of this server's copy of a person: the auth service checks passwords now, and this is not
/// a valid hash, so no password ever matches it here.
pub const NO_PASSWORD: &str = "!external-sign-in";

/// A new organization on the free trial for someone who already has an account: its roles and team, the person as
/// owner, the trial subscription, and the audit entry.
/// A trial organization. `owner` becomes its owner at once; without one (Caller Whale's staff opening it for a customer) it
/// waits for the owner invitation to be accepted.
pub async fn open_trial_organization(tx: &mut db::Tx, owner: Option<Uuid>, actor: Uuid, name: &str, tz: &str, organization: Option<&str>) -> ApiResult<Uuid> {
    let organization = organization.map(str::to_string).unwrap_or_else(|| format!("{name}'s workspace"));
    let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (name, timezone, account_kind) VALUES ($1, $2, 'trial') RETURNING id")
        .bind(&organization)
        .bind(tz)
        .fetch_one(&mut **tx)
        .await?;
    seed_organization(tx, org).await?;
    if let Some(owner) = owner {
        sqlx::query("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1, $2, ARRAY['owner'])").bind(org).bind(owner).execute(&mut **tx).await?;
    }
    let trial = plan(&mut **tx, "trial").await?;
    sqlx::query(
        "INSERT INTO subscriptions (org_id, plan_key, status, seats, minutes_included, period_end) \
         VALUES ($1, 'trial', 'trialing', 1, $2, now() + make_interval(days => $3))",
    )
    .bind(org)
    .bind(trial.minutes(1))
    .bind(trial.period_days)
    .execute(&mut **tx)
    .await?;
    let mut change = Change::new("organization", org, "organization.signed_up");
    change.actor_id = Some(actor);
    change.actor_label = name;
    change.after = Some(json!({ "plan": "trial", "minutes": trial.minutes(1) }));
    record(&mut **tx, change).await?;
    Ok(org)
}

#[derive(Deserialize)]
pub struct StartTrial {
    #[serde(default)]
    organization: String,
    #[serde(default)]
    timezone: String,
}

/// After signing up with the auth service, a person asks for their workspace here: a new organization on the free
/// trial, with them as owner. One trial per person.
pub async fn start_trial(State(state): State<AppState>, ctx: Ctx, Json(body): Json<StartTrial>) -> ApiResult<Json<Value>> {
    if !state.config.public_signup {
        return Err(ApiError::forbidden("Caller Whale is by invitation only. Ask your workspace owner, or Caller Whale, for an invitation"));
    }
    let organization = match body.organization.trim() {
        "" => format!("{}'s workspace", ctx.label),
        given => given.to_string(),
    };
    if organization.chars().count() > 200 {
        return Err(ApiError::bad("Use an organization name of up to 200 characters"));
    }
    if !signup_allowed() {
        return Err(ApiError::TooMany("Too many new accounts right now; try again in a few minutes".into()));
    }
    let tz = if body.timezone.is_empty() { "UTC".to_string() } else { body.timezone.clone() };
    let mut tx = state.db.begin().await?;
    let had_trial: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND o.account_kind = 'trial')",
    )
    .bind(ctx.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if had_trial {
        return Err(ApiError::Conflict("You already have a trial workspace".into()));
    }
    let org = open_trial_organization(&mut tx, Some(ctx.user_id), ctx.user_id, &ctx.label, &tz, Some(&organization)).await?;
    let trial = plan(&mut tx, "trial").await?;
    tx.commit().await?;
    Ok(Json(json!({ "organization_id": org, "plan": "trial", "minutes": trial.minutes(1), "trial_days": trial.period_days })))
}

// --- The account: plan, seats, minutes, payments ------------------------------------------------------------------

async fn account(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.member_scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let kind: String = sqlx::query_scalar("SELECT account_kind FROM organizations WHERE id = callerwhale_org()").fetch_one(&mut *tx).await?;
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&mut *tx).await?;
    let taken = seats_taken(&mut tx).await?;
    let Some(standing) = standing(&mut tx, false).await? else {
        return Ok(Json(json!({ "account_kind": kind, "plan": null, "limited": false, "seats_taken": taken, "email_verified": verified })));
    };
    // Payments carry amounts; only those who manage the organization see them.
    let payments: Vec<Value> = if ctx.access.can("admin") {
        sqlx::query_scalar(
            "SELECT json_build_object('id', id, 'plan', plan_key, 'seats', seats, 'amount_cents', amount_cents, 'currency', currency, \
               'status', status, 'created_at', created_at, 'paid_at', paid_at)::jsonb FROM payments WHERE org_id = callerwhale_org() ORDER BY created_at DESC LIMIT 24",
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        vec![]
    };
    tx.commit().await?;
    let usable = ctx.subscription.as_ref().and_then(auth::Subscription::refusal);
    Ok(Json(json!({
        "account_kind": kind,
        "limited": true,
        "plan": standing.plan.to_json(),
        "status": standing.status,
        "usable": usable.is_none(),
        "reason": usable,
        "seats": standing.seats,
        "seats_taken": taken,
        "can_invite": standing.plan.can_invite && taken < standing.seats as i64,
        "minutes_included": standing.minutes_included,
        "minutes_used": standing.minutes_used,
        "minutes_left": standing.minutes_left(),
        "period_start": standing.period_start,
        "period_end": standing.period_end,
        "email_verified": verified,
        "payments": payments,
    })))
}

#[derive(Deserialize)]
struct Checkout {
    plan: String,
    #[serde(default = "one")]
    seats: i32,
}

fn one() -> i32 {
    1
}

/// Starts paying for a plan: records a pending payment and answers where to pay it. Owners and administrators only,
/// with a verified email address.
async fn checkout(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Checkout>) -> ApiResult<Json<Value>> {
    let scope = ctx.member_scope()?;
    if !ctx.access.can("admin") {
        return Err(ApiError::forbidden("Only the organization's owner or administrator can change its plan"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&mut *tx).await?;
    if !verified {
        return Err(ApiError::forbidden("Confirm your email address before choosing a paid plan"));
    }
    if body.plan == "trial" {
        return Err(ApiError::bad("The trial cannot be bought; choose Solo or Business"));
    }
    let chosen = plan(&mut tx, &body.plan).await?;
    if body.seats < chosen.min_seats || body.seats > chosen.max_seats {
        return Err(ApiError::bad(format!("{} takes {} to {} seats", chosen.name, chosen.min_seats, chosen.max_seats)));
    }
    let members: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE org_id = callerwhale_org()").fetch_one(&mut *tx).await?;
    if (body.seats as i64) < members {
        return Err(ApiError::bad(format!("Your organization has {members} members; choose at least that many seats or remove someone first")));
    }
    let amount = chosen.amount_cents(body.seats);
    let payment: Uuid = sqlx::query_scalar(
        "INSERT INTO payments (org_id, plan_key, seats, amount_cents, provider, created_by) VALUES (callerwhale_org(), $1, $2, $3, 'checkout', $4) RETURNING id",
    )
    .bind(&chosen.key)
    .bind(body.seats)
    .bind(amount)
    .bind(ctx.user_id)
    .fetch_one(&mut *tx)
    .await?;
    let mut change = Change::new("payment", payment, "payment.started");
    change.actor_id = Some(ctx.user_id);
    change.actor_label = &ctx.label;
    change.after = Some(json!({ "plan": chosen.key, "seats": body.seats, "amount_cents": amount }));
    record(&mut tx, change).await?;
    tx.commit().await?;
    let url = (!state.config.checkout_url.is_empty()).then(|| format!("{}?payment={payment}", state.config.checkout_url));
    Ok(Json(json!({ "payment_id": payment, "plan": chosen.key, "seats": body.seats, "amount_cents": amount, "currency": "USD", "checkout_url": url })))
}

// --- The payment provider's webhook -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct ProviderEvent {
    event_id: String,
    #[serde(rename = "type")]
    kind: String,
    payment_id: Uuid,
    #[serde(default)]
    amount_cents: Option<i32>,
    #[serde(default)]
    provider_ref: Option<String>,
    #[serde(default)]
    customer_id: Option<String>,
}

/// `X-CallerWhale-Signature: sha256=<hex HMAC-SHA256 of the raw body>`, compared in constant time.
pub fn signature_valid(secret: &str, body: &[u8], header: Option<&str>) -> bool {
    let Some(hex_sig) = header.and_then(|value| value.trim().strip_prefix("sha256=")) else { return false };
    let Ok(given) = hex::decode(hex_sig) else { return false };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return false };
    mac.update(body);
    mac.verify_slice(&given).is_ok()
}

async fn webhook(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    let secret = &state.config.billing_webhook_secret;
    if secret.len() < 24 {
        return Err(ApiError::NotFound("Payments are not configured on this server".into()));
    }
    if !signature_valid(secret, &body, headers.get("x-callerwhale-signature").and_then(|v| v.to_str().ok())) {
        return Err(ApiError::forbidden("The signature does not match"));
    }
    let event: ProviderEvent = serde_json::from_slice(&body).map_err(|_| ApiError::bad("The event is not in the expected form"))?;
    let org: Option<Uuid> = sqlx::query_scalar("SELECT callerwhale_payment_org($1)").bind(event.payment_id).fetch_one(&state.db).await?;
    let org = org.ok_or_else(|| ApiError::not_found("The payment"))?;
    let mut tx = db::begin(&state.db, &Scope::system(org)).await?;
    // A provider retries; each event acts once.
    let fresh = sqlx::query("INSERT INTO provider_events (provider, event_id, org_id) VALUES ('checkout', $1, $2) ON CONFLICT DO NOTHING")
        .bind(&event.event_id)
        .bind(org)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        == 1;
    if !fresh {
        return Ok(Json(json!({ "received": true, "duplicate": true })));
    }
    let (plan_key, seats, amount, status): (String, i32, i32, String) =
        sqlx::query_as("SELECT plan_key, seats, amount_cents, status FROM payments WHERE id = $1 FOR UPDATE").bind(event.payment_id).fetch_one(&mut *tx).await?;
    if status != "pending" {
        tx.commit().await?;
        return Ok(Json(json!({ "received": true, "already": status })));
    }
    let outcome = match event.kind.as_str() {
        "payment.succeeded" => {
            if event.amount_cents != Some(amount) {
                return Err(ApiError::bad("The amount paid does not match the checkout"));
            }
            let chosen = plan(&mut tx, &plan_key).await?;
            sqlx::query("UPDATE payments SET status = 'paid', paid_at = now(), provider_ref = $2 WHERE id = $1")
                .bind(event.payment_id)
                .bind(&event.provider_ref)
                .execute(&mut *tx)
                .await?;
            // A new period starts with the plan's full minutes.
            sqlx::query(
                "INSERT INTO subscriptions (org_id, plan_key, status, seats, minutes_included, period_start, period_end, provider, provider_customer_id) \
                 VALUES (callerwhale_org(), $1, 'active', $2, $3, now(), now() + make_interval(days => $4), 'checkout', $5) \
                 ON CONFLICT (org_id) DO UPDATE SET plan_key = EXCLUDED.plan_key, status = 'active', seats = EXCLUDED.seats, \
                   minutes_included = EXCLUDED.minutes_included, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, \
                   provider = EXCLUDED.provider, provider_customer_id = coalesce(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id), \
                   updated_at = now()",
            )
            .bind(&chosen.key)
            .bind(seats)
            .bind(chosen.minutes(seats))
            .bind(chosen.period_days)
            .bind(&event.customer_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE organizations SET account_kind = $1 WHERE id = callerwhale_org()").bind(&chosen.key).execute(&mut *tx).await?;
            "paid"
        }
        "payment.failed" => {
            sqlx::query("UPDATE payments SET status = 'failed' WHERE id = $1").bind(event.payment_id).execute(&mut *tx).await?;
            "failed"
        }
        _ => return Err(ApiError::bad("Unknown event type")),
    };
    let mut change = Change::new("payment", event.payment_id, if outcome == "paid" { "payment.succeeded" } else { "payment.failed" });
    change.actor_label = "Payment provider";
    change.after = Some(json!({ "plan": plan_key, "seats": seats, "amount_cents": amount }));
    record(&mut tx, change).await?;
    crate::record::access_changed(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "received": true, "status": outcome })))
}

// --- Call minutes -------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct StartCall {
    #[serde(default)]
    lead_id: Option<Uuid>,
}

/// Opens a call and says how long it may last. Refused when the period's minutes are used up.
async fn start_call(State(state): State<AppState>, ctx: Ctx, Json(body): Json<StartCall>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("call")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    if let Some(lead) = body.lead_id {
        let visible: bool = sqlx::query_scalar("SELECT callerwhale_visible_lead($1)").bind(lead).fetch_one(&mut *tx).await?;
        if !visible {
            return Err(ApiError::not_found("The lead"));
        }
    }
    let standing = standing(&mut tx, true).await?;
    // Minutes promised to calls still open count as spent, so parallel calls cannot overdraw the period.
    let open: i64 = sqlx::query_scalar("SELECT coalesce(sum(ceil(max_seconds / 60.0)), 0)::bigint FROM call_sessions WHERE ended_at IS NULL AND max_seconds IS NOT NULL")
        .fetch_one(&mut *tx)
        .await?;
    let max_seconds = match &standing {
        Some(standing) => {
            let left = standing.minutes_left() - open;
            if left <= 0 {
                return Err(ApiError::PaymentRequired("Your calling minutes for this period are used up. Upgrade or wait for the next period.".into()));
            }
            Some((left * 60).min(4 * 3600) as i32)
        }
        None => None,
    };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO call_sessions (org_id, lead_id, agent_id, direction, provider, status, max_seconds) \
         VALUES (callerwhale_org(), $1, $2, 'outbound', 'callerwhale', 'in_progress', $3) RETURNING id",
    )
    .bind(body.lead_id)
    .bind(ctx.user_id)
    .bind(max_seconds)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "call_id": id, "max_seconds": max_seconds })))
}

/// Ends a call and records its minutes. The length comes from the server's clock, never the client, and never more
/// than the call was allowed. Ending twice records once.
async fn end_call(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    // Ending stays possible after the plan runs out mid-call, so the minutes are still counted.
    let scope = ctx.member_scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let call: Option<(Option<Uuid>, Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT agent_id, max_seconds, seconds FROM call_sessions WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let (agent, max_seconds, recorded) = call.ok_or_else(|| ApiError::not_found("The call"))?;
    if agent != Some(ctx.user_id) && !ctx.access.can("admin") {
        return Err(ApiError::not_found("The call"));
    }
    if let Some(seconds) = recorded {
        return Ok(Json(json!({ "call_id": id, "seconds": seconds, "billed_minutes": (seconds + 59) / 60, "already_ended": true })));
    }
    let elapsed: i32 = sqlx::query_scalar("SELECT greatest(0, extract(epoch FROM now() - started_at))::int FROM call_sessions WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let seconds = max_seconds.map_or(elapsed, |cap| elapsed.min(cap));
    let billed = (seconds + 59) / 60;
    sqlx::query("UPDATE call_sessions SET ended_at = now(), seconds = $2, status = 'completed' WHERE id = $1").bind(id).bind(seconds).execute(&mut *tx).await?;
    if let Some(standing) = standing(&mut tx, true).await? {
        sqlx::query("INSERT INTO usage_events (org_id, user_id, call_session_id, seconds, billed_minutes, period_start) VALUES (callerwhale_org(), $1, $2, $3, $4, $5)")
            .bind(ctx.user_id)
            .bind(id)
            .bind(seconds)
            .bind(billed)
            .bind(standing.period_start)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "call_id": id, "seconds": seconds, "billed_minutes": billed })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_are_checked_against_the_raw_body() {
        let secret = "a-webhook-secret-of-enough-length";
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(b"{\"a\":1}");
        let good = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
        assert!(signature_valid(secret, b"{\"a\":1}", Some(&good)));
        assert!(!signature_valid(secret, b"{\"a\":2}", Some(&good)), "a changed body fails");
        assert!(!signature_valid("another-secret-of-enough-length!", b"{\"a\":1}", Some(&good)));
        assert!(!signature_valid(secret, b"{\"a\":1}", None));
        assert!(!signature_valid(secret, b"{\"a\":1}", Some("sha256=zz")));
    }

    #[test]
    fn per_seat_plans_multiply() {
        let business = Plan { key: "business".into(), name: "Business".into(), price_cents: 12900, per_seat: true, included_minutes: 4000, min_seats: 2, max_seats: 500, can_invite: true, period_days: 30 };
        assert_eq!(business.amount_cents(5), 64500);
        assert_eq!(business.minutes(5), 20000);
        let solo = Plan { per_seat: false, price_cents: 14900, included_minutes: 5000, ..business };
        assert_eq!(solo.amount_cents(1), 14900);
        assert_eq!(solo.minutes(1), 5000);
    }
}
