//! The HTTP API. Contract: services/auth/openapi.yaml.

use crate::{
    email,
    error::{AuthError, AuthResult},
    keys::Person as TokenPerson,
    now, oauth, AppState,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, State},
    http::{header, request::Parts, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use turf_auth_verify::Claims;
use uuid::Uuid;

/// Five failed sign-ins for one email within this many seconds pauses that email.
const LOCKOUT_WINDOW: i64 = 15 * 60;
const LOCKOUT_FAILURES: i64 = 5;
const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({ "ok": true, "service": "auth" })) }))
        .route("/version", get(|| async { Json(json!({ "service": "auth", "version": VERSION })) }))
        .route("/.well-known/jwks.json", get(jwks))
        .route("/v1/accounts", post(sign_up))
        .route("/v1/sessions", post(sign_in).get(list_sessions))
        .route("/v1/sessions/refresh", post(refresh))
        .route("/v1/sessions/sign-out", post(sign_out))
        .route("/v1/sessions/revoke", post(revoke))
        .route("/v1/me", get(me))
        .route("/v1/password", post(change_password))
        .route("/v1/mfa/setup", post(mfa_setup))
        .route("/v1/mfa/confirm", post(mfa_confirm))
        .route("/v1/mfa/verify", post(mfa_verify))
        .merge(email::routes())
        .merge(oauth::routes())
}

// ---- helpers ----

pub(crate) fn hash_password(password: &str) -> AuthResult<String> {
    if password.chars().count() < 12 {
        return Err(AuthError::Bad("Use a password of at least 12 characters.".into()));
    }
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|h| h.to_string())
        .map_err(|e| AuthError::Internal(anyhow::anyhow!("hashing failed: {e}")))
}

fn password_matches(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()).unwrap_or(false)
}

pub(crate) fn sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// A random secret for the client and the hash the server keeps. Only the hash is stored.
pub(crate) fn new_secret() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = hex::encode(bytes);
    let hash = sha256(&secret);
    (secret, hash)
}

fn totp(secret: &str, account: &str) -> AuthResult<totp_rs::TOTP> {
    let bytes = totp_rs::Secret::Encoded(secret.to_string()).to_bytes().map_err(|_| AuthError::Bad("The two-step secret is not valid.".into()))?;
    totp_rs::TOTP::new(totp_rs::Algorithm::SHA1, 6, 1, 30, bytes, Some("Caller Whale".into()), account.to_string())
        .map_err(|e| AuthError::Internal(anyhow::anyhow!("totp: {e}")))
}

fn code_matches(secret: &str, account: &str, code: &str) -> bool {
    let digits: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.len() == 6 && totp(secret, account).map(|t| t.check_current(&digits).unwrap_or(false)).unwrap_or(false)
}

fn recovery_codes() -> Vec<String> {
    (0..10)
        .map(|_| {
            let mut bytes = [0u8; 5];
            rand::thread_rng().fill_bytes(&mut bytes);
            let raw = hex::encode(bytes);
            format!("{}-{}", &raw[..5], &raw[5..])
        })
        .collect()
}

pub(crate) fn normal_email(email: &str) -> AuthResult<String> {
    let email = email.trim().to_lowercase();
    let ok = email.len() <= 254 && email.split_once('@').is_some_and(|(a, b)| !a.is_empty() && b.contains('.') && !b.starts_with('.') && !b.ends_with('.'));
    if ok && !email.contains(char::is_whitespace) {
        Ok(email)
    } else {
        Err(AuthError::Bad("Enter a valid email address.".into()))
    }
}

pub(crate) struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub password_hash: String,
    pub totp_secret: Option<String>,
    pub disabled: bool,
    pub email_verified: bool,
}

