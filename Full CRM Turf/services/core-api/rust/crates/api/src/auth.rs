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
/// With an auth-service token, the organization the request acts in (a session of this server remembers it instead).
pub const ORG_HEADER: &str = "x-turf-org";

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
    /// The server requires MFA for the roles that call for it (Config::require_mfa).
    pub mfa_enforced: bool,
    /// The organization's subscription; `None` on a self-hosted organization, which has no limits.
    pub subscription: Option<Subscription>,
}

/// What the request needs to know about the organization's plan.
#[derive(Clone, Debug)]
pub struct Subscription {
    pub plan: String,
    pub status: String,
    /// The period has not ended yet.
    pub current: bool,
}

impl Subscription {
    /// Whether the organization may use the CRM now. Billing pages stay open either way, so it can pay.
    pub fn refusal(&self) -> Option<&'static str> {
        match (self.status.as_str(), self.current) {
            ("trialing", true) | ("active", true) => None,
            ("trialing", false) => Some("Your free trial has ended. Choose a plan to keep using Turf."),
            ("past_due", _) => Some("Your last payment did not go through. Update your plan to keep using Turf."),
            ("canceled", _) => Some("This subscription was cancelled. Choose a plan to use Turf again."),
            _ => Some("Your plan has ended. Renew it to keep using Turf."),
        }
    }
}

impl Ctx {
    pub fn mfa_required(&self) -> bool {
        self.mfa_enforced && self.roles.iter().any(|role| requires_mfa(role))
    }

    /// The organization scope for data access; fails until an organization is chosen, MFA is satisfied and the
    /// organization's plan is in good standing.
    pub fn scope(&self) -> ApiResult<Scope> {
        if let Some(reason) = self.subscription.as_ref().and_then(Subscription::refusal) {
            return Err(ApiError::PaymentRequired(reason.into()));
        }
        self.member_scope()
    }

    /// The organization scope whatever the state of its plan: for billing, so an expired organization can still pay.
    pub fn member_scope(&self) -> ApiResult<Scope> {
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
    let ctx = Ctx {
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
        mfa_enforced: state.config.require_mfa,
        subscription: None,
    };
    let _ = row.session_revision;
    match row.org_id {
        Some(org_id) => with_organization(state, ctx, org_id).await,
        None => Ok(ctx),
    }
}

/// The person's roles, grants and plan in an organization. Without a membership there, the context has no organization.
async fn with_organization(state: &AppState, mut ctx: Ctx, org_id: Uuid) -> ApiResult<Ctx> {
    // Memberships are read before row security applies; the role table needs the organization set.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org_id.to_string()).execute(&mut *tx).await?;
    let membership: Option<(Vec<String>, Vec<String>, Vec<Uuid>, Vec<Uuid>, i64)> = sqlx::query_as(
        "SELECT m.roles, m.restrictions, m.team_ids, m.project_ids, o.access_revision FROM memberships m \
         JOIN organizations o ON o.id = m.org_id WHERE m.org_id = $1 AND m.user_id = $2",
    )
    .bind(org_id)
    .bind(ctx.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((roles, restrictions, team_ids, project_ids, revision)) = membership else {
        // Membership removed: the session no longer opens this organization.
        return Ok(ctx);
    };
    let grants: Vec<(Vec<String>, String)> =
        sqlx::query_as("SELECT capabilities, scope FROM roles WHERE org_id = $1 AND key = ANY($2)").bind(org_id).bind(&roles).fetch_all(&mut *tx).await?;
    let subscription: Option<(String, String, bool)> = sqlx::query_as("SELECT plan_key, status, period_end > now() FROM subscriptions WHERE org_id = $1")
        .bind(org_id)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    ctx.subscription = subscription.map(|(plan, status, current)| Subscription { plan, status, current });
    ctx.access = Access::combine(grants.iter().map(|(c, s)| (&c[..], s.as_str())), &restrictions);
    ctx.org_id = Some(org_id);
    ctx.roles = roles;
    ctx.team_ids = team_ids;
    ctx.project_ids = project_ids;
    ctx.access_revision = revision;
    Ok(ctx)
}

/// A person signed in with the auth service. The token was already checked against auth's public keys; this server
/// only needs the person to exist here too (the same id), and reads the organization from the x-turf-org header.
pub async fn load_from_auth(state: &AppState, claims: &turf_auth_verify::Claims, org_header: Option<&str>) -> ApiResult<Ctx> {
    let user_id = Uuid::parse_str(&claims.sub).map_err(|_| ApiError::Unauthenticated)?;
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT email::text, display_name, totp_secret FROM users WHERE id = $1 AND disabled_at IS NULL").bind(user_id).fetch_optional(&state.db).await?;
    let (email, label, totp_secret) = row.ok_or(ApiError::Unauthenticated)?;
    let ctx = Ctx {
        user_id,
        email,
        label,
        session_hash: format!("auth:{}", claims.sid),
        org_id: None,
        roles: vec![],
        access: Access::default(),
        team_ids: vec![],
        project_ids: vec![],
        access_revision: 0,
        mfa_passed: claims.mfa,
        mfa_enrolled: claims.mfa || totp_secret.is_some(),
        via_cookie: false,
        mfa_enforced: state.config.require_mfa,
        subscription: None,
    };
    match org_header.map(str::trim).filter(|v| !v.is_empty()) {
        Some(org) => with_organization(state, ctx, Uuid::parse_str(org).map_err(|_| ApiError::bad("x-turf-org is not an organization id"))?).await,
        None => Ok(ctx),
    }
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
            // A token from the auth service is checked with its public keys, without calling it.
            if let (Some(verifier), true) = (&state.auth, turf_auth_verify::looks_like_jwt(&token)) {
                let claims = verifier.verify(&token).map_err(|_| ApiError::Unauthenticated)?;
                let org = parts.headers.get(ORG_HEADER).and_then(|v| v.to_str().ok());
                return load_from_auth(state, &claims, org).await;
            }
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
