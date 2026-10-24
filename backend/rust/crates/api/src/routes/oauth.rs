//! Sign-in and sign-up with Google or Apple (OpenID Connect, authorization code flow).
//!
//! The browser is sent to the provider with a single-use state, a nonce and (Google) a PKCE challenge, all kept on the
//! server for ten minutes. The provider sends it back with a code; the server exchanges the code itself, checks the ID
//! token's signature against the provider's published keys, its issuer, audience, expiry and nonce, and requires a
//! verified email. Then it signs in the linked account, links an existing account with that verified email, or opens a
//! new account on the free trial, exactly like the sign-up form.

use crate::{
    auth,
    config::OauthProvider,
    error::{ApiError, ApiResult},
    routes::{billing, identity},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Form, Json, Router,
};
use axum_extra::extract::cookie::CookieJar;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/providers", get(providers))
        .route("/auth/oauth/{provider}/start", get(start))
        // Google returns with a GET; Apple posts a form back (response_mode=form_post) once it asked for a name.
        .route("/auth/oauth/{provider}/callback", get(callback_get).post(callback_post))
        // The desktop app collects a sign-in its browser finished.
        .route("/auth/oauth/exchange", axum::routing::post(exchange))
}

fn provider<'a>(state: &'a AppState, name: &str) -> ApiResult<&'a OauthProvider> {
    match name {
        "google" => Ok(&state.config.google),
        "apple" => Ok(&state.config.apple),
        _ => Err(ApiError::not_found("That sign-in provider")),
    }
}

fn label(name: &str) -> &'static str {
    if name == "apple" { "Apple" } else { "Google" }
}

fn redirect_uri(state: &AppState, name: &str) -> String {
    format!("{}/api/v1/auth/oauth/{name}/callback", state.config.public_url)
}

fn random() -> String {
    let (token, _) = auth::new_token();
    token
}

async fn providers(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "google": state.config.google.configured(), "apple": state.config.apple.configured() }))
}

#[derive(Deserialize)]
struct Start {
    /// "website" (default), "app" (the CRM in a browser tab) or "desktop" (the desktop app, with `port`).
    #[serde(default)]
    target: String,
    /// Desktop only: the port the app listens on at 127.0.0.1 for the result.
    #[serde(default)]
    port: Option<i32>,
}

/// Sends the browser to the provider.
async fn start(State(state): State<AppState>, Path(name): Path<String>, Query(query): Query<Start>) -> ApiResult<Response> {
    let config = provider(&state, &name)?;
    if !config.configured() {
        return Err(ApiError::NotFound(format!("{} sign-in is not set up on this server yet", label(&name))));
    }
    let target = match query.target.as_str() {
        "app" => "app",
        "desktop" => "desktop",
        _ => "website",
    };
    // The desktop app's result only ever goes back to this computer (127.0.0.1), on an unprivileged port.
    let port = if target == "desktop" {
        Some(query.port.filter(|p| (1024..=65535).contains(p)).ok_or_else(|| ApiError::bad("The app did not say where to return"))?)
    } else {
        None
    };
    let state_token = random();
    let nonce = random();
    // PKCE for Google; Apple's flow does not take it (the client secret already proves the server).
    let verifier = (name == "google").then(random);
    sqlx::query(
        "INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, target, return_port, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')",
    )
    .bind(auth::token_hash(&state_token))
    .bind(&name)
    .bind(&nonce)
    .bind(&verifier)
    .bind(target)
    .bind(port)
    .execute(&state.db)
    .await?;
    // Started sign-ins that were never finished are cleared as new ones begin.
    sqlx::query("DELETE FROM oauth_states WHERE expires_at < now()").execute(&state.db).await?;
    let mut url = reqwest::Url::parse(&config.auth_url).map_err(|e| ApiError::Internal(anyhow::anyhow!("auth url: {e}")))?;
    {
        let mut params = url.query_pairs_mut();
        params
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", &redirect_uri(&state, &name))
            .append_pair("response_type", "code")
            .append_pair("state", &state_token)
            .append_pair("nonce", &nonce);
        if name == "apple" {
            params.append_pair("scope", "name email").append_pair("response_mode", "form_post");
        } else {
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_deref().unwrap_or_default().as_bytes()));
            params
                .append_pair("scope", "openid email profile")
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("prompt", "select_account");
        }
    }
    Ok(Redirect::to(url.as_str()).into_response())
}