pub(crate) async fn user_by(state: &AppState, column: &str, value: &str) -> AuthResult<Option<User>> {
    let sql = format!("SELECT id, email, display_name, password_hash, totp_secret, disabled_at, email_verified_at FROM users WHERE {column} = $1");
    let row = sqlx::query(&sql).bind(value).fetch_optional(&state.db).await?;
    Ok(match row {
        None => None,
        Some(r) => Some(User {
            id: r.try_get("id")?,
            email: r.try_get("email")?,
            name: r.try_get("display_name")?,
            password_hash: r.try_get("password_hash")?,
            totp_secret: r.try_get("totp_secret")?,
            disabled: r.try_get::<Option<i64>, _>("disabled_at")?.is_some(),
            email_verified: r.try_get::<Option<i64>, _>("email_verified_at")?.is_some(),
        }),
    })
}

/// Opens a session and returns the tokens for it. `provider`: how it began ("password", "google", "apple").
pub(crate) async fn open_session(state: &AppState, user: &User, kind: &str, mfa_passed: bool, provider: &str) -> AuthResult<Value> {
    let t = now() as i64;
    let id = Uuid::new_v4().to_string();
    let (refresh, refresh_hash) = new_secret();
    let expires = t + state.config.refresh_days as i64 * 86_400;
    sqlx::query("INSERT INTO sessions (id, user_id, refresh_hash, kind, mfa_passed, created_at, last_seen_at, expires_at, provider) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)")
        .bind(&id)
        .bind(&user.id)
        .bind(&refresh_hash)
        .bind(kind)
        .bind(mfa_passed as i64)
        .bind(t)
        .bind(expires)
        .bind(provider)
        .execute(&state.db)
        .await?;
    tokens(state, user, &id, mfa_passed, provider, refresh)
}

fn tokens(state: &AppState, user: &User, sid: &str, mfa: bool, provider: &str, refresh: String) -> AuthResult<Value> {
    let person = TokenPerson { id: user.id.clone(), email: user.email.clone(), name: user.name.clone(), email_verified: user.email_verified };
    let (access, expires_in) = state.keys.sign(&person, sid, mfa, provider, now(), state.config.access_minutes)?;
    Ok(json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": expires_in,
        "refresh_token": refresh,
        "user": { "id": user.id, "email": user.email, "name": user.name, "email_verified": user.email_verified },
    }))
}

async fn recent_failures(state: &AppState, email: &str) -> AuthResult<i64> {
    let since = now() as i64 - LOCKOUT_WINDOW;
    Ok(sqlx::query("SELECT COUNT(*) AS n FROM failed_sign_ins WHERE email = $1 AND at > $2").bind(email).bind(since).fetch_one(&state.db).await?.try_get("n")?)
}

async fn record_failure(state: &AppState, email: &str) -> AuthResult<()> {
    sqlx::query("INSERT INTO failed_sign_ins (email, at) VALUES ($1, $2)").bind(email).bind(now() as i64).execute(&state.db).await?;
    Ok(())
}

fn kind_of(kind: Option<&str>) -> AuthResult<&'static str> {
    match kind.unwrap_or("browser") {
        "browser" => Ok("browser"),
        "desktop" => Ok("desktop"),
        _ => Err(AuthError::Bad("kind is browser or desktop.".into())),
    }
}

// ---- the signed-in person ----

/// The person behind a request's `Authorization: Bearer <access token>`, with a session that is still open.
pub struct Person(pub Claims);

impl FromRequestParts<AppState> for Person {
    type Rejection = AuthError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(AuthError::Unauthenticated)?;
        let claims = state.keys.verifier.verify(token).map_err(|_| AuthError::Unauthenticated)?;
        // Other services trust the token until it expires; this service also refuses one whose session was closed.
        let open = sqlx::query("SELECT 1 AS one FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3")
            .bind(&claims.sid)
            .bind(&claims.sub)
            .bind(now() as i64)
            .fetch_optional(&state.db)
            .await?;
        if open.is_none() {
            return Err(AuthError::Unauthenticated);
        }
        Ok(Person(claims))
    }
}

// ---- handlers ----

async fn jwks(State(state): State<AppState>) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=300")], state.keys.jwks.clone())
}

#[derive(Deserialize)]
struct SignUp {
    email: String,
    password: String,
    name: String,
    kind: Option<String>,
}

