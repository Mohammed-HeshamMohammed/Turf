//! A fake Firebase (Identity Toolkit and Secure Token), enough for the auth service's Firebase mode: email and password,
//! an authenticator that accepts the code 123456, Google ID tokens, confirmation emails and refresh tokens. It counts
//! what it was asked, so a test can check that something was (or was not) sent to Firebase.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use axum::{extract::State, http::StatusCode, routing::post, Form, Json, Router};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub const GOOD_CODE: &str = "123456";

#[derive(Default, Clone)]
struct Account {
    uid: String,
    email: String,
    password: String,
    name: String,
    verified: bool,
    mfa: bool,
}

#[derive(Default)]
pub struct World {
    accounts: Vec<Account>,
    /// ID token -> uid, and refresh token -> uid.
    ids: HashMap<String, String>,
    refreshes: HashMap<String, String>,
    pub sent_verifications: Vec<String>,
    pub sent_resets: Vec<String>,
    pub calls: Vec<String>,
    counter: u32,
}

pub type Shared = Arc<Mutex<World>>;

pub struct Fake {
    pub base: String,
    pub world: Shared,
}

pub async fn start() -> Fake {
    let world: Shared = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/v1/accounts:signUp", post(sign_up))
        .route("/v1/accounts:signInWithPassword", post(sign_in))
        .route("/v1/accounts:signInWithIdp", post(sign_in_idp))
        .route("/v2/accounts/mfaSignIn:finalize", post(mfa_sign_in))
        .route("/v1/accounts:lookup", post(lookup))
        .route("/v1/accounts:update", post(update))
        .route("/v1/accounts:sendOobCode", post(send_oob))
        .route("/v1/accounts:resetPassword", post(reset_password))
        .route("/v2/accounts/mfaEnrollment:start", post(enroll_start))
        .route("/v2/accounts/mfaEnrollment:finalize", post(enroll_finalize))
        .route("/v1/token", post(token))
        .with_state(world.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fake { base, world }
}

type Reply = (StatusCode, Json<Value>);

fn refuse(message: &str) -> Reply {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": { "code": 400, "message": message } })))
}

fn ok(value: Value) -> Reply {
    (StatusCode::OK, Json(value))
}

impl World {
    fn tokens(&mut self, uid: &str) -> Value {
        self.counter += 1;
        let id = format!("id-{uid}-{}", self.counter);
        let refresh = format!("rt-{uid}-{}", self.counter);
        self.ids.insert(id.clone(), uid.to_string());
        self.refreshes.insert(refresh.clone(), uid.to_string());
        json!({ "idToken": id, "refreshToken": refresh, "localId": uid })
    }

    fn uid_of(&self, id_token: &str) -> Option<String> {
        self.ids.get(id_token).cloned()
    }

    fn account(&mut self, uid: &str) -> Option<&mut Account> {
        self.accounts.iter_mut().find(|a| a.uid == uid)
    }

    pub fn has_account(&self, email: &str) -> bool {
        self.accounts.iter().any(|a| a.email == email)
    }

    pub fn verified(&self, email: &str) -> bool {
        self.accounts.iter().any(|a| a.email == email && a.verified)
    }

    pub fn has_mfa(&self, email: &str) -> bool {
        self.accounts.iter().any(|a| a.email == email && a.mfa)
    }

    pub fn password_of(&self, email: &str) -> Option<String> {
        self.accounts.iter().find(|a| a.email == email).map(|a| a.password.clone())
    }

    pub fn verify_now(&mut self, email: &str) {
        if let Some(a) = self.accounts.iter_mut().find(|a| a.email == email) {
            a.verified = true;
        }
    }

    pub fn asked(&self, what: &str) -> usize {
        self.calls.iter().filter(|c| c.as_str() == what).count()
    }
}

fn text(body: &Value, key: &str) -> String {
    body[key].as_str().unwrap_or_default().to_string()
}

async fn sign_up(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("signUp".into());
    let email = text(&body, "email").to_lowercase();
    if w.has_account(&email) {
        return refuse("EMAIL_EXISTS");
    }
    let uid = format!("fb-{}", w.accounts.len() + 1);
    w.accounts.push(Account { uid: uid.clone(), email, password: text(&body, "password"), ..Default::default() });
    ok(w.tokens(&uid))
}

async fn sign_in(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("signInWithPassword".into());
    let email = text(&body, "email").to_lowercase();
    let account = w.accounts.iter().find(|a| a.email == email && a.password == text(&body, "password")).cloned();
    let Some(account) = account else { return refuse("INVALID_LOGIN_CREDENTIALS") };
    if account.mfa {
        return ok(json!({ "mfaPendingCredential": format!("pending-{}", account.uid), "mfaInfo": [{ "mfaEnrollmentId": "enroll-1", "totpInfo": {} }] }));
    }
    ok(w.tokens(&account.uid))
}

/// The Google ID token is a real JWT (the auth service passes along what Google gave it); only its claims are read here.
async fn sign_in_idp(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("signInWithIdp".into());
    let post_body = text(&body, "postBody");
    let encoded = reqwest::Url::parse(&format!("http://localhost?{post_body}")).unwrap();
    let fields: std::collections::HashMap<_, _> = encoded.query_pairs().into_owned().collect();
    let id_token = fields.get("id_token").cloned().unwrap_or_default();
    let provider = fields.get("providerId").map(String::as_str).unwrap_or_default();
    assert!(matches!(provider, "google.com" | "apple.com"));
    let claims = id_token.split('.').nth(1).and_then(|p| URL_SAFE_NO_PAD.decode(p).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(claims) = claims else { return refuse("INVALID_IDP_RESPONSE") };
    if provider == "apple.com" {
        use sha2::{Digest, Sha256};
        let raw_nonce = fields.get("nonce").expect("Apple requires a raw nonce");
        assert_eq!(text(&claims, "nonce"), hex::encode(Sha256::digest(raw_nonce.as_bytes())));
    }
    w.calls.push(provider.into());
    let email = text(&claims, "email");
    let name = text(&claims, "name");
    let email = email.to_lowercase();
    let existing = w.accounts.iter().find(|a| a.email == email).cloned();
    let account = match existing {
        Some(a) => a,
        None => {
            let uid = format!("fb-{}", w.accounts.len() + 1);
            let a = Account { uid: uid.clone(), email, name: name.into(), verified: true, ..Default::default() };
            w.accounts.push(a.clone());
            a
        }
    };
    if account.mfa {
        return ok(json!({ "mfaPendingCredential": format!("pending-{}", account.uid), "mfaInfo": [{ "mfaEnrollmentId": "enroll-1", "totpInfo": {} }] }));
    }
    ok(w.tokens(&account.uid))
}

async fn mfa_sign_in(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("mfaSignIn".into());
    let uid = text(&body, "mfaPendingCredential").strip_prefix("pending-").map(str::to_string);
    let Some(uid) = uid else { return refuse("INVALID_MFA_PENDING_CREDENTIAL") };
    if body["totpVerificationInfo"]["verificationCode"].as_str() != Some(GOOD_CODE) {
        return refuse("INVALID_CODE");
    }
    ok(w.tokens(&uid))
}

async fn lookup(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("lookup".into());
    let Some(uid) = w.uid_of(&text(&body, "idToken")) else { return refuse("INVALID_ID_TOKEN") };
    let a = w.account(&uid).cloned().unwrap();
    let mut user = json!({ "localId": a.uid, "email": a.email, "displayName": a.name, "emailVerified": a.verified });
    if a.mfa {
        user["mfaInfo"] = json!([{ "mfaEnrollmentId": "enroll-1" }]);
    }
    ok(json!({ "users": [user] }))
}

async fn update(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("update".into());
    if let Some(oob) = body["oobCode"].as_str() {
        let Some(email) = oob.strip_prefix("confirm-") else { return refuse("INVALID_OOB_CODE") };
        let email = email.to_string();
        if let Some(a) = w.accounts.iter_mut().find(|a| a.email == email) {
            a.verified = true;
        }
        return ok(json!({ "email": email }));
    }
    let Some(uid) = w.uid_of(&text(&body, "idToken")) else { return refuse("INVALID_ID_TOKEN") };
    let account = w.account(&uid).unwrap();
    if let Some(name) = body["displayName"].as_str() {
        account.name = name.into();
    }
    if let Some(password) = body["password"].as_str() {
        account.password = password.into();
    }
    ok(json!({ "localId": uid }))
}

async fn send_oob(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("sendOobCode".into());
    if body["requestType"] == "PASSWORD_RESET" {
        let email = text(&body, "email").to_lowercase();
        if !w.has_account(&email) {
            return refuse("EMAIL_NOT_FOUND");
        }
        w.sent_resets.push(email);
        return ok(json!({}));
    }
    let Some(uid) = w.uid_of(&text(&body, "idToken")) else { return refuse("INVALID_ID_TOKEN") };
    let email = w.account(&uid).unwrap().email.clone();
    w.sent_verifications.push(email);
    ok(json!({}))
}

async fn reset_password(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("resetPassword".into());
    let Some(email) = text(&body, "oobCode").strip_prefix("reset-").map(str::to_string) else { return refuse("INVALID_OOB_CODE") };
    let password = text(&body, "newPassword");
    match w.accounts.iter_mut().find(|a| a.email == email) {
        Some(a) => a.password = password,
        None => return refuse("INVALID_OOB_CODE"),
    }
    ok(json!({ "email": email }))
}

async fn enroll_start(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("mfaEnrollment:start".into());
    let Some(uid) = w.uid_of(&text(&body, "idToken")) else { return refuse("INVALID_ID_TOKEN") };
    ok(json!({ "totpSessionInfo": { "sharedSecretKey": "JBSWY3DPEHPK3PXP", "sessionInfo": format!("session-{uid}"), "periodSec": 30 } }))
}

async fn enroll_finalize(State(w): State<Shared>, Json(body): Json<Value>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("mfaEnrollment:finalize".into());
    let Some(uid) = w.uid_of(&text(&body, "idToken")) else { return refuse("INVALID_ID_TOKEN") };
    if body["totpVerificationInfo"]["verificationCode"].as_str() != Some(GOOD_CODE) {
        return refuse("INVALID_CODE");
    }
    w.account(&uid).unwrap().mfa = true;
    ok(w.tokens(&uid))
}

async fn token(State(w): State<Shared>, Form(form): Form<HashMap<String, String>>) -> Reply {
    let mut w = w.lock().unwrap();
    w.calls.push("token".into());
    let Some(uid) = form.get("refresh_token").and_then(|r| w.refreshes.get(r)).cloned() else { return refuse("INVALID_REFRESH_TOKEN") };
    let t = w.tokens(&uid);
    ok(json!({ "id_token": t["idToken"], "refresh_token": t["refreshToken"], "user_id": uid }))
}
