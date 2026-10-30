use callerwhale_api::{config::Config, serve};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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
