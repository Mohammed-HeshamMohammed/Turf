//! Email this server asks for: invitations to the desktop app. It never talks to a mail server: the notification service sends
//! them (it holds the mail login and the wording).

use crate::config::Config;
use anyhow::Context;

/// Whether the server knows the notification service and has its token there (neither is written in the code).
pub fn configured(config: &Config) -> bool {
    !config.notify_url.is_empty() && !config.notify_token.is_empty()
}

/// Asks the notification service to email the invitation to the desktop app: who invited them, how many credits a month, and
/// where to sign up. The service owns the mail server login and the wording; this only says what to send and to whom.
pub async fn send_invitation(config: &Config, to: &str, name: &str, inviter: &str, monthly_credits: i64) -> anyhow::Result<()> {
    anyhow::ensure!(configured(config), "The notification service is not set (CALLERWHALE_NOTIFY_URL and CALLERWHALE_NOTIFY_TOKEN)");
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
    let res = client
        .post(format!("{}/v1/mail", config.notify_url))
        .bearer_auth(&config.notify_token)
        .json(&serde_json::json!({
            "template": "invitation",
            "to": to,
            "data": { "name": name, "inviter": inviter, "monthly_credits": monthly_credits, "link": format!("{}/signup", config.website_url) },
        }))
        .send()
        .await
        .context("The notification service could not be reached")?;
    anyhow::ensure!(res.status().is_success(), "The notification service refused the message ({})", res.status());
    Ok(())
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

}
