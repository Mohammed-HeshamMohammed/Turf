//! The admin dashboard's API, for the people who run Turf the service: every customer workspace with its plan, usage,
//! seats and payments (never their CRM records), the people on the server, Turf's own staff, and what staff did.
//!
//! There are two platform roles (users.platform_role). The **platform owner** is the owner of the app: set once on the
//! server (services/core-api/scripts/create_platform_owner.py), never through the API. **System administrators** are
//! named and removed only by the owner, here. Nobody can get either by signing up or by an invitation, and the
//! database refuses a platform role from anything but the owner's function (migration 0010).
//!
//! Staff may look at everything, extend a plan, suspend a workspace and turn a customer's access off. Only the owner
//! names staff, sets a workspace's plan or makes one unlimited. Every change is kept in platform_events.

use crate::{
    auth::{self, Ctx},
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/platform/organizations", get(organizations))
        .route("/platform/organizations/{id}/suspend", post(suspend))
        .route("/platform/organizations/{id}/subscription", post(subscription))
        .route("/platform/people", get(people))
        .route("/platform/people/{id}/access", post(access))
        .route("/platform/staff", get(staff_list).post(set_staff))
        .route("/platform/payments", get(payments))
        .route("/platform/activity", get(activity))
        .route("/platform/workspace", post(workspace))
        .route("/platform/customers", post(customer))
}

#[derive(Clone, Copy, PartialEq)]
enum Staff {
    Owner,
    Admin,
}

/// The person's platform role, or a refusal. Turf's staff always need the second sign-in step (the authenticator
/// code), whatever the server's MFA setting: a token that has not passed it opens nothing here.
async fn staff(state: &AppState, ctx: &Ctx) -> ApiResult<Staff> {
    let role: Option<String> = sqlx::query_scalar("SELECT platform_role FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    let role = match role.as_deref() {
        Some("owner") => Staff::Owner,
        Some("admin") => Staff::Admin,
        _ => return Err(ApiError::forbidden("Only Turf's platform administrators can see this")),
    };
    if !ctx.mfa_passed {
        return Err(ApiError::MfaRequired);
    }
    Ok(role)
}

async fn owner(state: &AppState, ctx: &Ctx) -> ApiResult<()> {
    if staff(state, ctx).await? != Staff::Owner {
        return Err(ApiError::forbidden("Only the platform owner can do this"));
    }
    Ok(())
}

async fn event(tx: &mut sqlx::PgConnection, ctx: &Ctx, action: &str, kind: &str, target: Option<Uuid>, detail: Value) -> ApiResult<()> {
    sqlx::query("INSERT INTO platform_events (actor_id, action, target_kind, target_id, detail) VALUES ($1, $2, $3, $4, $5)")
        .bind(ctx.user_id)
        .bind(action)
        .bind(kind)
        .bind(target)
        .bind(detail)
        .execute(tx)
        .await?;
    Ok(())
}

/// A transaction acting in one customer workspace, so its row security lets the change through.
async fn in_org(state: &AppState, org: Uuid) -> ApiResult<sqlx::Transaction<'static, sqlx::Postgres>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org.to_string()).execute(&mut *tx).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1)").bind(org).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(ApiError::not_found("The workspace"));
    }
    Ok(tx)
}

type Row = (
    Uuid,
    String,
    String,
    chrono::DateTime<chrono::Utc>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i32>,
    i64,
    Option<chrono::DateTime<chrono::Utc>>,
    i64,
    Option<String>,
    i64,
    Option<chrono::DateTime<chrono::Utc>>,
);

async fn organizations(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let role = staff(&state, &ctx).await?;
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM turf_platform_overview($1)").bind(ctx.user_id).fetch_all(&state.db).await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|(id, name, kind, created, plan, status, seats, included, used, period_end, members, owner, paid, suspended)| {
            // A period that has run out is shown as ended, whatever the stored status still says.
            let lapsed = period_end.is_some_and(|end| end < chrono::Utc::now()) && matches!(status.as_deref(), Some("active" | "trialing"));
            let status = if lapsed { Some("expired".to_string()) } else { status.clone() };
            json!({ "id": id, "name": name, "account_kind": kind, "created_at": created, "plan": plan, "status": status, "seats": seats,
                    "minutes_included": included, "minutes_used": used, "period_end": period_end, "members": members,
                    "owner_email": owner, "paid_cents": paid, "suspended": suspended.is_some() })
        })
        .collect();
    let paying = list.iter().filter(|o| o["status"] == "active").count();
    let trials = list.iter().filter(|o| o["status"] == "trialing").count();
    let suspended = list.iter().filter(|o| o["suspended"] == true).count();
    let revenue: i64 = rows.iter().map(|r| r.12).sum();
    let people: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&state.db).await?;
    Ok(Json(json!({
        "you": if role == Staff::Owner { "owner" } else { "admin" },
        "organizations": list,
        "totals": { "organizations": list.len(), "paying": paying, "trials": trials, "suspended": suspended, "paid_cents": revenue, "people": people },
    })))
}

