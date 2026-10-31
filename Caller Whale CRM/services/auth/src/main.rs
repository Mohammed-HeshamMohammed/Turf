use std::sync::Arc;
use callerwhale_auth::{app, config::Config, connect, keys::Keys, setup_database, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();

    // `service health` is the container's health check: the image has no shell or curl.
    if std::env::args().nth(1).as_deref() == Some("health") {
        let port = std::env::var("PORT").unwrap_or_else(|_| "8101".into());
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/healthz")).await.map(|r| r.status().is_success()).unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    // `callerwhale-auth new-key` prints a signing key for AUTH_SIGNING_KEY and exits.
    if std::env::args().nth(1).as_deref() == Some("new-key") {
        println!("{}", Keys::new_secret()?);
        return Ok(());
    }

    let config = Config::from_env()?;
    let keys = if config.signing_key.is_empty() {
        tracing::warn!("AUTH_SIGNING_KEY is not set: using a temporary key, so every token stops working when this process stops");
        Keys::generate()?
    } else {
        Keys::from_base64(&config.signing_key)?
    };
    let db = connect(&config.database_url).await?;
    setup_database(&db).await?;

    let port = config.port;
    let state = AppState { db, keys: Arc::new(keys), config: Arc::new(config) };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("auth listening on http://localhost:{port}");
    axum::serve(listener, app(state)).await?;
    Ok(())
}
