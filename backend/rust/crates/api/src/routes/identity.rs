//! Sign-in, MFA, sessions, invitations and organization choice (plan 2.4).

use crate::{
    access::{requires_mfa, PRESETS},
    auth::{self, Ctx, COOKIE},
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/mfa/setup", post(mfa_setup))
        .route("/auth/mfa/confirm", post(mfa_confirm))
        .route("/auth/mfa/verify", post(mfa_verify))
        .route("/auth/sessions", get(sessions))
        .route("/auth/sessions/revoke", post(revoke_sessions))
        .route("/auth/invitations/accept", post(accept_invitation))
        .route("/auth/organization", post(choose_organization))
        .route("/auth/password", post(change_password))
        .route("/me", get(me))
}

/// Failed sign-ins per address: five in fifteen minutes, then wait (plan 5.1, rate limiting).
static ATTEMPTS: Mutex<Option<HashMap<String, (u32, Instant)>>> = Mutex::new(None);

fn throttled(email: &str) -> bool {
    let mut guard = ATTEMPTS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.retain(|_, (_, since)| since.elapsed() < Duration::from_secs(900));
    map.get(email).map(|(count, _)| *count >= 5).unwrap_or(false)
}

fn failed(email: &str) {
    let mut guard = ATTEMPTS.lock().unwrap();
    let entry = guard.get_or_insert_with(HashMap::new).entry(email.to_string()).or_insert((0, Instant::now()));
    entry.0 += 1;
}

fn cleared(email: &str) {
    if let Some(map) = ATTEMPTS.lock().unwrap().as_mut() {
        map.remove(email);
    }
}

pub(crate) fn session_cookie(state: &AppState, token: String) -> Cookie<'static> {
    let mut cookie = Cookie::new(COOKIE, token);
    cookie.set_http_only(true);
    cookie.set_secure(state.config.secure_cookies);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_path("/");
    cookie.set_max_age(time_duration(state.config.session_hours));
    cookie
}

fn time_duration(hours: i64) -> time::Duration {
    time::Duration::hours(hours)
}

pub(crate) async fn create_session(state: &AppState, user: Uuid, org: Option<Uuid>, kind: &str) -> ApiResult<String> {
    let (token, hash) = auth::new_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, org_id, kind, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))")
        .bind(&hash)
        .bind(user)
        .bind(org)
        .bind(kind)
        .bind(state.config.session_hours as i32)
        .execute(&state.db)
        .await?;
    Ok(token)
}

/// Hands the token to the client: a cookie for browsers, the body for the desktop app (which keeps it in OS storage).
pub(crate) fn signed_in(state: &AppState, jar: CookieJar, token: String, kind: &str, extra: Value) -> (CookieJar, Json<Value>) {
    if kind == "desktop" {
        let mut body = extra;
        body["token"] = json!(token);
        (jar, Json(body))
    } else {
        (jar.add(session_cookie(state, token)), Json(extra))
    }
}

#[derive(Deserialize)]
struct Bootstrap {
    organization: String,
    email: String,
    display_name: String,
    password: String,
    #[serde(default = "browser")]
    kind: String,
    #[serde(default)]
    timezone: String,
}

pub(crate) fn browser() -> String {
    "browser".into()
}

/// The first account on a fresh server: creates the organization, its role presets and its owner. Refused once any
/// organization exists; later people join by invitation.
async fn bootstrap(State(state): State<AppState>, jar: CookieJar, Json(body): Json<Bootstrap>) -> ApiResult<(CookieJar, Json<Value>)> {
    let hash = auth::hash_password(&body.password)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("LOCK TABLE organizations IN EXCLUSIVE MODE").execute(&mut *tx).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organizations)").fetch_one(&mut *tx).await?;
    if exists {
        return Err(ApiError::forbidden("This server is already set up; ask an administrator for an invitation"));
    }
    let tz = if body.timezone.is_empty() { "UTC".to_string() } else { body.timezone.clone() };
    let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id")
        .bind(body.organization.trim())
        .bind(&tz)
        .fetch_one(&mut *tx)
        .await?;
    let user: Uuid = sqlx::query_scalar("INSERT INTO users (email, display_name, password_hash, timezone) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(body.email.trim())
        .bind(body.display_name.trim())
        .bind(&hash)
        .bind(&tz)
        .fetch_one(&mut *tx)
        .await?;
    seed_organization(&mut tx, org).await?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1, $2, ARRAY['owner', 'admin'])").bind(org).bind(user).execute(&mut *tx).await?;
    tx.commit().await?;
    let token = create_session(&state, user, Some(org), &body.kind).await?;
    Ok(signed_in(&state, jar, token, &body.kind, json!({ "organization_id": org, "user_id": user, "mfa_required": state.config.require_mfa })))
}

/// Role presets and a default team for a new organization.
pub async fn seed_organization(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org.to_string()).execute(&mut **tx).await?;
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
struct Login {
    email: String,
    password: String,
    #[serde(default = "browser")]
    kind: String,
    #[serde(default)]
    organization_id: Option<Uuid>,
}

