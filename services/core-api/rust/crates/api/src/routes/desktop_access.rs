//! Who may use the desktop app, and how much (migration 0014). Turf's staff invite a person by email with a monthly
//! credit limit; the invitation is emailed through Turf's mail server. The person signs in on the website with that
//! email, confirmed (password or Google), which activates it: they get a workspace of their own, their dashboard and
//! the download. Nobody else gets either: an account alone opens nothing.
//!
//! Staff (`/platform/invitations`) list everyone invited with this month's usage, change a limit, suspend or reactivate
//! a person (which turns their account off on this server at once, so the desktop app signs them out at its next
//! request), resend the email, and withdraw an invitation that was not accepted yet.
//!
//! The person (`/account`) sees their limit, what they used this month and the download. The desktop app asks
//! `/credits/use` before a metered action (Skip Tracing: a credit per row checked) and is refused when the month's
//! credits are used up. Retries carry the same request id and are counted once.

use crate::{
    auth::Ctx,
    error::{ApiError, ApiResult},
    mail,
    routes::platform::{event, staff},
    state::AppState,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::OnceLock;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/platform/invitations", get(list).post(invite))
        .route("/platform/invitations/{id}", patch(change).delete(withdraw))
        .route("/platform/invitations/{id}/resend", post(resend))
        .route("/platform/invitations/{id}/usage", get(usage_of))
        .route("/account", get(account))
        .route("/account/download", post(download_link))
        .route("/credits/use", post(use_credits))
        .route("/download/{token}", get(download))
}

/// What one credit buys, by kind. The database refuses any other kind.
pub const KINDS: &[(&str, &str)] = &[("skip_trace", "Skip Tracing: one row checked")];

/// The start and end of the current calendar month, in UTC: the period credits are counted in.
pub fn month(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).single().expect("the first of a month exists");
    let (y, m) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    let end = Utc.with_ymd_and_hms(y, m, 1, 0, 0, 0).single().expect("the first of a month exists");
    (start, end)
}

fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else { return false };
    email.len() <= 254 && !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !email.chars().any(|c| c.is_whitespace() || c == '<' || c == '>' || c == ',')
}

fn check_credits(value: i64) -> ApiResult<i64> {
    if !(0..=1_000_000_000).contains(&value) {
        return Err(ApiError::bad("Set a monthly limit from 0 to 1,000,000,000 credits"));
    }
    Ok(value)
}

const SELECT: &str = "SELECT json_build_object('id', i.id, 'email', i.email, 'name', i.name, 'monthly_credits', i.monthly_credits, 'status', i.status, \
       'note', i.note, 'created_at', i.created_at, 'accepted_at', i.accepted_at, 'emailed_at', i.emailed_at, 'updated_at', i.updated_at, \
       'invited_by', (SELECT email FROM users WHERE id = i.invited_by), 'user_id', i.user_id, 'organization_id', i.org_id, \
       'sign_in', u.sign_in_provider, 'registered', u.id IS NOT NULL, \
       'used_this_month', coalesce((SELECT sum(c.credits) FROM credit_usage c WHERE c.invitation_id = i.id AND c.at >= $1 AND c.at < $2), 0)::bigint, \
       'used_total', coalesce((SELECT sum(c.credits) FROM credit_usage c WHERE c.invitation_id = i.id), 0)::bigint, \
       'last_used_at', (SELECT max(c.at) FROM credit_usage c WHERE c.invitation_id = i.id))::jsonb \
     FROM access_invitations i LEFT JOIN users u ON u.id = i.user_id OR (i.user_id IS NULL AND u.email = i.email)";

async fn one(state: &AppState, id: Uuid) -> ApiResult<Value> {
    let (start, end) = month(Utc::now());
    sqlx::query_scalar(&format!("{SELECT} WHERE i.id = $3"))
        .bind(start)
        .bind(end)
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("The invitation"))
}

