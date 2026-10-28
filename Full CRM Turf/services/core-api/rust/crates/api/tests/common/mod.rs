//! Test harness: runs the API in-process against a real PostgreSQL (plan 5.1: mocked storage does not establish SQL
//! correctness). Needs TEST_DATABASE_URL (the turf_api login) and TEST_MIGRATION_DATABASE_URL (the owner); see
//! services/core-api/scripts/dev-services.sh. Tests share one database, so they take a lock and start from empty tables.
//!
//! People sign in with the auth service, never with this API, so the harness plays auth's part: it holds a signing
//! key, gives the API its public half, and signs access tokens for the people a test needs.

#![allow(dead_code)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};
use turf_api::config::Config;
use turf_auth_verify::{Claims, AUDIENCE, ISSUER};
use uuid::Uuid;

static LOCK: Mutex<()> = Mutex::new(());
pub const WORKER: &str = "test-worker-token-0123456789abcdef";
pub const WEBHOOK_SECRET: &str = "test-webhook-secret-0123456789abcdef";
/// The Firebase project the API trusts in tests, and the throwaway key pair its ID tokens are signed with.
pub const FIREBASE_PROJECT: &str = "turf-test";
const FIREBASE_PEM: &str = include_str!("../../../../../../auth/verify/testdata/firebase-test-key.pem");
const FIREBASE_JWKS: &str = include_str!("../../../../../../auth/verify/testdata/firebase-test-jwks.json");

/// A Firebase ID token as Firebase would sign it. `totp`: they confirmed an authenticator code at sign-in.
pub fn firebase_token(uid: &str, email: &str, name: Option<&str>, totp: bool, email_verified: bool) -> String {
    firebase_token_via("password", uid, email, name, totp, email_verified)
}

/// The same, signed in with `provider` as Firebase names it ("google.com", "apple.com", "password").
pub fn firebase_token_via(provider: &str, uid: &str, email: &str, name: Option<&str>, totp: bool, email_verified: bool) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let mut detail = json!({ "sign_in_provider": provider });
    if totp {
        detail["sign_in_second_factor"] = "totp".into();
    }
    let mut claims = json!({
        "iss": format!("https://securetoken.google.com/{FIREBASE_PROJECT}"), "aud": FIREBASE_PROJECT, "sub": uid, "email": email,
        "email_verified": email_verified, "auth_time": now - 5, "iat": now - 5, "exp": now + 3600, "firebase": detail,
    });
    if let Some(name) = name {
        claims["name"] = name.into();
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("firebase-test".into());
    encode(&header, &claims, &EncodingKey::from_rsa_pem(FIREBASE_PEM.as_bytes()).unwrap()).unwrap()
}

/// A signing key as the auth service holds one, and the public key set it publishes.
pub struct AuthKey {
    pkcs8: Vec<u8>,
    pub jwks: String,
}

pub fn auth_key() -> AuthKey {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap().as_ref().to_vec();
    let public = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap().public_key().as_ref().to_vec();
    let jwks = json!({ "keys": [{ "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": "test", "x": URL_SAFE_NO_PAD.encode(public) }] });
    AuthKey { pkcs8, jwks: jwks.to_string() }
}

impl AuthKey {
    /// An access token as the auth service would sign it.
    pub fn sign(&self, sub: &str, email: &str, name: &str, mfa: bool, email_verified: bool) -> String {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let claims = Claims { sub: sub.into(), email: email.into(), name: name.into(), sid: "s-1".into(), mfa, email_verified, provider: "password".into(), iss: ISSUER.into(), aud: AUDIENCE.into(), iat: now, exp: now + 600 };
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some("test".into());
        encode(&header, &claims, &EncodingKey::from_ed_der(&self.pkcs8)).unwrap()
    }
}

pub struct Harness {
    pub base: String,
    pub owner: sqlx::PgPool,
    pub key: Arc<AuthKey>,
    _guard: MutexGuard<'static, ()>,
}

