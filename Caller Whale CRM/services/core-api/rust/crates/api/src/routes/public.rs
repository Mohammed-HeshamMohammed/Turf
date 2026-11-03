//! The website's two public forms: the waitlist and the contact form. No sign-in, so no token is read here; the gateway lets just
//! these two paths through without one and limits each address. This server adds its own limit across all addresses, so a flood
//! from many of them cannot fill the table or the inbox.
//!
//! The waitlist is a table (`landing_waitlist`). A contact message is not stored: it is emailed on, through the notification
//! service, to the team's inbox with the writer's address as the reply address. A message that cannot be sent is refused, so the
//! writer is told and can try again, instead of it being lost.

use crate::{
    error::{ApiError, ApiResult},
    mail,
    state::AppState,
};
use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/public/waitlist", post(waitlist)).route("/public/contact", post(contact))
}

// --- Abuse limits ---------------------------------------------------------------------------------------------------

/// Across every address: at most this many of each form in ten minutes.
const WAITLIST_PER_WINDOW: usize = 200;
const CONTACT_PER_WINDOW: usize = 40;
static WAITLIST_RECENT: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());
static CONTACT_RECENT: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

fn allowed(recent: &Mutex<VecDeque<Instant>>, limit: usize) -> bool {
    let mut recent = recent.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    while recent.front().is_some_and(|at| at.elapsed() > Duration::from_secs(600)) {
        recent.pop_front();
    }
    if recent.len() >= limit {
        return false;
    }
    recent.push_back(Instant::now());
    true
}

// --- What the forms may send ------------------------------------------------------------------------------------------

/// A text field, trimmed and cut to `max` characters; empty when it is missing or not text.
fn text(body: &Value, key: &str, max: usize) -> String {
    body.get(key).and_then(Value::as_str).map(|s| s.trim().chars().take(max).collect()).unwrap_or_default()
}

/// The address in lower case, or nothing when it is not one (no spaces, one @, a dot in the domain, 254 characters at most).
fn email(body: &Value) -> Option<String> {
    let value = body.get("email").and_then(Value::as_str)?.trim().to_lowercase();
    let (local, domain) = value.split_once('@')?;
    let (host, last) = domain.rsplit_once('.')?;
    let ok = value.chars().count() <= 254 && !local.is_empty() && !host.is_empty() && last.chars().count() >= 2 && !domain.contains('@') && !value.chars().any(char::is_whitespace);
    ok.then_some(value)
}

const BAD_EMAIL: &str = "Enter a valid email address.";

/// A hidden field only bots fill in: answered as if it worked, and dropped.
fn is_bot(body: &Value) -> bool {
    body.get("website").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
}

async fn waitlist(State(state): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    if is_bot(&body) {
        return Ok(Json(json!({ "ok": true })));
    }
    if !allowed(&WAITLIST_RECENT, WAITLIST_PER_WINDOW) {
        return Err(ApiError::TooMany("Too many requests. Try again in a few minutes.".into()));
    }
    let email = email(&body).ok_or_else(|| ApiError::bad(BAD_EMAIL))?;
    let tier = text(&body, "tier", 10);
    let tier = if ["solo", "duo", "team", "pro"].contains(&tier.as_str()) { tier } else { String::new() };
    // The same answer whether the address was new or already there, so the form cannot be used to find out who is on the list.
    sqlx::query("INSERT INTO landing_waitlist (email, name, company, tier) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING")
        .bind(&email)
        .bind(text(&body, "name", 120))
        .bind(text(&body, "company", 120))
        .bind(&tier)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn contact(State(state): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    if is_bot(&body) {
        return Ok(Json(json!({ "ok": true })));
    }
    if !allowed(&CONTACT_RECENT, CONTACT_PER_WINDOW) {
        return Err(ApiError::TooMany("Too many requests. Try again in a few minutes.".into()));
    }
    let email = email(&body).ok_or_else(|| ApiError::bad(BAD_EMAIL))?;
    let message = text(&body, "message", 4000);
    if message.chars().count() < 5 {
        return Err(ApiError::bad("Write a short message."));
    }
    if let Err(error) = mail::send_contact(&state.config, &text(&body, "name", 120), &email, &message).await {
        tracing::error!(error = %error, "contact message not sent");
        return Err(ApiError::Unavailable("Your message could not be sent right now. Try again in a little while.".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_checked_like_the_site_checks_them() {
        for good in ["a@b.co", " Sami@Example.COM ", "first.last+tag@sub.example.org"] {
            assert!(email(&json!({ "email": good })).is_some(), "{good}");
        }
        assert_eq!(email(&json!({ "email": " Sami@Example.COM " })).as_deref(), Some("sami@example.com"));
        for bad in ["", "plain", "a@b", "a@b.c", "@b.co", "a@.co", "a b@c.co", "a@b@c.co", "a@b.co\nBcc: x@y.co"] {
            assert!(email(&json!({ "email": bad })).is_none(), "{bad:?}");
        }
        assert!(email(&json!({ "email": format!("{}@example.com", "a".repeat(250)) })).is_none(), "longer than 254");
        assert!(email(&json!({})).is_none());
        assert!(email(&json!({ "email": 5 })).is_none());
    }

    #[test]
    fn text_is_trimmed_and_cut_and_only_text_counts() {
        assert_eq!(text(&json!({ "n": "  Sami  " }), "n", 120), "Sami");
        assert_eq!(text(&json!({ "n": "abcdef" }), "n", 3), "abc");
        assert_eq!(text(&json!({ "n": 7 }), "n", 3), "");
        assert_eq!(text(&json!({}), "n", 3), "");
    }

    #[test]
    fn the_hidden_field_marks_a_bot() {
        assert!(is_bot(&json!({ "website": "http://spam.example" })));
        assert!(!is_bot(&json!({ "website": "  " })));
        assert!(!is_bot(&json!({})));
    }

    #[test]
    fn a_window_lets_a_limited_number_through() {
        let recent = Mutex::new(VecDeque::new());
        assert!((0..3).all(|_| allowed(&recent, 3)));
        assert!(!allowed(&recent, 3));
    }
}
