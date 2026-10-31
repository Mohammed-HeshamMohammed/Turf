//! Firebase Authentication as this service's account store, through Firebase's server API (Identity Toolkit).
//!
//! This service is the only part of Caller Whale that talks to Firebase. Passwords, email confirmation and authenticator
//! codes live in Firebase; this service calls it, keeps a row per person and per session, and hands every other part its
//! own signed tokens (`/.well-known/jwks.json`). The website, the desktop app, the gateway and the core API never see
//! Firebase: they sign in here and verify the tokens made here.
//!
//! Switched on by `AUTH_FIREBASE_API_KEY`. Without it the service keeps its own passwords and codes, as before.

use crate::error::AuthError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Firebase {
    api_key: String,
    /// Identity Toolkit, `https://identitytoolkit.googleapis.com` (a stand-in in tests).
    identity: String,
    /// Secure Token, `https://securetoken.googleapis.com`.
    token: String,
    http: reqwest::Client,
}

/// What a successful Firebase sign-in or sign-up hands back.
#[derive(Debug, Clone, Default)]
pub struct Login {
    pub id_token: String,
    pub refresh_token: String,
    pub uid: String,
}

/// What a session keeps of its Firebase sign-in: the refresh token, kept server side to ask Firebase for the person later.
#[derive(Debug, Clone, Default)]
pub struct FbSession {
    pub refresh: String,
}

/// A person as Firebase describes them.
#[derive(Debug, Clone, Default)]
pub struct Profile {
    pub uid: String,
    pub email: String,
    pub name: String,
    pub email_verified: bool,
    pub disabled: bool,
}

/// Why Firebase refused, in terms this service acts on.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    WrongPassword,
    EmailTaken,
    WeakPassword,
    WrongCode,
    TooMany,
    Disabled,
    /// Firebase wants an authenticator code of its own: Caller Whale's second step replaced that, so an administrator resets it.
    FirebaseAuthenticator,
    RecentLogin,
    BadLink,
    Setup(String),
    Other(String),
}

impl From<Refusal> for AuthError {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::WrongPassword | Refusal::Disabled => AuthError::WrongCredentials,
            Refusal::EmailTaken => AuthError::Conflict("An account with this email already exists. Sign in instead.".into()),
            Refusal::WeakPassword => AuthError::Bad("Use a password of at least 12 characters.".into()),
            Refusal::WrongCode => AuthError::WrongCode,
            Refusal::TooMany => AuthError::TooMany,
            Refusal::RecentLogin => AuthError::Unauthenticated,
            Refusal::BadLink => AuthError::Forbidden("This link is not valid or has expired.".into()),
            Refusal::FirebaseAuthenticator => AuthError::Forbidden("This account has an old authenticator in Firebase. Ask Caller Whale to reset it, then sign in again.".into()),
            Refusal::Setup(message) | Refusal::Other(message) => AuthError::Internal(anyhow::anyhow!("firebase: {message}")),
        }
    }
}

