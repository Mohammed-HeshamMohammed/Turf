/// Everything the service reads from its environment.
#[derive(Clone, Debug)]
pub struct Config {
    /// PostgreSQL in production; `sqlite://auth.db?mode=rwc` (the default) for local development.
    pub database_url: String,
    pub port: u16,
    pub human: Option<crate::human::HumanCheck>,
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
    /// Where a sign-in started from the public site (callerwhale.com) returns.
    pub landing_url: String,
    /// Where a sign-in started from the CRM in a browser tab returns.
    pub app_url: String,
    /// Development only: return email confirmation tokens in responses, since no email is sent yet.
    pub dev_tokens: bool,
    /// Browser origins that may call this service: the CRM, the website and the desktop window.
    pub allowed_origins: Vec<String>,
    pub google: Provider,
    pub apple: Provider,
    /// Firebase Authentication as the account store (`AUTH_FIREBASE_API_KEY`). None: this service keeps its own accounts.
    pub firebase: Option<crate::firebase::Firebase>,
    /// Asks the notification service to email the codes of the second step (`AUTH_NOTIFY_URL`, `AUTH_NOTIFY_TOKEN`). None: email codes are not offered.
    pub mailer: Option<std::sync::Arc<dyn crate::mail::Mailer>>,
    /// The Telegram bot that sends the Telegram codes (`AUTH_TELEGRAM_BOT_TOKEN`). None: Telegram is not offered.
    pub telegram: Option<crate::telegram::Telegram>,
    /// The secret in the Telegram webhook's address; Telegram posts there when a person opens their link.
    pub telegram_webhook_secret: String,
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
        let mut config = Config {
            database_url: var("DATABASE_URL", "sqlite://auth.db?mode=rwc"),
            port: var("PORT", "8101").parse()?,
            human: None,
            signing_key: var("AUTH_SIGNING_KEY", ""),
            access_minutes: var("AUTH_ACCESS_MINUTES", "15").parse()?,
            refresh_days: var("AUTH_REFRESH_DAYS", "30").parse()?,
            public_signup: var("AUTH_PUBLIC_SIGNUP", "true") != "false",
            public_url: var("AUTH_PUBLIC_URL", "http://localhost:8101").trim_end_matches('/').to_string(),
            website_url: var("AUTH_WEBSITE_URL", "http://localhost:8088").trim_end_matches('/').to_string(),
            app_url: var("AUTH_APP_URL", "http://localhost:5190").trim_end_matches('/').to_string(),
            landing_url: var("AUTH_LANDING_URL", "http://localhost:5200").trim_end_matches('/').to_string(),
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
            // Email codes are offered only when the notification service is set (its address and this service's token there).
            mailer: Some(var("AUTH_NOTIFY_URL", ""))
                .filter(|url| !url.trim().is_empty() && !var("AUTH_NOTIFY_TOKEN", "").trim().is_empty())
                .map(|url| std::sync::Arc::new(crate::mail::Notify::new(&url, &var("AUTH_NOTIFY_TOKEN", ""))) as std::sync::Arc<dyn crate::mail::Mailer>),
            telegram: Some(var("AUTH_TELEGRAM_BOT_TOKEN", "")).filter(|token| !token.trim().is_empty()).map(|token| {
                crate::telegram::Telegram::new(token.trim(), &var("AUTH_TELEGRAM_BOT_NAME", ""), &var("AUTH_TELEGRAM_API_URL", "https://api.telegram.org"))
            }),
            telegram_webhook_secret: var("AUTH_TELEGRAM_WEBHOOK_SECRET", "").trim().to_string(),
            firebase: Some(var("AUTH_FIREBASE_API_KEY", "")).filter(|key| !key.trim().is_empty()).map(|key| {
                crate::firebase::Firebase::new(
                    key.trim(),
                    &var("AUTH_FIREBASE_IDENTITY_URL", "https://identitytoolkit.googleapis.com"),
                    &var("AUTH_FIREBASE_TOKEN_URL", "https://securetoken.googleapis.com"),
                )
            }),
        };
        match var("AUTH_BOT_PROTECTION", "false").as_str() {
            "false" => {},
            "true" => {
                let explicit = var("AUTH_TURNSTILE_HOSTNAMES", "");
                let hosts = if explicit.trim().is_empty() {
                    config.allowed_origins.iter().chain([&config.public_url, &config.website_url, &config.landing_url, &config.app_url])
                        .filter_map(|s| reqwest::Url::parse(s).ok()?.host_str().map(str::to_owned)).collect()
                } else {
                    explicit.split(',').map(str::trim).filter(|h| !h.is_empty()).map(str::to_owned).collect()
                };
                config.human = Some(crate::human::HumanCheck::new(&var("AUTH_TURNSTILE_SITE_KEY", ""), &var("AUTH_TURNSTILE_SECRET_KEY", ""), hosts)?);
            },
            _ => anyhow::bail!("AUTH_BOT_PROTECTION must be true or false"),
        }
        Ok(config)
    }

    /// Settings for tests and examples: nothing outside, sign-up open, development tokens on.
    pub fn for_tests() -> Self {
        Config {
            database_url: "sqlite::memory:".into(),
            port: 0,
            human: None,
            signing_key: String::new(),
            access_minutes: 15,
            refresh_days: 30,
            public_signup: true,
            public_url: "http://auth.example".into(),
            website_url: "http://website.example".into(),
            app_url: "http://app.example".into(),
            landing_url: "http://landing.example".into(),
            dev_tokens: true,
            allowed_origins: vec!["http://app.example".into()],
            google: Provider::default(),
            apple: Provider::default(),
            firebase: None,
            mailer: None,
            telegram: None,
            telegram_webhook_secret: String::new(),
        }
    }
}
