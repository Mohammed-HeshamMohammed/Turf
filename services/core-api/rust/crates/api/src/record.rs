//! Every committed change writes, in the same transaction: an audit event, a change-log row for /sync/pull, an outbox
//! event for workers and rules, and a notification for live WebSocket fan-out (delivered by PostgreSQL at commit).

use sqlx::PgConnection;
use serde_json::{json, Value};
use uuid::Uuid;

pub struct Change<'a> {
    pub actor_id: Option<Uuid>,
    pub actor_label: &'a str,
    pub entity: &'a str,
    pub entity_id: Uuid,
    pub lead_id: Option<Uuid>,
    /// Audit action and outbox kind, e.g. "lead.stage_changed".
    pub kind: &'a str,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub operation_id: Option<Uuid>,
    pub occurred_at: Option<chrono::DateTime<chrono::Utc>>,
    pub deleted: bool,
    /// Rule depth carried from the event that caused this change; 0 for people.
    pub depth: i32,
}

impl<'a> Change<'a> {
    pub fn new(entity: &'a str, entity_id: Uuid, kind: &'a str) -> Self {
        Change {
            actor_id: None,
            actor_label: "",
            entity,
            entity_id,
            lead_id: None,
            kind,
            before: None,
            after: None,
            operation_id: None,
            occurred_at: None,
            deleted: false,
            depth: 0,
        }
    }
}

pub async fn record(tx: &mut PgConnection, change: Change<'_>) -> Result<i64, sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events (org_id, actor_id, actor_label, entity, entity_id, action, before, after, operation_id, occurred_at) \
         VALUES (callerwhale_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(change.actor_id)
    .bind(change.actor_label)
    .bind(change.entity)
    .bind(change.entity_id)
    .bind(change.kind)
    .bind(&change.before)
    .bind(&change.after)
    .bind(change.operation_id)
    .bind(change.occurred_at)
    .execute(&mut *tx)
    .await?;
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (callerwhale_org(), $1, $2, $3, $4) RETURNING seq",
    )
    .bind(change.entity)
    .bind(change.entity_id)
    .bind(change.lead_id)
    .bind(if change.deleted { "delete" } else { "upsert" })
    .fetch_one(&mut *tx)
    .await?;
    let payload = json!({ "before": change.before, "after": change.after, "actor_id": change.actor_id });
    sqlx::query("INSERT INTO outbox_events (org_id, kind, entity, entity_id, lead_id, payload, depth) VALUES (callerwhale_org(), $1, $2, $3, $4, $5, $6)")
        .bind(change.kind)
        .bind(change.entity)
        .bind(change.entity_id)
        .bind(change.lead_id)
        .bind(payload)
        .bind(change.depth)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE organizations SET data_revision = data_revision + 1 WHERE id = callerwhale_org()").execute(&mut *tx).await?;
    let event = json!({
        "org_id": null, "kind": change.kind, "entity": change.entity, "entity_id": change.entity_id,
        "lead_id": change.lead_id, "user_id": change.actor_id, "seq": seq,
    });
    sqlx::query("SELECT pg_notify('callerwhale_events', jsonb_set($1::jsonb, '{org_id}', to_jsonb(callerwhale_org()))::text)")
        .bind(event)
        .execute(&mut *tx)
        .await?;
    Ok(seq)
}

/// Bumps the organization's access revision: caches and offline copies made before it are no longer trusted.
pub async fn access_changed(tx: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE organizations SET access_revision = access_revision + 1 WHERE id = callerwhale_org()").execute(&mut *tx).await?;
    sqlx::query("SELECT pg_notify('callerwhale_events', json_build_object('org_id', callerwhale_org(), 'kind', 'access.changed', 'entity', 'organization', 'entity_id', callerwhale_org(), 'lead_id', null, 'user_id', null, 'seq', 0)::text)")
        .execute(&mut *tx)
        .await?;
    Ok(())
}
