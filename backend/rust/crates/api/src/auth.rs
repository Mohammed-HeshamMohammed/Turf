//! Accounts, sessions and MFA (plan 2.4): Argon2id passwords, TOTP, recovery codes, revocable sessions.

use crate::{
    access::{requires_mfa, Access},
    db::Scope,
    error::{ApiError, ApiResult},
    state::AppState,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::cookie::CookieJar;
use rand::RngCore;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const COOKIE: &str = "turf_session";
/// Cookie-authenticated mutations must carry this header; browsers cannot add it cross-site without CORS approval.
pub const CSRF_HEADER: &str = "x-turf-request";

pub fn hash_password(password: &str) -> ApiResult<String> {
    if password.chars().count() < 12 {
        return Err(ApiError::bad("Use a password of at least 12 characters"));
    }
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string())
        .map_err(|error| ApiError::Internal(anyhow::anyhow!("hashing failed: {error}")))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()).unwrap_or(false)
}

/// A random token for the client and the hash the server keeps. Only hashes are stored.
pub fn new_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let hash = token_hash(&token);
    (token, hash)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn totp(secret_base32: &str, account: &str) -> ApiResult<totp_rs::TOTP> {
    let secret = totp_rs::Secret::Encoded(secret_base32.to_string()).to_bytes().map_err(|_| ApiError::bad("The MFA secret is not valid"))?;
    totp_rs::TOTP::new(totp_rs::Algorithm::SHA1, 6, 1, 30, secret, Some("Turf".into()), account.to_string())
        .map_err(|error| ApiError::Internal(anyhow::anyhow!("totp: {error}")))
}

pub fn check_totp(secret_base32: &str, account: &str, code: &str) -> bool {
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    totp(secret_base32, account).map(|t| t.check_current(&code).unwrap_or(false)).unwrap_or(false)
}

/// Ten single-use recovery codes, shown once.
pub fn recovery_codes() -> Vec<String> {
    (0..10)
        .map(|_| {
            let mut bytes = [0u8; 5];
            rand::thread_rng().fill_bytes(&mut bytes);
            let raw = hex::encode(bytes);
            format!("{}-{}", &raw[..5], &raw[5..])
        })
        .collect()
}

/// The authenticated person and what they may do in the organization their session has open.
#[derive(Clone, Debug)]
pub struct Ctx {
    pub user_id: Uuid,
    pub email: String,
    pub label: String,
    pub session_hash: String,
    pub org_id: Option<Uuid>,
    pub roles: Vec<String>,
    pub access: Access,
    pub team_ids: Vec<Uuid>,
    pub project_ids: Vec<Uuid>,
    pub access_revision: i64,
    pub mfa_passed: bool,
    pub mfa_enrolled: bool,
    pub via_cookie: bool,
}

impl Ctx {
    pub fn mfa_required(&self) -> bool {
        self.roles.iter().any(|role| requires_mfa(role))
    }

    /// The organization scope for data access; fails until an organization is chosen and MFA is satisfied.
    pub fn scope(&self) -> ApiResult<Scope> {
        let org_id = self.org_id.ok_or_else(|| ApiError::bad("Choose an organization first"))?;
        if self.mfa_required() && !self.mfa_passed {
            return Err(ApiError::MfaRequired);
        }
        Ok(Scope { org_id, user_id: Some(self.user_id), access: self.access.clone(), team_ids: self.team_ids.clone(), project_ids: self.project_ids.clone() })
    }

    pub fn require(&self, capability: &str) -> ApiResult<Scope> {
        let scope = self.scope()?;
        if !self.access.can(capability) {
            return Err(ApiError::forbidden(format!("Your role does not allow this ({capability})")));
        }
        Ok(scope)
    }
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    user_id: Uuid,
    email: String,
    display_name: String,
    org_id: Option<Uuid>,
    mfa_passed: bool,
    totp_secret: Option<String>,
    session_revision: i64,
}

pub async fn load(state: &AppState, token: &str, via_cookie: bool) -> ApiResult<Ctx> {
    let hash = token_hash(token);
    let row: Option<SessionRow> = sqlx::query_as(
        "UPDATE sessions s SET last_seen_at = now() FROM users u \
         WHERE s.token_hash = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL \
         RETURNING s.user_id, u.email::text AS email, u.display_name, s.org_id, s.mfa_passed, u.totp_secret, s.access_revision AS session_revision",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::Unauthenticated)?;
    let mut ctx = Ctx {
        user_id: row.user_id,
        email: row.email,
        label: row.display_name,
        session_hash: hash,
        org_id: None,
        roles: vec![],
        access: Access::default(),
        team_ids: vec![],
        project_ids: vec![],
        access_revision: 0,
        mfa_passed: row.mfa_passed,
        mfa_enrolled: row.totp_secret.is_some(),
        via_cookie,
    };
    let Some(org_id) = row.org_id else { return Ok(ctx) };
    // Memberships are read before row security applies; the role table needs the organization set.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org_id.to_string()).execute(&mut *tx).await?;
    let membership: Option<(Vec<String>, Vec<String>, Vec<Uuid>, Vec<Uuid>, i64)> = sqlx::query_as(
        "SELECT m.roles, m.restrictions, m.team_ids, m.project_ids, o.access_revision FROM memberships m \
         JOIN organizations o ON o.id = m.org_id WHERE m.org_id = $1 AND m.user_id = $2",
    )
    .bind(org_id)
    .bind(row.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((roles, restrictions, team_ids, project_ids, revision)) = membership else {
        // Membership removed: the session no longer opens this organization.
        return Ok(ctx);
    };
    let grants: Vec<(Vec<String>, String)> =
        sqlx::query_as("SELECT capabilities, scope FROM roles WHERE org_id = $1 AND key = ANY($2)").bind(org_id).bind(&roles).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    ctx.access = Access::combine(grants.iter().map(|(c, s)| (&c[..], s.as_str())), &restrictions);
    ctx.org_id = Some(org_id);
    ctx.roles = roles;
    ctx.team_ids = team_ids;
    ctx.project_ids = project_ids;
    ctx.access_revision = revision;
    let _ = row.session_revision;
    Ok(ctx)
}

impl FromRequestParts<AppState> for Ctx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let bearer = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_string);
        if let Some(token) = bearer {
            return load(state, &token, false).await;
        }
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(COOKIE).map(|cookie| cookie.value().to_string()).ok_or(ApiError::Unauthenticated)?;
        let unsafe_method = !matches!(parts.method, axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS);
        if unsafe_method && !parts.headers.contains_key(CSRF_HEADER) {
            return Err(ApiError::forbidden("Missing request header"));
        }
        load(state, &token, true).await
    }
}