pub fn config(redis: bool) -> Option<Config> {
    let database_url = std::env::var("TEST_DATABASE_URL").ok()?;
    Some(Config {
        database_url,
        migration_database_url: std::env::var("TEST_MIGRATION_DATABASE_URL").ok()?,
        redis_url: if redis { std::env::var("TEST_REDIS_URL").unwrap_or_default() } else { String::new() },
        bind: "127.0.0.1:0".into(),
        allowed_origins: vec![],
        worker_tokens: vec![("tests".into(), WORKER.into())],
        artifact_dir: std::env::temp_dir().join("turf-test-artifacts").to_string_lossy().into_owned(),
        max_body_bytes: 10 * 1024 * 1024,
        public_signup: true,
        billing_webhook_secret: WEBHOOK_SECRET.into(),
        checkout_url: "https://pay.example/checkout".into(),
        site_dir: String::new(),
        require_mfa: true,
        auth_jwks: String::new(),
        auth_jwks_url: String::new(),
        auth_public_url: "http://auth.example".into(),
        firebase_project: String::new(),
        firebase_jwks: String::new(),
        firebase_jwks_url: String::new(),
        firebase_api_key: String::new(),
        firebase_auth_domain: String::new(),
        firebase_app_id: String::new(),
        firebase_providers: vec![],
    })
}

/// None (and the test returns early, saying so) when no test database is configured.
pub async fn start() -> Option<Harness> {
    start_with(true).await
}

pub async fn start_with(redis: bool) -> Option<Harness> {
    start_configured(redis, true, true).await
}

/// A server that does not require MFA (the current default: TURF_REQUIRE_MFA unset).
pub async fn start_without_mfa() -> Option<Harness> {
    start_configured(true, false, true).await
}

/// A server where new sign-ups cannot open a workspace themselves (the default: TURF_PUBLIC_SIGNUP unset).
pub async fn start_closed() -> Option<Harness> {
    start_configured(true, true, false).await
}

async fn start_configured(redis: bool, require_mfa: bool, public_signup: bool) -> Option<Harness> {
    let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(mut config) = config(redis) else {
        eprintln!("TEST_DATABASE_URL is not set; skipping");
        return None;
    };
    let key = Arc::new(auth_key());
    config.require_mfa = require_mfa;
    config.public_signup = public_signup;
    config.auth_jwks = key.jwks.clone();
    config.firebase_project = FIREBASE_PROJECT.into();
    config.firebase_jwks = FIREBASE_JWKS.into();
    turf_api::db::migrate(&config).await.expect("migrations");
    let owner = sqlx::PgPool::connect(&config.migration_database_url).await.expect("owner connection");
    let tables: Vec<String> = sqlx::query_scalar("SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_sqlx_migrations', 'plans')")
        .fetch_all(&owner)
        .await
        .unwrap();
    sqlx::query(&format!("TRUNCATE {} RESTART IDENTITY CASCADE", tables.join(", "))).execute(&owner).await.unwrap();
    let state = turf_api::state(config).await.expect("state");
    turf_api::events::spawn_listener(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, turf_api::app(state)).await.unwrap() });
    Some(Harness { base, owner, key, _guard: guard })
}

impl Harness {
    /// Someone signed in with auth (a new account there), with no organization chosen yet.
    pub fn client(&self, email: &str, name: &str, mfa: bool, verified: bool) -> Client {
        Client::signed_in(&self.base, self.key.clone(), &Uuid::new_v4().to_string(), email, name, mfa, verified)
    }

    /// Someone signed in with Firebase: their token carries a Firebase uid, not an id of this server.
    pub fn firebase_client(&self, uid: &str, email: &str, name: Option<&str>, totp: bool, verified: bool) -> Client {
        Client {
            http: reqwest::Client::new(),
            base: self.base.clone(),
            id: String::new(),
            email: email.into(),
            name: name.unwrap_or_default().into(),
            key: None,
            token: Mutex::new(Some(firebase_token(uid, email, name, totp, verified))),
            org: Mutex::new(None),
        }
    }

    /// A request with no token at all.
    pub fn anonymous(&self) -> Client {
        Client { http: reqwest::Client::new(), base: self.base.clone(), id: String::new(), email: String::new(), name: String::new(), key: None, token: Mutex::new(None), org: Mutex::new(None) }
    }

    pub fn token(&self, sub: &str, email: &str, name: &str, mfa: bool, verified: bool) -> String {
        self.key.sign(sub, email, name, mfa, verified)
    }
}

