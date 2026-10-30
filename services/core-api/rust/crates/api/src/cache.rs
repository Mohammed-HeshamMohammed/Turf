//! Redis as the shared cache (plan 2.6). Any Redis failure falls back to the database: a miss, never an error.

use redis::{aio::ConnectionManager, AsyncCommands};
use serde::{de::DeserializeOwned, Serialize};

#[derive(Clone)]
pub struct Cache {
    redis: Option<ConnectionManager>,
}

impl Cache {
    pub async fn connect(url: &str) -> Cache {
        if url.is_empty() {
            return Cache { redis: None };
        }
        let redis = match redis::Client::open(url) {
            Ok(client) => match tokio::time::timeout(std::time::Duration::from_secs(3), ConnectionManager::new(client)).await {
                Ok(Ok(manager)) => Some(manager),
                Ok(Err(error)) => {
                    tracing::warn!(%error, "Redis unavailable; reads use PostgreSQL");
                    None
                }
                Err(_) => {
                    tracing::warn!("Redis did not answer; reads use PostgreSQL");
                    None
                }
            },
            Err(error) => {
                tracing::warn!(%error, "Redis URL is not valid; reads use PostgreSQL");
                None
            }
        };
        Cache { redis }
    }

    pub fn none() -> Cache {
        Cache { redis: None }
    }

    pub fn enabled(&self) -> bool {
        self.redis.is_some()
    }

    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let mut redis = self.redis.clone()?;
        let raw: Option<String> = tokio::time::timeout(std::time::Duration::from_millis(250), redis.get(key)).await.ok()?.ok()?;
        serde_json::from_str(&raw?).ok()
    }

    pub async fn put<T: Serialize>(&self, key: &str, value: &T, seconds: u64) {
        let Some(mut redis) = self.redis.clone() else { return };
        let Ok(raw) = serde_json::to_string(value) else { return };
        let _: Result<Result<(), _>, _> = tokio::time::timeout(std::time::Duration::from_millis(250), redis.set_ex(key, raw, seconds)).await;
    }
}

/// Keys carry organization, access revision and data revision, so a role change or edit makes old entries unreachable.
pub fn key(org: uuid::Uuid, access_revision: i64, data_revision: i64, rest: &str) -> String {
    format!("callerwhale:{org}:a{access_revision}:d{data_revision}:{rest}")
}
