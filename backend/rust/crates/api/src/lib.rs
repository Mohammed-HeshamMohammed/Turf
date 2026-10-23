//! Turf CRM API (plan 2.2, 2.3): authentication, permission enforcement, authoritative transactions,
//! synchronization and WebSocket events. Workers reach the database only through the /internal routes.

pub mod access;
pub mod auth;
pub mod cache;
pub mod config;
pub mod db;
pub mod error;
pub mod events;
pub mod ops;
pub mod outcomes;
pub mod record;
pub mod routes;
pub mod state;

use axum::{
    http::{header, HeaderName, HeaderValue, Method},
    Router,
};
use state::AppState;
use std::sync::Arc;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
    propagate_header::PropagateHeaderLayer,
    request_id::{MakeRequestUuid, SetRequestIdLayer},
    services::ServeDir,
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

pub async fn state(config: config::Config) -> anyhow::Result<AppState> {
    let db = db::connect(&config).await?;
    let cache = cache::Cache::connect(&config.redis_url).await;
    let (events, _) = tokio::sync::broadcast::channel(4096);
    Ok(AppState { db, cache, events, config: Arc::new(config) })
}

pub fn app(state: AppState) -> Router {
    let request_id = HeaderName::from_static("x-request-id");
    let origins: Vec<HeaderValue> = state.config.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, HeaderName::from_static(auth::CSRF_HEADER), request_id.clone()]);
    let limit = state.config.max_body_bytes;
    let site = state.config.site_dir.clone();
    let mut router = routes::router().with_state(state);
    if !site.is_empty() {
        // The public website: plain files, its scripts only from itself, never framed by another site.
        router = router.fallback_service(ServeDir::new(site));
    }
    router
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("same-origin")))
        .layer(RequestBodyLimitLayer::new(limit))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(PropagateHeaderLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
}

pub async fn serve(config: config::Config) -> anyhow::Result<()> {
    if !config.migration_database_url.is_empty() {
        db::migrate(&config).await?;
    }
    let bind = config.bind.clone();
    let state = state(config).await?;
    events::spawn_listener(state.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "Turf API listening");
    axum::serve(listener, app(state)).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
    tracing::info!("shutting down");
}