async fn list(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let (start, end) = month(Utc::now());
    let rows: Vec<Value> = sqlx::query_scalar(&format!("{SELECT} ORDER BY i.created_at DESC LIMIT 1000")).bind(start).bind(end).fetch_all(&state.db).await?;
    let count = |status: &str| rows.iter().filter(|r| r["status"] == status).count();
    let used: i64 = rows.iter().filter_map(|r| r["used_this_month"].as_i64()).sum();
    let limit: i64 = rows.iter().filter(|r| r["status"] == "active").filter_map(|r| r["monthly_credits"].as_i64()).sum();
    Ok(Json(json!({
        "invitations": rows,
        "period": { "start": start, "end": end },
        "totals": { "invited": count("invited"), "active": count("active"), "suspended": count("suspended"), "used_this_month": used, "active_limit": limit },
        "mail": mail::configured(&state.config),
        "kinds": KINDS.iter().map(|(k, d)| json!({ "kind": k, "description": d })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct Invite {
    email: String,
    #[serde(default)]
    name: String,
    monthly_credits: i64,
    #[serde(default)]
    note: String,
}

/// Sends the invitation email and records when; the reason it failed otherwise, for the dashboard.
async fn send_invitation(state: &AppState, ctx: &Ctx, id: Uuid, email: &str, name: &str, credits: i64) -> (bool, Option<String>) {
    if !mail::configured(&state.config) {
        return (false, Some("No mail server is set up on this server (TURF_SMTP_HOST), so no email was sent.".into()));
    }
    let inviter = if ctx.label.trim().is_empty() { ctx.email.clone() } else { ctx.label.trim().to_string() };
    match mail::send(&state.config, mail::invitation(&state.config, email, name, &inviter, credits)).await {
        Ok(()) => {
            let _ = sqlx::query("UPDATE access_invitations SET emailed_at = now() WHERE id = $1").bind(id).execute(&state.db).await;
            (true, None)
        }
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "invitation email not sent");
            (false, Some("The mail server did not accept the email. Check the mail settings, then resend.".into()))
        }
    }
}

async fn invite(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Invite>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let email = body.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(ApiError::bad("Enter the person's email address"));
    }
    let name = body.name.trim();
    if name.chars().count() > 200 || body.note.chars().count() > 1000 {
        return Err(ApiError::bad("The name or note is too long"));
    }
    let credits = check_credits(body.monthly_credits)?;
    let mut tx = state.db.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM access_invitations WHERE email = $1)").bind(&email).fetch_one(&mut *tx).await?;
    if exists {
        return Err(ApiError::Conflict("This person is already invited. Change their limit or resend the email instead".into()));
    }
    let id: Uuid = sqlx::query_scalar("INSERT INTO access_invitations (email, name, monthly_credits, note, invited_by) VALUES ($1, $2, $3, $4, $5) RETURNING id")
        .bind(&email)
        .bind(name)
        .bind(credits)
        .bind(body.note.trim())
        .bind(ctx.user_id)
        .fetch_one(&mut *tx)
        .await?;
    event(&mut tx, &ctx, "access.invited", "invitation", Some(id), json!({ "email": email, "monthly_credits": credits })).await?;
    tx.commit().await?;
    let (emailed, email_error) = send_invitation(&state, &ctx, id, &email, name, credits).await;
    Ok(Json(json!({ "invitation": one(&state, id).await?, "emailed": emailed, "email_error": email_error })))
}

#[derive(Deserialize)]
struct Change {
    monthly_credits: Option<i64>,
    /// "suspended" or "active" (reactivate). An invitation that was not accepted yet cannot be made active by staff.
    status: Option<String>,
    name: Option<String>,
    note: Option<String>,
}

async fn change(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>, Json(body): Json<Change>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let mut tx = state.db.begin().await?;
    let row: Option<(String, Option<Uuid>)> = sqlx::query_as("SELECT status, user_id FROM access_invitations WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let (status, user) = row.ok_or_else(|| ApiError::not_found("The invitation"))?;
    let mut detail = json!({});
    if let Some(credits) = body.monthly_credits {
        let credits = check_credits(credits)?;
        sqlx::query("UPDATE access_invitations SET monthly_credits = $2, updated_at = now() WHERE id = $1").bind(id).bind(credits).execute(&mut *tx).await?;
        detail["monthly_credits"] = credits.into();
    }
    if let Some(name) = body.name.as_deref().map(str::trim) {
        if name.chars().count() > 200 {
            return Err(ApiError::bad("The name is too long"));
        }
        sqlx::query("UPDATE access_invitations SET name = $2, updated_at = now() WHERE id = $1").bind(id).bind(name).execute(&mut *tx).await?;
    }
    if let Some(note) = body.note.as_deref().map(str::trim) {
        if note.chars().count() > 1000 {
            return Err(ApiError::bad("The note is too long"));
        }
        sqlx::query("UPDATE access_invitations SET note = $2, updated_at = now() WHERE id = $1").bind(id).bind(note).execute(&mut *tx).await?;
    }
    if let Some(next) = body.status.as_deref() {
        let suspend = match (status.as_str(), next) {
            (current, wanted) if current == wanted => None,
            ("active", "suspended") => Some(true),
            ("suspended", "active") => Some(false),
            ("invited", _) => return Err(ApiError::bad("This person has not accepted the invitation yet. Withdraw it instead")),
            _ => return Err(ApiError::bad("Choose active or suspended")),
        };
        if let Some(suspend) = suspend {
            if let Some(user) = user {
                let role: Option<String> = sqlx::query_scalar("SELECT platform_role FROM users WHERE id = $1").bind(user).fetch_one(&mut *tx).await?;
                if role.is_some() {
                    return Err(ApiError::forbidden("This person is on Turf's staff. Change their access from the Staff page"));
                }
                if user == ctx.user_id {
                    return Err(ApiError::bad("You cannot suspend yourself"));
                }
                // Their account is turned off on this server at once: every request they make is refused from now on.
                sqlx::query("UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) END WHERE id = $1").bind(user).bind(suspend).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE access_invitations SET status = $2, updated_at = now() WHERE id = $1").bind(id).bind(next).execute(&mut *tx).await?;
            detail["status"] = next.into();
        }
    }
    event(&mut tx, &ctx, "access.changed", "invitation", Some(id), detail).await?;
    tx.commit().await?;
    Ok(Json(json!({ "invitation": one(&state, id).await? })))
}

async fn withdraw(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let mut tx = state.db.begin().await?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT status, email::text FROM access_invitations WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let (status, email) = row.ok_or_else(|| ApiError::not_found("The invitation"))?;
    if status != "invited" {
        return Err(ApiError::Conflict("This person has already accepted. Suspend them instead, so their usage is kept".into()));
    }
    sqlx::query("DELETE FROM access_invitations WHERE id = $1").bind(id).execute(&mut *tx).await?;
    event(&mut tx, &ctx, "access.withdrawn", "invitation", Some(id), json!({ "email": email })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "withdrawn": true })))
}

async fn resend(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let row: Option<(String, String, i64, String)> =
        sqlx::query_as("SELECT email::text, name, monthly_credits, status FROM access_invitations WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
    let (email, name, credits, status) = row.ok_or_else(|| ApiError::not_found("The invitation"))?;
    if status == "suspended" {
        return Err(ApiError::bad("This person is suspended. Reactivate them first"));
    }
    let (emailed, email_error) = send_invitation(&state, &ctx, id, &email, &name, credits).await;
    let mut tx = state.db.begin().await?;
    event(&mut tx, &ctx, "access.emailed", "invitation", Some(id), json!({ "emailed": emailed })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "invitation": one(&state, id).await?, "emailed": emailed, "email_error": email_error })))
}