async fn sign_up(State(state): State<AppState>, Json(body): Json<SignUp>) -> AuthResult<(StatusCode, Json<Value>)> {
    if !state.config.public_signup {
        return Err(AuthError::Forbidden("New accounts are by invitation on this server.".into()));
    }
    let email = normal_email(&body.email)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(AuthError::Bad("Enter your name.".into()));
    }
    let kind = kind_of(body.kind.as_deref())?;
    let hash = hash_password(&body.password)?;
    if user_by(&state, "email", &email).await?.is_some() {
        return Err(AuthError::Conflict("An account with this email already exists. Sign in instead.".into()));
    }
    let user = User { id: Uuid::new_v4().to_string(), email, name, password_hash: hash, totp_secret: None, disabled: false, email_verified: false };
    let t = now() as i64;
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(&user.id)
        .bind(&user.email)
        .bind(&user.name)
        .bind(&user.password_hash)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    email::outbox(&mut tx, "user.signed_up", json!({ "user_id": user.id, "version": 1 })).await?;
    let link = email::new_verification(&mut tx, &user.id).await?;
    tx.commit().await?;
    let mut reply = open_session(&state, &user, kind, false, "password").await?;
    email::with_dev_token(&state, &mut reply, link);
    Ok((StatusCode::CREATED, Json(reply)))
}

#[derive(Deserialize)]
struct SignIn {
    email: String,
    password: String,
    /// A code from the authenticator app, or a recovery code.
    code: Option<String>,
    kind: Option<String>,
}

async fn sign_in(State(state): State<AppState>, Json(body): Json<SignIn>) -> AuthResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    let kind = kind_of(body.kind.as_deref())?;
    if recent_failures(&state, &email).await? >= LOCKOUT_FAILURES {
        return Err(AuthError::TooMany);
    }
    let user = match user_by(&state, "email", &email).await? {
        Some(u) if !u.disabled && password_matches(&body.password, &u.password_hash) => u,
        _ => {
            record_failure(&state, &email).await?;
            return Err(AuthError::WrongCredentials);
        }
    };
    let mut mfa_passed = false;
    if let Some(secret) = &user.totp_secret {
        let code = body.code.as_deref().map(str::trim).filter(|c| !c.is_empty()).ok_or(AuthError::MfaRequired)?;
        if code_matches(secret, &user.email, code) {
            mfa_passed = true;
        } else if use_recovery_code(&state, &user.id, code).await? {
            mfa_passed = true;
        } else {
            record_failure(&state, &email).await?;
            return Err(AuthError::WrongCode);
        }
    }
    sqlx::query("DELETE FROM failed_sign_ins WHERE email = $1").bind(&email).execute(&state.db).await?;
    Ok(Json(open_session(&state, &user, kind, mfa_passed, "password").await?))
}

/// Marks a recovery code used. True when it was one of the person's unused codes.
async fn use_recovery_code(state: &AppState, user_id: &str, code: &str) -> AuthResult<bool> {
    let hash = sha256(&code.trim().to_lowercase());
    let done = sqlx::query("UPDATE recovery_codes SET used_at = $1 WHERE user_id = $2 AND code_hash = $3 AND used_at IS NULL")
        .bind(now() as i64)
        .bind(user_id)
        .bind(&hash)
        .execute(&state.db)
        .await?;
    Ok(done.rows_affected() == 1)
}

#[derive(Deserialize)]
struct Refresh {
    refresh_token: String,
}