#[derive(Deserialize, Default)]
struct Returned {
    #[serde(default)]
    code: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    error: String,
    /// Apple, on the first sign-in only: {"name": {"firstName", "lastName"}, "email"}.
    #[serde(default)]
    user: String,
}

async fn callback_get(State(state): State<AppState>, jar: CookieJar, Path(name): Path<String>, Query(returned): Query<Returned>) -> Response {
    finish(state, jar, name, returned).await
}

async fn callback_post(State(state): State<AppState>, jar: CookieJar, Path(name): Path<String>, Form(returned): Form<Returned>) -> Response {
    finish(state, jar, name, returned).await
}

/// Where the person goes back to, with an error message when the sign-in did not work. The desktop app gets its
/// one-time code (or the error) on 127.0.0.1 at the port it gave.
fn back(state: &AppState, target: &str, port: Option<i32>, code: Option<&str>, error: Option<&str>) -> Redirect {
    let query = |pairs: &[(&str, &str)]| reqwest::Url::parse_with_params("http://x/", pairs).map(|u| u.query().unwrap_or_default().to_string()).unwrap_or_default();
    if target == "desktop" {
        let base = format!("http://127.0.0.1:{}/turf-sign-in", port.unwrap_or(0));
        return match (code, error) {
            (Some(code), None) => Redirect::to(&format!("{base}?{}", query(&[("code", code)]))),
            _ => Redirect::to(&format!("{base}?{}", query(&[("error", error.unwrap_or("Sign-in did not finish."))]))),
        };
    }
    let base = if target == "app" { format!("{}/", state.config.app_url) } else { format!("{}/", state.config.public_url) };
    match error {
        None if target == "app" => Redirect::to(&base),
        None => Redirect::to(&format!("{base}#/account")),
        Some(message) => {
            let encoded = query(&[("oauth_error", message)]);
            if target == "app" { Redirect::to(&format!("{base}?{encoded}")) } else { Redirect::to(&format!("{base}?{encoded}#/signin")) }
        }
    }
}

async fn finish(state: AppState, jar: CookieJar, name: String, returned: Returned) -> Response {
    // The state is taken (and so used up) first: without a valid one nothing else is trusted, not even the target.
    let row: Option<(String, String, Option<String>, String, Option<i32>)> = match sqlx::query_as(
        "DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING provider, nonce, code_verifier, target, return_port",
    )
    .bind(auth::token_hash(&returned.state))
    .fetch_optional(&state.db)
    .await
    {
        Ok(row) => row,
        Err(error) => return ApiError::from(error).into_response(),
    };
    let Some((stored_provider, nonce, verifier, target, port)) = row.filter(|(p, ..)| *p == name) else {
        return back(&state, "website", None, None, Some("That sign-in link has expired. Try again.")).into_response();
    };
    if !returned.error.is_empty() || returned.code.is_empty() {
        return back(&state, &target, port, None, Some("Sign-in was cancelled.")).into_response();
    }
    let outcome = match sign_in(&state, &stored_provider, &returned, &nonce, verifier.as_deref()).await {
        // The desktop app is not this browser: it gets a one-time code to collect the session with.
        Ok((user, org)) if target == "desktop" => handoff(&state, user, org).await.map(|code| (jar, back(&state, &target, port, Some(&code), None))),
        Ok((user, org)) => identity::create_session(&state, user, org, "browser")
            .await
            .map(|token| (jar.add(identity::session_cookie(&state, token)), back(&state, &target, port, None, None))),
        Err(error) => Err(error),
    };
    match outcome {
        Ok(done) => done.into_response(),
        Err(error) => {
            if let ApiError::Internal(cause) = &error {
                tracing::error!(error = %cause, provider = %name, "provider sign-in failed");
            }
            let message = match &error {
                ApiError::Internal(_) => format!("{} sign-in did not work. Try again in a moment.", label(&name)),
                other => other.to_string(),
            };
            back(&state, &target, port, None, Some(&message)).into_response()
        }
    }
}

/// A finished sign-in for the desktop app to collect, once, within two minutes.
async fn handoff(state: &AppState, user: Uuid, org: Option<Uuid>) -> ApiResult<String> {
    let code = random();
    sqlx::query("INSERT INTO oauth_handoffs (code_hash, user_id, org_id, expires_at) VALUES ($1, $2, $3, now() + interval '2 minutes')")
        .bind(auth::token_hash(&code))
        .bind(user)
        .bind(org)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM oauth_handoffs WHERE expires_at < now()").execute(&state.db).await?;
    Ok(code)
}

