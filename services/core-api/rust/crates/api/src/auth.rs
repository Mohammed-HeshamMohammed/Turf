//! Who is asking (plan 2.4). Accounts, passwords, two-step sign-in and sessions live only in the auth service
//! (services/auth); every request here carries its access token, checked with auth's public keys, and this server
//! decides what that person may do in the organization they name.

use crate::{
    access::{requires_mfa, Access},
    db::Scope,
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{extract::FromRequestParts, http::request::Parts};
use rand::RngCore;
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// The organization the request acts in.
pub const ORG_HEADER: &str = "x-turf-org";
/// A browser cannot put headers on a WebSocket, so the live-events socket carries the token and organization in its
/// subprotocol list instead: `["turf.v1", "bearer.<access token>", "org.<organization id>"]`. Unlike a query string,
/// that list is not written to proxy and server logs.
pub const SOCKET_PROTOCOL: &str = "turf.v1";

/// The token and organization from a Sec-WebSocket-Protocol header, when the client sent them that way.
pub fn from_socket_protocols(header: &str) -> (Option<String>, Option<String>) {
    let mut token = None;
    let mut org = None;
    for item in header.split(',').map(str::trim) {
        if let Some(t) = item.strip_prefix("bearer.") {
            token = Some(t.to_string());
        } else if let Some(o) = item.strip_prefix("org.") {
            org = Some(o.to_string());
        }
    }
    (token, org)
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

/// The authenticated person and what they may do in the organization the request names.
#[derive(Clone, Debug)]
pub struct Ctx {
    pub user_id: Uuid,
    pub email: String,
    pub label: String,
    /// The auth service's session id, `auth:<sid>`.
    pub session_id: String,
    pub org_id: Option<Uuid>,
    pub roles: Vec<String>,
    pub access: Access,
    pub team_ids: Vec<Uuid>,
    pub project_ids: Vec<Uuid>,
    pub access_revision: i64,
    pub mfa_passed: bool,
    pub mfa_enrolled: bool,
    /// The server requires MFA for the roles that call for it (Config::require_mfa).
    pub mfa_enforced: bool,
    /// Caller Whale's own staff (platform owner or system administrator): they always need the authenticator code, whatever
    /// the server's setting.
    pub staff: bool,
    /// The organization's subscription; `None` on a self-hosted organization, which has no limits.
    pub subscription: Option<Subscription>,
    /// Caller Whale has suspended this workspace from the admin dashboard.
    pub suspended: bool,
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
            ("canceled", _) => Some("This subscription was cancelled. Choose a plan to use Caller Whale again."),
            _ => Some("Your plan has ended. Renew it to keep using Turf."),
        }
    }
}

