//! Sign-in and sign-up with Google or Apple (OpenID Connect, authorization code flow), moved here from the core API.
//!
//! The browser goes to the provider with a single-use state, a nonce and (Google) a PKCE challenge, kept here for ten
//! minutes. The provider sends it back with a code; this service exchanges the code itself, checks the ID token against
//! the provider's published keys (issuer, audience, expiry, nonce) and requires a confirmed email. Then it signs in the
//! linked account, links the account that already has that confirmed email, or opens a new one.
//!
//! Every way back gets a one-time code (two minutes) that the website, the app or the desktop app trades for tokens at
//! `POST /v1/oauth/exchange`. Tokens never travel in an address. The desktop app's code only ever goes to 127.0.0.1.
//!
//! Opening a workspace for a new person is not this service's job: the app asks the core API for one after signing in.

use crate::{
    config::Provider,
    email,
    error::{AuthError, AuthResult},
    now,
    firebase::{FbSession, Firebase},
    routes::{new_secret, open_session_fb, sha256, upsert_firebase_user, user_by, User},
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Form, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Stored as the password of an account that signs in only with Google or Apple. It is not a valid hash, so no
/// password ever matches it. The same value the core API used, so imported accounts behave the same.
pub const NO_PASSWORD: &str = "!external-sign-in";
const STATE_SECONDS: i64 = 10 * 60;
const HANDOFF_SECONDS: i64 = 2 * 60;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/providers", get(providers))
        .route("/v1/oauth/{provider}/start", get(start).post(start_post))
        // Google returns with a GET; Apple posts a form back (response_mode=form_post) once it asked for a name.
        .route("/v1/oauth/{provider}/callback", get(callback_get).post(callback_post))
        .route("/v1/oauth/exchange", post(exchange))
}

fn provider<'a>(state: &'a AppState, name: &str) -> AuthResult<&'a Provider> {
    match name {
        "google" => Ok(&state.config.google),
        "apple" => Ok(&state.config.apple),
        _ => Err(AuthError::Bad("That sign-in provider does not exist.".into())),
    }
}

fn label(name: &str) -> &'static str {
    if name == "apple" { "Apple" } else { "Google" }
}

fn redirect_uri(state: &AppState, name: &str) -> String {
    format!("{}/v1/oauth/{name}/callback", state.config.public_url)
}

fn random() -> String {
    new_secret().0
}

async fn providers(State(state): State<AppState>) -> Json<Value> {
    let available = |name: &'static str, direct: bool| {
        let state = &state;
        async move {
            if direct { return true; }
            match &state.config.firebase {
                Some(fb) => fb.oauth_available(name, &redirect_uri(state, name)).await,
                None => false,
            }
        }
    };
    let (google, apple) = tokio::join!(available("google", state.config.google.configured()), available("apple", state.config.apple.configured()));
    Json(json!({ "google": google, "apple": apple }))
}

#[derive(Deserialize)]
struct Start {
    /// "website" (default), "app" (the CRM in a browser tab) or "desktop" (the desktop app, with `port`).
    #[serde(default)]
    target: String,
    /// Desktop only: the port the app listens on at 127.0.0.1 for the result.
    #[serde(default)]
    port: Option<i64>,
}

/// Sends the browser to the provider.
async fn start(State(state): State<AppState>, Path(name): Path<String>, Query(query): Query<Start>) -> AuthResult<Response> {
    if state.config.human.is_some() { return Err(AuthError::HumanRequired); }
    start_inner(state, name, query).await
}

#[derive(Deserialize)]
struct ProtectedStart {
    #[serde(default)]
    target: String,
    #[serde(default)]
    port: Option<i64>,
    #[serde(default)]
    human_token: String,
    #[serde(default = "signin_action")]
    action: String,
}

fn signin_action() -> String { "signin".into() }

async fn start_post(State(state): State<AppState>, Path(name): Path<String>, Json(body): Json<ProtectedStart>) -> AuthResult<Json<Value>> {
    if !matches!(body.action.as_str(), "signin" | "signup") {
        return Err(AuthError::Bad("Choose sign-in or sign-up.".into()));
    }
    if let Some(check) = &state.config.human { check.verify(&body.human_token, &body.action).await?; }
    let response = start_inner(state, name, Start { target: body.target, port: body.port }).await?;
    let url = response.headers().get("location").and_then(|v| v.to_str().ok())
        .ok_or_else(|| AuthError::Internal(anyhow::anyhow!("missing authorization redirect")))?;
    Ok(Json(json!({"url":url})))
}

