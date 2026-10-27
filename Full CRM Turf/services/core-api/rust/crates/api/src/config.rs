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
    /// Anyone may create an account and a trial organization (POST /auth/signup). Off for a private server.
    pub public_signup: bool,
    /// Shared secret the payment provider signs webhooks with (HMAC-SHA256). Shorter than 24 characters: webhooks off.
    pub billing_webhook_secret: String,
    /// Where checkout sends the browser; the payment id is appended. Empty: no hosted checkout is configured.
    pub checkout_url: String,
    /// Development only: return email-verification tokens in responses instead of needing an email to arrive.
    pub dev_tokens: bool,
    /// Folder of the public website (sign-up, sign-in, account) served at `/`. Empty: no website.
    pub site_dir: String,
    /// Owners and administrators must confirm an authenticator code (TURF_REQUIRE_MFA=true). Off for now; people can
    /// still set one up from the API, and it is checked when they have.
    pub require_mfa: bool,
    /// This server's public address, as browsers reach it (provider sign-ins return here).
    pub public_url: String,
    /// The CRM's address, where a sign-in started from the app returns.
    pub app_url: String,
    pub google: OauthProvider,
    pub apple: OauthProvider,
    /// The auth service's public keys (the JSON of its /.well-known/jwks.json). When set, a request may sign in with
    /// an auth access token instead of a session of this server. Empty: only this server's own sessions.
    pub auth_jwks: String,
    /// Where to fetch those keys at start, when TURF_AUTH_JWKS is not given directly.
    pub auth_jwks_url: String,
    /// Where browsers reach the auth service, for the website and the app to find it.
    pub auth_public_url: String,
}

/// One outside sign-in (OpenID Connect). Not configured until it has a client id and a secret (or, for Apple, a key).
#[derive(Clone, Debug, Default)]
pub struct OauthProvider {
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

impl OauthProvider {
    pub fn google_defaults() -> Self {
        OauthProvider {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            jwks_url: "https://www.googleapis.com/oauth2/v3/certs".into(),
            issuer: "https://accounts.google.com".into(),
            ..Default::default()
        }
    }

    pub fn apple_defaults() -> Self {
        OauthProvider {
            auth_url: "https://appleid.apple.com/auth/authorize".into(),
            token_url: "https://appleid.apple.com/auth/token".into(),
            jwks_url: "https://appleid.apple.com/auth/keys".into(),
            issuer: "https://appleid.apple.com".into(),
            ..Default::default()
        }
    }

    pub fn configured(&self) -> bool {
        !self.client_id.is_empty() && (!self.client_secret.is_empty() || (!self.private_key.is_empty() && !self.team_id.is_empty() && !self.key_id.is_empty()))
    }
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
            public_signup: var("TURF_PUBLIC_SIGNUP", "true") != "false",
            billing_webhook_secret: var("TURF_BILLING_WEBHOOK_SECRET", ""),
            checkout_url: var("TURF_CHECKOUT_URL", ""),
            dev_tokens: var("TURF_DEV_TOKENS", "false") == "true",
            site_dir: var("TURF_SITE_DIR", ""),
            require_mfa: var("TURF_REQUIRE_MFA", "false") == "true",
            public_url: var("TURF_PUBLIC_URL", "http://localhost:8088").trim_end_matches('/').to_string(),
            app_url: var("TURF_APP_URL", "http://localhost:5190").trim_end_matches('/').to_string(),
            google: OauthProvider {
                client_id: var("TURF_GOOGLE_CLIENT_ID", ""),
                client_secret: var("TURF_GOOGLE_CLIENT_SECRET", ""),
                ..OauthProvider::google_defaults()
            },
            auth_jwks: var("TURF_AUTH_JWKS", ""),
            auth_jwks_url: var("TURF_AUTH_JWKS_URL", ""),
            auth_public_url: var("TURF_AUTH_PUBLIC_URL", "http://localhost:8101").trim_end_matches('/').to_string(),
            apple: OauthProvider {
                client_id: var("TURF_APPLE_CLIENT_ID", ""),
                team_id: var("TURF_APPLE_TEAM_ID", ""),
                key_id: var("TURF_APPLE_KEY_ID", ""),
                // A .p8 key in an environment variable usually arrives with "\n" for its line breaks.
                private_key: var("TURF_APPLE_PRIVATE_KEY", "").replace("\\n", "\n"),
                ..OauthProvider::apple_defaults()
            },
        })
    }
}