/// This month's usage of one invitation by day and by kind, and its latest actions.
async fn usage_report(state: &AppState, id: Uuid) -> ApiResult<Value> {
    let (start, end) = month(Utc::now());
    let days: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('day', d.day, 'credits', d.credits)::jsonb FROM ( \
           SELECT (date_trunc('day', at AT TIME ZONE 'UTC'))::date AS day, sum(credits)::bigint AS credits FROM credit_usage \
           WHERE invitation_id = $1 AND at >= $2 AND at < $3 GROUP BY 1 ORDER BY 1) d",
    )
    .bind(id)
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    let kinds: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('kind', kind, 'credits', sum(credits)::bigint)::jsonb FROM credit_usage WHERE invitation_id = $1 AND at >= $2 AND at < $3 GROUP BY kind ORDER BY kind",
    )
    .bind(id)
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    let recent: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('at', at, 'kind', kind, 'credits', credits, 'detail', detail)::jsonb FROM credit_usage WHERE invitation_id = $1 ORDER BY id DESC LIMIT 50",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(json!({ "period": { "start": start, "end": end }, "days": days, "kinds": kinds, "recent": recent }))
}

async fn usage_of(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    staff(&state, &ctx).await?;
    let invitation = one(&state, id).await?;
    Ok(Json(json!({ "invitation": invitation, "usage": usage_report(&state, id).await? })))
}

