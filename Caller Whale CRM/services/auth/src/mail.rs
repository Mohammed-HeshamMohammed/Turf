//! Email this service asks for: the six-digit codes of the second step. It never talks to a mail server and holds no mail
//! login or template: it asks the notification service (POST /v1/mail with this service's token), which sends the message.
//! A trait, so tests catch what would be sent instead of sending it.

use anyhow::Context;

#[async_trait::async_trait]
pub trait Mailer: Send + Sync + std::fmt::Debug {
    /// Asks for the sign-in code to be emailed to this address.
    async fn send_code(&self, to: &str, code: &str) -> anyhow::Result<()>;
}

#[derive(Debug, Clone)]
pub struct Notify {
    /// The notification service's address (AUTH_NOTIFY_URL).
    pub url: String,
    /// This service's token there (AUTH_NOTIFY_TOKEN).
    pub token: String,
    client: reqwest::Client,
}

impl Notify {
    pub fn new(url: &str, token: &str) -> Self {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
        Self { url: url.trim().trim_end_matches('/').to_string(), token: token.trim().to_string(), client }
    }
}

#[async_trait::async_trait]
impl Mailer for Notify {
    async fn send_code(&self, to: &str, code: &str) -> anyhow::Result<()> {
        let res = self
            .client
            .post(format!("{}/v1/mail", self.url))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "template": "mfa_code", "to": to, "data": { "code": code } }))
            .send()
            .await
            .context("The notification service could not be reached")?;
        anyhow::ensure!(res.status().is_success(), "The notification service refused the message ({})", res.status());
        Ok(())
    }
}
