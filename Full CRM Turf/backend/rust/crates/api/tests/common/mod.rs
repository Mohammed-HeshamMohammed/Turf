//! Test harness: runs the API in-process against a real PostgreSQL (plan 5.1: mocked storage does not establish SQL
//! correctness). Needs TEST_DATABASE_URL (the turf_api login) and TEST_MIGRATION_DATABASE_URL (the owner); see
//! backend/scripts/dev-services.sh. Tests share one database, so they take a lock and start from empty tables.

#![allow(dead_code)]

pub mod keys;
pub mod provider;

use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use turf_api::config::Config;
use uuid::Uuid;

static LOCK: Mutex<()> = Mutex::new(());
pub const WORKER: &str = "test-worker-token-0123456789abcdef";
pub const WEBHOOK_SECRET: &str = "test-webhook-secret-0123456789abcdef";

pub struct Harness {
    pub base: String,
    /// The fake Google/Apple both sign-ins use in tests (see provider.rs).
    pub provider: String,
    pub owner: sqlx::PgPool,
    _guard: MutexGuard<'static, ()>,
}

pub fn config(redis: bool) -> Option<Config> {
    config_for(redis, "http://127.0.0.1:9", "http://127.0.0.1:9")
}

pub fn config_for(redis: bool, base: &str, provider: &str) -> Option<Config> {
    let endpoints = |client: &str| turf_api::config::OauthProvider {
        client_id: client.into(),
        auth_url: format!("{provider}/authorize"),
        token_url: format!("{provider}/token"),
        jwks_url: format!("{provider}/jwks"),
        issuer: provider.into(),
        ..Default::default()
    };
    let database_url = std::env::var("TEST_DATABASE_URL").ok()?;
    Some(Config {
        database_url,
        migration_database_url: std::env::var("TEST_MIGRATION_DATABASE_URL").ok()?,
        redis_url: if redis { std::env::var("TEST_REDIS_URL").unwrap_or_default() } else { String::new() },
        bind: "127.0.0.1:0".into(),
        secure_cookies: false,
        allowed_origins: vec![],
        worker_tokens: vec![("tests".into(), WORKER.into())],
        artifact_dir: std::env::temp_dir().join("turf-test-artifacts").to_string_lossy().into_owned(),
        session_hours: 24,
        max_body_bytes: 10 * 1024 * 1024,
        public_signup: true,
        billing_webhook_secret: WEBHOOK_SECRET.into(),
        checkout_url: "https://pay.example/checkout".into(),
        dev_tokens: true,
        site_dir: String::new(),
        require_mfa: true,
        public_url: base.into(),
        app_url: "http://app.example".into(),
        google: turf_api::config::OauthProvider { client_secret: "google-test-secret".into(), ..endpoints("google-test-client") },
        apple: turf_api::config::OauthProvider {
            team_id: "TEAMTEST01".into(),
            key_id: "KEYTEST001".into(),
            private_key: keys::EC_PRIVATE_PEM.into(),
            ..endpoints("apple-test-client")
        },
    })
}

/// None (and the test returns early, saying so) when no test database is configured.
pub async fn start() -> Option<Harness> {
    start_with(true).await
}

pub async fn start_with(redis: bool) -> Option<Harness> {
    start_configured(redis, true).await
}

/// A server that does not require MFA (the current default: TURF_REQUIRE_MFA unset).
pub async fn start_without_mfa() -> Option<Harness> {
    start_configured(true, false).await
}

async fn start_configured(redis: bool, require_mfa: bool) -> Option<Harness> {
    let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The API's own address must be known before it starts: provider sign-ins return to it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let provider = provider::start().await;
    let Some(mut config) = config_for(redis, &base, &provider) else {
        eprintln!("TEST_DATABASE_URL is not set; skipping");
        return None;
    };
    config.require_mfa = require_mfa;
    turf_api::db::migrate(&config).await.expect("migrations");
    let owner = sqlx::PgPool::connect(&config.migration_database_url).await.expect("owner connection");
    let tables: Vec<String> = sqlx::query_scalar("SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_sqlx_migrations', 'plans')")
        .fetch_all(&owner)
        .await
        .unwrap();
    sqlx::query(&format!("TRUNCATE {} RESTART IDENTITY CASCADE", tables.join(", "))).execute(&owner).await.unwrap();
    let state = turf_api::state(config).await.expect("state");
    turf_api::events::spawn_listener(state.clone());
    tokio::spawn(async move { axum::serve(listener, turf_api::app(state)).await.unwrap() });
    Some(Harness { base, provider, owner, _guard: guard })
}

