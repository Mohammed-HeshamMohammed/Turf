pub mod admin;
pub mod artifacts;
pub mod identity;
pub mod internal;
pub mod records;
pub mod reports;
pub mod sync;

use crate::state::AppState;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({ "ok": true })) }))
        .route("/readyz", get(ready))
        .nest("/api/v1", identity::routes().merge(admin::routes()).merge(records::routes()).merge(reports::routes()).merge(artifacts::routes()))
        .route("/api/v1/ops", post(sync::one))
        .route("/sync/push", post(sync::push))
        .route("/sync/pull", get(sync::pull))
        .route("/sync/snapshot", get(sync::snapshot))
        .route("/events", get(crate::events::socket))
        .nest("/internal", internal::routes())
}

async fn ready(State(state): State<AppState>) -> (axum::http::StatusCode, Json<Value>) {
    let database = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await.is_ok();
    let status = if database { axum::http::StatusCode::OK } else { axum::http::StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(json!({ "database": database, "cache": state.cache.enabled() })))
}
