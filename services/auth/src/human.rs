//! Optional server-side Cloudflare Turnstile verification. Never accepts a client IP hint.
use crate::{config::Config, error::{AuthError, AuthResult}};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct HumanCheck {
    pub site_key: String,
    secret_key: String,
    hostnames: Vec<String>,
    client: reqwest::Client,
}

impl std::fmt::Debug for HumanCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HumanCheck").field("site_key", &self.site_key).field("hostnames", &self.hostnames).finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct Verification {
    success: bool,
    action: Option<String>,
    hostname: Option<String>,
}

impl HumanCheck {
    pub fn new(site_key: &str, secret_key: &str, hostnames: Vec<String>) -> anyhow::Result<Self> {
        anyhow::ensure!(!site_key.trim().is_empty() && !secret_key.trim().is_empty(), "Bot protection requires AUTH_TURNSTILE_SITE_KEY and AUTH_TURNSTILE_SECRET_KEY");
        anyhow::ensure!(!hostnames.is_empty(), "Bot protection requires an allowed hostname");
        Ok(Self {
            site_key: site_key.trim().into(), secret_key: secret_key.trim().into(),
            hostnames: hostnames.into_iter().map(|h| h.to_ascii_lowercase()).collect(),
            client: reqwest::Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build()?,
        })
    }

    pub async fn verify(&self, token: &str, action: &str) -> AuthResult<()> {
        self.verify_at(Some(token), action, "https://challenges.cloudflare.com/turnstile/v0/siteverify").await
    }

    async fn verify_at(&self, token: Option<&str>, action: &str, endpoint: &str) -> AuthResult<()> {
        let token = token.filter(|t| !t.trim().is_empty() && t.len() <= 2048).ok_or(AuthError::HumanRequired)?;
        // No remoteip: forwarded headers and body IP addresses are not trusted.
        let response = self.client.post(endpoint).json(&json!({"secret": self.secret_key, "response": token}))
            .send().await.map_err(|_| AuthError::HumanRequired)?;
        if !response.status().is_success() { return Err(AuthError::HumanRequired); }
        let result: Verification = response.json().await.map_err(|_| AuthError::HumanRequired)?;
        if !result.success || result.action.as_deref() != Some(action)
            || !result.hostname.as_ref().is_some_and(|h| self.hostnames.contains(&h.to_ascii_lowercase())) {
            return Err(AuthError::HumanRequired);
        }
        Ok(())
    }
}

pub async fn guard(config: &Config, token: Option<&str>, action: &str) -> AuthResult<()> {
    if let Some(check) = &config.human { check.verify(token.unwrap_or_default(), action).await?; }
    Ok(())
}

pub async fn security(axum::extract::State(state): axum::extract::State<crate::AppState>) -> axum::Json<Value> {
    axum::Json(json!({
        "bot_protection": {"enabled": state.config.human.is_some(), "site_key": state.config.human.as_ref().map(|h| h.site_key.as_str()).unwrap_or_default()},
        "password_policy": {"minimum":8,"maximum":4096,"uppercase":true,"lowercase":true,"number":true,"special":true}
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn siteverify_checks_every_response_and_binding() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = axum::Router::new().route("/", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let count = count.clone();
            async move {
                assert!(body.get("remoteip").is_none());
                assert_eq!(body["secret"], "secret");
                count.fetch_add(1, Ordering::SeqCst);
                let token = body["response"].as_str().unwrap();
                axum::Json(json!({"success":token != "failed", "action":if token == "action" {"signin"} else {"signup"}, "hostname":if token == "host" {"evil.example"} else {"app.example"}}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let check = HumanCheck::new("site", "secret", vec!["app.example".into()]).unwrap();
        for token in [None, Some(""), Some("   "), Some("x".repeat(2049).as_str())] {
            assert!(check.verify_at(token, "signup", &url).await.is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        for token in ["failed", "action", "host"] { assert!(check.verify_at(Some(token), "signup", &url).await.is_err()); }
        for _ in 0..2 { check.verify_at(Some("good"), "signup", &url).await.unwrap(); }
        assert_eq!(calls.load(Ordering::SeqCst), 5); // Even repeated tokens go to Cloudflare, which rejects replay.
        task.abort();
    }
}
