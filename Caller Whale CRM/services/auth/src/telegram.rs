//! Telegram, for the second step: a bot that sends a six-digit code to a chat the person linked. The bot is optional: with no
//! token this service does not offer Telegram. A person links their chat by opening a one-time link, `t.me/<bot>?start=<code>`,
//! and Telegram then tells `/v1/mfa/telegram/webhook/<secret>` which chat sent it.

use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Telegram {
    token: String,
    pub bot: String,
    /// `https://api.telegram.org` (a stand-in in tests).
    base: String,
    http: reqwest::Client,
}

impl Telegram {
    pub fn new(token: &str, bot: &str, base: &str) -> Self {
        Telegram { token: token.to_string(), bot: bot.trim_start_matches('@').to_string(), base: base.trim_end_matches('/').to_string(), http: reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default() }
    }

    pub async fn send(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let res = self.http.post(format!("{}/bot{}/sendMessage", self.base, self.token)).json(&json!({ "chat_id": chat_id, "text": text })).send().await?;
        anyhow::ensure!(res.status().is_success(), "Telegram answered {}", res.status());
        Ok(())
    }

    /// The chat and the text of an update Telegram posted to the webhook, when it is a plain message.
    pub fn message_of(update: &Value) -> Option<(String, String)> {
        let message = update.get("message")?;
        let chat = message["chat"]["id"].as_i64()?;
        Some((chat.to_string(), message["text"].as_str()?.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_message_gives_its_chat_and_text() {
        let update = json!({ "update_id": 1, "message": { "chat": { "id": 42 }, "text": "/start abc" } });
        assert_eq!(Telegram::message_of(&update), Some(("42".into(), "/start abc".into())));
        assert_eq!(Telegram::message_of(&json!({ "edited_message": {} })), None);
    }
}
