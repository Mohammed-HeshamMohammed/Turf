//! The second step at sign-in (docs/plans/second-factor.md): an authenticator app (up to three devices), a code by email, a code
//! by Telegram, or an approval on a device that is already signed in. This service owns it, whether the password is checked by
//! Firebase or here, and the `mfa` claim in a token means one of these passed.
//!
//! A sign-in whose person has set something up answers `mfa_required` with a one-time challenge and the ways to answer it.
//! Email and Telegram codes are six digits, good for ten minutes, and used once. Five wrong answers end a challenge. A step-up
//! (after a Google sign-in, or for a person who has set nothing up yet but must) is the same challenge on an open session.

use crate::{
    error::{AuthError, AuthResult},
    firebase::FbSession,
    keys::Person as TokenPerson,
    now,
    routes::{code_matches, new_secret, open_session_fb, recent_failures, record_failure, recovery_codes, sha256, totp, use_recovery_code, user_by, Person, User, LOCKOUT_FAILURES},
    AppState,
};
use axum::{
    extract::{Path, State},
    routing::{delete, get, post},
    Json, Router,
};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

/// An authenticator app may be set up on this many devices; setting up another removes the one set up longest ago.
pub const MAX_TOTP: i64 = 3;
const CHALLENGE_SECONDS: i64 = 600;
const CODE_SECONDS: i64 = 600;
const PUSH_SECONDS: i64 = 300;
const MAX_TRIES: i64 = 5;
const RESEND_SECONDS: i64 = 30;
const LINK_SECONDS: i64 = 600;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/mfa/factors", get(factors))
        .route("/v1/mfa/factors/{id}", delete(remove_factor))
        .route("/v1/mfa/setup", post(totp_setup))
        .route("/v1/mfa/totp/setup", post(totp_setup))
        .route("/v1/mfa/confirm", post(totp_confirm))
        .route("/v1/mfa/totp/confirm", post(totp_confirm))
        .route("/v1/mfa/verify", post(verify_session))
        .route("/v1/mfa/challenge/start", post(challenge_start))
        .route("/v1/mfa/challenge/send", post(challenge_send))
        .route("/v1/mfa/challenge/status", post(challenge_status))
        .route("/v1/mfa/challenge/answer", post(challenge_answer))
        .route("/v1/mfa/approvals", get(approvals))
        .route("/v1/mfa/approvals/{id}", post(decide))
        .route("/v1/mfa/telegram/link", post(telegram_link))
        .route("/v1/mfa/telegram/webhook/{secret}", post(telegram_webhook))
}

// ---- what a person has, and what a sign-in may use ----

/// Whether the person has set up any second step of their own (an authenticator or Telegram). Email needs no setup.
pub(crate) async fn enrolled(state: &AppState, user_id: &str) -> AuthResult<bool> {
    Ok(sqlx::query("SELECT 1 AS one FROM mfa_factors WHERE user_id = $1 LIMIT 1").bind(user_id).fetch_optional(&state.db).await?.is_some())
}

async fn totp_secrets(state: &AppState, user_id: &str) -> AuthResult<Vec<(String, String)>> {
    let rows = sqlx::query("SELECT id, secret FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' ORDER BY n").bind(user_id).fetch_all(&state.db).await?;
    rows.iter().map(|r| Ok((r.try_get("id")?, r.try_get("secret")?))).collect()
}

async fn telegram_chat(state: &AppState, user_id: &str) -> AuthResult<Option<String>> {
    let row = sqlx::query("SELECT secret FROM mfa_factors WHERE user_id = $1 AND kind = 'telegram' ORDER BY n DESC LIMIT 1").bind(user_id).fetch_optional(&state.db).await?;
    Ok(match row {
        Some(r) => Some(r.try_get("secret")?),
        None => None,
    })
}