async fn refresh(State(state): State<AppState>, Json(body): Json<Refresh>) -> AuthResult<Json<Value>> {
    let presented = sha256(body.refresh_token.trim());
    let t = now() as i64;
    let row = sqlx::query("SELECT id, user_id, mfa_passed, provider FROM sessions WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > $2")
        .bind(&presented)
        .bind(t)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        // A refresh token that was already used: someone else has it. End that session.
        sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE prev_refresh_hash = $2 AND revoked_at IS NULL").bind(t).bind(&presented).execute(&state.db).await?;
        return Err(AuthError::Unauthenticated);
    };
    let sid: String = row.try_get("id")?;
    let user_id: String = row.try_get("user_id")?;
    let mfa: i64 = row.try_get("mfa_passed")?;
    let provider: String = row.try_get("provider")?;
    let user = user_by(&state, "id", &user_id).await?.filter(|u| !u.disabled).ok_or(AuthError::Unauthenticated)?;
    let (next, next_hash) = new_secret();
    sqlx::query("UPDATE sessions SET refresh_hash = $1, prev_refresh_hash = $2, last_seen_at = $3 WHERE id = $4")
        .bind(&next_hash)
        .bind(&presented)
        .bind(t)
        .bind(&sid)
        .execute(&state.db)
        .await?;
    Ok(Json(tokens(&state, &user, &sid, mfa == 1, &provider, next)?))
}

#[derive(Deserialize, Default)]
struct SignOut {
    refresh_token: Option<String>,
}

/// Ends the session of the access token, or of the refresh token in the body.
async fn sign_out(State(state): State<AppState>, parts: Parts, body: Option<Json<SignOut>>) -> AuthResult<Json<Value>> {
    let t = now() as i64;
    let mut parts = parts;
    if let Ok(Person(claims)) = Person::from_request_parts(&mut parts, &state).await {
        sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL").bind(t).bind(&claims.sid).execute(&state.db).await?;
        return Ok(Json(json!({ "ok": true })));
    }
    let refresh = body.and_then(|Json(b)| b.refresh_token).ok_or(AuthError::Unauthenticated)?;
    sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE refresh_hash = $2 AND revoked_at IS NULL").bind(t).bind(sha256(refresh.trim())).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_sessions(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let rows = sqlx::query("SELECT id, kind, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_seen_at DESC")
        .bind(&claims.sub)
        .bind(now() as i64)
        .fetch_all(&state.db)
        .await?;
    let mut sessions = Vec::new();
    for r in rows {
        let id: String = r.try_get("id")?;
        sessions.push(json!({
            "id": id,
            "kind": r.try_get::<String, _>("kind")?,
            "created_at": r.try_get::<i64, _>("created_at")?,
            "last_seen_at": r.try_get::<i64, _>("last_seen_at")?,
            "current": id == claims.sid,
        }));
    }
    Ok(Json(json!({ "sessions": sessions })))
}

#[derive(Deserialize)]
struct Revoke {
    session_id: Option<String>,
    /// Close every other session of this person.
    #[serde(default)]
    others: bool,
}

async fn revoke(State(state): State<AppState>, Person(claims): Person, Json(body): Json<Revoke>) -> AuthResult<Json<Value>> {
    let t = now() as i64;
    let done = if body.others {
        sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL").bind(t).bind(&claims.sub).bind(&claims.sid).execute(&state.db).await?
    } else {
        let id = body.session_id.ok_or_else(|| AuthError::Bad("Say which session to close.".into()))?;
        sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id = $3 AND revoked_at IS NULL").bind(t).bind(&claims.sub).bind(&id).execute(&state.db).await?
    };
    Ok(Json(json!({ "ok": true, "closed": done.rows_affected() })))
}

async fn me(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    Ok(Json(json!({
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "mfa_enrolled": user.totp_secret.is_some(),
        "email_verified": user.email_verified,
        "mfa_passed": claims.mfa,
        "session_id": claims.sid,
    })))
}

#[derive(Deserialize)]
struct PasswordChange {
    current: String,
    new: String,
}

/// Changes the password and closes every other session.
async fn change_password(State(state): State<AppState>, Person(claims): Person, Json(body): Json<PasswordChange>) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    if !password_matches(&body.current, &user.password_hash) {
        return Err(AuthError::WrongCredentials);
    }
    let hash = hash_password(&body.new)?;
    let t = now() as i64;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(&hash).bind(&user.id).execute(&state.db).await?;
    sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL").bind(t).bind(&user.id).bind(&claims.sid).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn mfa_setup(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    if user.totp_secret.is_some() {
        return Err(AuthError::Conflict("Two-step sign-in is already on.".into()));
    }
    let secret = match totp_rs::Secret::generate_secret().to_encoded() {
        totp_rs::Secret::Encoded(s) => s,
        totp_rs::Secret::Raw(_) => return Err(AuthError::Internal(anyhow::anyhow!("secret was not encoded"))),
    };
    let url = totp(&secret, &user.email)?.get_url();
    sqlx::query("UPDATE users SET totp_pending = $1 WHERE id = $2").bind(&secret).bind(&user.id).execute(&state.db).await?;
    Ok(Json(json!({ "secret": secret, "otpauth_url": url })))
}