fn classify(message: &str) -> Refusal {
    let head = message.split([' ', ':']).next().unwrap_or("");
    match head {
        "INVALID_PASSWORD" | "EMAIL_NOT_FOUND" | "INVALID_LOGIN_CREDENTIALS" | "INVALID_EMAIL" | "MISSING_PASSWORD" => Refusal::WrongPassword,
        "EMAIL_EXISTS" => Refusal::EmailTaken,
        "WEAK_PASSWORD" | "PASSWORD_DOES_NOT_MEET_REQUIREMENTS" => Refusal::WeakPassword,
        "INVALID_CODE" | "INVALID_MFA_PENDING_CREDENTIAL" | "INVALID_VERIFICATION_CODE" | "CODE_EXPIRED" => Refusal::WrongCode,
        "TOO_MANY_ATTEMPTS_TRY_LATER" => Refusal::TooMany,
        "USER_DISABLED" => Refusal::Disabled,
        "CREDENTIAL_TOO_OLD_LOGIN_AGAIN" | "TOKEN_EXPIRED" | "INVALID_ID_TOKEN" | "INVALID_REFRESH_TOKEN" => Refusal::RecentLogin,
        "INVALID_OOB_CODE" | "EXPIRED_OOB_CODE" => Refusal::BadLink,
        "API_KEY_INVALID" | "OPERATION_NOT_ALLOWED" | "CONFIGURATION_NOT_FOUND" | "ADMIN_ONLY_OPERATION" | "UNAUTHORIZED_DOMAIN" => Refusal::Setup(message.to_string()),
        _ => Refusal::Other(message.to_string()),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Reply {
    id_token: String,
    refresh_token: String,
    local_id: String,
    mfa_pending_credential: String,
    email: String,
    email_verified: bool,
    display_name: String,
    // securetoken.googleapis.com answers in snake_case.
    #[serde(rename = "user_id")]
    user_id: String,
    #[serde(rename = "id_token")]
    id_token_snake: String,
    #[serde(rename = "refresh_token")]
    refresh_token_snake: String,
}

impl Firebase {
    pub fn new(api_key: &str, identity: &str, token: &str) -> Self {
        Firebase {
            api_key: api_key.to_string(),
            identity: identity.trim_end_matches('/').to_string(),
            token: token.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default(),
        }
    }

    async fn post(&self, url: String, body: Value) -> Result<Value, Refusal> {
        let res = self.http.post(url).query(&[("key", self.api_key.as_str())]).json(&body).send().await.map_err(|e| Refusal::Other(format!("not reachable: {e}")))?;
        let status = res.status();
        let data: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(data);
        }
        let message = data["error"]["message"].as_str().unwrap_or("UNKNOWN").to_string();
        Err(classify(&message))
    }

    async fn call(&self, path: &str, body: Value) -> Result<Reply, Refusal> {
        let value = self.post(format!("{}{}", self.identity, path), body).await?;
        serde_json::from_value(value).map_err(|e| Refusal::Other(format!("unexpected answer: {e}")))
    }

    fn login(reply: &Reply) -> Login {
        Login { id_token: reply.id_token.clone(), refresh_token: reply.refresh_token.clone(), uid: reply.local_id.clone() }
    }

    /// A sign-in result: signed in, or (for an account that still has an authenticator in Firebase) refused.
    fn outcome(reply: Reply) -> Result<Login, Refusal> {
        if !reply.mfa_pending_credential.is_empty() {
            return Err(Refusal::FirebaseAuthenticator);
        }
        if reply.id_token.is_empty() {
            return Err(Refusal::Other("no token in the answer".into()));
        }
        Ok(Self::login(&reply))
    }

    pub async fn sign_up(&self, email: &str, password: &str) -> Result<Login, Refusal> {
        let reply = self.call("/v1/accounts:signUp", json!({ "email": email, "password": password, "returnSecureToken": true })).await?;
        Ok(Self::login(&reply))
    }

    pub async fn sign_in(&self, email: &str, password: &str) -> Result<Login, Refusal> {
        let reply = self.call("/v1/accounts:signInWithPassword", json!({ "email": email, "password": password, "returnSecureToken": true })).await?;
        Self::outcome(reply)
    }

    /// Google: the ID token this service already checked, handed to Firebase to find or open the person.
    pub async fn sign_in_google(&self, google_id_token: &str) -> Result<Login, Refusal> {
        let body = json!({
            "postBody": format!("id_token={google_id_token}&providerId=google.com"),
            "requestUri": "http://localhost",
            "returnSecureToken": true,
            "returnIdpCredential": false,
        });
        Self::outcome(self.call("/v1/accounts:signInWithIdp", body).await?)
    }

    /// A fresh ID token from a refresh token (Firebase may rotate the refresh token too).
    pub async fn refresh(&self, refresh_token: &str) -> Result<Login, Refusal> {
        let res = self
            .http
            .post(format!("{}/v1/token", self.token))
            .query(&[("key", self.api_key.as_str())])
            .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
            .send()
            .await
            .map_err(|e| Refusal::Other(format!("not reachable: {e}")))?;
        let status = res.status();
        let data: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(classify(data["error"]["message"].as_str().unwrap_or("UNKNOWN")));
        }
        let reply: Reply = serde_json::from_value(data).map_err(|e| Refusal::Other(format!("unexpected answer: {e}")))?;
        Ok(Login { id_token: reply.id_token_snake, refresh_token: reply.refresh_token_snake, uid: reply.user_id })
    }

    pub async fn profile(&self, id_token: &str) -> Result<Profile, Refusal> {
        let value = self.post(format!("{}/v1/accounts:lookup", self.identity), json!({ "idToken": id_token })).await?;
        let user = value["users"].get(0).ok_or_else(|| Refusal::Other("no user in the answer".into()))?;
        Ok(Profile {
            uid: user["localId"].as_str().unwrap_or_default().to_string(),
            email: user["email"].as_str().unwrap_or_default().to_lowercase(),
            name: user["displayName"].as_str().unwrap_or_default().to_string(),
            email_verified: user["emailVerified"].as_bool().unwrap_or(false),
            disabled: user["disabled"].as_bool().unwrap_or(false),
        })
    }

    pub async fn set_name(&self, id_token: &str, name: &str) -> Result<(), Refusal> {
        self.call("/v1/accounts:update", json!({ "idToken": id_token, "displayName": name, "returnSecureToken": false })).await.map(|_| ())
    }

    pub async fn set_password(&self, id_token: &str, password: &str) -> Result<(), Refusal> {
        self.call("/v1/accounts:update", json!({ "idToken": id_token, "password": password, "returnSecureToken": false })).await.map(|_| ())
    }

    /// Firebase emails the confirmation link itself.
    pub async fn send_verification(&self, id_token: &str) -> Result<(), Refusal> {
        self.call("/v1/accounts:sendOobCode", json!({ "requestType": "VERIFY_EMAIL", "idToken": id_token })).await.map(|_| ())
    }

    /// Firebase emails a password reset link itself. It answers the same whether or not the address has an account.
    pub async fn send_password_reset(&self, email: &str) -> Result<(), Refusal> {
        match self.call("/v1/accounts:sendOobCode", json!({ "requestType": "PASSWORD_RESET", "email": email })).await {
            Err(Refusal::WrongPassword) => Ok(()), // EMAIL_NOT_FOUND: say nothing about who has an account
            other => other.map(|_| ()),
        }
    }

    /// A new password with the code from the reset link.
    pub async fn reset_password(&self, oob_code: &str, password: &str) -> Result<String, Refusal> {
        let reply = self.call("/v1/accounts:resetPassword", json!({ "oobCode": oob_code, "newPassword": password })).await?;
        Ok(reply.email.to_lowercase())
    }

    /// The code from the confirmation link. Returns the address it confirmed.
    pub async fn confirm_email(&self, oob_code: &str) -> Result<String, Refusal> {
        let reply = self.call("/v1/accounts:update", json!({ "oobCode": oob_code })).await?;
        Ok(reply.email.to_lowercase())
    }

}