#[derive(Deserialize)]
struct Suspend {
    suspended: bool,
    #[serde(default)]
    reason: String,
}

async fn suspend(State(state): State<AppState>, ctx: Ctx, Path(org): Path<Uuid>, Json(body): Json<Suspend>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let mut tx = in_org(&state, org).await?;
    sqlx::query("UPDATE organizations SET suspended_at = CASE WHEN $2 THEN coalesce(suspended_at, now()) END WHERE id = $1").bind(org).bind(body.suspended).execute(&mut *tx).await?;
    crate::record::access_changed(&mut tx).await?;
    event(&mut tx, &ctx, if body.suspended { "workspace.suspended" } else { "workspace.reactivated" }, "organization", Some(org), json!({ "reason": body.reason.trim() })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "suspended": body.suspended })))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum PlanChange {
    /// Push the end of the current period out (a trial or a paid plan), and open it again if it had lapsed.
    Extend { days: i64 },
    /// Put the workspace on a plan, without a payment. The owner only.
    Set { plan: String, seats: i32, days: i64 },
    /// No plan at all, so no limits: for Turf's own workspaces and special customers. The owner only.
    Unlimited,
}

async fn subscription(State(state): State<AppState>, ctx: Ctx, Path(org): Path<Uuid>, Json(body): Json<PlanChange>) -> ApiResult<Json<Value>> {
    let role = staff(&state, &ctx).await?;
    if !matches!(body, PlanChange::Extend { .. }) && role != Staff::Owner {
        return Err(ApiError::forbidden("Only the platform owner can set a plan or remove limits"));
    }
    let mut tx = in_org(&state, org).await?;
    let detail = match body {
        PlanChange::Extend { days } => {
            if !(1..=365).contains(&days) {
                return Err(ApiError::bad("Extend by 1 to 365 days"));
            }
            let changed = sqlx::query(
                "UPDATE subscriptions SET period_end = greatest(period_end, now()) + make_interval(days => $2::int), \
                   status = CASE WHEN plan_key = 'trial' THEN 'trialing' ELSE 'active' END, updated_at = now() WHERE org_id = $1",
            )
            .bind(org)
            .bind(days)
            .execute(&mut *tx)
            .await?;
            if changed.rows_affected() == 0 {
                return Err(ApiError::bad("This workspace has no plan to extend; it has no limits"));
            }
            json!({ "action": "extend", "days": days })
        }
        PlanChange::Set { plan, seats, days } => {
            let row: Option<(bool, i32, i32, i32, String)> = sqlx::query_as("SELECT per_seat, included_minutes, min_seats, max_seats, key FROM plans WHERE key = $1")
                .bind(&plan)
                .fetch_optional(&mut *tx)
                .await?;
            let (per_seat, minutes, min_seats, max_seats, key) = row.ok_or_else(|| ApiError::bad("No such plan"))?;
            if seats < min_seats || seats > max_seats {
                return Err(ApiError::bad(format!("This plan takes {min_seats} to {max_seats} seats")));
            }
            if !(1..=3650).contains(&days) {
                return Err(ApiError::bad("Choose 1 to 3650 days"));
            }
            let included = if per_seat { minutes * seats } else { minutes };
            let status = if key == "trial" { "trialing" } else { "active" };
            sqlx::query(
                "INSERT INTO subscriptions (org_id, plan_key, status, seats, minutes_included, period_start, period_end) \
                 VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(days => $6::int)) \
                 ON CONFLICT (org_id) DO UPDATE SET plan_key = EXCLUDED.plan_key, status = EXCLUDED.status, seats = EXCLUDED.seats, \
                   minutes_included = EXCLUDED.minutes_included, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, updated_at = now()",
            )
            .bind(org)
            .bind(&key)
            .bind(status)
            .bind(seats)
            .bind(included)
            .bind(days)
            .execute(&mut *tx)
            .await?;
            let kind = if key == "trial" { "trial" } else if key == "solo" { "solo" } else { "business" };
            sqlx::query("UPDATE organizations SET account_kind = $2 WHERE id = $1").bind(org).bind(kind).execute(&mut *tx).await?;
            json!({ "action": "set", "plan": key, "seats": seats, "days": days })
        }
        PlanChange::Unlimited => {
            sqlx::query("DELETE FROM subscriptions WHERE org_id = $1").bind(org).execute(&mut *tx).await?;
            sqlx::query("UPDATE organizations SET account_kind = 'business' WHERE id = $1").bind(org).execute(&mut *tx).await?;
            json!({ "action": "unlimited" })
        }
    };
    crate::record::access_changed(&mut tx).await?;
    event(&mut tx, &ctx, "workspace.plan_changed", "organization", Some(org), detail.clone()).await?;
    tx.commit().await?;
    Ok(Json(detail))
}

