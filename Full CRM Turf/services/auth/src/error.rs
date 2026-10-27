use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Every refusal the service sends: a status, a stable code for programs and a sentence for people.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("{0}")]
    Bad(String),
    #[error("Sign in first.")]
    Unauthenticated,
    #[error("Wrong email or password.")]
    WrongCredentials,
    #[error("Enter the code from your authenticator app.")]
    MfaRequired,
    #[error("That code is not right.")]
    WrongCode,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Conflict(String),
    #[error("Too many attempts. Wait 15 minutes and try again.")]
    TooMany,
    #[error("Something went wrong.")]
    Internal(#[from] anyhow::Error),
}

impl AuthError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            AuthError::Bad(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AuthError::Unauthenticated => (StatusCode::UNAUTHORIZED, "unauthenticated"),
            AuthError::WrongCredentials => (StatusCode::UNAUTHORIZED, "wrong_credentials"),
            AuthError::MfaRequired => (StatusCode::UNAUTHORIZED, "mfa_required"),
            AuthError::WrongCode => (StatusCode::UNAUTHORIZED, "wrong_code"),
            AuthError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            AuthError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AuthError::TooMany => (StatusCode::TOO_MANY_REQUESTS, "too_many_attempts"),
            AuthError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl From<sqlx::Error> for AuthError {
    fn from(error: sqlx::Error) -> Self {
        AuthError::Internal(error.into())
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        if let AuthError::Internal(error) = &self {
            tracing::error!("{error:#}");
        }
        let (status, code) = self.status_and_code();
        (status, Json(json!({ "error": self.to_string(), "code": code }))).into_response()
    }
}

pub type AuthResult<T> = Result<T, AuthError>;