/// The `otpauth://` address an authenticator app scans.
pub fn otpauth_url(email: &str, secret: &str) -> String {
    let issuer = "Caller%20Whale";
    format!("otpauth://totp/{issuer}:{}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30", email.replace('@', "%40"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firebase_messages_become_refusals() {
        assert_eq!(classify("INVALID_LOGIN_CREDENTIALS"), Refusal::WrongPassword);
        assert_eq!(classify("EMAIL_EXISTS"), Refusal::EmailTaken);
        assert_eq!(classify("WEAK_PASSWORD : Password should be at least 6 characters"), Refusal::WeakPassword);
        assert_eq!(classify("INVALID_CODE"), Refusal::WrongCode);
        assert_eq!(classify("TOO_MANY_ATTEMPTS_TRY_LATER : later"), Refusal::TooMany);
        assert_eq!(classify("CREDENTIAL_TOO_OLD_LOGIN_AGAIN"), Refusal::RecentLogin);
        assert!(matches!(classify("OPERATION_NOT_ALLOWED"), Refusal::Setup(_)));
        assert!(matches!(classify("SOMETHING_NEW"), Refusal::Other(_)));
    }

    #[test]
    fn the_authenticator_address_names_the_app_and_the_person() {
        let url = otpauth_url("sami@example.com", "ABCDEF");
        assert!(url.starts_with("otpauth://totp/Caller%20Whale:sami%40example.com?secret=ABCDEF"));
    }
}
