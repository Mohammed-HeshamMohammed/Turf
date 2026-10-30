use anyhow::Context;

#[derive(Clone, Debug)]
pub struct Config {
    /// The API's own connection: a login role that is a member of callerwhale_app and never bypasses row security.
    pub database_url: String,
    /// The owning role, used only to run migrations. Empty: migrations are not run by this process.
    pub migration_database_url: String,
    /// Empty: no Redis; every cached read goes to PostgreSQL.
    pub redis_url: String,
    pub bind: String,
    /// Browser origins allowed to call the API (the CRM's), comma separated.
    pub allowed_origins: Vec<String>,
    /// Tokens workers present on /internal routes, as name=token pairs.
    pub worker_tokens: Vec<(String, String)>,
    pub artifact_dir: String,
    pub max_body_bytes: usize,
    /// Anyone signed in with auth may open a trial organization (POST /organizations/trial). Only with
    /// CALLERWHALE_PUBLIC_SIGNUP=true; otherwise only Caller Whale's staff open workspaces, and everyone else joins by invitation.
    pub public_signup: bool,
    /// Shared secret the payment provider signs webhooks with (HMAC-SHA256). Shorter than 24 characters: webhooks off.
    pub billing_webhook_secret: String,
    /// Where checkout sends the browser; the payment id is appended. Empty: no hosted checkout is configured.
    pub checkout_url: String,
    /// Folder of the public website (sign-up, sign-in, account) served at `/`. Empty: no website.
    pub site_dir: String,
    /// Owners and administrators must confirm an authenticator code (CALLERWHALE_REQUIRE_MFA=true). Off for now; people can
    /// still set one up from the API, and it is checked when they have.
    pub require_mfa: bool,
    /// The auth service's public keys (the JSON of its /.well-known/jwks.json), here or as CALLERWHALE_AUTH_JWKS_URL. This or
    /// a Firebase project is required: every request carries an access token.
    pub auth_jwks: String,
    /// Where to fetch those keys at start, when CALLERWHALE_AUTH_JWKS is not given directly.
    pub auth_jwks_url: String,
    /// Where browsers reach the auth service, for the website and the app to find it.
    pub auth_public_url: String,
    /// The Firebase project whose ID tokens are accepted too (docs/plans/firebase-auth.md). Empty: none.
    pub firebase_project: String,
    /// Firebase's public keys given directly (tests, or a server without internet). Empty: fetched from
    /// `firebase_jwks_url` at start and every hour after, since Google rotates them.
    pub firebase_jwks: String,
    pub firebase_jwks_url: String,
    /// The web app's Firebase config, handed to the website and the CRM so they sign in with Firebase. These are
    /// public by design. Without an API key the pages keep signing in with the auth service.
    pub firebase_api_key: String,
    /// Default `<project>.firebaseapp.com`.
    pub firebase_auth_domain: String,
    pub firebase_app_id: String,
    /// Providers turned on in the Firebase console besides email and password (comma separated: google, apple).
    pub firebase_providers: Vec<String>,
    /// Where staff open Grafana: the Grafana login proxy's address (services/grafana-proxy). Empty: no Grafana link,
    /// and the website may post a sign-in nowhere but here.
    pub grafana_url: String,
    /// Caller Whale's staff must confirm an authenticator code to open the admin dashboard (CALLERWHALE_STAFF_MFA, default true).
    /// Turn it off only while the Firebase project has no authenticator codes (Identity Platform) set up.
    pub staff_mfa: bool,
    /// The public website people are invited to (links in invitation emails), e.g. https://callerwhale.com.
    pub website_url: String,
    /// The mail server invitations go out through (STARTTLS on 587, TLS on 465). Empty host: no email is sent, and the
    /// dashboard says so.
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    /// The sender, as "Name <address>". The mail server lets a login send only as its own address.
    pub mail_from: String,
    /// `owner/repo` whose GitHub releases hold the desktop installer. Empty: no download yet.
    pub release_repo: String,
    /// Only releases whose tag starts with this are the desktop app's (the repository releases other things too).
    pub release_tag_prefix: String,
    /// A GitHub token that can read the releases, for a private repository. Empty: public releases only.
    pub github_token: String,
}

