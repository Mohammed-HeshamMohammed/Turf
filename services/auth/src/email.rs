//! Email confirmation, moved here from the core API. A new password account gets a link (a single-use token, two
//! days); following it confirms the address. Google and Apple accounts arrive confirmed. Sending the email is the
//! notification service's job: the link is written to the outbox as `notification.requested`. In development
//! (`AUTH_DEV_TOKENS=true`) the token also comes back in the response, since nothing sends email yet.

use crate::{
    error::{AuthError, AuthResult},
    now,
    routes::{new_secret, sha256, user_by, Person},
    AppState,
};
use axum::{extract::State, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Any, Row, Transaction};
use uuid::Uuid;

const LINK_SECONDS: i64 = 2 * 86_400;
/// A new link at most once a minute per person.
const RESEND_SECONDS: i64 = 60;

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/email/verify", post(verify)).route("/v1/email/resend", post(resend))
}

/// An event for the bus, in the same transaction as the change it reports.
pub async fn outbox(tx: &mut Transaction<'_, Any>, name: &str, payload: Value) -> AuthResult<()> {
    sqlx::query("INSERT INTO outbox (id, name, payload, created_at) VALUES ($1, $2, $3, $4)")
        .bind(Uuid::new_v4().to_string())
        .bind(name)
        .bind(payload.to_string())
        .bind(now() as i64)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// A confirmation link for this person, and the request to email it. Returns the token.
pub async fn new_verification(tx: &mut Transaction<'_, Any>, user_id: &str) -> AuthResult<String> {
    let (token, hash) = new_secret();
    let t = now() as i64;
    sqlx::query("INSERT INTO email_verifications (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)")
        .bind(&hash)
        .bind(user_id)
        .bind(t)
        .bind(t + LINK_SECONDS)
        .execute(&mut **tx)
        .await?;
    // The one place an event carries a secret: the single-use link the notification service must put in the email.
    outbox(tx, "notification.requested", json!({ "user_id": user_id, "template": "confirm_email", "data": { "token": token }, "version": 1 })).await?;
    Ok(token)
}

pub fn with_dev_token(state: &AppState, reply: &mut Value, token: String) {
    if state.config.dev_tokens {
        reply["verification_token"] = json!(token);
    }
}

#[derive(Deserialize)]
struct Verify {
    token: String,
}

async fn verify(State(state): State<AppState>, Json(body): Json<Verify>) -> AuthResult<Json<Value>> {
    let t = now() as i64;
    if let Some(fb) = state.config.firebase.clone() {
        // Firebase sent the link and knows the code; this service only records that the address is confirmed.
        let email = fb.confirm_email(body.token.trim()).await.map_err(AuthError::from)?;
        sqlx::query("UPDATE users SET email_verified_at = $1 WHERE email = $2 AND email_verified_at IS NULL").bind(t).bind(&email).execute(&state.db).await?;
        return Ok(Json(json!({ "email_verified": true })));
    }
    let mut tx = state.db.begin().await?;
    let row = sqlx::query("SELECT user_id FROM email_verifications WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2")
        .bind(sha256(body.token.trim()))
        .bind(t)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AuthError::Forbidden("This link is not valid or has expired.".into()))?;
    let user_id: String = row.try_get("user_id")?;
    sqlx::query("UPDATE email_verifications SET used_at = $1 WHERE token_hash = $2").bind(t).bind(sha256(body.token.trim())).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET email_verified_at = $1 WHERE id = $2 AND email_verified_at IS NULL").bind(t).bind(&user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    // Tokens issued before this still say "not confirmed" until they are refreshed, at most 15 minutes.
    Ok(Json(json!({ "email_verified": true })))
}

async fn resend(State(state): State<AppState>, Person(claims): Person) -> AuthResult<Json<Value>> {
    let user = user_by(&state, "id", &claims.sub).await?.ok_or(AuthError::Unauthenticated)?;
    if user.email_verified {
        return Ok(Json(json!({ "email_verified": true })));
    }
    if let Some(fb) = state.config.firebase.clone() {
        let id = crate::routes::session_id_token(&state, &fb, &claims.sid).await?;
        fb.send_verification(&id).await.map_err(AuthError::from)?;
        return Ok(Json(json!({ "email_verified": false, "sent": true })));
    }
    let latest: Option<i64> = sqlx::query("SELECT MAX(created_at) AS at FROM email_verifications WHERE user_id = $1").bind(&user.id).fetch_one(&state.db).await?.try_get("at")?;
    if latest.is_some_and(|at| now() as i64 - at < RESEND_SECONDS) {
        return Err(AuthError::Bad("A link was just sent. Wait a minute before asking for another.".into()));
    }
    let mut tx = state.db.begin().await?;
    let token = new_verification(&mut tx, &user.id).await?;
    tx.commit().await?;
    let mut reply = json!({ "email_verified": false, "sent": true });
    with_dev_token(&state, &mut reply, token);
    Ok(Json(reply))
}