/// Another session of this person that has passed a second step, which can approve a sign-in.
async fn approver_exists(state: &AppState, user_id: &str, except_session: &str) -> AuthResult<bool> {
    Ok(sqlx::query("SELECT 1 AS one FROM sessions WHERE user_id = $1 AND mfa_passed = 1 AND revoked_at IS NULL AND expires_at > $2 AND id <> $3 LIMIT 1")
        .bind(user_id)
        .bind(now() as i64)
        .bind(except_session)
        .fetch_optional(&state.db)
        .await?
        .is_some())
}

/// The ways this person can answer a challenge right now.
pub(crate) async fn methods(state: &AppState, user: &User, session: Option<&str>) -> AuthResult<Vec<&'static str>> {
    let mut found = vec![];
    if !totp_secrets(state, &user.id).await?.is_empty() {
        found.push("totp");
    }
    if state.config.mailer.is_some() && user.email_verified {
        found.push("email");
    }
    if state.config.telegram.is_some() && telegram_chat(state, &user.id).await?.is_some() {
        found.push("telegram");
    }
    if approver_exists(state, &user.id, session.unwrap_or("")).await? {
        found.push("push");
    }
    Ok(found)
}

/// Checks a code from an authenticator device, or a recovery code (only where this service keeps its own accounts).
pub(crate) async fn verify_totp(state: &AppState, user: &User, code: &str) -> AuthResult<bool> {
    let code = code.trim();
    for (id, secret) in totp_secrets(state, &user.id).await? {
        if code_matches(&secret, &user.email, code) {
            sqlx::query("UPDATE mfa_factors SET last_used_at = $1 WHERE id = $2").bind(now() as i64).bind(&id).execute(&state.db).await?;
            return Ok(true);
        }
    }
    Ok(state.config.firebase.is_none() && use_recovery_code(state, &user.id, code).await?)
}

// ---- challenges ----

pub(crate) struct Challenge {
    id: String,
    user_id: String,
    session_id: Option<String>,
    kind: String,
    provider: String,
    fb_refresh: Option<String>,
    code_hash: Option<String>,
    code_method: Option<String>,
    code_sent_at: Option<i64>,
    code_expires_at: Option<i64>,
    tries: i64,
    push_state: String,
}

/// A new challenge for a sign-in (no session yet) or for an open session, and the error that hands it to the client.
pub(crate) async fn challenge_error(state: &AppState, user: &User, session: Option<&str>, kind: &str, provider: &str, fb: Option<&FbSession>) -> AuthResult<AuthError> {
    let t = now() as i64;
    let (token, hash) = new_secret();
    sqlx::query("DELETE FROM mfa_challenges WHERE expires_at < $1").bind(t).execute(&state.db).await?;
    sqlx::query("INSERT INTO mfa_challenges (id, token_hash, user_id, session_id, session_kind, provider, fb_refresh, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
        .bind(Uuid::new_v4().to_string())
        .bind(&hash)
        .bind(&user.id)
        .bind(session)
        .bind(kind)
        .bind(provider)
        .bind(fb.map(|f| f.refresh.clone()).filter(|r| !r.is_empty()))
        .bind(t)
        .bind(t + CHALLENGE_SECONDS)
        .execute(&state.db)
        .await?;
    Ok(AuthError::MfaChallenge { challenge: token, methods: methods(state, user, session).await? })
}

async fn load(state: &AppState, token: &str) -> AuthResult<Challenge> {
    let row = sqlx::query(
        "SELECT id, user_id, session_id, session_kind, provider, fb_refresh, code_hash, code_method, code_sent_at, code_expires_at, tries, push_state FROM mfa_challenges WHERE token_hash = $1 AND expires_at > $2",
    )
    .bind(sha256(token.trim()))
    .bind(now() as i64)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AuthError::Forbidden("This sign-in has expired. Start again.".into()))?;
    Ok(Challenge {
        id: row.try_get("id")?,
        user_id: row.try_get("user_id")?,
        session_id: row.try_get("session_id")?,
        kind: row.try_get("session_kind")?,
        provider: row.try_get("provider")?,
        fb_refresh: row.try_get("fb_refresh")?,
        code_hash: row.try_get("code_hash")?,
        code_method: row.try_get("code_method")?,
        code_sent_at: row.try_get("code_sent_at")?,
        code_expires_at: row.try_get("code_expires_at")?,
        tries: row.try_get("tries")?,
        push_state: row.try_get("push_state")?,
    })
}

