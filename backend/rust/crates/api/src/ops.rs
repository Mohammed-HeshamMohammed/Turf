//! CRM mutations as operations (plan 2.3, 2.7). Online requests, offline queues and rule actions all come here, so
//! deduplication, permission checks, conflict rules and audit are the same for every path.
//!
//! Each operation carries a client-chosen id. A replay returns the first answer with status "duplicate". Versioned
//! field edits carry the values the client edited from (`base`): a field applies when its server value still equals
//! the base, or already equals the new value; otherwise the operation is a conflict with local and server values, and
//! nothing in it applies. Client clocks never decide which edit wins.

use crate::{
    db::Scope,
    error::{ApiError, ApiResult},
    outcomes,
    record::{record, Change},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Op {
    pub id: Uuid,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
    /// The device's claim of when it happened; kept, never trusted for ordering.
    #[serde(default)]
    pub claimed_at: Option<DateTime<Utc>>,
    /// True when the client queued it while disconnected.
    #[serde(default)]
    pub queued_offline: bool,
    #[serde(default)]
    pub device_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct OpResult {
    pub id: Uuid,
    /// applied, duplicate, rejected or conflict
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_status: Option<String>,
    #[serde(skip_serializing_if = "Value::is_null", default)]
    pub result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Who is acting. Rules act as the system with a depth that bounds loops.
#[derive(Clone, Debug)]
pub struct Actor {
    pub scope: Scope,
    pub label: String,
    pub depth: i32,
}

enum Failure {
    Rejected(String),
    Conflict(Value),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        match ApiError::from(error) {
            ApiError::Internal(error) => Failure::Rejected(format!("internal: {error}")),
            other => Failure::Rejected(other.to_string()),
        }
    }
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Failure::Rejected(error.to_string())
    }
}

type OpOutcome = Result<Value, Failure>;

/// Kinds that change ownership, permissions or many records: never accepted from an offline queue (plan 2.7).
const ONLINE_ONLY: &[&str] = &["lead.assign", "lead.delete", "lead.share", "handoff.decide"];

pub async fn apply(pool: &PgPool, actor: &Actor, op: Op) -> ApiResult<OpResult> {
    let mut tx = crate::db::begin(pool, &actor.scope).await?;
    let user_id = actor.scope.user_id;
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO operations (id, org_id, user_id, device_id, kind, payload, status, claimed_at) \
         VALUES ($1, turf_org(), $2, $3, $4, $5, 'applied', $6) ON CONFLICT (id) DO NOTHING RETURNING id",
    )
    .bind(op.id)
    .bind(user_id)
    .bind(&op.device_id)
    .bind(&op.kind)
    .bind(&op.payload)
    .bind(op.claimed_at)
    .fetch_optional(&mut *tx)
    .await?;
    if inserted.is_none() {
        let existing: Option<(String, Value, Option<Uuid>)> = sqlx::query_as("SELECT status, result, user_id FROM operations WHERE id = $1")
            .bind(op.id)
            .fetch_optional(&mut *tx)
            .await?;
        tx.rollback().await?;
        return match existing {
            Some((status, result, owner)) if owner == user_id => {
                Ok(OpResult { id: op.id, status: "duplicate".into(), original_status: Some(status), result, message: None })
            }
            // An id from another person or organization is never revealed.
            _ => Ok(rejected(op.id, "That operation id is already used")),
        };
    }
    let outcome = if op.queued_offline && ONLINE_ONLY.contains(&op.kind.as_str()) {
        Err(Failure::Rejected("This change needs a connection; it was not applied".into()))
    } else {
        let mut inner = sqlx::Acquire::begin(&mut *tx).await?;
        let result = run(&mut inner, actor, &op).await;
        match result {
            Ok(value) => {
                inner.commit().await?;
                Ok(value)
            }
            Err(failure) => {
                inner.rollback().await?;
                Err(failure)
            }
        }
    };
    let answer = match outcome {
        Ok(value) => OpResult { id: op.id, status: "applied".into(), original_status: None, result: value, message: None },
        Err(Failure::Rejected(message)) => OpResult { id: op.id, status: "rejected".into(), original_status: None, result: Value::Null, message: Some(message) },
        Err(Failure::Conflict(fields)) => OpResult {
            id: op.id,
            status: "conflict".into(),
            original_status: None,
            result: json!({ "fields": fields }),
            message: Some("Someone changed this since you edited it".into()),
        },
    };
    sqlx::query("UPDATE operations SET status = $2, result = $3 WHERE id = $1")
        .bind(op.id)
        .bind(&answer.status)
        .bind(if answer.result.is_null() { json!({ "message": answer.message }) } else { answer.result.clone() })
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(answer)
}

fn rejected(id: Uuid, message: &str) -> OpResult {
    OpResult { id, status: "rejected".into(), original_status: None, result: Value::Null, message: Some(message.into()) }
}

async fn run(tx: &mut PgConnection, actor: &Actor, op: &Op) -> OpOutcome {
    let p = &op.payload;
    match op.kind.as_str() {
        "lead.create" => lead_create(tx, actor, op, p).await,
        "lead.update" => lead_update(tx, actor, op, p).await,
        "lead.assign" => lead_assign(tx, actor, op, p).await,
        "lead.delete" => lead_delete(tx, actor, op, p).await,
        "lead.share" => lead_share(tx, actor, op, p).await,
        "note.add" => note_add(tx, actor, op, p).await,
        "call.record" => call_record(tx, actor, op, p).await,
        "task.create" => task_create(tx, actor, op, p).await,
        "task.update" => task_update(tx, actor, op, p).await,
        "task.complete" => task_complete(tx, actor, op, p).await,
        "handoff.request" => handoff_request(tx, actor, op, p).await,
        "handoff.decide" => handoff_decide(tx, actor, op, p).await,
        "deal.create" => deal_create(tx, actor, op, p).await,
        "deal.update" => deal_update(tx, actor, op, p).await,
        "message.draft" => message_draft(tx, actor, op, p).await,
        "follow" => follow(tx, actor, p).await,
        "notification.read" => notification_read(tx, actor, p).await,
        other => Err(Failure::Rejected(format!("Unknown operation kind: {other}"))),
    }
}

// ------------------------------------------------------------------------------------------------------- helpers

fn need(actor: &Actor, capability: &str) -> Result<(), Failure> {
    if actor.scope.access.can(capability) {
        Ok(())
    } else {
        Err(Failure::Rejected(format!("Your role does not allow this ({capability})")))
    }
}

fn uuid_field(p: &Value, name: &str) -> Result<Uuid, Failure> {
    p.get(name)
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| Failure::Rejected(format!("{name} is required")))
}