#[derive(Deserialize)]
struct Exchange {
    code: String,
}

/// The desktop app trades its one-time code for a session (the same cookie a browser sign-in sets).
async fn exchange(State(state): State<AppState>, jar: CookieJar, Json(body): Json<Exchange>) -> ApiResult<(CookieJar, Json<Value>)> {
    let found: Option<(Uuid, Option<Uuid>)> =
        sqlx::query_as("DELETE FROM oauth_handoffs WHERE code_hash = $1 AND expires_at > now() RETURNING user_id, org_id")
            .bind(auth::token_hash(body.code.trim()))
            .fetch_optional(&state.db)
            .await?;
    let (user, org) = found.ok_or_else(|| ApiError::forbidden("This sign-in has expired. Try again."))?;
    let token = identity::create_session(&state, user, org, "browser").await?;
    Ok((jar.add(identity::session_cookie(&state, token)), Json(json!({ "signed_in": true, "organization_id": org }))))
}

#[derive(Deserialize)]
struct TokenAnswer {
    id_token: String,
}

/// The ID token's claims Turf reads. Apple sends `email_verified` as a string.
#[derive(Deserialize)]
pub struct Claims {
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: Option<Value>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

impl Claims {
    pub fn verified_email(&self) -> Option<String> {
        let verified = matches!(&self.email_verified, Some(Value::Bool(true))) || matches!(&self.email_verified, Some(Value::String(s)) if s == "true");
        self.email.as_ref().filter(|_| verified).map(|e| e.trim().to_lowercase())
    }
}

/// Apple's client secret: a short-lived ES256 JWT signed with the team's key.
pub fn apple_client_secret(config: &OauthProvider) -> ApiResult<String> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(config.key_id.clone());
    let now = chrono::Utc::now().timestamp();
    let claims = json!({ "iss": config.team_id, "iat": now, "exp": now + 300, "aud": "https://appleid.apple.com", "sub": config.client_id });
    let key = EncodingKey::from_ec_pem(config.private_key.as_bytes()).map_err(|e| ApiError::Internal(anyhow::anyhow!("apple key: {e}")))?;
    jsonwebtoken::encode(&header, &claims, &key).map_err(|e| ApiError::Internal(anyhow::anyhow!("apple secret: {e}")))
}

/// Each provider's signing keys, fetched at most once an hour (and again when a token names a key not seen yet).
static KEYS: Mutex<Option<HashMap<String, (JwkSet, Instant)>>> = Mutex::new(None);