async fn challenge_user(state: &AppState, ch: &Challenge) -> AuthResult<User> {
    user_by(state, "id", &ch.user_id).await?.filter(|u| !u.disabled).ok_or_else(|| AuthError::Forbidden("This account is disabled.".into()))
}

fn six_digits() -> String {
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000))
}

/// Starts a step-up on the open session: for a Google sign-in, or for staff who have not set anything up.
async fn challenge_start(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    match challenge_error(&state, &user, Some(&claims.sid), "browser", &claims.provider, None).await? {
        AuthError::MfaChallenge { challenge, methods } => {
            if methods.is_empty() {
                return Err(AuthError::Bad("No second step is available yet. Set up an authenticator app, or ask Caller Whale to turn on email codes.".into()));
            }
            Ok(Json(json!({ "challenge": challenge, "methods": methods })))
        }
        other => Err(other),
    }
}

#[derive(Deserialize)]
struct Send {
    challenge: String,
    method: String,
    /// What to call this device in the approval prompt on the other one ("Chrome on Windows").
    device: Option<String>,
}

/// Sends the code (email or Telegram), or puts the sign-in in front of the person's other device.
async fn challenge_send(State(state): State<AppState>, Json(body): Json<Send>) -> AuthResult<Json<Value>> {
    let ch = load(&state, &body.challenge).await?;
    let user = challenge_user(&state, &ch).await?;
    let t = now() as i64;
    let allowed = methods(&state, &user, ch.session_id.as_deref()).await?;
    let method = body.method.as_str();
    if !allowed.contains(&method) {
        return Err(AuthError::Bad("That way is not available for this account.".into()));
    }
    match method {
        "email" | "telegram" => {
            if ch.code_sent_at.is_some_and(|at| t - at < RESEND_SECONDS) {
                return Err(AuthError::Bad("A code was just sent. Wait a few seconds before asking for another.".into()));
            }
            let code = six_digits();
            let text = format!("{code} is your Caller Whale code. It works for 10 minutes. If you did not just try to sign in, ignore this and change your password.");
            if method == "email" {
                let mailer = state.config.mailer.clone().ok_or_else(|| AuthError::Bad("Email codes are not set up.".into()))?;
                mailer.send(&user.email, "Your Caller Whale code", &text).await.map_err(AuthError::Internal)?;
            } else {
                let telegram = state.config.telegram.clone().ok_or_else(|| AuthError::Bad("Telegram is not set up.".into()))?;
                let chat = telegram_chat(&state, &user.id).await?.ok_or_else(|| AuthError::Bad("Telegram is not linked.".into()))?;
                telegram.send(&chat, &text).await.map_err(AuthError::Internal)?;
            }
            sqlx::query("UPDATE mfa_challenges SET code_hash = $1, code_method = $2, code_sent_at = $3, code_expires_at = $4 WHERE id = $5")
                .bind(sha256(&code))
                .bind(method)
                .bind(t)
                .bind(t + CODE_SECONDS)
                .bind(&ch.id)
                .execute(&state.db)
                .await?;
            Ok(Json(json!({ "sent": true, "method": method, "expires_in": CODE_SECONDS })))
        }
        "push" => {
            let label: String = body.device.as_deref().map(str::trim).filter(|d| !d.is_empty()).unwrap_or("A new device").chars().take(80).collect();
            sqlx::query("UPDATE mfa_challenges SET push_state = 'pending', push_label = $1, code_sent_at = $2 WHERE id = $3").bind(&label).bind(t).bind(&ch.id).execute(&state.db).await?;
            Ok(Json(json!({ "sent": true, "method": "push", "expires_in": PUSH_SECONDS })))
        }
        _ => Err(AuthError::Bad("Open your authenticator app and enter the code it shows.".into())),
    }
}

