/// Everything the service reads from its environment.
#[derive(Clone, Debug)]
pub struct Config {
    /// PostgreSQL in production; `sqlite://auth.db?mode=rwc` (the default) for local development.
    pub database_url: String,
    pub port: u16,
    /// The Ed25519 signing key: base64 of its PKCS#8 form. Empty: a new key is made at start, so tokens stop working
    /// when the service restarts. Only acceptable on a developer's machine.
    pub signing_key: String,
    pub access_minutes: u64,
    pub refresh_days: u64,
    /// Anyone may create an account. Off for a private server.
    pub public_signup: bool,
}

fn var(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Config {
            database_url: var("DATABASE_URL", "sqlite://auth.db?mode=rwc"),
            port: var("PORT", "8101").parse()?,
            signing_key: var("AUTH_SIGNING_KEY", ""),
            access_minutes: var("AUTH_ACCESS_MINUTES", "15").parse()?,
            refresh_days: var("AUTH_REFRESH_DAYS", "30").parse()?,
            public_signup: var("AUTH_PUBLIC_SIGNUP", "true") != "false",
        })
    }
}