async fn start_inner(state: AppState, name: String, query: Start) -> AuthResult<Response> {
    let config = provider(&state, &name)?;
    let target = match query.target.as_str() {
        "app" => "app",
        "landing" => "landing",
        "desktop" => "desktop",
        _ => "website",
    };
    // The desktop app's result only ever goes back to this computer (127.0.0.1), on an unprivileged port.
    let port = if target == "desktop" {
        Some(query.port.filter(|p| (1024..=65535).contains(p)).ok_or_else(|| AuthError::Bad("The app did not say where to return.".into()))?)
    } else {
        None
    };
    if !config.configured() {
        let fb = state.config.firebase.as_ref().ok_or_else(|| AuthError::Bad(format!("{} sign-in is not set up on this server yet.", label(&name))))?;
        let (uri, session, token) = tokio::time::timeout(Duration::from_secs(5), fb.oauth_uri(&name, &redirect_uri(&state, &name)))
            .await.ok().and_then(Result::ok)
            .ok_or_else(|| AuthError::Bad(format!("{} sign-in is unavailable. Ask the administrator to enable its Firebase authorization code flow and configure its client and callback URL.", label(&name))))?;
        sqlx::query("INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, target, return_port, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)")
            .bind(sha256(&token)).bind(&name).bind(session).bind("firebase").bind(target).bind(port).bind(now() as i64 + STATE_SECONDS)
            .execute(&state.db).await?;
        sqlx::query("DELETE FROM oauth_states WHERE expires_at < $1").bind(now() as i64).execute(&state.db).await?;
        return Ok(Redirect::to(&uri).into_response());
    }
    let state_token = random();
    let nonce = random();
    // PKCE for Google; Apple's flow does not take it (the client secret already proves this server).
    let verifier = (name == "google").then(random);
    let t = now() as i64;
    sqlx::query("INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, target, return_port, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(sha256(&state_token))
        .bind(&name)
        .bind(&nonce)
        .bind(&verifier)
        .bind(target)
        .bind(port)
        .bind(t + STATE_SECONDS)
        .execute(&state.db)
        .await?;
    // Sign-ins that were started and never finished are cleared as new ones begin.
    sqlx::query("DELETE FROM oauth_states WHERE expires_at < $1").bind(t).execute(&state.db).await?;
    let mut url = reqwest::Url::parse(&config.auth_url).map_err(|e| AuthError::Internal(anyhow::anyhow!("auth url: {e}")))?;
    {
        let mut params = url.query_pairs_mut();
        params
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", &redirect_uri(&state, &name))
            .append_pair("response_type", "code")
            .append_pair("state", &state_token)
            .append_pair("nonce", &if name == "apple" { sha256(&nonce) } else { nonce.clone() });
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

async fn callback_get(State(state): State<AppState>, Path(name): Path<String>, Query(returned): Query<Returned>) -> Response {
    finish(state, name, returned).await
}

async fn callback_post(State(state): State<AppState>, Path(name): Path<String>, Form(returned): Form<Returned>) -> Response {
    finish(state, name, returned).await
}

/// Where the person goes back to: with the one-time code, or with a message when the sign-in did not work.
fn back(state: &AppState, target: &str, port: Option<i64>, code: Option<&str>, error: Option<&str>) -> Redirect {
    let query = |pairs: &[(&str, &str)]| reqwest::Url::parse_with_params("http://x/", pairs).map(|u| u.query().unwrap_or_default().to_string()).unwrap_or_default();
    let found = match (code, error) {
        (Some(code), None) => query(&[("callerwhale_code", code)]),
        _ => query(&[("oauth_error", error.unwrap_or("Sign-in did not finish."))]),
    };
    match target {
        "desktop" => {
            // The desktop app's own page: it reads `code` or `error`.
            let pairs = match (code, error) {
                (Some(code), None) => query(&[("code", code)]),
                _ => query(&[("error", error.unwrap_or("Sign-in did not finish."))]),
            };
            Redirect::to(&format!("http://127.0.0.1:{}/callerwhale-sign-in?{pairs}", port.unwrap_or(0)))
        }
        "app" => Redirect::to(&format!("{}/?{found}", state.config.app_url)),
        // The public site: back to its sign-in page, which finishes the sign-in with the code.
        "landing" => Redirect::to(&format!("{}/signin?{found}", state.config.landing_url)),
        _ => {
            let page = if code.is_some() && error.is_none() { "account" } else { "signin" };
            Redirect::to(&format!("{}/?{found}#/{page}", state.config.website_url))
        }
    }
}

async fn finish(state: AppState, name: String, returned: Returned) -> Response {
    let t = now() as i64;
    // The state is used up first: without a valid one nothing else is trusted, not even the target.
    let row = match sqlx::query("SELECT provider, nonce, code_verifier, target, return_port FROM oauth_states WHERE state_hash = $1 AND expires_at > $2")
        .bind(sha256(&returned.state))
        .bind(t)
        .fetch_optional(&state.db)
        .await
    {
        Ok(row) => row,
        Err(error) => return AuthError::from(error).into_response(),
    };
    match sqlx::query("DELETE FROM oauth_states WHERE state_hash = $1").bind(sha256(&returned.state)).execute(&state.db).await {
        Ok(used) if used.rows_affected() == 1 => {},
        Ok(_) => return back(&state, "website", None, None, Some("That sign-in link has expired. Try again.")).into_response(),
        Err(error) => return AuthError::from(error).into_response(),
    }
    let parsed = row.and_then(|r| {
        Some((
            r.try_get::<String, _>("provider").ok()?,
            r.try_get::<String, _>("nonce").ok()?,
            r.try_get::<Option<String>, _>("code_verifier").ok()?,
            r.try_get::<String, _>("target").ok()?,
            r.try_get::<Option<i64>, _>("return_port").ok()?,
        ))
    });
    let Some((stored_provider, nonce, verifier, target, port)) = parsed.filter(|(p, ..)| *p == name) else {
        return back(&state, "website", None, None, Some("That sign-in link has expired. Try again.")).into_response();
    };
    if !returned.error.is_empty() || returned.code.is_empty() {
        return back(&state, &target, port, None, Some("Sign-in was cancelled.")).into_response();
    }
    let kind = if target == "desktop" { "desktop" } else { "browser" };
    let outcome = match sign_in(&state, &stored_provider, &returned, &nonce, verifier.as_deref()).await {
        Ok((user, fb)) => handoff(&state, &user, kind, &stored_provider, fb.as_ref()).await,
        Err(error) => Err(error),
    };
    match outcome {
        Ok(code) => back(&state, &target, port, Some(&code), None).into_response(),
        Err(error) => {
            if let AuthError::Internal(cause) = &error {
                tracing::error!(error = %cause, provider = %name, "provider sign-in failed");
            }
            let message = match &error {
                AuthError::Internal(_) => format!("{} sign-in did not work. Try again in a moment.", label(&name)),
                other => other.to_string(),
            };
            back(&state, &target, port, None, Some(&message)).into_response()
        }
    }
}

/// A finished sign-in to collect, once, within two minutes.
async fn handoff(state: &AppState, user: &str, kind: &str, provider: &str, fb: Option<&FbSession>) -> AuthResult<String> {
    let (code, hash) = new_secret();
    let t = now() as i64;
    sqlx::query("INSERT INTO oauth_handoffs (code_hash, user_id, kind, expires_at, provider, fb_refresh) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(&hash)
        .bind(user)
        .bind(kind)
        .bind(t + HANDOFF_SECONDS)
        .bind(provider)
        .bind(fb.map(|f| f.refresh.clone()).filter(|r| !r.is_empty()))
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM oauth_handoffs WHERE expires_at < $1").bind(t).execute(&state.db).await?;
    Ok(code)
}

#[derive(Deserialize)]
struct Exchange {
    code: String,
}

/// Trades the one-time code from a provider sign-in for tokens. The code works once.
async fn exchange(State(state): State<AppState>, Json(body): Json<Exchange>) -> AuthResult<Json<Value>> {
    let hash = sha256(body.code.trim());
    let mut tx = state.db.begin().await?;
    let row = sqlx::query("SELECT user_id, kind, provider, fb_refresh FROM oauth_handoffs WHERE code_hash = $1 AND expires_at > $2")
        .bind(&hash)
        .bind(now() as i64)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AuthError::Forbidden("This sign-in has expired. Try again.".into()))?;
    let user_id: String = row.try_get("user_id")?;
    let kind: String = row.try_get("kind")?;
    let provider: String = row.try_get("provider")?;
    let fb_refresh: Option<String> = row.try_get("fb_refresh")?;
    let used = sqlx::query("DELETE FROM oauth_handoffs WHERE code_hash = $1").bind(&hash).execute(&mut *tx).await?;
    tx.commit().await?;
    if used.rows_affected() != 1 {
        return Err(AuthError::Forbidden("This sign-in has expired. Try again.".into()));
    }
    let user = user_by(&state, "id", &user_id).await?.filter(|u| !u.disabled).ok_or_else(|| AuthError::Forbidden("This account is disabled.".into()))?;
    // A provider sign-in does not pass two-step sign-in: the token says so, and services that need it will ask.
    let fb = fb_refresh.filter(|r| !r.is_empty()).map(|refresh| FbSession { refresh });
    Ok(Json(open_session_fb(&state, &user, &kind, false, &provider, fb.as_ref()).await?))
}

#[derive(Deserialize)]
struct TokenAnswer {
    id_token: String,
}

/// The ID token's claims Caller Whale reads. Apple sends `email_verified` as a string.
#[derive(Deserialize)]
pub struct IdClaims {
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

impl IdClaims {
    pub fn verified_email(&self) -> Option<String> {
        let verified = matches!(&self.email_verified, Some(Value::Bool(true))) || matches!(&self.email_verified, Some(Value::String(s)) if s == "true");
        self.email.as_ref().filter(|_| verified).map(|e| e.trim().to_lowercase())
    }
}

/// Apple's client secret: a short-lived ES256 JWT signed with the team's key.
pub fn apple_client_secret(config: &Provider) -> AuthResult<String> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(config.key_id.clone());
    let t = now() as i64;
    let claims = json!({ "iss": config.team_id, "iat": t, "exp": t + 300, "aud": "https://appleid.apple.com", "sub": config.client_id });
    let key = EncodingKey::from_ec_pem(config.private_key.as_bytes()).map_err(|e| AuthError::Internal(anyhow::anyhow!("apple key: {e}")))?;
    jsonwebtoken::encode(&header, &claims, &key).map_err(|e| AuthError::Internal(anyhow::anyhow!("apple secret: {e}")))
}

/// Each provider's signing keys, fetched at most once an hour (and again when a token names a key not seen yet).
static KEYS: Mutex<Option<HashMap<String, (JwkSet, Instant)>>> = Mutex::new(None);

async fn signing_keys(url: &str, refresh: bool) -> AuthResult<JwkSet> {
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
        .map_err(|e| AuthError::Internal(anyhow::anyhow!("keys: {e}")))?
        .json()
        .await
        .map_err(|e| AuthError::Internal(anyhow::anyhow!("keys: {e}")))?;
    KEYS.lock().unwrap().get_or_insert_with(HashMap::new).insert(url.to_string(), (set.clone(), Instant::now()));
    Ok(set)
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client")
}

/// Checks an ID token: signed by one of the provider's keys with RS256, from its issuer, for this client, unexpired,
/// and carrying the nonce this sign-in started with.
pub async fn verify_id_token(config: &Provider, token: &str, nonce: &str) -> AuthResult<IdClaims> {
    let header = decode_header(token).map_err(|_| AuthError::Bad("The provider's answer was not a valid sign-in token.".into()))?;
    if header.alg != Algorithm::RS256 {
        return Err(AuthError::Bad("The provider's sign-in token used an unexpected signature.".into()));
    }
    let kid = header.kid.ok_or_else(|| AuthError::Bad("The provider's sign-in token names no key.".into()))?;
    let mut keys = signing_keys(&config.jwks_url, false).await?;
    if keys.find(&kid).is_none() {
        keys = signing_keys(&config.jwks_url, true).await?;
    }
    let jwk = keys.find(&kid).ok_or_else(|| AuthError::Bad("The provider's sign-in token was signed with an unknown key.".into()))?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| AuthError::Bad("The provider's key could not be read.".into()))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[&config.issuer]);
    validation.set_audience(&[&config.client_id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<IdClaims>(token, &key, &validation).map_err(|_| AuthError::Forbidden("The sign-in token did not check out.".into()))?.claims;
    if claims.nonce.as_deref() != Some(nonce) {
        return Err(AuthError::Forbidden("The sign-in token was not for this sign-in.".into()));
    }
    Ok(claims)
}

/// Exchanges the provider's code, checks who it says the person is, and returns their account's id.
async fn sign_in(state: &AppState, name: &str, returned: &Returned, nonce: &str, verifier: Option<&str>) -> AuthResult<(String, Option<FbSession>)> {
    if verifier == Some("firebase") {
        let fb = state.config.firebase.as_ref().ok_or_else(|| AuthError::Bad("Sign-in configuration changed. Try again.".into()))?;
        let login = fb.finish_oauth(&redirect_uri(state, name), nonce, name, &returned.code, &returned.state).await.map_err(AuthError::from)?;
        return firebase_account(state, fb, login, "").await;
    }
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
        .map_err(|e| AuthError::Internal(anyhow::anyhow!("token exchange: {e}")))?
        .json()
        .await
        .map_err(|e| AuthError::Internal(anyhow::anyhow!("token answer: {e}")))?;
    let claims = verify_id_token(config, &answer.id_token, &if name == "apple" { sha256(nonce) } else { nonce.to_string() }).await?;
    let email = claims.verified_email().ok_or_else(|| AuthError::Forbidden(format!("Your {} account has no confirmed email address.", label(name))))?;
    let display = claims
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| apple_name(&returned.user))
        .unwrap_or_else(|| email.split('@').next().unwrap_or("Caller Whale user").to_string());

    if let Some(fb) = state.config.firebase.clone() {
        return firebase_provider(state, &fb, name, &answer.id_token, nonce, &display).await;
    }

    let t = now() as i64;
    let mut tx = state.db.begin().await?;
    let linked = sqlx::query("SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2").bind(name).bind(&claims.sub).fetch_optional(&mut *tx).await?;
    let user_id = match linked {
        Some(row) => row.try_get::<String, _>("user_id")?,
        None => {
            let existing = sqlx::query("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
            let user_id = match existing {
                // The provider confirmed this address, which proves the person owns the account it belongs to.
                Some(row) => {
                    let id: String = row.try_get("id")?;
                    sqlx::query("UPDATE users SET email_verified_at = $1 WHERE id = $2 AND email_verified_at IS NULL").bind(t).bind(&id).execute(&mut *tx).await?;
                    id
                }
                None => {
                    if !state.config.public_signup {
                        return Err(AuthError::Forbidden("This server does not take new sign-ups.".into()));
                    }
                    let id = Uuid::new_v4().to_string();
                    sqlx::query("INSERT INTO users (id, email, display_name, password_hash, created_at, email_verified_at) VALUES ($1, $2, $3, $4, $5, $5)")
                        .bind(&id)
                        .bind(&email)
                        .bind(&display)
                        .bind(NO_PASSWORD)
                        .bind(t)
                        .execute(&mut *tx)
                        .await?;
                    email::outbox(&mut tx, "user.signed_up", json!({ "user_id": id, "provider": name, "version": 1 })).await?;
                    id
                }
            };
            sqlx::query("INSERT INTO user_identities (provider, subject, user_id, email, created_at) VALUES ($1, $2, $3, $4, $5)")
                .bind(name)
                .bind(&claims.sub)
                .bind(&user_id)
                .bind(&email)
                .bind(t)
                .execute(&mut *tx)
                .await?;
            user_id
        }
    };
    tx.commit().await?;
    let user: Option<User> = user_by(state, "id", &user_id).await?;
    match user {
        Some(u) if !u.disabled => Ok((u.id, None)),
        _ => Err(AuthError::Forbidden("This account is disabled.".into())),
    }
}

/// Google or Apple through Firebase: the ID token this service just checked goes to Firebase, which finds or opens the person.
async fn firebase_provider(state: &AppState, fb: &Firebase, provider: &str, id_token: &str, nonce: &str, display: &str) -> AuthResult<(String, Option<FbSession>)> {
    let login = fb.sign_in_provider(provider, id_token, nonce).await.map_err(AuthError::from)?;
    firebase_account(state, fb, login, display).await
}

async fn firebase_account(state: &AppState, fb: &Firebase, login: crate::firebase::Login, display: &str) -> AuthResult<(String, Option<FbSession>)> {
    let mut profile = fb.profile(&login.id_token).await.map_err(AuthError::from)?;
    if profile.disabled || !profile.email_verified || profile.email.trim().is_empty() {
        return Err(AuthError::Forbidden("Sign-in requires an enabled account with a confirmed email address.".into()));
    }
    if profile.name.trim().is_empty() {
        profile.name = display.to_string();
    }
    let user = upsert_firebase_user(state, &profile).await?;
    if user.disabled {
        return Err(AuthError::Forbidden("This account is disabled.".into()));
    }
    Ok((user.id, Some(FbSession { refresh: login.refresh_token })))
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
        let claims = |verified: Value| IdClaims { sub: "1".into(), email: Some("A@Example.com ".into()), email_verified: Some(verified), nonce: None, name: None };
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