impl Config {
    /// The config the website's Firebase SDK starts with, or None when the pages should use the auth service.
    pub fn firebase_web(&self) -> Option<serde_json::Value> {
        if self.firebase_project.is_empty() || self.firebase_api_key.is_empty() {
            return None;
        }
        Some(serde_json::json!({
            "apiKey": self.firebase_api_key,
            "authDomain": self.firebase_auth_domain,
            "projectId": self.firebase_project,
            "appId": self.firebase_app_id,
            "providers": self.firebase_providers,
        }))
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_string());
        let worker_tokens = var("CALLERWHALE_WORKER_TOKENS", "")
            .split(',')
            .filter_map(|pair| pair.split_once('='))
            .map(|(name, token)| (name.trim().to_string(), token.trim().to_string()))
            .filter(|(_, token)| token.len() >= 24)
            .collect();
        Ok(Config {
            database_url: std::env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            migration_database_url: var("MIGRATION_DATABASE_URL", ""),
            redis_url: var("REDIS_URL", ""),
            bind: var("CALLERWHALE_BIND", "127.0.0.1:8088"),
            allowed_origins: var("CALLERWHALE_ALLOWED_ORIGINS", "").split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
            worker_tokens,
            artifact_dir: var("CALLERWHALE_ARTIFACT_DIR", "artifacts"),
            max_body_bytes: var("CALLERWHALE_MAX_BODY_BYTES", "26214400").parse().context("CALLERWHALE_MAX_BODY_BYTES")?,
            public_signup: var("CALLERWHALE_PUBLIC_SIGNUP", "false") == "true",
            billing_webhook_secret: var("CALLERWHALE_BILLING_WEBHOOK_SECRET", ""),
            checkout_url: var("CALLERWHALE_CHECKOUT_URL", ""),
            site_dir: var("CALLERWHALE_SITE_DIR", ""),
            require_mfa: var("CALLERWHALE_REQUIRE_MFA", "false") == "true",
            auth_jwks: var("CALLERWHALE_AUTH_JWKS", ""),
            auth_jwks_url: var("CALLERWHALE_AUTH_JWKS_URL", ""),
            firebase_project: var("CALLERWHALE_FIREBASE_PROJECT", "").trim().to_string(),
            firebase_jwks: var("CALLERWHALE_FIREBASE_JWKS", ""),
            firebase_jwks_url: var("CALLERWHALE_FIREBASE_JWKS_URL", callerwhale_auth_verify::FIREBASE_JWKS_URL),
            firebase_api_key: var("CALLERWHALE_FIREBASE_API_KEY", "").trim().to_string(),
            firebase_auth_domain: match var("CALLERWHALE_FIREBASE_AUTH_DOMAIN", "").trim() {
                "" => format!("{}.firebaseapp.com", var("CALLERWHALE_FIREBASE_PROJECT", "").trim()),
                given => given.to_string(),
            },
            firebase_app_id: var("CALLERWHALE_FIREBASE_APP_ID", "").trim().to_string(),
            grafana_url: var("CALLERWHALE_GRAFANA_URL", "").trim().trim_end_matches('/').to_string(),
            firebase_providers: var("CALLERWHALE_FIREBASE_PROVIDERS", "google").split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect(),
            auth_public_url: var("CALLERWHALE_AUTH_PUBLIC_URL", "http://localhost:8101").trim_end_matches('/').to_string(),
            staff_mfa: var("CALLERWHALE_STAFF_MFA", "true") != "false",
            website_url: var("CALLERWHALE_WEBSITE_URL", "http://localhost:5200").trim().trim_end_matches('/').to_string(),
            smtp_host: var("CALLERWHALE_SMTP_HOST", "").trim().to_string(),
            smtp_port: var("CALLERWHALE_SMTP_PORT", "587").trim().parse().context("CALLERWHALE_SMTP_PORT")?,
            smtp_user: var("CALLERWHALE_SMTP_USER", "").trim().to_string(),
            smtp_password: var("CALLERWHALE_SMTP_PASSWORD", ""),
            mail_from: var("CALLERWHALE_MAIL_FROM", "Caller Whale <no-reply@softfix.dev>").trim().to_string(),
            release_repo: var("CALLERWHALE_RELEASE_REPO", "").trim().to_string(),
            release_tag_prefix: var("CALLERWHALE_RELEASE_TAG_PREFIX", "crm-v").trim().to_string(),
            github_token: var("CALLERWHALE_GITHUB_TOKEN", "").trim().to_string(),
        })
    }
}