#[derive(Deserialize)]
struct ChallengeRef {
    challenge: String,
}

/// Where an approval request stands, for the device waiting for it.
async fn challenge_status(State(state): State<AppState>, Json(body): Json<ChallengeRef>) -> AuthResult<Json<Value>> {
    let ch = load(&state, &body.challenge).await?;
    let t = now() as i64;
    let stale = ch.push_state == "pending" && ch.code_sent_at.is_some_and(|at| t - at > PUSH_SECONDS);
    Ok(Json(json!({ "push": if stale { "expired" } else { ch.push_state.as_str() } })))
}

#[derive(Deserialize)]
struct Answer {
    challenge: String,
    method: String,
    code: Option<String>,
}

async fn challenge_answer(State(state): State<AppState>, Json(body): Json<Answer>) -> AuthResult<Json<Value>> {
    let ch = load(&state, &body.challenge).await?;
    let user = challenge_user(&state, &ch).await?;
    let t = now() as i64;
    if ch.tries >= MAX_TRIES {
        sqlx::query("DELETE FROM mfa_challenges WHERE id = $1").bind(&ch.id).execute(&state.db).await?;
        return Err(AuthError::TooMany);
    }
    let code = body.code.as_deref().map(str::trim).unwrap_or("");
    let passed = match body.method.as_str() {
        "totp" => verify_totp(&state, &user, code).await?,
        "email" | "telegram" => {
            let right = ch.code_method.as_deref() == Some(body.method.as_str()) && ch.code_expires_at.is_some_and(|at| at > t) && !code.is_empty() && ch.code_hash.as_deref() == Some(sha256(code).as_str());
            if right {
                // A code works once.
                sqlx::query("UPDATE mfa_challenges SET code_hash = NULL WHERE id = $1").bind(&ch.id).execute(&state.db).await?;
            }
            right
        }
        "push" => ch.push_state == "approved" && ch.code_sent_at.is_some_and(|at| t - at <= PUSH_SECONDS),
        _ => return Err(AuthError::Bad("That way is not available for this account.".into())),
    };
    if !passed {
        sqlx::query("UPDATE mfa_challenges SET tries = tries + 1 WHERE id = $1").bind(&ch.id).execute(&state.db).await?;
        record_failure(&state, &user.email).await?;
        return Err(if body.method == "push" && ch.push_state == "denied" { AuthError::Forbidden("The sign-in was denied on your other device.".into()) } else { AuthError::WrongCode });
    }
    complete(&state, &ch, &user).await
}

/// A challenge answered: the sign-in opens its session, or the open session passes its step-up.
async fn complete(state: &AppState, ch: &Challenge, user: &User) -> AuthResult<Json<Value>> {
    sqlx::query("DELETE FROM mfa_challenges WHERE id = $1").bind(&ch.id).execute(&state.db).await?;
    sqlx::query("DELETE FROM failed_sign_ins WHERE email = $1").bind(&user.email).execute(&state.db).await?;
    match &ch.session_id {
        None => {
            let fb = ch.fb_refresh.clone().filter(|r| !r.is_empty()).map(|refresh| FbSession { refresh });
            Ok(Json(open_session_fb(state, user, &ch.kind, true, &ch.provider, fb.as_ref()).await?))
        }
        Some(sid) => step_up_token(state, user, sid, &ch.provider).await,
    }
}