#[derive(Deserialize)]
struct Search {
    #[serde(default)]
    q: String,
}

async fn people(State(state): State<AppState>, ctx: Ctx, Query(search): Query<Search>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let pattern = format!("%{}%", search.q.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('id', u.id, 'email', u.email, 'name', u.display_name, 'platform_role', u.platform_role, \
           'disabled', u.disabled_at IS NOT NULL, 'created_at', u.created_at, \
           'workspaces', coalesce((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'roles', m.roles) ORDER BY o.name) \
                                   FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id), '[]'))::jsonb \
         FROM users u WHERE u.email ILIKE $1 OR u.display_name ILIKE $1 ORDER BY u.created_at DESC LIMIT 200",
    )
    .bind(pattern)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "people": rows })))
}

#[derive(Deserialize)]
struct Access {
    disabled: bool,
}

/// Turns someone's access to Turf off (or back on). Staff can do this to customers; only the owner to other staff;
/// nobody to the owner or to themselves.
async fn access(State(state): State<AppState>, ctx: Ctx, Path(user): Path<Uuid>, Json(body): Json<Access>) -> ApiResult<Json<Value>> {
    let role = staff(&state, &ctx).await?;
    if user == ctx.user_id {
        return Err(ApiError::bad("You cannot turn off your own access"));
    }
    let target: Option<Option<String>> = sqlx::query_scalar("SELECT platform_role FROM users WHERE id = $1").bind(user).fetch_optional(&state.db).await?;
    let target = target.ok_or_else(|| ApiError::not_found("The person"))?;
    match target.as_deref() {
        Some("owner") => return Err(ApiError::forbidden("The platform owner's access cannot be turned off")),
        Some(_) if role != Staff::Owner => return Err(ApiError::forbidden("Only the platform owner can change another administrator's access")),
        _ => {}
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) END WHERE id = $1").bind(user).bind(body.disabled).execute(&mut *tx).await?;
    event(&mut tx, &ctx, if body.disabled { "person.disabled" } else { "person.enabled" }, "user", Some(user), json!({})).await?;
    tx.commit().await?;
    Ok(Json(json!({ "disabled": body.disabled })))
}

async fn staff_list(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('id', id, 'email', email, 'name', display_name, 'platform_role', platform_role, 'disabled', disabled_at IS NOT NULL)::jsonb \
         FROM users WHERE platform_role IS NOT NULL ORDER BY platform_role DESC, email",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "staff": rows })))
}

#[derive(Deserialize)]
struct StaffChange {
    email: String,
    /// "admin" names a system administrator; null removes the role.
    role: Option<String>,
}

/// The owner names or removes a system administrator. The person must have signed in to Turf once (with the auth
/// service), so this server knows them. The owner role itself can never be given.
async fn set_staff(State(state): State<AppState>, ctx: Ctx, Json(body): Json<StaffChange>) -> ApiResult<Json<Value>> {
    owner(&state, &ctx).await?;
    if body.role.as_deref().is_some_and(|r| r != "admin") {
        return Err(ApiError::forbidden("Only the system administrator role can be given"));
    }
    let email = body.email.trim().to_lowercase();
    let user: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&state.db).await?;
    let user = user.ok_or_else(|| ApiError::not_found("Nobody with this email has signed in to Turf yet. Ask them to sign in once"))?;
    if user == ctx.user_id {
        return Err(ApiError::bad("You are the platform owner"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT turf_platform_set_role($1, $2, $3)").bind(ctx.user_id).bind(user).bind(&body.role).execute(&mut *tx).await?;
    event(&mut tx, &ctx, if body.role.is_some() { "staff.added" } else { "staff.removed" }, "user", Some(user), json!({ "email": email })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "user_id": user, "platform_role": body.role })))
}