/// The person's invitation, activated if this is their first visit with the invited email confirmed. Activation opens
/// a workspace of their own, with no plan (credits are their limit), and links the invitation to their account.
async fn activate(state: &AppState, ctx: &Ctx) -> ApiResult<Option<(Uuid, String)>> {
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid, String, Option<Uuid>, String)> = sqlx::query_as(
        "SELECT id, status, user_id, name FROM access_invitations WHERE user_id = $1 OR (user_id IS NULL AND email = $2) ORDER BY user_id NULLS LAST LIMIT 1 FOR UPDATE",
    )
    .bind(ctx.user_id)
    .bind(&ctx.email)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((id, status, user, name)) = row else { return Ok(None) };
    if user.is_some() || status != "invited" {
        return Ok(Some((id, status)));
    }
    // The email must be confirmed: anyone can make a password account with someone else's address, but only its owner
    // can confirm it (Google accounts are confirmed already).
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&mut *tx).await?;
    if !verified {
        return Ok(Some((id, "unverified".into())));
    }
    let label = if !name.trim().is_empty() { name.trim().to_string() } else if !ctx.label.trim().is_empty() { ctx.label.trim().to_string() } else { ctx.email.clone() };
    let workspace: String = format!("{label}'s workspace").chars().take(200).collect();
    let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (name, account_kind) VALUES ($1, 'solo') RETURNING id").bind(&workspace).fetch_one(&mut *tx).await?;
    crate::routes::identity::seed_organization(&mut tx, org).await?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1, $2, ARRAY['owner']) ON CONFLICT (org_id, user_id) DO NOTHING").bind(org).bind(ctx.user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE access_invitations SET status = 'active', user_id = $2, org_id = $3, accepted_at = now(), updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(ctx.user_id)
        .bind(org)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some((id, "active".into())))
}