/// The open session has passed a second step: it says so from now on, and this is a token that says so.
async fn step_up_token(state: &AppState, user: &User, sid: &str, provider: &str) -> AuthResult<Json<Value>> {
    sqlx::query("UPDATE sessions SET mfa_passed = 1 WHERE id = $1").bind(sid).execute(&state.db).await?;
    let started: i64 = sqlx::query("SELECT created_at FROM sessions WHERE id = $1").bind(sid).fetch_one(&state.db).await?.try_get("created_at")?;
    let person = TokenPerson { id: user.id.clone(), email: user.email.clone(), name: user.name.clone(), email_verified: user.email_verified };
    let (access, expires_in) = state.keys.sign(&person, sid, true, provider, started as u64, now(), state.config.access_minutes)?;
    Ok(Json(json!({ "access_token": access, "token_type": "Bearer", "expires_in": expires_in })))
}

/// The older step-up: a code from an authenticator device (or a recovery code) for the open session.
async fn verify_session(State(state): State<AppState>, Person(claims): Person, Json(body): Json<CodeBody>) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    if !enrolled(&state, &user.id).await? {
        return Err(AuthError::Bad("Two-step sign-in is not on for this account.".into()));
    }
    if recent_failures(&state, &user.email).await? >= LOCKOUT_FAILURES {
        return Err(AuthError::TooMany);
    }
    if !verify_totp(&state, &user, &body.code).await? {
        record_failure(&state, &user.email).await?;
        return Err(AuthError::WrongCode);
    }
    step_up_token(&state, &user, &claims.sid, &claims.provider).await
}

// ---- approvals on a device that is already signed in ----

/// Needs a session that passed a second step itself: an approval from one that has not would be no second step at all.
fn must_have_passed(claims: &callerwhale_auth_verify::Claims) -> AuthResult<()> {
    if claims.mfa {
        Ok(())
    } else {
        Err(AuthError::Forbidden("Confirm a second step on this device first.".into()))
    }
}

async fn approvals(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    must_have_passed(&claims)?;
    let t = now() as i64;
    let rows = sqlx::query("SELECT id, push_label, code_sent_at FROM mfa_challenges WHERE user_id = $1 AND push_state = 'pending' AND expires_at > $2 AND code_sent_at > $3 ORDER BY code_sent_at DESC")
        .bind(&claims.sub)
        .bind(t)
        .bind(t - PUSH_SECONDS)
        .fetch_all(&state.db)
        .await?;
    let mut waiting = vec![];
    for r in rows {
        waiting.push(json!({ "id": r.try_get::<String, _>("id")?, "device": r.try_get::<Option<String>, _>("push_label")?, "at": r.try_get::<Option<i64>, _>("code_sent_at")? }));
    }
    Ok(Json(json!({ "approvals": waiting })))
}

#[derive(Deserialize)]
struct Decision {
    approve: bool,
}