fn opt_uuid(p: &Value, name: &str) -> Result<Option<Uuid>, Failure> {
    match p.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Uuid::parse_str(s).map(Some).map_err(|_| Failure::Rejected(format!("{name} is not valid"))),
        _ => Err(Failure::Rejected(format!("{name} is not valid"))),
    }
}

fn text(p: &Value, name: &str) -> String {
    p.get(name).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn opt_time(p: &Value, name: &str) -> Result<Option<DateTime<Utc>>, Failure> {
    match p.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => DateTime::parse_from_rfc3339(s)
            .map(|t| Some(t.with_timezone(&Utc)))
            .map_err(|_| Failure::Rejected(format!("{name} must be an RFC 3339 time with an offset"))),
        _ => Err(Failure::Rejected(format!("{name} is not valid"))),
    }
}

/// A lead's record as the actor may see it, locked for update when asked. None: missing or outside their scope.
pub async fn lead_json(tx: &mut PgConnection, id: Uuid, lock: bool) -> Result<Option<Value>, sqlx::Error> {
    let sql = format!(
        "SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 AND turf_visible_lead(l.id){}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_scalar(&sql).bind(id).fetch_optional(&mut *tx).await
}

/// Removes fields the actor may not read: financial values without "finance", internal fields for external clients.
pub fn redact_lead(mut lead: Value, scope: &Scope) -> Value {
    if let Some(map) = lead.as_object_mut() {
        if !scope.access.can("finance") {
            map.remove("value_amount");
            map.remove("value_currency");
        }
        if scope.access.scopes.iter().all(|s| s == "shared") {
            for field in ["qualification", "verdict", "source", "priority", "do_not_call", "team_id", "project_id", "contact_id"] {
                map.remove(field);
            }
        }
    }
    lead
}

async fn visible_lead(tx: &mut PgConnection, id: Uuid, lock: bool) -> Result<Value, Failure> {
    lead_json(tx, id, lock).await?.ok_or_else(|| Failure::Rejected("The lead was not found, was deleted, or is outside your access".into()))
}

fn change<'a>(actor: &'a Actor, op: &Op, entity: &'a str, id: Uuid, lead: Option<Uuid>, kind: &'a str) -> Change<'a> {
    let mut c = Change::new(entity, id, kind);
    c.actor_id = actor.scope.user_id;
    c.actor_label = &actor.label;
    c.lead_id = lead;
    c.operation_id = Some(op.id);
    c.occurred_at = op.claimed_at;
    c.depth = actor.depth;
    c
}

async fn is_member_with(tx: &mut PgConnection, user: Uuid, capability: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM memberships m JOIN roles r ON r.org_id = m.org_id AND r.key = ANY(m.roles) \
         WHERE m.org_id = turf_org() AND m.user_id = $1 AND $2 = ANY(r.capabilities) AND NOT ($2 = ANY(m.restrictions)))",
    )
    .bind(user)
    .bind(capability)
    .fetch_one(&mut *tx)
    .await
}

