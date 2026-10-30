//! Administration (plan 2.4, 3.6): members, invitations, teams, roles, projects, versioned settings, templates and
//! integration status. Every grant change bumps the access revision.

use crate::{
    access::{CAPABILITIES, HELD_ROLES},
    auth::{self, Ctx},
    db::{self, Scope},
    error::{ApiError, ApiResult},
    record::{access_changed, record, Change},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    routing::{get, patch, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/members", get(members).post(invite))
        .route("/admin/members/{user_id}", patch(update_member).delete(remove_member))
        .route("/admin/teams", get(teams).post(create_team))
        .route("/admin/roles", get(roles))
        .route("/admin/roles/{key}", put(update_role))
        .route("/projects", get(projects).post(create_project))
        .route("/projects/{id}", patch(update_project))
        .route("/settings", get(all_settings))
        .route("/settings/{key}", get(setting).put(put_setting))
        .route("/settings/{key}/history", get(setting_history))
        .route("/templates", get(templates).post(create_template))
        .route("/templates/{id}", put(update_template))
        .route("/integrations", get(integrations))
        .route("/directory", get(directory))
        .route("/admin/audit", get(audit))
        .route("/admin/operations", get(rejected_operations))
        .route("/admin/operations/{id}/resolve", post(resolve_operation))
}

fn actor_change<'a>(ctx: &'a Ctx, entity: &'a str, id: Uuid, kind: &'a str) -> Change<'a> {
    let mut c = Change::new(entity, id, kind);
    c.actor_id = Some(ctx.user_id);
    c.actor_label = &ctx.label;
    c
}

async fn members(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('user_id', u.id, 'email', u.email, 'name', u.display_name, 'roles', m.roles, 'restrictions', m.restrictions, \
           'team_ids', m.team_ids, 'project_ids', m.project_ids, 'mfa', u.totp_secret IS NOT NULL, 'disabled', u.disabled_at IS NOT NULL, 'sign_in', u.sign_in_provider, \n           'expires_at', m.expires_at, 'expired', m.expires_at IS NOT NULL AND m.expires_at <= now())::jsonb \
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = callerwhale_org() ORDER BY u.display_name",
    )
    .fetch_all(&mut *tx)
    .await?;
    let invites: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('email', email, 'roles', roles, 'expires_at', expires_at, 'access_days', access_days)::jsonb FROM invitations \
         WHERE org_id = callerwhale_org() AND accepted_at IS NULL AND expires_at > now() ORDER BY expires_at",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!({ "members": rows, "invitations": invites })))
}

async fn valid_roles(tx: &mut db::Tx, roles: &[String]) -> ApiResult<()> {
    if roles.is_empty() {
        return Err(ApiError::bad("Choose at least one role"));
    }
    let known: Vec<String> = sqlx::query_scalar("SELECT key FROM roles WHERE org_id = callerwhale_org()").fetch_all(&mut **tx).await?;
    if let Some(role) = roles.iter().find(|r| !known.contains(r)) {
        return Err(ApiError::bad(format!("{role} is not a role here")));
    }
    if roles.iter().any(|r| HELD_ROLES.contains(&r.as_str())) {
        return Err(ApiError::forbidden("Only the person who opened this workspace is its owner; that role cannot be given"));
    }
    Ok(())
}

/// Whether this member is the workspace's owner, whose role and membership nobody else can change.
async fn is_owner(tx: &mut db::Tx, user: Uuid) -> ApiResult<bool> {
    Ok(sqlx::query_scalar("SELECT roles && $2 FROM memberships WHERE org_id = callerwhale_org() AND user_id = $1")
        .bind(user)
        .bind(HELD_ROLES.iter().map(|r| r.to_string()).collect::<Vec<_>>())
        .fetch_optional(&mut **tx)
        .await?
        .unwrap_or(false))
}

#[derive(Deserialize)]
struct Invite {
    email: String,
    roles: Vec<String>,
    #[serde(default)]
    team_ids: Vec<Uuid>,
    /// How long their access lasts once they accept, in days. Absent: no end date.
    access_days: Option<i32>,
}

