use callerwhale_api::{config::Config, serve};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `callerwhale-api health` is the container's health check: the image has no curl, and this needs no database or settings.
    if std::env::args().nth(1).as_deref() == Some("health") {
        let bind = std::env::var("CALLERWHALE_BIND").unwrap_or_else(|_| "127.0.0.1:8088".into());
        let port = bind.rsplit(':').next().unwrap_or("8088");
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/healthz")).await.map(|r| r.status().is_success()).unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()))
        .json()
        .init();
    let config = Config::from_env()?;
    if std::env::args().any(|arg| arg == "migrate") {
        callerwhale_api::db::migrate(&config).await?;
        return Ok(());
    }
    serve(config).await
}
