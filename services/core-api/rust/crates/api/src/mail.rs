//! Email this server sends itself: invitations to the desktop app. It goes through Caller Whale's mail server (the Mail-Server
//! repository: smtp.softfix.dev, a login per sender address), with STARTTLS on 587 or TLS on 465, never in the clear.

use crate::config::Config;
use anyhow::Context;
use lettre::{
    message::{header::ContentType, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};

pub struct Mail {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// Whether the server has a mail server to send through.
pub fn configured(config: &Config) -> bool {
    !config.smtp_host.is_empty()
}

pub async fn send(config: &Config, mail: Mail) -> anyhow::Result<()> {
    anyhow::ensure!(configured(config), "No mail server is set (TURF_SMTP_HOST)");
    let from: Mailbox = config.mail_from.parse().context("TURF_MAIL_FROM is not an address")?;
    let to: Mailbox = mail.to.parse().context("The recipient is not an address")?;
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(mail.subject)
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(mail.text))
                .singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(mail.html)),
        )?;
    let builder = if config.smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_host)?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)?
    };
    let mut builder = builder.port(config.smtp_port).timeout(Some(std::time::Duration::from_secs(20)));
    if !config.smtp_user.is_empty() {
        builder = builder.credentials(Credentials::new(config.smtp_user.clone(), config.smtp_password.clone()));
    }
    builder.build().send(message).await.context("The mail server refused the message")?;
    Ok(())
}

/// Escapes text for the HTML part of an email.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// The invitation to use the desktop app: who invited them, how many credits a month, and where to sign in.
pub fn invitation(config: &Config, to: &str, name: &str, inviter: &str, monthly_credits: i64) -> Mail {
    let link = format!("{}/signup", config.website_url);
    let greeting = if name.trim().is_empty() { "Hello,".to_string() } else { format!("Hello {},", name.trim()) };
    let credits = format_number(monthly_credits);
    let text = format!(
        "{greeting}\n\n{inviter} has invited you to Caller Whale, the desktop app for your lists, Skip Tracing and calls.\n\n\
         Your account comes with {credits} credits a month.\n\n\
         1. Create your account at {link} with this email address ({to}), or sign in with Google if it is a Google account.\n\
         2. Open your dashboard and download the desktop app.\n\
         3. Sign in to the app with the same account.\n\n\
         Only this email address can use the invitation.\n\n— Caller Whale"
    );
    let html = format!(
        "<div style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px\">\
         <p>{greeting}</p>\
         <p><strong>{inviter}</strong> has invited you to Caller Whale, the desktop app for your lists, Skip Tracing and calls.</p>\
         <p>Your account comes with <strong>{credits} credits a month</strong>.</p>\
         <ol><li>Create your account with this email address ({to}), or sign in with Google if it is a Google account.</li>\
         <li>Open your dashboard and download the desktop app.</li><li>Sign in to the app with the same account.</li></ol>\
         <p><a href=\"{link}\" style=\"display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none\">Accept the invitation</a></p>\
         <p style=\"color:#666;font-size:13px\">Only this email address can use the invitation.</p></div>",
        greeting = escape(&greeting),
        inviter = escape(inviter),
        to = escape(to),
        link = escape(&link),
    );
    Mail { to: to.to_string(), subject: format!("{inviter} invited you to Caller Whale"), text, html }
}

/// 12500 as "12,500".
pub fn format_number(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if value < 0 {
        format!("-{out}")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_get_thousands_separators() {
        assert_eq!(format_number(0), "0");
        assert_eq!(format_number(999), "999");
        assert_eq!(format_number(12500), "12,500");
        assert_eq!(format_number(1000000), "1,000,000");
    }

    #[test]
    fn names_in_the_html_part_are_escaped() {
        assert_eq!(escape("<b>\"Al\" & co</b>"), "&lt;b&gt;&quot;Al&quot; &amp; co&lt;/b&gt;");
    }
}