/// Compares the client's base values with the current record. Ok(true) when every edited field may apply.
fn check_base(current: &Value, changes: &Map<String, Value>, base: &Map<String, Value>) -> Result<(), Failure> {
    let mut conflicts = Map::new();
    for (field, local) in changes {
        let server = current.get(field).cloned().unwrap_or(Value::Null);
        if &server == local {
            continue;
        }
        if let Some(edited_from) = base.get(field) {
            if !same_value(edited_from, &server) {
                conflicts.insert(field.clone(), json!({ "local": local, "server": server, "base": edited_from }));
            }
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(Failure::Conflict(Value::Object(conflicts)))
    }
}

/// Numbers and times may come back from PostgreSQL in another spelling than the client sent.
fn same_value(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    match (a, b) {
        (Value::String(x), Value::String(y)) => {
            match (DateTime::parse_from_rfc3339(x), DateTime::parse_from_rfc3339(y)) {
                (Ok(tx), Ok(ty)) => tx == ty,
                _ => x.parse::<f64>().ok().zip(y.parse::<f64>().ok()).map(|(p, q)| p == q).unwrap_or(false),
            }
        }
        (Value::Number(x), Value::String(y)) | (Value::String(y), Value::Number(x)) => {
            y.parse::<f64>().ok().zip(x.as_f64()).map(|(p, q)| p == q).unwrap_or(false)
        }
        (Value::Null, Value::String(s)) | (Value::String(s), Value::Null) => s.is_empty(),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------- leads

const LEAD_EDITABLE: &[&str] = &[
    "name", "phone", "email", "stage", "verdict", "next_action", "next_action_at", "next_action_tz", "priority", "qualification", "sent_to",
    "value_amount", "value_currency", "do_not_call", "source",
];

async fn stages(tx: &mut PgConnection, key: &str, fallback: &[&str]) -> Result<Vec<String>, sqlx::Error> {
    let saved: Option<Value> =
        sqlx::query_scalar("SELECT value FROM settings_versions WHERE org_id = turf_org() AND key = $1 ORDER BY id DESC LIMIT 1")
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?;
    Ok(saved
        .and_then(|v| v.get("stages").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.iter().map(|s| s.to_string()).collect()))
}

pub const LEAD_STAGES: &[&str] = &["New", "Contacted", "Interested", "Qualified", "Closed"];
pub const DEAL_STAGES: &[&str] = &["Qualified", "Appointment", "Offer preparation", "Offer sent", "Negotiation", "Under contract", "Closed won", "Closed lost"];

async fn lead_create(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "edit")?;
    let name = text(p, "name");
    if name.is_empty() {
        return Err(Failure::Rejected("A lead needs a name".into()));
    }
    let id = opt_uuid(p, "id")?.unwrap_or_else(Uuid::new_v4);
    let assignee = opt_uuid(p, "assignee_id")?.or(actor.scope.user_id);
    if assignee != actor.scope.user_id && !actor.scope.access.can("assign") {
        return Err(Failure::Rejected("Only someone who assigns work can create a lead for another person".into()));
    }
    // The lead joins its assignee's team, so that team's managers see it.
    let assignee_team: Option<Uuid> = match assignee {
        Some(user) => sqlx::query_scalar("SELECT team_ids[1] FROM memberships WHERE org_id = turf_org() AND user_id = $1")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?
            .flatten(),
        None => None,
    };
    let team = opt_uuid(p, "team_id")?.or(assignee_team).or_else(|| actor.scope.team_ids.first().copied());
    let stage = p.get("stage").and_then(Value::as_str).unwrap_or("New").to_string();
    if !stages(tx, "pipeline.lead", LEAD_STAGES).await?.contains(&stage) {
        return Err(Failure::Rejected(format!("{stage} is not a lead stage")));
    }
    let property_id: Option<Uuid> = if p.get("address").is_some() || p.get("latitude").is_some() {
        let lat = p.get("latitude").and_then(Value::as_f64);
        let lon = p.get("longitude").and_then(Value::as_f64);
        let (lat, lon) = match (lat, lon) {
            (Some(a), Some(b)) if (-90.0..=90.0).contains(&a) && (-180.0..=180.0).contains(&b) => (Some(a), Some(b)),
            _ => (None, None), // a partial or invalid pair is no location (plan 5.5)
        };
        Some(
            sqlx::query_scalar(
                "INSERT INTO properties (org_id, address, unit, city, region, postal_code, country, latitude, longitude, location_source) \
                 VALUES (turf_org(), $1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 IS NULL THEN 'none' ELSE 'supplied' END) RETURNING id",
            )
            .bind(text(p, "address"))
            .bind(text(p, "unit"))
            .bind(text(p, "city"))
            .bind(text(p, "region"))
            .bind(text(p, "zip"))
            .bind(text(p, "country"))
            .bind(lat)
            .bind(lon)
            .fetch_one(&mut *tx)
            .await?,
        )
    } else {
        None
    };
    let next_at = opt_time(p, "next_action_at")?;
    sqlx::query(
        "INSERT INTO leads (id, org_id, project_id, team_id, property_id, assignee_id, name, phone, email, stage, source, next_action_at, priority) \
         VALUES ($1, turf_org(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce(nullif($12, ''), 'Normal'))",
    )
    .bind(id)
    .bind(opt_uuid(p, "project_id")?)
    .bind(team)
    .bind(property_id)
    .bind(assignee)
    .bind(&name)
    .bind(text(p, "phone"))
    .bind(text(p, "email"))
    .bind(&stage)
    .bind(match text(p, "source") { s if s.is_empty() => "Added manually".to_string(), s => s })
    .bind(next_at)
    .bind(text(p, "priority"))
    .execute(&mut *tx)
    .await?;
    let after = visible_lead(tx, id, false).await?;
    let mut c = change(actor, op, "lead", id, Some(id), "lead.created");
    c.after = Some(after.clone());
    record(tx, c).await?;
    Ok(redact_lead(after, &actor.scope))
}

async fn lead_update(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    let id = uuid_field(p, "id")?;
    let changes = p.get("changes").and_then(Value::as_object).cloned().unwrap_or_default();
    let base = p.get("base").and_then(Value::as_object).cloned().unwrap_or_default();
    if changes.is_empty() {
        return Err(Failure::Rejected("Nothing to change".into()));
    }
    need(actor, "edit")?;
    if let Some(field) = changes.keys().find(|f| !LEAD_EDITABLE.contains(&f.as_str())) {
        return Err(Failure::Rejected(format!("{field} cannot be changed this way")));
    }
    if (changes.contains_key("value_amount") || changes.contains_key("value_currency")) && !actor.scope.access.can("finance") {
        return Err(Failure::Rejected("Changing values needs the finance permission".into()));
    }
    let before = visible_lead(tx, id, true).await?;
    if !can_edit_lead(actor, &before) {
        return Err(Failure::Rejected("You can only edit leads assigned to you".into()));
    }
    // Lifting a do-not-call is never a casual edit (plan: do-not-call is never dropped on a guess).
    if changes.get("do_not_call") == Some(&Value::Bool(false)) && before["do_not_call"] == Value::Bool(true) && !actor.scope.access.can("assign") {
        return Err(Failure::Rejected("Only a manager can lift a do-not-call".into()));
    }
    check_base(&before, &changes, &base)?;
    if let Some(stage) = changes.get("stage").and_then(Value::as_str) {
        if !stages(tx, "pipeline.lead", LEAD_STAGES).await?.iter().any(|s| s == stage) {
            return Err(Failure::Rejected(format!("{stage} is not a lead stage")));
        }
    }
    let mut merged = before.clone();
    for (field, value) in &changes {
        merged[field] = value.clone();
    }
    sqlx::query(
        "UPDATE leads l SET (name, phone, email, stage, verdict, next_action, next_action_at, next_action_tz, priority, qualification, sent_to, \
           value_amount, value_currency, do_not_call, source) = \
         (SELECT r.name, r.phone, r.email, r.stage, r.verdict, r.next_action, r.next_action_at, r.next_action_tz, r.priority, r.qualification, r.sent_to, \
           r.value_amount, r.value_currency, r.do_not_call, r.source FROM jsonb_populate_record(NULL::leads, $2) r), \
         version = l.version + 1, updated_at = now() WHERE l.id = $1",
    )
    .bind(id)
    .bind(&merged)
    .execute(&mut *tx)
    .await?;
    let after = visible_lead(tx, id, false).await?;
    let kind = if changes.contains_key("stage") && before["stage"] != after["stage"] { "lead.stage_changed" } else { "lead.updated" };
    let mut c = change(actor, op, "lead", id, Some(id), kind);
    c.before = Some(before);
    c.after = Some(after.clone());
    record(tx, c).await?;
    if after["stage"] == "Qualified" && kind == "lead.stage_changed" {
        let mut q = change(actor, op, "lead", id, Some(id), "lead.qualified");
        q.after = Some(after.clone());
        record(tx, q).await?;
    }
    Ok(redact_lead(after, &actor.scope))
}

fn can_edit_lead(actor: &Actor, lead: &Value) -> bool {
    let scopes = &actor.scope.access.scopes;
    if scopes.contains("organization") || scopes.contains("team") || scopes.contains("project") {
        return true;
    }
    lead.get("assignee_id").and_then(Value::as_str) == actor.scope.user_id.map(|u| u.to_string()).as_deref()
}

async fn lead_assign(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "assign")?;
    let ids: Vec<Uuid> = p
        .get("ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok())).collect())
        .unwrap_or_default();
    if ids.is_empty() || ids.len() > 5000 {
        return Err(Failure::Rejected("Choose between 1 and 5000 leads".into()));
    }
    let to = opt_uuid(p, "assignee_id")?;
    if let Some(user) = to {
        let member: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = turf_org() AND user_id = $1)")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        if !member {
            return Err(Failure::Rejected("That person is not in this organization".into()));
        }
    }
    let team = opt_uuid(p, "team_id")?;
    let reason = text(p, "reason");
    let mut changed = Vec::new();
    for id in ids {
        let before = visible_lead(tx, id, true).await?;
        sqlx::query("UPDATE leads SET assignee_id = $2, team_id = coalesce($3, team_id), version = version + 1, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(to)
            .bind(team)
            .execute(&mut *tx)
            .await?;
        let from: Option<Uuid> = before.get("assignee_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
        sqlx::query("INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id) VALUES (turf_org(), $1, $2, $3, $4, $5)")
            .bind(id)
            .bind(from)
            .bind(to)
            .bind(&reason)
            .bind(actor.scope.user_id)
            .execute(&mut *tx)
            .await?;
        // Open tasks follow the lead to its new owner.
        sqlx::query("UPDATE tasks SET assignee_id = $2, version = version + 1 WHERE lead_id = $1 AND done_at IS NULL AND assignee_id IS NOT DISTINCT FROM $3")
            .bind(id)
            .bind(to)
            .bind(from)
            .execute(&mut *tx)
            .await?;
        let after: Value = sqlx::query_scalar("SELECT to_jsonb(l) FROM leads l WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
        let mut c = change(actor, op, "lead", id, Some(id), "lead.assigned");
        c.before = Some(before);
        c.after = Some(after);
        record(tx, c).await?;
        if let Some(user) = to {
            notify(tx, user, "assignment", "A lead was assigned to you", "lead", id).await?;
        }
        changed.push(id);
    }
    Ok(json!({ "assigned": changed.len(), "ids": changed }))
}

async fn lead_delete(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "assign")?;
    let id = uuid_field(p, "id")?;
    let before = visible_lead(tx, id, true).await?;
    sqlx::query("UPDATE leads SET deleted_at = now(), version = version + 1 WHERE id = $1").bind(id).execute(&mut *tx).await?;
    let mut c = change(actor, op, "lead", id, Some(id), "lead.deleted");
    c.before = Some(before);
    c.deleted = true;
    record(tx, c).await?;
    Ok(json!({ "id": id, "deleted": true }))
}

async fn lead_share(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "assign")?;
    let id = uuid_field(p, "id")?;
    let user = uuid_field(p, "user_id")?;
    let share = p.get("shared").and_then(Value::as_bool).unwrap_or(true);
    visible_lead(tx, id, true).await?;
    if share {
        sqlx::query("INSERT INTO lead_shares (org_id, lead_id, user_id) VALUES (turf_org(), $1, $2) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(user)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM lead_shares WHERE lead_id = $1 AND user_id = $2").bind(id).bind(user).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE leads SET shared_external = EXISTS (SELECT 1 FROM lead_shares WHERE lead_id = $1), version = version + 1 WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::record::access_changed(tx).await?;
    let mut c = change(actor, op, "lead", id, Some(id), "lead.shared");
    c.after = Some(json!({ "user_id": user, "shared": share }));
    record(tx, c).await?;
    Ok(json!({ "id": id, "user_id": user, "shared": share }))
}

async fn notify(tx: &mut PgConnection, user: Uuid, kind: &str, text: &str, entity: &str, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO notifications (org_id, user_id, kind, text, entity, entity_id) VALUES (turf_org(), $1, $2, $3, $4, $5)")
        .bind(user)
        .bind(kind)
        .bind(text)
        .bind(entity)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------- notes and calls

async fn note_add(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    let lead_id = uuid_field(p, "lead_id")?;
    let body = text(p, "body");
    if body.is_empty() {
        return Err(Failure::Rejected("A note needs some text".into()));
    }
    visible_lead(tx, lead_id, false).await?;
    let external = actor.scope.access.scopes.iter().all(|s| s == "shared");
    if !actor.scope.access.can("edit") && !actor.scope.access.can("publicComment") {
        return Err(Failure::Rejected("Your role cannot add notes".into()));
    }
    // External comments are always shared; internal people choose.
    let visibility = if external || p.get("visibility").and_then(Value::as_str) == Some("shared") { "shared" } else { "internal" };
    let mentions: Vec<Uuid> = p
        .get("mentions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok())).collect())
        .unwrap_or_default();
    let note: Value = sqlx::query_scalar(
        "INSERT INTO notes (org_id, lead_id, author_id, author_label, body, visibility, mentions, occurred_at, operation_id) \
         VALUES (turf_org(), $1, $2, $3, $4, $5, $6, coalesce($7, now()), $8) RETURNING to_jsonb(notes.*)",
    )
    .bind(lead_id)
    .bind(actor.scope.user_id)
    .bind(&actor.label)
    .bind(&body)
    .bind(visibility)
    .bind(&mentions)
    .bind(op.claimed_at)
    .bind(op.id)
    .fetch_one(&mut *tx)
    .await?;
    let note_id = Uuid::parse_str(note["id"].as_str().unwrap_or_default()).unwrap_or_default();
    for user in &mentions {
        notify(tx, *user, "mention", &format!("{} mentioned you in a note", actor.label), "lead", lead_id).await?;
    }
    let mut c = change(actor, op, "note", note_id, Some(lead_id), "note.added");
    c.after = Some(note.clone());
    record(tx, c).await?;
    Ok(note)
}

async fn call_record(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "call")?;
    let lead_id = uuid_field(p, "lead_id")?;
    let label = text(p, "outcome");
    let outcome = outcomes::find(&label).ok_or_else(|| Failure::Rejected(format!("{label} is not a call outcome")))?;
    let before = visible_lead(tx, lead_id, true).await?;
    if !can_edit_lead(actor, &before) {
        return Err(Failure::Rejected("You can only log calls on leads assigned to you".into()));
    }
    if before["do_not_call"] == Value::Bool(true) {
        return Err(Failure::Rejected("This lead is do-not-call; calls cannot be logged".into()));
    }
    let occurred_at = opt_time(p, "occurred_at")?.or(op.claimed_at).unwrap_or_else(Utc::now);
    let callback_at = opt_time(p, "callback_at")?;
    let scheduled = if outcome.label == "Callback" {
        Some(callback_at.ok_or_else(|| Failure::Rejected("A callback needs a time".into()))?)
    } else {
        outcome.recall_days.map(|days| occurred_at + Duration::days(days))
    };
    let phone = match text(p, "phone") {
        s if s.is_empty() => before["phone"].as_str().unwrap_or("").to_string(),
        s => s,
    };
    let event: Value = sqlx::query_scalar(
        "INSERT INTO call_events (org_id, lead_id, agent_id, agent_label, phone, outcome, code, meaning, scheduled_at, source, occurred_at, operation_id) \
         VALUES (turf_org(), $1, $2, $3, $4, $5, $6, $7, $8, coalesce(nullif($9, ''), 'manual'), $10, $11) RETURNING to_jsonb(call_events.*)",
    )
    .bind(lead_id)
    .bind(actor.scope.user_id)
    .bind(&actor.label)
    .bind(&phone)
    .bind(outcome.label)
    .bind(outcome.code)
    .bind(outcome.meaning)
    .bind(scheduled)
    .bind(text(p, "source"))
    .bind(occurred_at)
    .bind(op.id)
    .fetch_one(&mut *tx)
    .await?;
    let stage = before["stage"].as_str().unwrap_or("New");
    let new_stage = match outcome.label {
        "Transfer" => "Qualified",
        "Do not call" => "Closed",
        _ if outcome.meaning == "reached" && stage == "New" => "Contacted",
        _ => stage,
    };
    let verdict = match outcome.meaning {
        "wrong_number" => "Wrong number",
        "wrong_person" => "Wrong person",
        "disconnected" => "Disconnected",
        "do_not_call" => "Do not call",
        _ => before["verdict"].as_str().unwrap_or("Unverified"),
    };
    sqlx::query(
        "UPDATE leads SET stage = $2, verdict = $3, do_not_call = do_not_call OR $4, next_action_at = $5, \
           next_action = CASE WHEN $5 IS NULL THEN '' ELSE $6 END, sent_to = CASE WHEN $7 THEN 'Appointments' ELSE sent_to END, \
           version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(lead_id)
    .bind(new_stage)
    .bind(verdict)
    .bind(outcome.meaning == "do_not_call")
    .bind(scheduled)
    .bind(if outcome.label == "Callback" { "Callback" } else { "Try again" })
    .bind(outcome.label == "Transfer")
    .execute(&mut *tx)
    .await?;
    if outcome.meaning == "do_not_call" && !phone.is_empty() {
        sqlx::query("INSERT INTO suppressions (org_id, channel, address, reason) VALUES (turf_org(), 'all', $1, 'Do not call (call outcome)') ON CONFLICT DO NOTHING")
            .bind(&phone)
            .execute(&mut *tx)
            .await?;
    }
    // One open callback task per lead: a new try replaces it, a final outcome closes it.
    let assignee: Option<Uuid> = before.get("assignee_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
    sqlx::query("UPDATE tasks SET done_at = now(), version = version + 1 WHERE lead_id = $1 AND type = 'Callback' AND done_at IS NULL")
        .bind(lead_id)
        .execute(&mut *tx)
        .await?;
    let name = before["name"].as_str().unwrap_or("lead");
    if let Some(at) = scheduled {
        let title = format!("{}{name}", if outcome.label == "Callback" { "Callback: " } else { "Try again: " });
        let task_id: Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, due_at, timezone) VALUES (turf_org(), $1, $2, $3, 'Callback', $4, $5) RETURNING id",
        )
        .bind(lead_id)
        .bind(assignee)
        .bind(&title)
        .bind(at)
        .bind(before["next_action_tz"].as_str())
        .fetch_one(&mut *tx)
        .await?;
        record(tx, change(actor, op, "task", task_id, Some(lead_id), "task.created")).await?;
    }
    if outcome.label == "Transfer" {
        let task_id: Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, priority, due_at) VALUES (turf_org(), $1, $2, $3, 'Appointment', 'High', now()) RETURNING id",
        )
        .bind(lead_id)
        .bind(assignee)
        .bind(format!("Appointment for {name} (transferred)"))
        .fetch_one(&mut *tx)
        .await?;
        record(tx, change(actor, op, "task", task_id, Some(lead_id), "task.created")).await?;
    }
    let after = visible_lead(tx, lead_id, false).await?;
    let call_id = Uuid::parse_str(event["id"].as_str().unwrap_or_default()).unwrap_or_default();
    let mut c = change(actor, op, "call", call_id, Some(lead_id), "call.recorded");
    c.after = Some(event.clone());
    record(tx, c).await?;
    let mut l = change(actor, op, "lead", lead_id, Some(lead_id), if before["stage"] != after["stage"] { "lead.stage_changed" } else { "lead.updated" });
    l.before = Some(before);
    l.after = Some(after.clone());
    record(tx, l).await?;
    Ok(json!({ "call": event, "lead": redact_lead(after, &actor.scope) }))
}

// ---------------------------------------------------------------------------------------------------------- tasks

const TASK_EDITABLE: &[&str] = &["title", "type", "priority", "due_at", "timezone", "recurrence", "assignee_id", "shared_external"];

async fn task_visible(tx: &mut PgConnection, id: Uuid, lock: bool) -> Result<Value, Failure> {
    let sql = format!(
        "SELECT to_jsonb(t) FROM tasks t WHERE t.id = $1 AND (t.lead_id IS NULL AND (t.assignee_id = nullif(current_setting('turf.user_id', true), '')::uuid \
           OR 'organization' = ANY(string_to_array(current_setting('turf.scopes', true), ','))) OR turf_visible_lead(t.lead_id)) \
           AND (NOT turf_external() OR t.shared_external){}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_scalar(&sql).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(|| Failure::Rejected("The task was not found or is outside your access".into()))
}

fn valid_recurrence(rule: &str) -> bool {
    rule.is_empty() || next_occurrence(rule, Utc::now()).is_some()
}

/// The next due time for a simple RRULE: FREQ=DAILY|WEEKLY|MONTHLY with an optional INTERVAL.
pub fn next_occurrence(rule: &str, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let mut freq = None;
    let mut interval = 1i64;
    for part in rule.split(';') {
        match part.split_once('=')? {
            ("FREQ", f) => freq = Some(f.to_string()),
            ("INTERVAL", n) => interval = n.parse().ok().filter(|n: &i64| (1..=365).contains(n))?,
            (_, _) => {}
        }
    }
    match freq.as_deref()? {
        "DAILY" => Some(from + Duration::days(interval)),
        "WEEKLY" => Some(from + Duration::weeks(interval)),
        "MONTHLY" => from.checked_add_months(chrono::Months::new(interval as u32)),
        _ => None,
    }
}

async fn task_create(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    if !actor.scope.access.can("edit") && !actor.scope.access.can("review") {
        return Err(Failure::Rejected("Your role cannot create tasks".into()));
    }
    let title = text(p, "title");
    if title.is_empty() {
        return Err(Failure::Rejected("A task needs a title".into()));
    }
    let lead_id = opt_uuid(p, "lead_id")?;
    if let Some(lead) = lead_id {
        visible_lead(tx, lead, false).await?;
    }
    let recurrence = text(p, "recurrence");
    if !valid_recurrence(&recurrence) {
        return Err(Failure::Rejected("Repeat must be FREQ=DAILY, WEEKLY or MONTHLY, with an optional INTERVAL".into()));
    }
    let assignee = opt_uuid(p, "assignee_id")?.or(actor.scope.user_id);
    let id = opt_uuid(p, "id")?.unwrap_or_else(Uuid::new_v4);
    let task: Value = sqlx::query_scalar(
        "INSERT INTO tasks (id, org_id, lead_id, assignee_id, title, type, priority, due_at, timezone, recurrence, shared_external) \
         VALUES ($1, turf_org(), $2, $3, $4, coalesce(nullif($5, ''), 'Task'), coalesce(nullif($6, ''), 'Normal'), $7, nullif($8, ''), nullif($9, ''), $10) \
         RETURNING to_jsonb(tasks.*)",
    )
    .bind(id)
    .bind(lead_id)
    .bind(assignee)
    .bind(&title)
    .bind(text(p, "type"))
    .bind(text(p, "priority"))
    .bind(opt_time(p, "due_at")?)
    .bind(text(p, "timezone"))
    .bind(&recurrence)
    .bind(p.get("shared_external").and_then(Value::as_bool).unwrap_or(false))
    .fetch_one(&mut *tx)
    .await?;
    let mut c = change(actor, op, "task", id, lead_id, "task.created");
    c.after = Some(task.clone());
    record(tx, c).await?;
    Ok(task)
}

async fn task_update(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    if !actor.scope.access.can("edit") && !actor.scope.access.can("review") {
        return Err(Failure::Rejected("Your role cannot change tasks".into()));
    }
    let id = uuid_field(p, "id")?;
    let changes = p.get("changes").and_then(Value::as_object).cloned().unwrap_or_default();
    let base = p.get("base").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(field) = changes.keys().find(|f| !TASK_EDITABLE.contains(&f.as_str())) {
        return Err(Failure::Rejected(format!("{field} cannot be changed this way")));
    }
    if let Some(rule) = changes.get("recurrence").and_then(Value::as_str) {
        if !valid_recurrence(rule) {
            return Err(Failure::Rejected("Repeat must be FREQ=DAILY, WEEKLY or MONTHLY".into()));
        }
    }
    let before = task_visible(tx, id, true).await?;
    check_base(&before, &changes, &base)?;
    let mut merged = before.clone();
    for (field, value) in &changes {
        merged[field] = value.clone();
    }
    let task: Value = sqlx::query_scalar(
        "UPDATE tasks t SET (title, type, priority, due_at, timezone, recurrence, assignee_id, shared_external) = \
           (SELECT r.title, r.type, r.priority, r.due_at, r.timezone, nullif(r.recurrence, ''), r.assignee_id, r.shared_external \
            FROM jsonb_populate_record(NULL::tasks, $2) r), version = t.version + 1 WHERE t.id = $1 RETURNING to_jsonb(t.*)",
    )
    .bind(id)
    .bind(&merged)
    .fetch_one(&mut *tx)
    .await?;
    let lead_id = task.get("lead_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
    let mut c = change(actor, op, "task", id, lead_id, "task.updated");
    c.before = Some(before);
    c.after = Some(task.clone());
    record(tx, c).await?;
    Ok(task)
}

async fn task_complete(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    if !actor.scope.access.can("edit") && !actor.scope.access.can("review") {
        return Err(Failure::Rejected("Your role cannot complete tasks".into()));
    }
    let id = uuid_field(p, "id")?;
    let done = p.get("done").and_then(Value::as_bool).unwrap_or(true);
    let before = task_visible(tx, id, true).await?;
    let task: Value = sqlx::query_scalar(
        "UPDATE tasks t SET done_at = CASE WHEN $2 THEN coalesce(t.done_at, now()) ELSE NULL END, version = t.version + 1 WHERE t.id = $1 RETURNING to_jsonb(t.*)",
    )
    .bind(id)
    .bind(done)
    .fetch_one(&mut *tx)
    .await?;
    let lead_id = task.get("lead_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
    let mut c = change(actor, op, "task", id, lead_id, if done { "task.completed" } else { "task.reopened" });
    c.before = Some(before.clone());
    c.after = Some(task.clone());
    record(tx, c).await?;
    // Completing a repeating task creates its next instance, once.
    let was_open = before["done_at"].is_null();
    let rule = task["recurrence"].as_str().unwrap_or("");
    if done && was_open && !rule.is_empty() {
        let due = task["due_at"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Utc)).unwrap_or_else(Utc::now);
        if let Some(next) = next_occurrence(rule, due) {
            let next_id: Uuid = sqlx::query_scalar(
                "INSERT INTO tasks (org_id, lead_id, deal_id, assignee_id, title, type, priority, due_at, timezone, recurrence, shared_external) \
                 SELECT org_id, lead_id, deal_id, assignee_id, title, type, priority, $2, timezone, recurrence, shared_external FROM tasks WHERE id = $1 RETURNING id",
            )
            .bind(id)
            .bind(next)
            .fetch_one(&mut *tx)
            .await?;
            record(tx, change(actor, op, "task", next_id, lead_id, "task.created")).await?;
        }
    }
    Ok(task)
}

// ------------------------------------------------------------------------------------------------------- handoffs

async fn handoff_request(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "handoff")?;
    let lead_id = uuid_field(p, "lead_id")?;
    let to = uuid_field(p, "to_user")?;
    let note = text(p, "note");
    if note.is_empty() {
        return Err(Failure::Rejected("Say what the recipient needs to know".into()));
    }
    let lead = visible_lead(tx, lead_id, true).await?;
    if !can_edit_lead(actor, &lead) {
        return Err(Failure::Rejected("You can only hand off leads assigned to you".into()));
    }
    if Some(to) == actor.scope.user_id {
        return Err(Failure::Rejected("Choose someone else to hand off to".into()));
    }
    if !is_member_with(tx, to, "accept").await? {
        return Err(Failure::Rejected("That person cannot accept handoffs".into()));
    }
    // Required qualification details for the lead's project (plan 3.3).
    if let Some(project) = lead.get("project_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok()) {
        let required: Vec<String> =
            sqlx::query_scalar("SELECT unnest(qualification_fields) FROM projects WHERE id = $1").bind(project).fetch_all(&mut *tx).await?;
        let missing: Vec<&String> = required
            .iter()
            .filter(|field| lead["qualification"].get(field.as_str()).and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty())
            .collect();
        if !missing.is_empty() {
            return Err(Failure::Rejected(format!(
                "Fill in the qualification details first: {}",
                missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            )));
        }
    }
    let handoff: Option<Value> = sqlx::query_scalar(
        "INSERT INTO handoffs (org_id, lead_id, from_user, to_user, note, due_at) VALUES (turf_org(), $1, $2, $3, $4, now() + interval '2 days') \
         ON CONFLICT (lead_id) WHERE status = 'Requested' DO NOTHING RETURNING to_jsonb(handoffs.*)",
    )
    .bind(lead_id)
    .bind(actor.scope.user_id)
    .bind(to)
    .bind(&note)
    .fetch_optional(&mut *tx)
    .await?;
    let handoff = handoff.ok_or_else(|| Failure::Rejected("This lead already has an open handoff".into()))?;
    let id = Uuid::parse_str(handoff["id"].as_str().unwrap_or_default()).unwrap_or_default();
    notify(tx, to, "handoff", &format!("{} asked you to take {}", actor.label, lead["name"].as_str().unwrap_or("a lead")), "handoff", id).await?;
    let mut c = change(actor, op, "handoff", id, Some(lead_id), "handoff.requested");
    c.after = Some(handoff.clone());
    record(tx, c).await?;
    Ok(handoff)
}

async fn handoff_decide(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    let id = uuid_field(p, "id")?;
    let decision = text(p, "decision");
    let handoff: Value = sqlx::query_scalar("SELECT to_jsonb(h) FROM handoffs h WHERE h.id = $1 AND turf_visible_lead(h.lead_id) FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Failure::Rejected("The handoff was not found or is outside your access".into()))?;
    if handoff["status"] != "Requested" {
        // Idempotent for the same decision; a different decision on a closed handoff is refused.
        let already = match decision.as_str() {
            "accept" => "Accepted",
            "decline" => "Declined",
            "cancel" => "Cancelled",
            _ => "",
        };
        if handoff["status"] == already {
            return Ok(handoff);
        }
        return Err(Failure::Rejected(format!("This handoff is already {}", handoff["status"].as_str().unwrap_or("closed").to_lowercase())));
    }
    let me = actor.scope.user_id.map(|u| u.to_string());
    let recipient = handoff["to_user"].as_str() == me.as_deref();
    let requester = handoff["from_user"].as_str() == me.as_deref();
    let manager = actor.scope.access.can("assign");
    let lead_id = Uuid::parse_str(handoff["lead_id"].as_str().unwrap_or_default()).unwrap_or_default();
    let to = Uuid::parse_str(handoff["to_user"].as_str().unwrap_or_default()).unwrap_or_default();
    let status = match decision.as_str() {
        "accept" if (recipient && actor.scope.access.can("accept")) || manager => "Accepted",
        "decline" if recipient || manager => "Declined",
        "cancel" if requester || manager => "Cancelled",
        "accept" | "decline" | "cancel" => return Err(Failure::Rejected("You cannot make this decision on the handoff".into())),
        _ => return Err(Failure::Rejected("decision must be accept, decline or cancel".into())),
    };
    let updated: Value = sqlx::query_scalar(
        "UPDATE handoffs SET status = $2, decided_at = now(), version = version + 1 WHERE id = $1 RETURNING to_jsonb(handoffs.*)",
    )
    .bind(id)
    .bind(status)
    .fetch_one(&mut *tx)
    .await?;
    if status == "Accepted" {
        // Ownership, history, tasks and the deal change together (plan 3.3).
        let before: Value = sqlx::query_scalar("SELECT to_jsonb(l) FROM leads l WHERE id = $1 FOR UPDATE").bind(lead_id).fetch_one(&mut *tx).await?;
        let from: Option<Uuid> = before.get("assignee_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
        sqlx::query("UPDATE leads SET assignee_id = $2, stage = 'Qualified', version = version + 1, updated_at = now() WHERE id = $1")
            .bind(lead_id)
            .bind(to)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id) VALUES (turf_org(), $1, $2, $3, 'Handoff accepted', $4)")
            .bind(lead_id)
            .bind(from)
            .bind(to)
            .bind(actor.scope.user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE tasks SET assignee_id = $2, version = version + 1 WHERE lead_id = $1 AND done_at IS NULL")
            .bind(lead_id)
            .bind(to)
            .execute(&mut *tx)
            .await?;
        let deal: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO deals (org_id, lead_id, property_id, stage, amount, currency) \
             SELECT org_id, id, property_id, 'Qualified', NULL, coalesce(value_currency, 'USD') FROM leads WHERE id = $1 \
             ON CONFLICT (lead_id) DO NOTHING RETURNING id",
        )
        .bind(lead_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(deal) = deal {
            record(tx, change(actor, op, "deal", deal, Some(lead_id), "deal.created")).await?;
        }
        let after: Value = sqlx::query_scalar("SELECT to_jsonb(l) FROM leads l WHERE id = $1").bind(lead_id).fetch_one(&mut *tx).await?;
        let mut l = change(actor, op, "lead", lead_id, Some(lead_id), "lead.assigned");
        l.before = Some(before);
        l.after = Some(after);
        record(tx, l).await?;
    }
    let from = Uuid::parse_str(handoff["from_user"].as_str().unwrap_or_default()).unwrap_or_default();
    notify(tx, from, "handoff", &format!("{} {} your handoff", actor.label, status.to_lowercase()), "handoff", id).await?;
    let kind = match status {
        "Accepted" => "handoff.accepted",
        "Declined" => "handoff.declined",
        _ => "handoff.cancelled",
    };
    let mut c = change(actor, op, "handoff", id, Some(lead_id), kind);
    c.before = Some(handoff);
    c.after = Some(updated.clone());
    record(tx, c).await?;
    Ok(updated)
}

// ---------------------------------------------------------------------------------------------------------- deals

const DEAL_EDITABLE: &[&str] = &["stage", "amount", "fee", "currency", "close_date", "outcome_reason"];

async fn deal_create(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "finance")?;
    let lead_id = uuid_field(p, "lead_id")?;
    visible_lead(tx, lead_id, false).await?;
    let deal: Option<Value> = sqlx::query_scalar(
        "INSERT INTO deals (org_id, lead_id, property_id, stage) SELECT org_id, id, property_id, 'Qualified' FROM leads WHERE id = $1 \
         ON CONFLICT (lead_id) DO NOTHING RETURNING to_jsonb(deals.*)",
    )
    .bind(lead_id)
    .fetch_optional(&mut *tx)
    .await?;
    let deal = deal.ok_or_else(|| Failure::Rejected("This lead already has a deal".into()))?;
    let id = Uuid::parse_str(deal["id"].as_str().unwrap_or_default()).unwrap_or_default();
    let mut c = change(actor, op, "deal", id, Some(lead_id), "deal.created");
    c.after = Some(deal.clone());
    record(tx, c).await?;
    Ok(deal)
}

async fn deal_update(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    need(actor, "finance")?;
    let id = uuid_field(p, "id")?;
    let changes = p.get("changes").and_then(Value::as_object).cloned().unwrap_or_default();
    let base = p.get("base").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(field) = changes.keys().find(|f| !DEAL_EDITABLE.contains(&f.as_str())) {
        return Err(Failure::Rejected(format!("{field} cannot be changed this way")));
    }
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM deals d WHERE d.id = $1 AND turf_visible_lead(d.lead_id) FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Failure::Rejected("The deal was not found or is outside your access".into()))?;
    check_base(&before, &changes, &base)?;
    if let Some(stage) = changes.get("stage").and_then(Value::as_str) {
        let pipeline = stages(tx, "pipeline.deal", DEAL_STAGES).await?;
        if !pipeline.iter().any(|s| s == stage) {
            return Err(Failure::Rejected(format!("{stage} is not a deal stage")));
        }
        let reason = changes.get("outcome_reason").or(before.get("outcome_reason")).and_then(Value::as_str).unwrap_or("");
        if stage == "Closed lost" && reason.trim().is_empty() {
            return Err(Failure::Rejected("Say why the deal was lost".into()));
        }
    }
    let mut merged = before.clone();
    for (field, value) in &changes {
        merged[field] = value.clone();
    }
    let deal: Value = sqlx::query_scalar(
        "UPDATE deals d SET (stage, amount, fee, currency, close_date, outcome_reason) = \
           (SELECT r.stage, r.amount, r.fee, r.currency, r.close_date, r.outcome_reason FROM jsonb_populate_record(NULL::deals, $2) r), \
         version = d.version + 1 WHERE d.id = $1 RETURNING to_jsonb(d.*)",
    )
    .bind(id)
    .bind(&merged)
    .fetch_one(&mut *tx)
    .await?;
    let lead_id = deal.get("lead_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
    let kind = if before["stage"] != deal["stage"] { "deal.stage_changed" } else { "deal.updated" };
    let mut c = change(actor, op, "deal", id, lead_id, kind);
    c.before = Some(before);
    c.after = Some(deal.clone());
    record(tx, c).await?;
    Ok(deal)
}

// ---------------------------------------------------------------------------------------------- communication etc.

async fn message_draft(tx: &mut PgConnection, actor: &Actor, op: &Op, p: &Value) -> OpOutcome {
    if !actor.scope.access.can("message") && !actor.scope.access.can("publicComment") {
        return Err(Failure::Rejected("Your role cannot write messages".into()));
    }
    let body = text(p, "body");
    if body.is_empty() {
        return Err(Failure::Rejected("A message needs some text".into()));
    }
    let conversation = match opt_uuid(p, "conversation_id")? {
        Some(id) => {
            let ok: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND (c.lead_id IS NULL OR turf_visible_lead(c.lead_id)) AND (NOT turf_external() OR c.shared_external))",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if !ok {
                return Err(Failure::Rejected("The conversation was not found or is outside your access".into()));
            }
            id
        }
        None => {
            let lead_id = uuid_field(p, "lead_id")?;
            visible_lead(tx, lead_id, false).await?;
            let channel = match text(p, "channel").as_str() {
                "sms" => "sms",
                "internal" => "internal",
                _ => "email",
            };
            sqlx::query_scalar("INSERT INTO conversations (org_id, lead_id, channel, subject, shared_external) VALUES (turf_org(), $1, $2, $3, $4) RETURNING id")
                .bind(lead_id)
                .bind(channel)
                .bind(text(p, "subject"))
                .bind(actor.scope.access.scopes.iter().all(|s| s == "shared"))
                .fetch_one(&mut *tx)
                .await?
        }
    };
    // Outreach stays a draft; sending is an online action that rechecks permission and suppression (plan 2.7, 3.5).
    let message: Value = sqlx::query_scalar(
        "INSERT INTO messages (org_id, conversation_id, direction, author_id, author_label, body, status, operation_id) \
         VALUES (turf_org(), $1, 'outbound', $2, $3, $4, 'draft', $5) RETURNING to_jsonb(messages.*)",
    )
    .bind(conversation)
    .bind(actor.scope.user_id)
    .bind(&actor.label)
    .bind(&body)
    .bind(op.id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE conversations SET updated_at = now() WHERE id = $1").bind(conversation).execute(&mut *tx).await?;
    let lead_id: Option<Uuid> = sqlx::query_scalar("SELECT lead_id FROM conversations WHERE id = $1").bind(conversation).fetch_one(&mut *tx).await?;
    let id = Uuid::parse_str(message["id"].as_str().unwrap_or_default()).unwrap_or_default();
    let mut c = change(actor, op, "message", id, lead_id, "message.drafted");
    c.after = Some(message.clone());
    record(tx, c).await?;
    Ok(message)
}

async fn follow(tx: &mut PgConnection, actor: &Actor, p: &Value) -> OpOutcome {
    let lead_id = uuid_field(p, "lead_id")?;
    let user = actor.scope.user_id.ok_or_else(|| Failure::Rejected("Only people follow leads".into()))?;
    visible_lead(tx, lead_id, false).await?;
    if p.get("follow").and_then(Value::as_bool).unwrap_or(true) {
        sqlx::query("INSERT INTO followers (org_id, lead_id, user_id) VALUES (turf_org(), $1, $2) ON CONFLICT DO NOTHING")
            .bind(lead_id)
            .bind(user)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM followers WHERE lead_id = $1 AND user_id = $2").bind(lead_id).bind(user).execute(&mut *tx).await?;
    }
    Ok(json!({ "lead_id": lead_id }))
}

async fn notification_read(tx: &mut PgConnection, actor: &Actor, p: &Value) -> OpOutcome {
    let user = actor.scope.user_id.ok_or_else(|| Failure::Rejected("Only people read notifications".into()))?;
    let ids: Vec<Uuid> = p
        .get("ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok())).collect())
        .unwrap_or_default();
    let count = sqlx::query("UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE user_id = $1 AND (cardinality($2::uuid[]) = 0 OR id = ANY($2))")
        .bind(user)
        .bind(&ids)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    Ok(json!({ "read": count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_check_applies_untouched_and_identical_fields() {
        let current = json!({ "stage": "Contacted", "priority": "High", "next_action_at": "2026-10-16T10:00:00+00:00" });
        let changes = json!({ "stage": "Interested", "priority": "High" });
        let base = json!({ "stage": "Contacted", "priority": "Normal" });
        assert!(check_base(&current, changes.as_object().unwrap(), base.as_object().unwrap()).is_ok());
        let stale = json!({ "stage": "New" });
        match check_base(&current, changes.as_object().unwrap(), stale.as_object().unwrap()) {
            Err(Failure::Conflict(fields)) => assert_eq!(fields["stage"]["server"], "Contacted"),
            _ => panic!("expected a conflict"),
        }
        let same_time = json!({ "next_action_at": "2026-10-17T00:00:00Z" });
        let base_time = json!({ "next_action_at": "2026-10-16T10:00:00Z" });
        assert!(check_base(&current, same_time.as_object().unwrap(), base_time.as_object().unwrap()).is_ok());
    }

    #[test]
    fn recurrence_supports_daily_weekly_monthly() {
        let from = DateTime::parse_from_rfc3339("2026-01-31T09:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(next_occurrence("FREQ=WEEKLY;INTERVAL=2", from).unwrap().to_rfc3339(), "2026-02-14T09:00:00+00:00");
        assert_eq!(next_occurrence("FREQ=MONTHLY", from).unwrap().to_rfc3339(), "2026-02-28T09:00:00+00:00");
        assert!(next_occurrence("FREQ=HOURLY", from).is_none());
        assert!(next_occurrence("FREQ=DAILY;INTERVAL=0", from).is_none());
    }
}