async fn account(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let (platform_role, verified): (Option<String>, bool) =
        sqlx::query_as("SELECT platform_role, email_verified_at IS NOT NULL FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    let person = json!({ "id": ctx.user_id, "email": ctx.email, "name": ctx.label, "email_verified": verified });
    let staff_info = platform_role.as_ref().map(|role| json!({ "role": role, "mfa_required": state.config.staff_mfa, "mfa_passed": ctx.mfa_passed }));
    let access = match activate(&state, &ctx).await? {
        None => Value::Null,
        Some((id, status)) if status == "unverified" || status == "invited" => json!({ "id": id, "status": status }),
        Some((id, _)) => {
            let invitation = one(&state, id).await?;
            let (start, end) = month(Utc::now());
            let limit = invitation["monthly_credits"].as_i64().unwrap_or(0);
            let used = invitation["used_this_month"].as_i64().unwrap_or(0);
            json!({
                "id": id, "status": invitation["status"], "monthly_credits": limit, "used_this_month": used, "remaining": (limit - used).max(0),
                "organization_id": invitation["organization_id"], "accepted_at": invitation["accepted_at"], "period": { "start": start, "end": end },
                "usage": usage_report(&state, id).await?,
            })
        }
    };
    let can_download = platform_role.is_some() || access["status"] == "active";
    let release = if can_download { latest_release(&state).await.map(|r| json!({ "version": r.version, "file": r.file, "size": r.size, "published": r.published })) } else { None };
    Ok(Json(json!({ "person": person, "staff": staff_info, "access": access, "can_download": can_download, "release": release })))
}

async fn used(tx: &mut sqlx::PgConnection, id: Uuid, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT coalesce(sum(credits), 0)::bigint FROM credit_usage WHERE invitation_id = $1 AND at >= $2 AND at < $3").bind(id).bind(start).bind(end).fetch_one(tx).await
}

#[derive(Deserialize)]
struct Use {
    kind: String,
    credits: i64,
    request_id: Uuid,
    #[serde(default)]
    detail: String,
}

/// Spends credits for a metered action, or refuses it when the month's are used up. People who were not invited this
/// way (Turf's staff, members a workspace owner invited) have no credit limit here.
async fn use_credits(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Use>) -> ApiResult<Json<Value>> {
    if !KINDS.iter().any(|(k, _)| *k == body.kind) {
        return Err(ApiError::bad("Unknown kind of usage"));
    }
    if !(1..=10_000_000).contains(&body.credits) {
        return Err(ApiError::bad("Use 1 to 10,000,000 credits at a time"));
    }
    let detail: String = body.detail.trim().chars().take(200).collect();
    let (start, end) = month(Utc::now());
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid, String, i64)> =
        sqlx::query_as("SELECT id, status, monthly_credits FROM access_invitations WHERE user_id = $1 FOR UPDATE").bind(ctx.user_id).fetch_optional(&mut *tx).await?;
    let Some((id, status, limit)) = row else {
        return Ok(Json(json!({ "limited": false })));
    };
    if status != "active" {
        return Err(ApiError::forbidden("Your access to Turf is suspended. Contact Turf support."));
    }
    let already: Option<i64> = sqlx::query_scalar("SELECT credits FROM credit_usage WHERE request_id = $1 AND user_id = $2").bind(body.request_id).bind(ctx.user_id).fetch_optional(&mut *tx).await?;
    if already.is_none() {
        let spent = used(&mut tx, id, start, end).await?;
        if spent + body.credits > limit {
            let left = (limit - spent).max(0);
            return Err(ApiError::PaymentRequired(format!(
                "Not enough credits left this month: {} left, and this needs {}. Ask Turf to raise your limit.",
                mail::format_number(left),
                mail::format_number(body.credits)
            )));
        }
        sqlx::query("INSERT INTO credit_usage (invitation_id, user_id, kind, credits, request_id, detail) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(id)
            .bind(ctx.user_id)
            .bind(&body.kind)
            .bind(body.credits)
            .bind(body.request_id)
            .bind(&detail)
            .execute(&mut *tx)
            .await?;
    }
    let spent = used(&mut tx, id, start, end).await?;
    tx.commit().await?;
    Ok(Json(json!({ "limited": true, "monthly_credits": limit, "used_this_month": spent, "remaining": (limit - spent).max(0) })))
}

// The installer, for people allowed to download it only. The page asks for a link (with its token); the link is good
// for 10 minutes and names the person, so a browser can download it without a header.

#[derive(Clone, Debug)]
struct Release {
    version: String,
    file: String,
    size: i64,
    published: String,
    /// GitHub's API address of the asset, fetched with `Accept: application/octet-stream`.
    api_url: String,
}

fn release_cache() -> &'static tokio::sync::Mutex<Option<(std::time::Instant, Option<Release>)>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<(std::time::Instant, Option<Release>)>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn github(state: &AppState, url: &str) -> reqwest::RequestBuilder {
    let request = reqwest::Client::new().get(url).header("user-agent", "turf-core-api").header("x-github-api-version", "2022-11-28");
    if state.config.github_token.is_empty() {
        request
    } else {
        request.bearer_auth(&state.config.github_token)
    }
}

/// The newest published desktop release with a Windows installer, from GitHub, cached for 10 minutes.
async fn latest_release(state: &AppState) -> Option<Release> {
    if state.config.release_repo.is_empty() {
        return None;
    }
    let mut cache = release_cache().lock().await;
    if let Some((at, release)) = cache.as_ref() {
        if at.elapsed() < std::time::Duration::from_secs(600) {
            return release.clone();
        }
    }
    let url = format!("https://api.github.com/repos/{}/releases?per_page=30", state.config.release_repo);
    let found = async {
        let releases: Vec<Value> = github(state, &url).header("accept", "application/vnd.github+json").send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
        releases.iter().find_map(|r| {
            let tag = r["tag_name"].as_str()?;
            if r["draft"] == true || r["prerelease"] == true || !tag.starts_with(&state.config.release_tag_prefix) {
                return None;
            }
            let asset = r["assets"].as_array()?.iter().find(|a| a["name"].as_str().is_some_and(|n| n.to_lowercase().ends_with(".exe")))?;
            Some(Release {
                version: tag.trim_start_matches(&state.config.release_tag_prefix).to_string(),
                file: asset["name"].as_str()?.to_string(),
                size: asset["size"].as_i64().unwrap_or(0),
                published: r["published_at"].as_str().unwrap_or_default().to_string(),
                api_url: asset["url"].as_str()?.to_string(),
            })
        })
    }
    .await;
    *cache = Some((std::time::Instant::now(), found.clone()));
    found
}