/// Creates an invitation and returns its one-time token. Sending it is the administrator's choice (or the email
/// adapter, once configured); the server never stores the token itself.
async fn invite(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Invite>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') {
        return Err(ApiError::bad("Enter an email address"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    valid_roles(&mut tx, &body.roles).await?;
    if body.access_days.is_some_and(|d| !(1..=3650).contains(&d)) {
        return Err(ApiError::bad("Access can last 1 to 3650 days"));
    }
    // The plan must allow a team and have a free seat (an open invitation holds one).
    crate::routes::billing::check_invite(&mut tx).await?;
    let (token, hash) = auth::new_token();
    sqlx::query(
        "INSERT INTO invitations (token_hash, org_id, email, roles, team_ids, invited_by, expires_at, access_days) VALUES ($1, callerwhale_org(), $2, $3, $4, $5, now() + interval '7 days', $6)",
    )
    .bind(&hash)
    .bind(&email)
    .bind(&body.roles)
    .bind(&body.team_ids)
    .bind(ctx.user_id)
    .bind(body.access_days)
    .execute(&mut *tx)
    .await?;
    let mut c = actor_change(&ctx, "invitation", scope.org_id, "member.invited");
    c.after = Some(json!({ "email": email, "roles": body.roles, "access_days": body.access_days }));
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(Json(json!({ "token": token, "expires_in_days": 7 })))
}

#[derive(Deserialize)]
struct MemberChange {
    roles: Option<Vec<String>>,
    restrictions: Option<Vec<String>>,
    team_ids: Option<Vec<Uuid>>,
    project_ids: Option<Vec<Uuid>>,
    /// Sets the end of their access to this many days from now; 0 removes the end date.
    access_days: Option<i32>,
}

async fn update_member(State(state): State<AppState>, ctx: Ctx, Path(user): Path<Uuid>, Json(body): Json<MemberChange>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(m) FROM memberships m WHERE org_id = callerwhale_org() AND user_id = $1 FOR UPDATE")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("The member"))?;
    if let Some(roles) = &body.roles {
        if is_owner(&mut tx, user).await? {
            return Err(ApiError::forbidden("The owner's role cannot be changed"));
        }
        valid_roles(&mut tx, roles).await?;
    }
    if let Some(days) = body.access_days {
        if !(0..=3650).contains(&days) {
            return Err(ApiError::bad("Access can last 1 to 3650 days, or 0 for no end"));
        }
        if is_owner(&mut tx, user).await? {
            return Err(ApiError::forbidden("The owner's access has no end date"));
        }
    }
    if let Some(restrictions) = &body.restrictions {
        if let Some(bad) = restrictions.iter().find(|r| !CAPABILITIES.contains(&r.as_str()) && !r.starts_with("scope:")) {
            return Err(ApiError::bad(format!("{bad} is not a capability")));
        }
    }
    let after: Value = sqlx::query_scalar(
        "UPDATE memberships SET roles = coalesce($2, roles), restrictions = coalesce($3, restrictions), team_ids = coalesce($4, team_ids), \
           project_ids = coalesce($5, project_ids), \n           expires_at = CASE WHEN $6::int IS NULL THEN expires_at WHEN $6 = 0 THEN NULL ELSE now() + make_interval(days => $6) END \n         WHERE org_id = callerwhale_org() AND user_id = $1 RETURNING to_jsonb(memberships.*)",
    )
    .bind(user)
    .bind(&body.roles)
    .bind(&body.restrictions)
    .bind(&body.team_ids)
    .bind(&body.project_ids)
    .bind(body.access_days)
    .fetch_one(&mut *tx)
    .await?;
    access_changed(&mut tx).await?;
    let mut c = actor_change(&ctx, "membership", user, "member.changed");
    c.before = Some(before);
    c.after = Some(after.clone());
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(Json(after))
}

async fn remove_member(State(state): State<AppState>, ctx: Ctx, Path(user): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    if user == ctx.user_id {
        return Err(ApiError::bad("You cannot remove yourself"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    if is_owner(&mut tx, user).await? {
        return Err(ApiError::forbidden("The workspace's owner cannot be removed"));
    }
    let removed = sqlx::query("DELETE FROM memberships WHERE org_id = callerwhale_org() AND user_id = $1").bind(user).execute(&mut *tx).await?;
    if removed.rows_affected() == 0 {
        return Err(ApiError::not_found("The member"));
    }
    // Every request reads the membership, so their access here ends now; their leads go to the unassigned queue.
    sqlx::query("UPDATE leads SET assignee_id = NULL, version = version + 1 WHERE assignee_id = $1").bind(user).execute(&mut *tx).await?;
    sqlx::query("UPDATE handoffs SET status = 'Cancelled', decided_at = now() WHERE status = 'Requested' AND (to_user = $1 OR from_user = $1)").bind(user).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM lead_shares WHERE user_id = $1").bind(user).execute(&mut *tx).await?;
    access_changed(&mut tx).await?;
    record(&mut tx, actor_change(&ctx, "membership", user, "member.removed")).await?;
    tx.commit().await?;
    Ok(Json(json!({ "removed": true })))
}

async fn teams(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(t) FROM teams t ORDER BY name").fetch_all(&mut *tx).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct Named {
    name: String,
    #[serde(default)]
    qualification_fields: Vec<String>,
}

async fn create_team(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Named>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let team: Value = sqlx::query_scalar("INSERT INTO teams (org_id, name) VALUES (callerwhale_org(), $1) RETURNING to_jsonb(teams.*)")
        .bind(body.name.trim())
        .fetch_one(&mut *tx)
        .await?;
    access_changed(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(team))
}

async fn roles(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM roles r ORDER BY name").fetch_all(&mut *tx).await?;
    Ok(Json(json!({ "roles": rows, "capabilities": CAPABILITIES })))
}

#[derive(Deserialize)]
struct RoleChange {
    name: Option<String>,
    capabilities: Option<Vec<String>>,
    scope: Option<String>,
}

async fn update_role(State(state): State<AppState>, ctx: Ctx, Path(key): Path<String>, Json(body): Json<RoleChange>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    if HELD_ROLES.contains(&key.as_str()) || key == "admin" {
        return Err(ApiError::forbidden("This role cannot be changed"));
    }
    if let Some(caps) = &body.capabilities {
        if let Some(bad) = caps.iter().find(|c| !CAPABILITIES.contains(&c.as_str())) {
            return Err(ApiError::bad(format!("{bad} is not a capability")));
        }
        // Managing access stays with the business owner.
        if caps.iter().any(|c| c == "admin") {
            return Err(ApiError::forbidden("Managing members and access stays with the workspace's owner"));
        }
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let role: Value = sqlx::query_scalar(
        "INSERT INTO roles (org_id, key, name, capabilities, scope) VALUES (callerwhale_org(), $1, coalesce($2, $1), coalesce($3, '{}'), coalesce($4, 'own')) \
         ON CONFLICT (org_id, key) DO UPDATE SET name = coalesce($2, roles.name), capabilities = coalesce($3, roles.capabilities), scope = coalesce($4, roles.scope) \
         RETURNING to_jsonb(roles.*)",
    )
    .bind(&key)
    .bind(&body.name)
    .bind(&body.capabilities)
    .bind(&body.scope)
    .fetch_one(&mut *tx)
    .await?;
    access_changed(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(role))
}

async fn projects(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM projects p WHERE 'organization' = ANY(string_to_array(current_setting('callerwhale.scopes', true), ',')) \
           OR p.id = ANY(callerwhale_setting_uuids('callerwhale.project_ids')) OR EXISTS (SELECT 1 FROM leads l WHERE l.project_id = p.id AND callerwhale_visible_lead(l.id)) ORDER BY name",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn create_project(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Named>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("import")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let project: Value = sqlx::query_scalar("INSERT INTO projects (org_id, name, qualification_fields) VALUES (callerwhale_org(), $1, $2) RETURNING to_jsonb(projects.*)")
        .bind(body.name.trim())
        .bind(&body.qualification_fields)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(project))
}

async fn update_project(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>, Json(body): Json<Named>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let project: Value = sqlx::query_scalar("UPDATE projects SET name = $2, qualification_fields = $3 WHERE id = $1 RETURNING to_jsonb(projects.*)")
        .bind(id)
        .bind(body.name.trim())
        .bind(&body.qualification_fields)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("The project"))?;
    tx.commit().await?;
    Ok(Json(project))
}

/// Configuration keys and what their value must look like.
const SETTINGS: &[&str] = &["pipeline.lead", "pipeline.deal", "scripts", "layouts", "workspace", "assignment", "notifications"];

fn validate_setting(key: &str, value: &Value) -> ApiResult<()> {
    if !SETTINGS.contains(&key) {
        return Err(ApiError::bad(format!("{key} is not a setting")));
    }
    if key.starts_with("pipeline.") {
        let stages = value.get("stages").and_then(Value::as_array).ok_or_else(|| ApiError::bad("A pipeline needs a list of stages"))?;
        if stages.is_empty() || stages.len() > 20 || stages.iter().any(|s| s.as_str().map(|s| s.trim().is_empty()).unwrap_or(true)) {
            return Err(ApiError::bad("A pipeline needs 1 to 20 named stages"));
        }
    }
    if key == "assignment" {
        let mode = value.get("mode").and_then(Value::as_str).unwrap_or("manual");
        if !["manual", "round_robin", "workload"].contains(&mode) {
            return Err(ApiError::bad("Assignment mode must be manual, round_robin or workload"));
        }
    }
    Ok(())
}

pub async fn latest_setting(tx: &mut db::Tx, key: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM settings_versions WHERE org_id = callerwhale_org() AND key = $1 ORDER BY id DESC LIMIT 1")
        .bind(key)
        .fetch_optional(&mut **tx)
        .await
}

async fn all_settings(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let mut out = serde_json::Map::new();
    for key in SETTINGS {
        if let Some(value) = latest_setting(&mut tx, key).await? {
            out.insert(key.to_string(), value);
        }
    }
    out.entry("pipeline.lead").or_insert(json!({ "stages": crate::ops::LEAD_STAGES }));
    out.entry("pipeline.deal").or_insert(json!({ "stages": crate::ops::DEAL_STAGES }));
    Ok(Json(Value::Object(out)))
}

async fn setting(State(state): State<AppState>, ctx: Ctx, Path(key): Path<String>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    Ok(Json(latest_setting(&mut tx, &key).await?.unwrap_or(Value::Null)))
}

async fn put_setting(State(state): State<AppState>, ctx: Ctx, Path(key): Path<String>, Json(value): Json<Value>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    validate_setting(&key, &value)?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO settings_versions (org_id, key, value, actor_id) VALUES (callerwhale_org(), $1, $2, $3) RETURNING id")
        .bind(&key)
        .bind(&value)
        .bind(ctx.user_id)
        .fetch_one(&mut *tx)
        .await?;
    let mut c = actor_change(&ctx, "setting", scope.org_id, "settings.changed");
    c.after = Some(json!({ "key": key, "value": value }));
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(Json(json!({ "key": key, "version": id, "value": value })))
}

async fn setting_history(State(state): State<AppState>, ctx: Ctx, Path(key): Path<String>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('version', id, 'value', value, 'actor_id', actor_id, 'at', at)::jsonb FROM settings_versions WHERE key = $1 ORDER BY id DESC LIMIT 50",
    )
    .bind(&key)
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn templates(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(t) FROM templates t ORDER BY channel, name").fetch_all(&mut *tx).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct TemplateBody {
    channel: String,
    name: String,
    #[serde(default)]
    subject: String,
    body: String,
    #[serde(default)]
    approved: bool,
}

async fn create_template(State(state): State<AppState>, ctx: Ctx, Json(body): Json<TemplateBody>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let template: Value = sqlx::query_scalar(
        "INSERT INTO templates (org_id, channel, name, subject, body, approved) VALUES (callerwhale_org(), $1, $2, $3, $4, $5) RETURNING to_jsonb(templates.*)",
    )
    .bind(&body.channel)
    .bind(body.name.trim())
    .bind(&body.subject)
    .bind(&body.body)
    .bind(body.approved)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(template))
}

async fn update_template(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>, Json(body): Json<TemplateBody>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    // Changing the words withdraws approval until approved again.
    let template: Value = sqlx::query_scalar(
        "UPDATE templates SET name = $2, subject = $3, body = $4, approved = CASE WHEN body = $4 AND subject = $3 THEN $5 ELSE $5 AND false END, \
         version = version + 1 WHERE id = $1 RETURNING to_jsonb(templates.*)",
    )
    .bind(id)
    .bind(body.name.trim())
    .bind(&body.subject)
    .bind(&body.body)
    .bind(body.approved)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("The template"))?;
    tx.commit().await?;
    Ok(Json(template))
}

async fn integrations(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<(String, bool)> = sqlx::query_as("SELECT provider, enabled AND secret_ciphertext IS NOT NULL FROM integrations").fetch_all(&mut *tx).await?;
    let mut out = serde_json::Map::new();
    for provider in ["email", "sms", "voice"] {
        let configured = rows.iter().any(|(p, on)| p == provider && *on);
        out.insert(provider.into(), json!({ "configured": configured, "status": if configured { "connected" } else { "not configured" } }));
    }
    Ok(Json(Value::Object(out)))
}

/// Names of the organization's people, for assignment pickers and mentions. External clients see no one.
async fn directory(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope: Scope = ctx.scope()?;
    if scope.access.scopes.iter().all(|s| s == "shared") {
        return Ok(Json(json!([])));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('id', u.id, 'name', u.display_name, 'roles', m.roles, 'team_ids', m.team_ids, 'sign_in', u.sign_in_provider)::jsonb \
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = callerwhale_org() AND u.disabled_at IS NULL ORDER BY u.display_name",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn audit(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.require("admin")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    // Administration sees identity and configuration history; record history stays with record access.
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(a) FROM audit_events a WHERE entity IN ('membership', 'invitation', 'setting', 'rule', 'organization') ORDER BY id DESC LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

/// Conflicting and rejected operations of the current person, for the review screen (plan 2.7).
async fn rejected_operations(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(o) - 'org_id' FROM operations o WHERE user_id = $1 AND status IN ('rejected', 'conflict') AND resolved_at IS NULL ORDER BY received_at DESC LIMIT 200",
    )
    .bind(ctx.user_id)
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn resolve_operation(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let done = sqlx::query("UPDATE operations SET resolved_at = now() WHERE id = $1 AND user_id = $2 AND status IN ('rejected', 'conflict')")
        .bind(id)
        .bind(ctx.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "resolved": done.rows_affected() == 1 })))
}
