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
    /// This service's public address, as browsers reach it: Google and Apple send people back here.
    pub public_url: String,
    /// Where a sign-in started from the website returns.
    pub website_url: String,
    /// Where a sign-in started from the CRM in a browser tab returns.
    pub app_url: String,
    /// Development only: return email confirmation tokens in responses, since no email is sent yet.
    pub dev_tokens: bool,
    /// Browser origins that may call this service: the CRM, the website and the desktop window.
    pub allowed_origins: Vec<String>,
    pub google: Provider,
    pub apple: Provider,
}

/// One outside sign-in (OpenID Connect). Not set up until it has a client id and a secret (or, for Apple, a key).
#[derive(Clone, Debug, Default)]
pub struct Provider {
    pub client_id: String,
    /// Google: the client secret. Apple: empty; the secret is a JWT signed with the key below.
    pub client_secret: String,
    pub team_id: String,
    pub key_id: String,
    /// Apple's .p8 private key (PEM).
    pub private_key: String,
    pub auth_url: String,
    pub token_url: String,
    pub jwks_url: String,
    pub issuer: String,
}

impl Provider {
    pub fn configured(&self) -> bool {
        !self.client_id.is_empty() && (!self.client_secret.is_empty() || (!self.private_key.is_empty() && !self.team_id.is_empty() && !self.key_id.is_empty()))
    }

    pub fn google_defaults() -> Self {
        Provider {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            jwks_url: "https://www.googleapis.com/oauth2/v3/certs".into(),
            issuer: "https://accounts.google.com".into(),
            ..Default::default()
        }
    }

    pub fn apple_defaults() -> Self {
        Provider {
            auth_url: "https://appleid.apple.com/auth/authorize".into(),
            token_url: "https://appleid.apple.com/auth/token".into(),
            jwks_url: "https://appleid.apple.com/auth/keys".into(),
            issuer: "https://appleid.apple.com".into(),
            ..Default::default()
        }
    }
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
            public_url: var("AUTH_PUBLIC_URL", "http://localhost:8101").trim_end_matches('/').to_string(),
            website_url: var("AUTH_WEBSITE_URL", "http://localhost:8088").trim_end_matches('/').to_string(),
            app_url: var("AUTH_APP_URL", "http://localhost:5190").trim_end_matches('/').to_string(),
            dev_tokens: var("AUTH_DEV_TOKENS", "false") == "true",
            allowed_origins: var("AUTH_ALLOWED_ORIGINS", "http://localhost:5190,http://localhost:8088,tauri://localhost,http://tauri.localhost")
                .split(',')
                .map(|o| o.trim().trim_end_matches('/').to_string())
                .filter(|o| !o.is_empty())
                .collect(),
            google: Provider {
                client_id: var("AUTH_GOOGLE_CLIENT_ID", ""),
                client_secret: var("AUTH_GOOGLE_CLIENT_SECRET", ""),
                ..Provider::google_defaults()
            },
            apple: Provider {
                client_id: var("AUTH_APPLE_CLIENT_ID", ""),
                team_id: var("AUTH_APPLE_TEAM_ID", ""),
                key_id: var("AUTH_APPLE_KEY_ID", ""),
                // A .p8 key in an environment variable usually arrives with "\n" for its line breaks.
                private_key: var("AUTH_APPLE_PRIVATE_KEY", "").replace("\\n", "\n"),
                ..Provider::apple_defaults()
            },
        })
    }

    /// Settings for tests and examples: nothing outside, sign-up open, development tokens on.
    pub fn for_tests() -> Self {
        Config {
            database_url: "sqlite::memory:".into(),
            port: 0,
            signing_key: String::new(),
            access_minutes: 15,
            refresh_days: 30,
            public_signup: true,
            public_url: "http://auth.example".into(),
            website_url: "http://website.example".into(),
            app_url: "http://app.example".into(),
            dev_tokens: true,
            allowed_origins: vec!["http://app.example".into()],
            google: Provider::default(),
            apple: Provider::default(),
        }
    }
}
