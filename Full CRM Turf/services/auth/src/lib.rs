//! Turf's authentication service: the one source of truth for who someone is, for every app and service.
//!
//! It owns accounts, passwords (Argon2id), two-step codes and recovery codes, and sessions. A session hands out
//! short-lived EdDSA access tokens and a refresh token that changes every time it is used. Other services never call
//! this service to check a token: they verify it with the public keys at `/.well-known/jwks.json`
//! (the `turf-auth-verify` crate).

pub mod config;
pub mod error;
pub mod keys;
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

/// Creates the tables if they are missing. Every statement is safe to run again.
pub async fn migrate(db: &AnyPool) -> anyhow::Result<()> {
    let sql = include_str!("../migrations/0001_auth.sql");
    let without_comments: String = sql.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
    for statement in without_comments.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::query(statement).execute(db).await?;
    }
    Ok(())
}

pub fn app(state: AppState) -> axum::Router {
    routes::router().with_state(state)
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
