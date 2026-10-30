//! Email this service sends itself: the six-digit codes of the second step. Through Caller Whale's mail server (STARTTLS on
//! 587 or TLS on 465, never in the clear). A trait, so tests catch what would be sent instead of sending it.

use anyhow::Context;
use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};

#[async_trait::async_trait]
pub trait Mailer: Send + Sync + std::fmt::Debug {
    async fn send(&self, to: &str, subject: &str, text: &str) -> anyhow::Result<()>;
}

#[derive(Debug, Clone)]
pub struct Smtp {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub from: String,
}

#[async_trait::async_trait]
impl Mailer for Smtp {
    async fn send(&self, to: &str, subject: &str, text: &str) -> anyhow::Result<()> {
        let from: Mailbox = self.from.parse().context("AUTH_MAIL_FROM is not an address")?;
        let to: Mailbox = to.parse().context("The recipient is not an address")?;
        let message = Message::builder().from(from).to(to).subject(subject).header(ContentType::TEXT_PLAIN).body(text.to_string())?;
        let builder = if self.port == 465 { AsyncSmtpTransport::<Tokio1Executor>::relay(&self.host)? } else { AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.host)? };
        let mut builder = builder.port(self.port).timeout(Some(std::time::Duration::from_secs(20)));
        if !self.user.is_empty() {
            builder = builder.credentials(Credentials::new(self.user.clone(), self.password.clone()));
        }
        builder.build().send(message).await.context("The mail server refused the message")?;
        Ok(())
    }
}
