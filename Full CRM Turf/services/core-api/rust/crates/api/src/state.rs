use crate::{cache::Cache, config::Config};
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

/// A committed change, fanned out to WebSocket connections that may see it (plan 2.3, /events).
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct Event {
    pub org_id: Uuid,
    pub kind: String,
    pub entity: String,
    pub entity_id: Uuid,
    pub lead_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    #[serde(default)]
    pub seq: i64,
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cache: Cache,
    pub events: broadcast::Sender<Event>,
    pub config: Arc<Config>,
    /// Checks access tokens from the auth service (the one source of truth for who someone is). `None`: not configured.
    pub auth: Option<Arc<turf_auth_verify::Verifier>>,
}