#[derive(Deserialize)]
struct Code {
    code: String,
}

/// Turns two-step sign-in on with the first code, and returns ten recovery codes, shown only this once.
async fn mfa_confirm(State(state): State<AppState>, Person(claims): Person, Json(body): Json<Code>) -> AuthResult<Json<Value>> {
    let row = sqlx::query("SELECT email, totp_pending FROM users WHERE id = $1").bind(&claims.sub).fetch_optional(&state.db).await?.ok_or(AuthError::Unauthenticated)?;
    let email: String = row.try_get("email")?;
    let pending: Option<String> = row.try_get("totp_pending")?;
    let pending = pending.ok_or_else(|| AuthError::Bad("Start two-step setup first.".into()))?;
    if !code_matches(&pending, &email, &body.code) {
        return Err(AuthError::WrongCode);
    }
    let codes = recovery_codes();
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET totp_secret = $1, totp_pending = NULL WHERE id = $2").bind(&pending).bind(&claims.sub).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = $1").bind(&claims.sub).execute(&mut *tx).await?;
    for code in &codes {
        sqlx::query("INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)").bind(&claims.sub).bind(sha256(code)).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE sessions SET mfa_passed = 1 WHERE id = $1").bind(&claims.sid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

/// Confirms a two-step code for the session already open (a Google or Apple sign-in, which does not ask for one), and
/// returns an access token that says so. The refresh token stays the same; its next tokens say so too.
async fn mfa_verify(State(state): State<AppState>, Person(claims): Person, Json(body): Json<Code>) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    let secret = user.totp_secret.clone().ok_or_else(|| AuthError::Bad("Two-step sign-in is not on for this account.".into()))?;
    if recent_failures(&state, &user.email).await? >= LOCKOUT_FAILURES {
        return Err(AuthError::TooMany);
    }
    let code = body.code.trim();
    if !(code_matches(&secret, &user.email, code) || use_recovery_code(&state, &user.id, code).await?) {
        record_failure(&state, &user.email).await?;
        return Err(AuthError::WrongCode);
    }
    sqlx::query("UPDATE sessions SET mfa_passed = 1 WHERE id = $1").bind(&claims.sid).execute(&state.db).await?;
    let person = TokenPerson { id: user.id.clone(), email: user.email.clone(), name: user.name.clone(), email_verified: user.email_verified };
    let (access, expires_in) = state.keys.sign(&person, &claims.sid, true, &claims.provider, now(), state.config.access_minutes)?;
    Ok(Json(json!({ "access_token": access, "token_type": "Bearer", "expires_in": expires_in })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_checked_and_lower_cased() {
        assert_eq!(normal_email("  Sami@Example.COM ").unwrap(), "sami@example.com");
        for bad in ["", "sami", "@example.com", "sami@", "sami@example", "sa mi@example.com", "sami@.com"] {
            assert!(normal_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn short_passwords_are_refused_and_hashes_check() {
        assert!(hash_password("short").is_err());
        let hash = hash_password("a long enough password").unwrap();
        assert!(password_matches("a long enough password", &hash));
        assert!(!password_matches("another password!!", &hash));
        assert!(!password_matches("anything", "not a hash"));
    }

    #[test]
    fn recovery_codes_are_ten_and_different() {
        let codes = recovery_codes();
        assert_eq!(codes.len(), 10);
        assert_eq!(codes.iter().collect::<std::collections::HashSet<_>>().len(), 10);
        assert!(codes.iter().all(|c| c.len() == 11 && c.as_bytes()[5] == b'-'));
    }
}
