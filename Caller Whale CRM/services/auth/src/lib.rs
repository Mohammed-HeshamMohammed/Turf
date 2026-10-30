//! Caller Whale's authentication service: the one source of truth for who someone is, for every app and service.
//!
//! It owns accounts, passwords (Argon2id), two-step codes and recovery codes, and sessions. A session hands out
//! short-lived EdDSA access tokens and a refresh token that changes every time it is used. Other services never call
//! this service to check a token: they verify it with the public keys at `/.well-known/jwks.json`
//! (the `callerwhale-auth-verify` crate).

pub mod config;
pub mod error;
pub mod keys;
pub mod email;
pub mod oauth;
pub mod routes;

use std::sync::Arc;

use sqlx::{any::AnyPoolOptions, AnyPool};

#[derive(Clone)]
pub struct AppState {
    pub db: AnyPool,
    pub keys: Arc<keys::Keys>,
    pub config: Arc<config::Config>,
}

/// Opens the database. An in-memory SQLite database must be a single connection, or each connection sees its own.
pub async fn connect(url: &str) -> anyhow::Result<AnyPool> {
    sqlx::any::install_default_drivers();
    let max = if url.contains(":memory:") { 1 } else { 10 };
    Ok(AnyPoolOptions::new().max_connections(max).connect(url).await?)
}

/// The migrations, in order. Each runs once; `schema_migrations` remembers which ran.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_auth.sql")),
    (2, include_str!("../migrations/0002_sign_in.sql")),
    (3, include_str!("../migrations/0003_session_provider.sql")),
];

/// Brings the database up to date. Safe to run on every start.
pub async fn migrate(db: &AnyPool) -> anyhow::Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)").execute(db).await?;
    for (version, sql) in MIGRATIONS {
        let done = sqlx::query("SELECT 1 AS one FROM schema_migrations WHERE version = $1").bind(version).fetch_optional(db).await?.is_some();
        if done {
            continue;
        }
        let mut tx = db.begin().await?;
        let without_comments: String = sql.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join("
");
        for statement in without_comments.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)").bind(version).bind(now() as i64).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}

pub fn app(state: AppState) -> axum::Router {
    use axum::http::{header, HeaderValue, Method};
    use tower_http::cors::{AllowOrigin, CorsLayer};
    // Browsers call this service directly with a bearer token (no cookies), from the origins listed in AUTH_ALLOWED_ORIGINS.
    let origins: Vec<HeaderValue> = state.config.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);
    routes::router().with_state(state).layer(cors)
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
