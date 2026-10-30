//! Who the person is here, and the workspace side of joining Caller Whale (plan 2.4).
//!
//! Accounts, passwords, two-step sign-in and sessions belong to the auth service (services/auth): every request
//! carries its access token, checked in `auth::Ctx`, and the organization it acts in (`x-callerwhale-org`). This server keeps
//! a copy of each person for its own records, and decides which organizations they are in and what they may do there.

use crate::{
    access::{requires_mfa, PRESETS},
    auth::{self, Ctx},
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/bootstrap", post(bootstrap))
        .route("/invitations/join", post(join_invitation))
        // The workspace half of signing up with the auth service (the handler lives with the rest of the trial code).
        .route("/organizations/trial", post(crate::routes::billing::start_trial))
        .route("/me", get(me))
        .route("/auth/service", get(auth_service))
}

#[derive(Deserialize)]
struct Bootstrap {
    organization: String,
    #[serde(default)]
    timezone: String,
}

/// The first organization on a fresh self-hosted server, owned by the signed-in person. It has no plan, so no limits.
/// Refused once any organization exists; later people join by invitation (or open a trial on Caller Whale's own service).
async fn bootstrap(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Bootstrap>) -> ApiResult<Json<Value>> {
    let name = body.organization.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad("Name the organization (up to 200 characters)"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("LOCK TABLE organizations IN EXCLUSIVE MODE").execute(&mut *tx).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organizations)").fetch_one(&mut *tx).await?;
    if exists {
        return Err(ApiError::forbidden("This server is already set up; ask an administrator for an invitation"));
    }
    let tz = if body.timezone.is_empty() { "UTC".to_string() } else { body.timezone.clone() };
    let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id").bind(name).bind(&tz).fetch_one(&mut *tx).await?;
    seed_organization(&mut tx, org).await?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1, $2, ARRAY['owner'])").bind(org).bind(ctx.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "organization_id": org, "user_id": ctx.user_id, "mfa_required": state.config.require_mfa })))
}

/// Role presets and a default team for a new organization.
pub async fn seed_organization(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('callerwhale.org_id', $1, true)").bind(org.to_string()).execute(&mut **tx).await?;
    for (key, name, capabilities, scope, _) in PRESETS {
        sqlx::query("INSERT INTO roles (org_id, key, name, capabilities, scope) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING")
            .bind(org)
            .bind(key)
            .bind(name)
            .bind(capabilities.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .bind(scope)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("INSERT INTO teams (org_id, name) VALUES ($1, 'Main team') ON CONFLICT DO NOTHING").bind(org).execute(&mut **tx).await?;
    Ok(())
}

#[derive(Deserialize)]
struct Join {
    token: String,
}

/// Joins the organization an invitation is for, as the signed-in person. The account itself is the auth service's:
/// signing up or signing in happens there first. The invitation must be for this person's email address.
async fn join_invitation(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Join>) -> ApiResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let invite: Option<(Uuid, String, Vec<String>, Vec<Uuid>, Option<i32>)> = sqlx::query_as(
        "SELECT org_id, email::text, roles, team_ids, access_days FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE",
    )
    .bind(auth::token_hash(body.token.trim()))
    .fetch_optional(&mut *tx)
    .await?;
    let (org, email, roles, teams, access_days) = invite.ok_or_else(|| ApiError::forbidden("This invitation is not valid or has expired"))?;
    if !email.eq_ignore_ascii_case(&ctx.email) {
        return Err(ApiError::forbidden("This invitation is for another email address. Sign in with that address to join"));
    }
    sqlx::query("UPDATE invitations SET accepted_at = now() WHERE token_hash = $1").bind(auth::token_hash(body.token.trim())).execute(&mut *tx).await?;
    sqlx::query("SELECT set_config('callerwhale.org_id', $1, true)").bind(org.to_string()).execute(&mut *tx).await?;
    // Seats can have been reduced since the invitation was sent; this invitation's seat is now a member's.
    crate::routes::billing::check_join(&mut tx).await?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles, team_ids, expires_at) VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5) END) \n         ON CONFLICT (org_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, team_ids = EXCLUDED.team_ids, expires_at = EXCLUDED.expires_at")
        .bind(org)
        .bind(ctx.user_id)
        .bind(&roles)
        .bind(&teams)
        .bind(access_days)
        .execute(&mut *tx)
        .await?;
    crate::record::access_changed(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "organization_id": org, "roles": roles, "mfa_required": state.config.require_mfa && roles.iter().any(|r| requires_mfa(r)) })))
}

/// Where the auth service is, for the website and the app: they sign in there and bring its token here.
async fn auth_service(State(state): State<AppState>) -> Json<Value> {
    // `signup`: whether a new account may open its own trial here, or must be invited.
    // `firebase`: the web config to sign in with Firebase instead, when this server uses it.
    // `grafana`: the Grafana login proxy, where the admin dashboard hands staff over (null: none).
    let grafana = Some(&state.config.grafana_url).filter(|u| !u.is_empty());
    Json(json!({ "url": state.config.auth_public_url, "signup": state.config.public_signup, "firebase": state.config.firebase_web(), "grafana": grafana }))
}

async fn me(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let (platform_role, sign_in): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT platform_role, sign_in_provider FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    let orgs: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT o.id, o.name FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND (m.expires_at IS NULL OR m.expires_at > now()) ORDER BY o.name")
            .bind(ctx.user_id)
            .fetch_all(&state.db)
            .await?;
    Ok(Json(json!({
        "user": { "id": ctx.user_id, "email": ctx.email, "name": ctx.label, "sign_in": sign_in },
        "organization_id": ctx.org_id,
        "organizations": orgs.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "roles": ctx.roles,
        "capabilities": ctx.access.capabilities,
        "scopes": ctx.access.scopes,
        "team_ids": ctx.team_ids,
        "access_revision": ctx.access_revision,
        "mfa": { "required": ctx.mfa_required(), "enrolled": ctx.mfa_enrolled, "passed": ctx.mfa_passed },
        "platform_admin": platform_role.is_some(),
        "platform_role": platform_role,
        "subscription": ctx.subscription.as_ref().map(|s| json!({ "plan": s.plan, "status": s.status, "usable": s.refusal().is_none(), "reason": s.refusal() })),
    })))
}
