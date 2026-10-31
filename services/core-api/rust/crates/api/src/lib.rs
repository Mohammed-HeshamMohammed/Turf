//! Caller Whale CRM API (plan 2.2, 2.3): authentication, permission enforcement, authoritative transactions,
//! synchronization and WebSocket events. Workers reach the database only through the /internal routes.

pub mod access;
pub mod auth;
pub mod cache;
pub mod config;
pub mod db;
pub mod error;
pub mod events;
pub mod mail;
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
    // People sign in only at the auth service, so without its keys nobody could use this server.
    let auth = auth_verifier(&config.auth_jwks, &config.auth_jwks_url).await?.map(Arc::new);
    if auth.is_none() {
        anyhow::bail!("Set CALLERWHALE_AUTH_JWKS or CALLERWHALE_AUTH_JWKS_URL: people sign in with the auth service, and this server checks its tokens");
    }
    Ok(AppState { db, cache, events, config: Arc::new(config), auth })
}

/// The auth service's public keys, from CALLERWHALE_AUTH_JWKS or fetched once from CALLERWHALE_AUTH_JWKS_URL. A bad key set stops the
/// server from starting rather than letting it run without the check it was told to make.
pub async fn auth_verifier(jwks: &str, jwks_url: &str) -> anyhow::Result<Option<callerwhale_auth_verify::Verifier>> {
    let json = if !jwks.trim().is_empty() {
        jwks.to_string()
    } else if !jwks_url.trim().is_empty() {
        reqwest::get(jwks_url).await?.error_for_status()?.text().await?
    } else {
        return Ok(None);
    };
    Ok(Some(callerwhale_auth_verify::Verifier::from_jwks_json(&json)?))
}

#[cfg(test)]
mod auth_keys_tests {
    use super::auth_verifier;

    #[test]
    fn the_website_may_call_the_auth_service_and_nothing_else() {
        assert_eq!(super::origin_of("https://auth.callerwhale.example/some/path"), "https://auth.callerwhale.example");
        assert_eq!(super::origin_of("http://localhost:8101"), "http://localhost:8101");
        assert_eq!(super::origin_of("not a url"), "");
        let policy = super::content_security_policy("https://auth.callerwhale.example", "");
        assert!(policy.contains("connect-src 'self' https://auth.callerwhale.example;"));
        assert!(policy.contains("script-src 'self';"));
        assert!(super::content_security_policy("", "").contains("connect-src 'self';"));
        assert!(policy.ends_with("form-action 'self'"), "forms post nowhere else without Grafana");
        // The admin dashboard posts a sign-in to the Grafana login proxy, and only there.
        let grafana = super::content_security_policy("", "https://grafana.callerwhale.example");
        assert!(grafana.ends_with("form-action 'self' https://grafana.callerwhale.example"));
        assert!(grafana.contains("connect-src 'self';"), "the proxy is posted to, never fetched");
        assert!(!policy.contains("google") && !policy.contains("firebase"), "the website knows no identity provider");
    }

    #[tokio::test]
    async fn no_keys_are_reported_as_none() {
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

/// The scheme, host and port of an address ("https://auth.callerwhale.example"), or nothing when it is not one.
pub fn origin_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().map(|u| u.origin().ascii_serialization()).filter(|o| o != "null").unwrap_or_default()
}

/// The website talks to this server and to the auth service, and to nothing else. Its forms post here, and to the
/// Grafana login proxy when there is one (the admin dashboard hands staff over with a form post).
pub fn content_security_policy(auth_origin: &str, grafana_origin: &str) -> String {
    let connect = if auth_origin.is_empty() { "'self'".to_string() } else { format!("'self' {auth_origin}") };
    let forms = if grafana_origin.is_empty() { "'self'".to_string() } else { format!("'self' {grafana_origin}") };
    format!("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src {connect}; frame-ancestors 'none'; base-uri 'none'; form-action {forms}")
}

/// Workers reach `/internal` straight over the private network. The edge proxy adds `X-Forwarded-For` to everything that
/// comes from the internet, so a proxied request never gets to the worker routes, whatever token it carries.
async fn private_only(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    use axum::response::IntoResponse;
    if req.uri().path().starts_with("/internal") && req.headers().contains_key("x-forwarded-for") {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    next.run(req).await
}

pub fn app(state: AppState) -> Router {
    let request_id = HeaderName::from_static("x-request-id");
    let origins: Vec<HeaderValue> = state.config.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        // Requests carry a bearer token, never a cookie, so no credentials are allowed across sites.
        .allow_credentials(false)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static(auth::ORG_HEADER),
            request_id.clone(),
        ]);
    let limit = state.config.max_body_bytes;
    let auth_origin = origin_of(&state.config.auth_public_url);
    let grafana_origin = origin_of(&state.config.grafana_url);
    let site = state.config.site_dir.clone();
    let mut router = routes::router().with_state(state);
    if !site.is_empty() {
        // The public website: plain files, its scripts only from itself, never framed by another site.
        // Browsers check back for a newer copy every time, so a release is seen at once.
        let no_cache = SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        router = router.fallback_service(no_cache.layer(ServeDir::new(site)));
    }
    router
        .layer(axum::middleware::from_fn(private_only))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(&content_security_policy(&auth_origin, &grafana_origin)).unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'")),
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
    if !config.database_setup_url.is_empty() {
        db::setup_database(&config).await?;
    }
    let bind = config.bind.clone();
    let state = state(config).await?;
    events::spawn_listener(state.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "Caller Whale API listening");
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