/// A person talking to the API: their auth access token and the organization they act in (x-turf-org).
pub struct Client {
    pub http: reqwest::Client,
    pub base: String,
    pub id: String,
    pub email: String,
    pub name: String,
    key: Option<Arc<AuthKey>>,
    token: Mutex<Option<String>>,
    org: Mutex<Option<String>>,
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
    fn signed_in(base: &str, key: Arc<AuthKey>, id: &str, email: &str, name: &str, mfa: bool, verified: bool) -> Client {
        let token = key.sign(id, email, name, mfa, verified);
        Client {
            http: reqwest::Client::new(),
            base: base.into(),
            id: id.into(),
            email: email.into(),
            name: name.into(),
            key: Some(key),
            token: Mutex::new(Some(token)),
            org: Mutex::new(None),
        }
    }

    /// The same person, signed in again: auth issues a new token, saying whether they passed two-step sign-in and
    /// confirmed their email.
    pub fn reissue(&self, mfa: bool, verified: bool) {
        let key = self.key.as_ref().expect("a signed-in client");
        *self.token.lock().unwrap() = Some(key.sign(&self.id, &self.email, &self.name, mfa, verified));
    }

    pub fn set_org(&self, org: &str) {
        *self.org.lock().unwrap() = Some(org.to_string());
    }

    pub fn clear_org(&self) {
        *self.org.lock().unwrap() = None;
    }

    pub fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    fn with_auth(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut request = request;
        if let Some(token) = self.token() {
            request = request.bearer_auth(token);
        }
        if let Some(org) = self.org.lock().unwrap().clone() {
            request = request.header("x-turf-org", org);
        }
        request
    }

    async fn reply(response: reqwest::Response) -> Reply {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Reply { status, body: serde_json::from_str(&text).unwrap_or(if text.is_empty() { Value::Null } else { Value::String(text) }) }
    }

    pub async fn post(&self, path: &str, body: Value) -> Reply {
        Self::reply(self.with_auth(self.http.post(format!("{}{path}", self.base))).json(&body).send().await.unwrap()).await
    }

    pub async fn put(&self, path: &str, body: Value) -> Reply {
        Self::reply(self.with_auth(self.http.put(format!("{}{path}", self.base))).json(&body).send().await.unwrap()).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> Reply {
        Self::reply(self.with_auth(self.http.patch(format!("{}{path}", self.base))).json(&body).send().await.unwrap()).await
    }

    pub async fn get(&self, path: &str) -> Reply {
        Self::reply(self.with_auth(self.http.get(format!("{}{path}", self.base))).send().await.unwrap()).await
    }

    pub async fn op(&self, kind: &str, payload: Value) -> Value {
        self.post("/api/v1/ops", json!({ "id": Uuid::new_v4(), "kind": kind, "payload": payload })).await.ok()
    }

    pub async fn worker(&self, path: &str, body: Value) -> Reply {
        let response = self.http.post(format!("{}/internal{path}", self.base)).header("authorization", format!("Worker {WORKER}")).json(&body).send().await.unwrap();
        Self::reply(response).await
    }
}

/// A fresh organization whose owner has passed MFA, plus people in each role. Returns (owner, people by role, ids).
pub struct World {
    pub owner: Client,
    pub org: String,
    pub team: String,
    pub people: std::collections::HashMap<String, (Client, String)>,
}

pub async fn world(h: &Harness) -> World {
    let owner = h.client("owner@example.com", "Jordan Ellis", true, true);
    let boot = owner.post("/api/v1/auth/bootstrap", json!({ "organization": "Oak & Palm" })).await.ok();
    let org = boot["organization_id"].as_str().unwrap().to_string();
    owner.set_org(&org);
    let teams = owner.get("/api/v1/admin/teams").await.ok();
    let team = teams[0]["id"].as_str().unwrap().to_string();
    let mut people = std::collections::HashMap::new();
    for (role, name) in [("caller", "Maya Chen"), ("closer", "Alex Rivera"), ("manager", "Lena Brooks"), ("client", "Taylor Reed"), ("researcher", "Ben Carter")] {
        let email = format!("{role}@example.com");
        let invite = owner.post("/api/v1/admin/members", json!({ "email": email, "roles": [role], "team_ids": [team] })).await.ok();
        let client = h.client(&email, name, false, true);
        client.post("/api/v1/invitations/join", json!({ "token": invite["token"] })).await.ok();
        client.set_org(&org);
        let id = client.id.clone();
        people.insert(role.to_string(), (client, id));
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