async fn decide(State(state): State<AppState>, Person(claims): Person, Path(id): Path<String>, Json(body): Json<Decision>) -> AuthResult<Json<Value>> {
    must_have_passed(&claims)?;
    let t = now() as i64;
    let done = sqlx::query("UPDATE mfa_challenges SET push_state = $1 WHERE id = $2 AND user_id = $3 AND push_state = 'pending' AND expires_at > $4 AND code_sent_at > $5")
        .bind(if body.approve { "approved" } else { "denied" })
        .bind(&id)
        .bind(&claims.sub)
        .bind(t)
        .bind(t - PUSH_SECONDS)
        .execute(&state.db)
        .await?;
    if done.rows_affected() != 1 {
        return Err(AuthError::Forbidden("That request is no longer waiting.".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---- what the person has set up ----

async fn factors(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    let rows = sqlx::query("SELECT id, kind, label, created_at, last_used_at FROM mfa_factors WHERE user_id = $1 ORDER BY n").bind(&user.id).fetch_all(&state.db).await?;
    let mut list = vec![];
    for r in rows {
        list.push(json!({
            "id": r.try_get::<String, _>("id")?,
            "kind": r.try_get::<String, _>("kind")?,
            "label": r.try_get::<String, _>("label")?,
            "created_at": r.try_get::<i64, _>("created_at")?,
            "last_used_at": r.try_get::<Option<i64>, _>("last_used_at")?,
        }));
    }
    Ok(Json(json!({
        "factors": list,
        "max_totp": MAX_TOTP,
        "available": { "email": state.config.mailer.is_some() && user.email_verified, "telegram": state.config.telegram.is_some(), "push": approver_exists(&state, &user.id, &claims.sid).await? },
    })))
}

async fn remove_factor(State(state): State<AppState>, Person(claims): Person, Path(id): Path<String>) -> AuthResult<Json<Value>> {
    must_have_passed(&claims)?;
    let done = sqlx::query("DELETE FROM mfa_factors WHERE id = $1 AND user_id = $2").bind(&id).bind(&claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true, "removed": done.rows_affected() })))
}

async fn next_n(state: &AppState, user_id: &str) -> AuthResult<i64> {
    let max: Option<i64> = sqlx::query("SELECT MAX(n) AS n FROM mfa_factors WHERE user_id = $1").bind(user_id).fetch_one(&state.db).await?.try_get("n")?;
    Ok(max.unwrap_or(0) + 1)
}

async fn totp_setup(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    let secret = match totp_rs::Secret::generate_secret().to_encoded() {
        totp_rs::Secret::Encoded(s) => s,
        totp_rs::Secret::Raw(_) => return Err(AuthError::Internal(anyhow::anyhow!("secret was not encoded"))),
    };
    let url = totp(&secret, &user.email)?.get_url();
    sqlx::query("UPDATE users SET totp_pending = $1 WHERE id = $2").bind(&secret).bind(&user.id).execute(&state.db).await?;
    Ok(Json(json!({ "secret": secret, "otpauth_url": url })))
}

#[derive(Deserialize)]
struct CodeBody {
    code: String,
}

#[derive(Deserialize)]
struct Confirm {
    code: String,
    label: Option<String>,
}

/// Adds the authenticator device with its first code. A fourth device removes the one set up longest ago.
async fn totp_confirm(State(state): State<AppState>, Person(claims): Person, Json(body): Json<Confirm>) -> AuthResult<Json<Value>> {
    let row = sqlx::query("SELECT email, totp_pending FROM users WHERE id = $1").bind(&claims.sub).fetch_optional(&state.db).await?.ok_or(AuthError::Unauthenticated)?;
    let email: String = row.try_get("email")?;
    let pending: Option<String> = row.try_get("totp_pending")?;
    let pending = pending.ok_or_else(|| AuthError::Bad("Start setting up the authenticator first.".into()))?;
    if !code_matches(&pending, &email, &body.code) {
        return Err(AuthError::WrongCode);
    }
    let first = !enrolled(&state, &claims.sub).await?;
    let label: String = body.label.as_deref().map(str::trim).filter(|l| !l.is_empty()).unwrap_or("Authenticator app").chars().take(60).collect();
    let n = next_n(&state, &claims.sub).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO mfa_factors (id, user_id, kind, label, secret, created_at, n) VALUES ($1, $2, 'totp', $3, $4, $5, $6)")
        .bind(Uuid::new_v4().to_string())
        .bind(&claims.sub)
        .bind(&label)
        .bind(&pending)
        .bind(now() as i64)
        .bind(n)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET totp_pending = NULL WHERE id = $1").bind(&claims.sub).execute(&mut *tx).await?;
    // The oldest devices beyond the limit go.
    let devices = sqlx::query("SELECT id, label FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' ORDER BY n").bind(&claims.sub).fetch_all(&mut *tx).await?;
    let mut removed = vec![];
    for r in devices.iter().take(devices.len().saturating_sub(MAX_TOTP as usize)) {
        sqlx::query("DELETE FROM mfa_factors WHERE id = $1").bind(r.try_get::<String, _>("id")?).execute(&mut *tx).await?;
        removed.push(r.try_get::<String, _>("label")?);
    }
    // Recovery codes only where this service keeps the accounts itself, and only with the first way set up.
    let mut codes: Vec<String> = vec![];
    if first && state.config.firebase.is_none() {
        codes = recovery_codes();
        sqlx::query("DELETE FROM recovery_codes WHERE user_id = $1").bind(&claims.sub).execute(&mut *tx).await?;
        for code in &codes {
            sqlx::query("INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)").bind(&claims.sub).bind(sha256(code)).execute(&mut *tx).await?;
        }
    }
    sqlx::query("UPDATE sessions SET mfa_passed = 1 WHERE id = $1").bind(&claims.sid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "recovery_codes": codes, "removed": removed })))
}

