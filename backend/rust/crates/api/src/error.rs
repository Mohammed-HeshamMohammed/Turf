use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Every error leaves as `{"error": {"code": "...", "message": "..."}}` with a matching status (plan 2.3).
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("Sign in to continue")]
    Unauthenticated,
    #[error("Confirm your sign-in code to continue")]
    MfaRequired,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    TooMany(String),
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    pub fn bad(message: impl Into<String>) -> Self {
        ApiError::BadRequest(message.into())
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        ApiError::Forbidden(message.into())
    }
    pub fn not_found(what: &str) -> Self {
        ApiError::NotFound(format!("{what} was not found or is outside your access"))
    }
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::Unauthenticated => (StatusCode::UNAUTHORIZED, "unauthenticated"),
            ApiError::MfaRequired => (StatusCode::UNAUTHORIZED, "mfa_required"),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            ApiError::TooMany(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &error {
            match db.code().as_deref() {
                Some("23505") => return ApiError::Conflict("That already exists".into()),
                Some("23503") => return ApiError::bad("A referenced record does not exist"),
                Some("23514") | Some("22P02") | Some("22007") | Some("22008") => return ApiError::bad("A value is not valid"),
                _ => {}
            }
        }
        if matches!(error, sqlx::Error::RowNotFound) {
            return ApiError::not_found("The record");
        }
        ApiError::Internal(error.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();
        if let ApiError::Internal(error) = &self {
            tracing::error!(error = %error, "request failed");
        }
        (status, Json(json!({ "error": { "code": code, "message": self.to_string() } }))).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