impl Ctx {
    pub fn mfa_required(&self) -> bool {
        self.staff || (self.mfa_enforced && self.roles.iter().any(|role| requires_mfa(role)))
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
        if self.suspended {
            return Err(ApiError::forbidden("This workspace is suspended. Contact Caller Whale support."));
        }
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

/// The person's roles, grants and plan in an organization. Without a membership there, the context has no organization.
async fn with_organization(state: &AppState, mut ctx: Ctx, org_id: Uuid) -> ApiResult<Ctx> {
    // Memberships are read before row security applies; the role table needs the organization set.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('turf.org_id', $1, true)").bind(org_id.to_string()).execute(&mut *tx).await?;
    let membership: Option<(Vec<String>, Vec<String>, Vec<Uuid>, Vec<Uuid>, i64, bool)> = sqlx::query_as(
        "SELECT m.roles, m.restrictions, m.team_ids, m.project_ids, o.access_revision, o.suspended_at IS NOT NULL FROM memberships m \
         JOIN organizations o ON o.id = m.org_id WHERE m.org_id = $1 AND m.user_id = $2 AND (m.expires_at IS NULL OR m.expires_at > now())",
    )
    .bind(org_id)
    .bind(ctx.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((roles, restrictions, team_ids, project_ids, revision, suspended)) = membership else {
        // Membership removed or its period over: the person no longer opens this organization.
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
    ctx.suspended = suspended;
    Ok(ctx)
}

/// This server's copy of a person the auth service vouches for: created the first time they arrive (same id, an
/// unusable password, since auth checks passwords now), and told when auth says their email is confirmed. A disabled
/// account here stays refused. An email already used by a different account here is refused rather than merged.
async fn local_person(state: &AppState, user_id: Uuid, claims: &turf_auth_verify::Claims) -> ApiResult<(String, String, Option<String>, bool)> {
    let read = || sqlx::query_as::<_, (String, String, Option<String>, bool, bool, bool, Option<String>)>(
        "SELECT email::text, display_name, totp_secret, disabled_at IS NOT NULL, email_verified_at IS NOT NULL, platform_role IS NOT NULL, sign_in_provider \
         FROM users WHERE id = $1",
    )
    .bind(user_id);
    let mut row = read().fetch_optional(&state.db).await?;
    if row.is_none() {
        sqlx::query(
            "INSERT INTO users (id, email, display_name, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END) ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(claims.email.trim().to_lowercase())
        .bind(claims.name.trim())
        .bind(crate::routes::billing::NO_PASSWORD)
        .bind(claims.email_verified)
        .execute(&state.db)
        .await?;
        row = read().fetch_optional(&state.db).await?;
    }
    let Some((email, label, totp_secret, disabled, verified, staff, provider)) = row else {
        return Err(ApiError::Conflict("This email address belongs to another account on this server. Contact support to merge them.".into()));
    };
    if disabled {
        return Err(ApiError::Unauthenticated);
    }
    // How they signed in this time, for the people lists; written only when it changed.
    if !claims.provider.is_empty() && provider.as_deref() != Some(claims.provider.as_str()) {
        sqlx::query("UPDATE users SET sign_in_provider = $2 WHERE id = $1").bind(user_id).bind(&claims.provider).execute(&state.db).await?;
    }
    if claims.email_verified && !verified {
        sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL").bind(user_id).execute(&state.db).await?;
    }
    Ok((email, label, totp_secret, staff))
}

/// The person's id here. An auth-service token carries it. A Firebase token carries a Firebase uid instead, kept in
/// users.firebase_uid: an account moved from the auth service has its id as its uid and is linked the first time it
/// arrives; anyone else gets a new id. An email already used by a different account here is refused, not merged.
async fn person_id(state: &AppState, claims: &turf_auth_verify::Claims) -> ApiResult<Uuid> {
    if !turf_auth_verify::is_firebase(claims) {
        return Uuid::parse_str(&claims.sub).map_err(|_| ApiError::Unauthenticated);
    }
    let uid = claims.sub.as_str();
    let find = || sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE firebase_uid = $1").bind(uid);
    if let Some(id) = find().fetch_optional(&state.db).await? {
        return Ok(id);
    }
    if let Ok(id) = Uuid::parse_str(uid) {
        let linked: Option<Uuid> = sqlx::query_scalar("UPDATE users SET firebase_uid = $1 WHERE id = $2 AND firebase_uid IS NULL RETURNING id")
            .bind(uid)
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
        if let Some(id) = linked {
            return Ok(id);
        }
    }
    // Two first requests at once: the second insert does nothing and both read the same row.
    sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, email_verified_at, firebase_uid) \
         VALUES (gen_random_uuid(), $1, $2, $3, CASE WHEN $4 THEN now() END, $5) ON CONFLICT DO NOTHING",
    )
    .bind(claims.email.trim().to_lowercase())
    .bind(claims.name.trim())
    .bind(crate::routes::billing::NO_PASSWORD)
    .bind(claims.email_verified)
    .bind(uid)
    .execute(&state.db)
    .await?;
    find().fetch_optional(&state.db).await?.ok_or_else(|| ApiError::Conflict("This email address belongs to another account on this server. Contact support to merge them.".into()))
}

/// A person signed in with the auth service. The token was already checked against auth's public keys; this server
/// only needs the person to exist here too (the same id), and reads the organization from the x-turf-org header.
pub async fn load_from_auth(state: &AppState, claims: &turf_auth_verify::Claims, org_header: Option<&str>) -> ApiResult<Ctx> {
    let user_id = person_id(state, claims).await?;
    let (email, label, totp_secret, staff) = local_person(state, user_id, claims).await?;
    let ctx = Ctx {
        user_id,
        email,
        label,
        session_id: format!("auth:{}", claims.sid),
        org_id: None,
        roles: vec![],
        access: Access::default(),
        team_ids: vec![],
        project_ids: vec![],
        access_revision: 0,
        mfa_passed: claims.mfa,
        mfa_enrolled: claims.mfa || totp_secret.is_some(),
        mfa_enforced: state.config.require_mfa,
        // Staff need the authenticator code everywhere, unless the server has turned that off (TURF_STAFF_MFA).
        staff: staff && state.config.staff_mfa,
        subscription: None,
        suspended: false,
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
        let (socket_token, socket_org) = parts
            .headers
            .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|v| v.to_str().ok())
            .map(from_socket_protocols)
            .unwrap_or_default();
        // Only an auth-service token is accepted, checked with its public keys without calling it. With no cookie
        // sessions any more, a request cannot be made on someone's behalf by another site, so there is no CSRF check.
        let token = bearer.or(socket_token).filter(|t| turf_auth_verify::looks_like_jwt(t)).ok_or(ApiError::Unauthenticated)?;
        // A token is the auth service's (EdDSA) or Firebase's (RS256); each verifier refuses the other's.
        let from_auth = state.auth.as_ref().and_then(|v| v.verify(&token).ok());
        let claims = match from_auth {
            Some(claims) => claims,
            None => {
                let firebase = state.firebase.as_ref().ok_or(ApiError::Unauthenticated)?;
                let verifier = firebase.read().unwrap_or_else(|p| p.into_inner()).clone();
                verifier.verify(&token).map_err(|_| ApiError::Unauthenticated)?
            }
        };
        let org = parts.headers.get(ORG_HEADER).and_then(|v| v.to_str().ok()).map(str::to_string).or(socket_org);
        load_from_auth(state, &claims, org.as_deref()).await
    }
}

#[cfg(test)]
mod socket_tests {
    use super::from_socket_protocols;

    #[test]
    fn the_token_and_organization_come_from_the_socket_protocols() {
        assert_eq!(
            from_socket_protocols("turf.v1, bearer.a.b.c, org.7d3c0d2e-0000-4000-8000-000000000000"),
            (Some("a.b.c".into()), Some("7d3c0d2e-0000-4000-8000-000000000000".into()))
        );
        assert_eq!(from_socket_protocols("turf.v1"), (None, None));
        assert_eq!(from_socket_protocols(""), (None, None));
    }
}
