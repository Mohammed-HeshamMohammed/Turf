use anyhow::Context;

#[derive(Clone, Debug)]
pub struct Config {
    /// The API's own connection: a login role that is a member of turf_app and never bypasses row security.
    pub database_url: String,
    /// The owning role, used only to run migrations. Empty: migrations are not run by this process.
    pub migration_database_url: String,
    /// Empty: no Redis; every cached read goes to PostgreSQL.
    pub redis_url: String,
    pub bind: String,
    /// Secure cookies need HTTPS; off only for local development over http.
    pub secure_cookies: bool,
    /// Allowed browser origins for credentialed requests, comma separated.
    pub allowed_origins: Vec<String>,
    /// Tokens workers present on /internal routes, as name=token pairs.
    pub worker_tokens: Vec<(String, String)>,
    pub artifact_dir: String,
    pub session_hours: i64,
    pub max_body_bytes: usize,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_string());
        let worker_tokens = var("TURF_WORKER_TOKENS", "")
            .split(',')
            .filter_map(|pair| pair.split_once('='))
            .map(|(name, token)| (name.trim().to_string(), token.trim().to_string()))
            .filter(|(_, token)| token.len() >= 24)
            .collect();
        Ok(Config {
            database_url: std::env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            migration_database_url: var("MIGRATION_DATABASE_URL", ""),
            redis_url: var("REDIS_URL", ""),
            bind: var("TURF_BIND", "127.0.0.1:8088"),
            secure_cookies: var("TURF_SECURE_COOKIES", "true") != "false",
            allowed_origins: var("TURF_ALLOWED_ORIGINS", "").split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
            worker_tokens,
            artifact_dir: var("TURF_ARTIFACT_DIR", "artifacts"),
            session_hours: var("TURF_SESSION_HOURS", "336").parse().context("TURF_SESSION_HOURS")?,
            max_body_bytes: var("TURF_MAX_BODY_BYTES", "26214400").parse().context("TURF_MAX_BODY_BYTES")?,
        })
    }
}