type PaymentRow = (
    Uuid,
    Uuid,
    String,
    String,
    i32,
    i32,
    String,
    String,
    String,
    chrono::DateTime<chrono::Utc>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<String>,
);

/// Every payment on the server, newest first, with what is paid, waiting and refunded. Card details never reach Turf:
/// only the provider's reference and the amounts.
async fn payments(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let rows: Vec<PaymentRow> = sqlx::query_as("SELECT * FROM turf_platform_payments($1)").bind(ctx.user_id).fetch_all(&state.db).await?;
    let sum = |status: &str| rows.iter().filter(|r| r.7 == status).map(|r| r.5 as i64).sum::<i64>();
    let list: Vec<Value> = rows
        .iter()
        .map(|(id, org, org_name, plan, seats, amount, currency, status, provider, created, paid, payer)| {
            json!({ "id": id, "organization_id": org, "organization": org_name, "plan": plan, "seats": seats, "amount_cents": amount, "currency": currency,
                    "status": status, "provider": provider, "created_at": created, "paid_at": paid, "payer_email": payer })
        })
        .collect();
    Ok(Json(json!({
        "payments": list,
        "totals": { "paid_cents": sum("paid"), "pending_cents": sum("pending"), "failed_cents": sum("failed"), "refunded_cents": sum("refunded") },
    })))
}

async fn activity(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('id', e.id, 'at', e.at, 'actor', u.email, 'action', e.action, 'target_kind', e.target_kind, 'target_id', e.target_id, \
           'target', CASE e.target_kind WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = e.target_id) \
                                        WHEN 'user' THEN (SELECT email::text FROM users WHERE id = e.target_id) END, 'detail', e.detail)::jsonb \
         FROM platform_events e JOIN users u ON u.id = e.actor_id ORDER BY e.id DESC LIMIT 200",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "events": rows })))
}

#[derive(Deserialize)]
struct Workspace {
    organization: String,
}

/// A workspace of Turf's own for a member of staff, with no plan and so no limits: as many callers and CRM users as
/// they invite. One per person.
async fn workspace(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Workspace>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let name = body.organization.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad("Name the workspace (up to 200 characters)"));
    }
    let mut tx = state.db.begin().await?;
    let has: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = $1 AND 'owner' = ANY(m.roles) \
           AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id = m.org_id))",
    )
    .bind(ctx.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if has {
        return Err(ApiError::Conflict("You already have a workspace without limits".into()));
    }
    let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (name, account_kind) VALUES ($1, 'business') RETURNING id").bind(name).fetch_one(&mut *tx).await?;
    crate::routes::identity::seed_organization(&mut tx, org).await?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1, $2, ARRAY['owner'])").bind(org).bind(ctx.user_id).execute(&mut *tx).await?;
    event(&mut tx, &ctx, "workspace.created", "organization", Some(org), json!({ "name": name })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "organization_id": org })))
}

#[derive(Deserialize)]
struct Customer {
    organization: String,
    email: String,
}

/// A trial workspace for a customer, with an invitation that makes them its owner. New sign-ups cannot open a
/// workspace themselves (Config::public_signup), so this is how a business gets into Turf: staff open it, the owner
/// accepts, and the owner invites everyone else.
async fn customer(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Customer>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let name = body.organization.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad("Name the workspace (up to 200 characters)"));
    }
    let email = body.email.trim().to_lowercase();
    if email.len() > 254 || !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err(ApiError::bad("Enter the owner's email address"));
    }
    let mut tx = state.db.begin().await?;
    let org = crate::routes::billing::open_trial_organization(&mut tx, None, ctx.user_id, &ctx.label, "UTC", Some(name)).await?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org.to_string()).execute(&mut *tx).await?;
    let (token, hash) = auth::new_token();
    sqlx::query(
        "INSERT INTO invitations (token_hash, org_id, email, roles, team_ids, invited_by, expires_at) VALUES ($1, $2, $3, ARRAY['owner'], '{}', $4, now() + interval '7 days')",
    )
    .bind(&hash)
    .bind(org)
    .bind(&email)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;
    event(&mut tx, &ctx, "workspace.opened_for_customer", "organization", Some(org), json!({ "name": name, "owner_email": email })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "organization_id": org, "token": token, "expires_in_days": 7 })))
}