async fn signing_keys(url: &str, refresh: bool) -> ApiResult<JwkSet> {
    if !refresh {
        if let Some((set, at)) = KEYS.lock().unwrap().as_ref().and_then(|keys| keys.get(url)) {
            if at.elapsed() < Duration::from_secs(3600) {
                return Ok(set.clone());
            }
        }
    }
    let set: JwkSet = http()
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("keys: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("keys: {e}")))?;
    KEYS.lock().unwrap().get_or_insert_with(HashMap::new).insert(url.to_string(), (set.clone(), Instant::now()));
    Ok(set)
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client")
}

/// Checks an ID token: signed by one of the provider's keys with RS256, from its issuer, for this client, unexpired,
/// and carrying the nonce this sign-in started with.
pub async fn verify_id_token(config: &OauthProvider, token: &str, nonce: &str) -> ApiResult<Claims> {
    let header = decode_header(token).map_err(|_| ApiError::bad("The provider's answer was not a valid sign-in token"))?;
    if header.alg != Algorithm::RS256 {
        return Err(ApiError::bad("The provider's sign-in token used an unexpected signature"));
    }
    let kid = header.kid.ok_or_else(|| ApiError::bad("The provider's sign-in token names no key"))?;
    let mut keys = signing_keys(&config.jwks_url, false).await?;
    if keys.find(&kid).is_none() {
        keys = signing_keys(&config.jwks_url, true).await?;
    }
    let jwk = keys.find(&kid).ok_or_else(|| ApiError::bad("The provider's sign-in token was signed with an unknown key"))?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| ApiError::bad("The provider's key could not be read"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[&config.issuer]);
    validation.set_audience(&[&config.client_id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<Claims>(token, &key, &validation).map_err(|_| ApiError::forbidden("The sign-in token did not check out"))?.claims;
    if claims.nonce.as_deref() != Some(nonce) {
        return Err(ApiError::forbidden("The sign-in token was not for this sign-in"));
    }
    Ok(claims)
}

async fn sign_in(state: &AppState, name: &str, returned: &Returned, nonce: &str, verifier: Option<&str>) -> ApiResult<(Uuid, Option<Uuid>)> {
    let config = provider(state, name)?;
    let secret = if name == "apple" { apple_client_secret(config)? } else { config.client_secret.clone() };
    let redirect = redirect_uri(state, name);
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", returned.code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("client_id", config.client_id.as_str()),
        ("client_secret", secret.as_str()),
    ];
    if let Some(verifier) = verifier {
        form.push(("code_verifier", verifier));
    }
    let answer: TokenAnswer = http()
        .post(&config.token_url)
        .form(&form)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("token exchange: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("token answer: {e}")))?;
    let claims = verify_id_token(config, &answer.id_token, nonce).await?;
    let email = claims.verified_email().ok_or_else(|| ApiError::forbidden(format!("Your {} account has no confirmed email address", label(name))))?;
    let display = claims.name.clone().filter(|n| !n.trim().is_empty()).or_else(|| apple_name(&returned.user)).unwrap_or_else(|| email.split('@').next().unwrap_or("Turf user").to_string());

    let mut tx = state.db.begin().await?;
    let linked: Option<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2").bind(name).bind(&claims.sub).fetch_optional(&mut *tx).await?;
    let (user, org) = match linked {
        Some(user) => (user, None),
        None => {
            let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
            let (user, org) = match existing {
                // The provider confirmed this address, which proves the person owns the account it belongs to.
                Some(user) => {
                    sqlx::query("UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1").bind(user).execute(&mut *tx).await?;
                    (user, None)
                }
                None => {
                    if !state.config.public_signup {
                        return Err(ApiError::forbidden("This server does not take new sign-ups"));
                    }
                    let (org, user) = billing::open_trial_account(&mut tx, &email, &display, billing::NO_PASSWORD, "UTC", None).await?;
                    sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1").bind(user).execute(&mut *tx).await?;
                    (user, Some(org))
                }
            };
            sqlx::query("INSERT INTO user_identities (provider, subject, user_id, email) VALUES ($1, $2, $3, $4)")
                .bind(name)
                .bind(&claims.sub)
                .bind(user)
                .bind(&email)
                .execute(&mut *tx)
                .await?;
            (user, org)
        }
    };
    let disabled: bool = sqlx::query_scalar("SELECT disabled_at IS NOT NULL FROM users WHERE id = $1").bind(user).fetch_one(&mut *tx).await?;
    if disabled {
        return Err(ApiError::forbidden("This account is disabled"));
    }
    let org = match org {
        Some(org) => Some(org),
        None => {
            let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at").bind(user).fetch_all(&mut *tx).await?;
            orgs.first().copied()
        }
    };
    tx.commit().await?;
    Ok((user, org))
}

fn apple_name(user: &str) -> Option<String> {
    let value: Value = serde_json::from_str(user).ok()?;
    let name = value.get("name")?;
    let full = [name.get("firstName"), name.get("lastName")].into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(" ");
    (!full.trim().is_empty()).then(|| full.trim().chars().take(120).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_verified_email_counts() {
        let claims = |verified: Value| Claims { sub: "1".into(), email: Some("A@Example.com ".into()), email_verified: Some(verified), nonce: None, name: None };
        assert_eq!(claims(json!(true)).verified_email().as_deref(), Some("a@example.com"));
        assert_eq!(claims(json!("true")).verified_email().as_deref(), Some("a@example.com"), "Apple sends a string");
        assert_eq!(claims(json!(false)).verified_email(), None);
        assert_eq!(claims(json!("false")).verified_email(), None);
    }

    #[test]
    fn apple_names_arrive_once_as_json() {
        assert_eq!(apple_name(r#"{"name":{"firstName":"Mona","lastName":"Adel"},"email":"m@x.com"}"#).as_deref(), Some("Mona Adel"));
        assert_eq!(apple_name(""), None);
        assert_eq!(apple_name(r#"{"email":"m@x.com"}"#), None);
    }
}
