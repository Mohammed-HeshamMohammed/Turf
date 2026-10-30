use std::sync::Arc;
use callerwhale_auth::{app, config::Config, connect, keys::Keys, migrate, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();

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
    migrate(&db).await?;

    let port = config.port;
    let state = AppState { db, keys: Arc::new(keys), config: Arc::new(config) };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("auth listening on http://localhost:{port}");
    axum::serve(listener, app(state)).await?;
    Ok(())
}