async fn login(State(state): State<AppState>, jar: CookieJar, Json(body): Json<Login>) -> ApiResult<(CookieJar, Json<Value>)> {
    let email = body.email.trim().to_lowercase();
    if throttled(&email) {
        return Err(ApiError::TooMany("Too many attempts; wait fifteen minutes".into()));
    }
    let user: Option<(Uuid, String, bool)> =
        sqlx::query_as("SELECT id, password_hash, totp_secret IS NOT NULL FROM users WHERE email = $1 AND disabled_at IS NULL")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    // The same message whether or not the address exists.
    let Some((user, hash, enrolled)) = user.filter(|(_, hash, _)| auth::verify_password(&body.password, hash)) else {
        failed(&email);
        return Err(ApiError::forbidden("The email or password is not right"));
    };
    let _ = hash;
    cleared(&email);
    let orgs: Vec<(Uuid, Vec<String>)> = sqlx::query_as("SELECT org_id, roles FROM memberships WHERE user_id = $1 ORDER BY created_at")
        .bind(user)
        .fetch_all(&state.db)
        .await?;
    let chosen = body.organization_id.filter(|id| orgs.iter().any(|(o, _)| o == id)).or(if orgs.len() == 1 { Some(orgs[0].0) } else { None });
    let mfa_required = chosen.and_then(|id| orgs.iter().find(|(o, _)| *o == id)).map(|(_, roles)| roles.iter().any(|r| requires_mfa(r))).unwrap_or(false) && state.config.require_mfa;
    let kind = if body.kind == "desktop" { "desktop" } else { "browser" };
    let token = create_session(&state, user, chosen, kind).await?;
    Ok(signed_in(
        &state,
        jar,
        token,
        kind,
        json!({ "user_id": user, "organization_id": chosen, "organizations": orgs.iter().map(|(o, _)| o).collect::<Vec<_>>(),
                "mfa_required": mfa_required, "mfa_enrolled": enrolled }),
    ))
}

async fn logout(State(state): State<AppState>, ctx: Ctx, jar: CookieJar) -> ApiResult<(CookieJar, Json<Value>)> {
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1").bind(&ctx.session_hash).execute(&state.db).await?;
    Ok((jar.remove(Cookie::build(COOKIE).path("/")), Json(json!({ "signed_out": true }))))
}

async fn mfa_setup(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    if ctx.mfa_enrolled && !ctx.mfa_passed {
        return Err(ApiError::MfaRequired);
    }
    let secret = totp_rs::Secret::generate_secret().to_encoded().to_string();
    let url = auth::totp(&secret, &ctx.email)?.get_url();
    sqlx::query("UPDATE users SET totp_pending = $2 WHERE id = $1").bind(ctx.user_id).bind(&secret).execute(&state.db).await?;
    Ok(Json(json!({ "secret": secret, "otpauth_url": url })))
}

#[derive(Deserialize)]
struct Code {
    #[serde(default)]
    code: String,
    #[serde(default)]
    recovery_code: String,
}