// ---- Telegram ----

async fn telegram_link(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    must_have_passed(&claims)?;
    let telegram = state.config.telegram.clone().ok_or_else(|| AuthError::Bad("Telegram is not set up on this server.".into()))?;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill(&mut bytes);
    let code = hex::encode(bytes);
    sqlx::query("DELETE FROM telegram_links WHERE user_id = $1 OR expires_at < $2").bind(&claims.sub).bind(now() as i64).execute(&state.db).await?;
    sqlx::query("INSERT INTO telegram_links (code_hash, user_id, expires_at) VALUES ($1, $2, $3)").bind(sha256(&code)).bind(&claims.sub).bind(now() as i64 + LINK_SECONDS).execute(&state.db).await?;
    Ok(Json(json!({ "url": format!("https://t.me/{}?start={code}", telegram.bot), "expires_in": LINK_SECONDS })))
}

/// Telegram posts here when someone writes to the bot. A `/start <code>` with a link code this service made links that chat.
async fn telegram_webhook(State(state): State<AppState>, Path(secret): Path<String>, Json(update): Json<Value>) -> AuthResult<Json<Value>> {
    let expected = &state.config.telegram_webhook_secret;
    // Anything but Telegram, with the secret in the address, finds nothing here.
    if expected.is_empty() || secret != *expected {
        return Err(AuthError::Forbidden("Not found.".into()));
    }
    let Some(telegram) = state.config.telegram.clone() else { return Ok(Json(json!({}))) };
    let Some((chat, text)) = crate::telegram::Telegram::message_of(&update) else { return Ok(Json(json!({}))) };
    let Some(code) = text.trim().strip_prefix("/start ").map(str::trim) else {
        let _ = telegram.send(&chat, "To link Caller Whale, open the link from your account's security settings.").await;
        return Ok(Json(json!({})));
    };
    let link = sqlx::query("SELECT user_id FROM telegram_links WHERE code_hash = $1 AND expires_at > $2").bind(sha256(code)).bind(now() as i64).fetch_optional(&state.db).await?;
    let Some(link) = link else {
        let _ = telegram.send(&chat, "That link has expired. Make a new one in your account's security settings.").await;
        return Ok(Json(json!({})));
    };
    let user_id: String = link.try_get("user_id")?;
    sqlx::query("DELETE FROM telegram_links WHERE code_hash = $1").bind(sha256(code)).execute(&state.db).await?;
    let n = next_n(&state, &user_id).await?;
    sqlx::query("DELETE FROM mfa_factors WHERE user_id = $1 AND kind = 'telegram'").bind(&user_id).execute(&state.db).await?;
    sqlx::query("INSERT INTO mfa_factors (id, user_id, kind, label, secret, created_at, n) VALUES ($1, $2, 'telegram', 'Telegram', $3, $4, $5)")
        .bind(Uuid::new_v4().to_string())
        .bind(&user_id)
        .bind(&chat)
        .bind(now() as i64)
        .bind(n)
        .execute(&state.db)
        .await?;
    let _ = telegram.send(&chat, "Linked. Caller Whale will send your sign-in codes here.").await;
    Ok(Json(json!({})))
}
