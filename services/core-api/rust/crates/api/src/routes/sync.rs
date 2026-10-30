//! /sync/push, /sync/pull and /sync/snapshot (plan 2.3, 2.7).
//!
//! Push applies each operation on its own and answers each individually (applied, duplicate, rejected, conflict), in
//! the order given, so a client sends dependencies first. Pull returns committed changes after a cursor, already
//! filtered by the person's current access; a change to something they can no longer see arrives as a removal. When
//! the organization's access revision moved past the one the client holds, the client must drop its cache and take a
//! fresh snapshot.

use crate::{
    auth::Ctx,
    db,
    error::{ApiError, ApiResult},
    ops::{self, redact_lead, Actor, Op},
    state::AppState,
};
use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

fn actor(ctx: &Ctx) -> ApiResult<Actor> {
    Ok(Actor { scope: ctx.scope()?, label: ctx.label.clone(), depth: 0 })
}

pub async fn one(State(state): State<AppState>, ctx: Ctx, Json(op): Json<Op>) -> ApiResult<Json<Value>> {
    let actor = actor(&ctx)?;
    let result = ops::apply(&state.db, &actor, op).await?;
    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct Push {
    operations: Vec<Op>,
    #[serde(default)]
    access_revision: Option<i64>,
}

pub async fn push(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Push>) -> ApiResult<Json<Value>> {
    if body.operations.len() > 500 {
        return Err(ApiError::bad("Send at most 500 operations at a time"));
    }
    let actor = actor(&ctx)?;
    let mut results = Vec::with_capacity(body.operations.len());
    for op in body.operations {
        results.push(ops::apply(&state.db, &actor, op).await?);
    }
    let stale = body.access_revision.map(|r| r != ctx.access_revision).unwrap_or(false);
    Ok(Json(json!({ "results": results, "access_revision": ctx.access_revision, "reset": stale })))
}

#[derive(Deserialize)]
pub struct Pull {
    #[serde(default)]
    cursor: i64,
    access_revision: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

pub async fn pull(State(state): State<AppState>, ctx: Ctx, Query(query): Query<Pull>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    if query.access_revision != Some(ctx.access_revision) {
        let cursor: i64 = sqlx::query_scalar("SELECT coalesce(max(seq), 0) FROM change_log WHERE org_id = $1").bind(scope.org_id).fetch_one(&state.db).await.unwrap_or(0);
        let _ = cursor;
        return Ok(Json(json!({ "reset": true, "access_revision": ctx.access_revision })));
    }
    let limit = query.limit.unwrap_or(500).clamp(1, 2000);
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<(i64, String, Uuid, Option<Uuid>, String)> = sqlx::query_as(
        "SELECT seq, entity, entity_id, lead_id, op FROM change_log WHERE seq > $1 ORDER BY seq LIMIT $2",
    )
    .bind(query.cursor)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let more = rows.len() as i64 > limit;
    let mut cursor = query.cursor;
    let mut changes = Vec::new();
    // Only the latest state of each record matters within one page.
    let mut seen = std::collections::HashSet::new();
    let page: Vec<_> = rows.into_iter().take(limit as usize).collect();
    for (seq, _, _, _, _) in &page {
        cursor = cursor.max(*seq);
    }
    for (_, entity, id, lead_id, op) in page.into_iter().rev() {
        if !seen.insert((entity.clone(), id)) {
            continue;
        }
        let record = if op == "delete" { None } else { current(&mut tx, &scope, &entity, id, lead_id).await? };
        match record {
            Some(record) => changes.push(json!({ "entity": entity, "id": id, "op": "upsert", "record": record })),
            // Deleted, or no longer visible to this person: the client removes its copy.
            None => {
                if syncable(&entity) {
                    changes.push(json!({ "entity": entity, "id": id, "op": "remove" }))
                }
            }
        }
    }
    changes.reverse();
    Ok(Json(json!({ "cursor": cursor, "changes": changes, "more": more, "access_revision": ctx.access_revision })))
}

fn syncable(entity: &str) -> bool {
    matches!(entity, "lead" | "task" | "note" | "call" | "deal" | "handoff" | "message")
}

async fn current(tx: &mut db::Tx, scope: &db::Scope, entity: &str, id: Uuid, lead_id: Option<Uuid>) -> ApiResult<Option<Value>> {
    let external = scope.access.scopes.iter().all(|s| s == "shared");
    let sql = match entity {
        "lead" => "SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 AND callerwhale_visible_lead(l.id)",
        "task" => "SELECT to_jsonb(t) FROM tasks t WHERE t.id = $1 AND (t.lead_id IS NULL OR callerwhale_visible_lead(t.lead_id)) AND (NOT callerwhale_external() OR t.shared_external)",
        "note" => "SELECT to_jsonb(n) FROM notes n WHERE n.id = $1 AND callerwhale_visible_lead(n.lead_id) AND (NOT callerwhale_external() OR n.visibility = 'shared')",
        "call" => "SELECT to_jsonb(c) FROM call_events c WHERE c.id = $1 AND callerwhale_visible_lead(c.lead_id) AND NOT callerwhale_external()",
        "deal" => "SELECT to_jsonb(d) FROM deals d WHERE d.id = $1 AND callerwhale_visible_lead(d.lead_id) AND NOT callerwhale_external()",
        "handoff" => "SELECT to_jsonb(h) FROM handoffs h WHERE h.id = $1 AND callerwhale_visible_lead(h.lead_id) AND NOT callerwhale_external()",
        "message" => "SELECT to_jsonb(m) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 \
                      AND (c.lead_id IS NULL OR callerwhale_visible_lead(c.lead_id)) AND (NOT callerwhale_external() OR c.shared_external)",
        _ => return Ok(None),
    };
    let _ = (lead_id, external);
    let mut record: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(&mut **tx).await?;
    if entity == "deal" && !scope.access.can("finance") {
        record = None;
    }
    if entity == "lead" {
        record = record.map(|lead| redact_lead(lead, scope));
    }
    Ok(record)
}

/// Everything the person may see, for a first sync or after a reset, with the cursor to continue from.
pub async fn snapshot(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    // The cursor is read first: anything committed after it arrives through the next pull.
    let cursor: i64 = sqlx::query_scalar("SELECT coalesce(max(seq), 0) FROM change_log").fetch_one(&mut *tx).await?;
    let all = |sql: &'static str| sqlx::query_scalar::<_, Value>(sql);
    let leads: Vec<Value> = all("SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p)) FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE callerwhale_visible_lead(l.id)")
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|l| redact_lead(l, &scope))
        .collect();
    let tasks = all("SELECT to_jsonb(t) FROM tasks t WHERE (t.lead_id IS NULL AND t.assignee_id = nullif(current_setting('callerwhale.user_id', true), '')::uuid OR callerwhale_visible_lead(t.lead_id)) AND (NOT callerwhale_external() OR t.shared_external)")
        .fetch_all(&mut *tx)
        .await?;
    let notes = all("SELECT to_jsonb(n) FROM notes n WHERE callerwhale_visible_lead(n.lead_id) AND (NOT callerwhale_external() OR n.visibility = 'shared')").fetch_all(&mut *tx).await?;
    let calls = all("SELECT to_jsonb(c) FROM call_events c WHERE callerwhale_visible_lead(c.lead_id) AND NOT callerwhale_external()").fetch_all(&mut *tx).await?;
    let handoffs = all("SELECT to_jsonb(h) FROM handoffs h WHERE callerwhale_visible_lead(h.lead_id) AND NOT callerwhale_external()").fetch_all(&mut *tx).await?;
    let deals = if scope.access.can("finance") {
        all("SELECT to_jsonb(d) FROM deals d WHERE callerwhale_visible_lead(d.lead_id) AND NOT callerwhale_external()").fetch_all(&mut *tx).await?
    } else {
        vec![]
    };
    tx.commit().await?;
    Ok(Json(json!({
        "cursor": cursor, "access_revision": ctx.access_revision,
        "leads": leads, "tasks": tasks, "notes": notes, "calls": calls, "handoffs": handoffs, "deals": deals,
        // Offline copies must be renewed online within a day (plan 2.7).
        "offline_lease_expires_at": chrono::Utc::now() + chrono::Duration::hours(24),
    })))
}