pub struct Client {
    pub http: reqwest::Client,
    pub base: String,
}

pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    pub fn ok(self) -> Value {
        assert!(self.status < 300, "expected success, got {}: {}", self.status, self.body);
        self.body
    }
}

impl Client {
    pub fn new(base: &str) -> Client {
        Client { http: reqwest::Client::builder().cookie_store(true).build().unwrap(), base: base.into() }
    }

    pub async fn post(&self, path: &str, body: Value) -> Reply {
        let response = self.http.post(format!("{}{path}", self.base)).header("x-turf-request", "1").json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        Reply { status, body: response.json().await.unwrap_or(Value::Null) }
    }

    pub async fn put(&self, path: &str, body: Value) -> Reply {
        let response = self.http.put(format!("{}{path}", self.base)).header("x-turf-request", "1").json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        Reply { status, body: response.json().await.unwrap_or(Value::Null) }
    }

    pub async fn patch(&self, path: &str, body: Value) -> Reply {
        let response = self.http.patch(format!("{}{path}", self.base)).header("x-turf-request", "1").json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        Reply { status, body: response.json().await.unwrap_or(Value::Null) }
    }

    pub async fn get(&self, path: &str) -> Reply {
        let response = self.http.get(format!("{}{path}", self.base)).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Reply { status, body: serde_json::from_str(&text).unwrap_or(Value::String(text)) }
    }

    pub async fn op(&self, kind: &str, payload: Value) -> Value {
        self.post("/api/v1/ops", json!({ "id": Uuid::new_v4(), "kind": kind, "payload": payload })).await.ok()
    }

    pub async fn worker(&self, path: &str, body: Value) -> Reply {
        let response = self.http.post(format!("{}/internal{path}", self.base)).header("authorization", format!("Worker {WORKER}")).json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        Reply { status, body: response.json().await.unwrap_or(Value::Null) }
    }
}

pub fn totp_now(secret: &str, email: &str) -> String {
    let bytes = totp_rs::Secret::Encoded(secret.to_string()).to_bytes().unwrap();
    totp_rs::TOTP::new(totp_rs::Algorithm::SHA1, 6, 1, 30, bytes, Some("Turf".into()), email.to_string()).unwrap().generate_current().unwrap()
}

pub const PASSWORD: &str = "correct horse battery";

/// A fresh organization whose owner has passed MFA, plus people in each role. Returns (owner, people by role, ids).
pub struct World {
    pub owner: Client,
    pub org: String,
    pub team: String,
    pub people: std::collections::HashMap<String, (Client, String)>,
}

pub async fn world(h: &Harness) -> World {
    let owner = Client::new(&h.base);
    let boot = owner
        .post("/api/v1/auth/bootstrap", json!({ "organization": "Oak & Palm", "email": "owner@example.com", "display_name": "Jordan Ellis", "password": PASSWORD }))
        .await
        .ok();
    let org = boot["organization_id"].as_str().unwrap().to_string();
    let setup = owner.post("/api/v1/auth/mfa/setup", json!({})).await.ok();
    let secret = setup["secret"].as_str().unwrap().to_string();
    owner.post("/api/v1/auth/mfa/confirm", json!({ "code": totp_now(&secret, "owner@example.com") })).await.ok();
    let teams = owner.get("/api/v1/admin/teams").await.ok();
    let team = teams[0]["id"].as_str().unwrap().to_string();
    let mut people = std::collections::HashMap::new();
    for (role, name) in [("caller", "Maya Chen"), ("closer", "Alex Rivera"), ("manager", "Lena Brooks"), ("client", "Taylor Reed"), ("researcher", "Ben Carter")] {
        let email = format!("{role}@example.com");
        let invite = owner.post("/api/v1/admin/members", json!({ "email": email, "roles": [role], "team_ids": [team] })).await.ok();
        let client = Client::new(&h.base);
        let joined = client
            .post("/api/v1/auth/invitations/accept", json!({ "token": invite["token"], "display_name": name, "password": PASSWORD }))
            .await
            .ok();
        people.insert(role.to_string(), (client, joined["user_id"].as_str().unwrap().to_string()));
    }
    World { owner, org, team, people }
}

impl World {
    pub fn client(&self, role: &str) -> &Client {
        &self.people[role].0
    }
    pub fn id(&self, role: &str) -> String {
        self.people[role].1.clone()
    }
}
