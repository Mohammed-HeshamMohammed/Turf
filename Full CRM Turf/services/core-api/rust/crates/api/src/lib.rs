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
use tower_layer::Layer;
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
    let auth = auth_verifier(&config.auth_jwks, &config.auth_jwks_url).await?.map(Arc::new);
    Ok(AppState { db, cache, events, config: Arc::new(config), auth })
}

/// The auth service's public keys, from TURF_AUTH_JWKS or fetched once from TURF_AUTH_JWKS_URL. A bad key set stops the
/// server from starting rather than letting it run without the check it was told to make.
pub async fn auth_verifier(jwks: &str, jwks_url: &str) -> anyhow::Result<Option<turf_auth_verify::Verifier>> {
    let json = if !jwks.trim().is_empty() {
        jwks.to_string()
    } else if !jwks_url.trim().is_empty() {
        reqwest::get(jwks_url).await?.error_for_status()?.text().await?
    } else {
        return Ok(None);
    };
    Ok(Some(turf_auth_verify::Verifier::from_jwks_json(&json)?))
}

#[cfg(test)]
mod auth_keys_tests {
    use super::auth_verifier;

    #[tokio::test]
    async fn no_keys_means_only_this_servers_sessions() {
        assert!(auth_verifier("", "").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn auth_keys_are_read_and_bad_ones_stop_the_start() {
        // The public key from RFC 8037's Ed25519 example.
        let jwks = r#"{"keys":[{"kty":"OKP","crv":"Ed25519","alg":"EdDSA","kid":"k1","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}]}"#;
        assert!(auth_verifier(jwks, "").await.unwrap().is_some());
        assert!(auth_verifier("not json", "").await.is_err());
        assert!(auth_verifier(r#"{"keys":[]}"#, "").await.is_err());
    }
}

pub fn app(state: AppState) -> Router {
    let request_id = HeaderName::from_static("x-request-id");
    let origins: Vec<HeaderValue> = state.config.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static(auth::CSRF_HEADER),
            HeaderName::from_static(auth::ORG_HEADER),
            request_id.clone(),
        ]);
    let limit = state.config.max_body_bytes;
    let site = state.config.site_dir.clone();
    let mut router = routes::router().with_state(state);
    if !site.is_empty() {
        // The public website: plain files, its scripts only from itself, never framed by another site.
        // Browsers check back for a newer copy every time, so a release is seen at once.
        let no_cache = SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        router = router.fallback_service(no_cache.layer(ServeDir::new(site)));
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