async fn mfa_confirm(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Code>) -> ApiResult<Json<Value>> {
    let pending: Option<String> = sqlx::query_scalar("SELECT totp_pending FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    let secret = pending.ok_or_else(|| ApiError::bad("Start MFA setup first"))?;
    if !auth::check_totp(&secret, &ctx.email, &body.code) {
        return Err(ApiError::bad("That code is not right; check the time on your device"));
    }
    let codes = auth::recovery_codes();
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET totp_secret = $2, totp_pending = NULL WHERE id = $1").bind(ctx.user_id).bind(&secret).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = $1").bind(ctx.user_id).execute(&mut *tx).await?;
    for code in &codes {
        sqlx::query("INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)").bind(ctx.user_id).bind(auth::token_hash(code)).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE sessions SET mfa_passed = true WHERE token_hash = $1").bind(&ctx.session_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

async fn mfa_verify(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Code>) -> ApiResult<Json<Value>> {
    let secret: Option<String> = sqlx::query_scalar("SELECT totp_secret FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    let secret = secret.ok_or_else(|| ApiError::bad("Set up MFA first"))?;
    if throttled(&format!("mfa:{}", ctx.user_id)) {
        return Err(ApiError::TooMany("Too many attempts; wait fifteen minutes".into()));
    }
    let ok = if !body.recovery_code.is_empty() {
        sqlx::query("UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL")
            .bind(ctx.user_id)
            .bind(auth::token_hash(body.recovery_code.trim()))
            .execute(&state.db)
            .await?
            .rows_affected()
            == 1
    } else {
        auth::check_totp(&secret, &ctx.email, &body.code)
    };
    if !ok {
        failed(&format!("mfa:{}", ctx.user_id));
        return Err(ApiError::forbidden("That code is not right"));
    }
    sqlx::query("UPDATE sessions SET mfa_passed = true WHERE token_hash = $1").bind(&ctx.session_hash).execute(&state.db).await?;
    Ok(Json(json!({ "mfa_passed": true })))
}

async fn sessions(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT token_hash, kind, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(hash, kind, created, seen)| json!({ "id": &hash[..16], "kind": kind, "created_at": created, "last_seen_at": seen, "current": hash == ctx.session_hash }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct Revoke {
    #[serde(default)]
    id: String,
    #[serde(default)]
    all_others: bool,
}

async fn revoke_sessions(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Revoke>) -> ApiResult<Json<Value>> {
    let count = if body.all_others {
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL")
            .bind(ctx.user_id)
            .bind(&ctx.session_hash)
            .execute(&state.db)
            .await?
    } else {
        if body.id.len() != 16 {
            return Err(ApiError::bad("Choose a session"));
        }
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND left(token_hash, 16) = $2 AND revoked_at IS NULL")
            .bind(ctx.user_id)
            .bind(&body.id)
            .execute(&state.db)
            .await?
    };
    Ok(Json(json!({ "revoked": count.rows_affected() })))
}

#[derive(Deserialize)]
struct Accept {
    token: String,
    display_name: String,
    #[serde(default)]
    password: String,
    #[serde(default = "browser")]
    kind: String,
}

async fn accept_invitation(State(state): State<AppState>, jar: CookieJar, Json(body): Json<Accept>) -> ApiResult<(CookieJar, Json<Value>)> {
    let mut tx = state.db.begin().await?;
    let invite: Option<(Uuid, String, Vec<String>, Vec<Uuid>)> = sqlx::query_as(
        "UPDATE invitations SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING org_id, email::text, roles, team_ids",
    )
    .bind(auth::token_hash(body.token.trim()))
    .fetch_optional(&mut *tx)
    .await?;
    let (org, email, roles, teams) = invite.ok_or_else(|| ApiError::forbidden("This invitation is not valid or has expired"))?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org.to_string()).execute(&mut *tx).await?;
    // Seats can have been reduced since the invitation was sent; this invitation's seat is now a member's.
    crate::routes::billing::check_join(&mut tx).await?;
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
    let user = match existing {
        // An existing account joins with its own password, which it must prove.
        Some(id) => {
            let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
            if !auth::verify_password(&body.password, &hash) {
                return Err(ApiError::forbidden("Sign in with your existing password to join"));
            }
            id
        }
        None => sqlx::query_scalar("INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id")
            .bind(&email)
            .bind(body.display_name.trim())
            .bind(auth::hash_password(&body.password)?)
            .fetch_one(&mut *tx)
            .await?,
    };
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles, team_ids) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, team_ids = EXCLUDED.team_ids")
        .bind(org)
        .bind(user)
        .bind(&roles)
        .bind(&teams)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org.to_string()).execute(&mut *tx).await?;
    crate::record::access_changed(&mut tx).await?;
    tx.commit().await?;
    let kind = if body.kind == "desktop" { "desktop" } else { "browser" };
    let token = create_session(&state, user, Some(org), kind).await?;
    Ok(signed_in(&state, jar, token, kind, json!({ "organization_id": org, "user_id": user, "mfa_required": state.config.require_mfa && roles.iter().any(|r| requires_mfa(r)) })))
}

#[derive(Deserialize)]
struct Choose {
    organization_id: Uuid,
}

async fn choose_organization(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Choose>) -> ApiResult<Json<Value>> {
    let member: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2)")
        .bind(body.organization_id)
        .bind(ctx.user_id)
        .fetch_one(&state.db)
        .await?;
    if !member {
        return Err(ApiError::forbidden("You are not a member of that organization"));
    }
    sqlx::query("UPDATE sessions SET org_id = $2 WHERE token_hash = $1").bind(&ctx.session_hash).bind(body.organization_id).execute(&state.db).await?;
    Ok(Json(json!({ "organization_id": body.organization_id })))
}

#[derive(Deserialize)]
struct PasswordChange {
    current: String,
    new: String,
}

async fn change_password(State(state): State<AppState>, ctx: Ctx, Json(body): Json<PasswordChange>) -> ApiResult<Json<Value>> {
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    if !auth::verify_password(&body.current, &hash) {
        return Err(ApiError::forbidden("The current password is not right"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1").bind(ctx.user_id).bind(auth::hash_password(&body.new)?).execute(&mut *tx).await?;
    // Every other session must sign in again.
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL")
        .bind(ctx.user_id)
        .bind(&ctx.session_hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "changed": true })))
}

async fn me(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let platform_admin: bool = sqlx::query_scalar("SELECT platform_admin FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    let orgs: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT o.id, o.name FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name")
            .bind(ctx.user_id)
            .fetch_all(&state.db)
            .await?;
    Ok(Json(json!({
        "user": { "id": ctx.user_id, "email": ctx.email, "name": ctx.label },
        "organization_id": ctx.org_id,
        "organizations": orgs.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "roles": ctx.roles,
        "capabilities": ctx.access.capabilities,
        "scopes": ctx.access.scopes,
        "team_ids": ctx.team_ids,
        "access_revision": ctx.access_revision,
        "mfa": { "required": ctx.mfa_required(), "enrolled": ctx.mfa_enrolled, "passed": ctx.mfa_passed },
        "platform_admin": platform_admin,
        "subscription": ctx.subscription.as_ref().map(|s| json!({ "plan": s.plan, "status": s.status, "usable": s.refusal().is_none(), "reason": s.refusal() })),
    })))
}