fn download_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| {
        let mut key = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut key);
        key
    })
}

fn sign(user: Uuid, expires: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(download_key()).expect("any key length");
    mac.update(format!("download:{user}:{expires}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn download_token(user: Uuid, expires: i64) -> String {
    format!("{expires}.{user}.{}", sign(user, expires))
}

/// The person a download token names, if it is genuine and has not expired.
pub fn check_download_token(token: &str, now: i64) -> Option<Uuid> {
    let mut parts = token.splitn(3, '.');
    let expires: i64 = parts.next()?.parse().ok()?;
    let user = Uuid::parse_str(parts.next()?).ok()?;
    let given = hex::decode(parts.next()?).ok()?;
    if expires < now {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(download_key()).expect("any key length");
    mac.update(format!("download:{user}:{expires}").as_bytes());
    mac.verify_slice(&given).ok()?;
    Some(user)
}

/// Whether this person may download the app now: Turf's staff, or someone whose invitation is active.
async fn may_download(state: &AppState, user: Uuid) -> ApiResult<bool> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.disabled_at IS NULL AND (u.platform_role IS NOT NULL \
           OR EXISTS (SELECT 1 FROM access_invitations i WHERE i.user_id = u.id AND i.status = 'active')))",
    )
    .bind(user)
    .fetch_one(&state.db)
    .await?;
    Ok(allowed)
}

async fn download_link(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    activate(&state, &ctx).await?;
    if !may_download(&state, ctx.user_id).await? {
        return Err(ApiError::forbidden("Only people invited to Turf can download the desktop app"));
    }
    let release = latest_release(&state).await.ok_or_else(|| ApiError::NotFound("No desktop release is published yet".into()))?;
    let expires = Utc::now().timestamp() + 600;
    Ok(Json(json!({ "url": format!("/api/v1/download/{}", download_token(ctx.user_id, expires)), "file": release.file, "version": release.version, "size": release.size })))
}

async fn download(State(state): State<AppState>, Path(token): Path<String>) -> ApiResult<Response> {
    let user = check_download_token(&token, Utc::now().timestamp()).ok_or_else(|| ApiError::forbidden("This download link has expired. Open your dashboard and download again"))?;
    if !may_download(&state, user).await? {
        return Err(ApiError::forbidden("Only people invited to Turf can download the desktop app"));
    }
    let release = latest_release(&state).await.ok_or_else(|| ApiError::NotFound("No desktop release is published yet".into()))?;
    let upstream = github(&state, &release.api_url)
        .header("accept", "application/octet-stream")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("GitHub refused the installer download: {e}")))?;
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", release.file.replace(['"', '\\', '\r', '\n'], ""))) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    if release.size > 0 {
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(release.size as u64));
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((StatusCode::OK, response).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_month_runs_from_its_first_day_to_the_next_months() {
        let (start, end) = month(Utc.with_ymd_and_hms(2026, 12, 31, 23, 59, 0).unwrap());
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap());
        assert_eq!(end, Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap());
        let (start, end) = month(Utc.with_ymd_and_hms(2026, 2, 1, 0, 0, 0).unwrap());
        assert_eq!((start.month(), end.month()), (2, 3));
    }

    #[test]
    fn emails_are_checked_loosely_but_not_carelessly() {
        assert!(valid_email("sam@example.com"));
        assert!(!valid_email("sam@example"));
        assert!(!valid_email("@example.com"));
        assert!(!valid_email("sam @example.com"));
        assert!(!valid_email("Sam <sam@example.com>"));
        assert!(!valid_email("a@b.com,c@d.com"));
    }

    #[test]
    fn download_tokens_name_one_person_and_expire() {
        let user = Uuid::new_v4();
        let token = download_token(user, 1_000);
        assert_eq!(check_download_token(&token, 999), Some(user));
        assert_eq!(check_download_token(&token, 1_001), None);
        let forged = token.replace(&user.to_string(), &Uuid::new_v4().to_string());
        assert_eq!(check_download_token(&forged, 999), None);
        let later = token.replacen("1000", "9000", 1);
        assert_eq!(check_download_token(&later, 999), None);
        assert_eq!(check_download_token("nonsense", 0), None);
    }
}
