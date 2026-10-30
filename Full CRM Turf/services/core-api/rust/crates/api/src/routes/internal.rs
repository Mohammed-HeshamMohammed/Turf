//! Internal routes for workers on the private network (plan 2.3, internal job API). Workers present a named token;
//! job calls also need the lease the worker holds. Workers never change ownership, permissions or canonical records
//! directly: rule actions run here as operations, with the same checks as people's.

use crate::{
    db::{self, Scope},
    error::{ApiError, ApiResult},
    ops::{self, Actor, Op},
    record::{record, Change},
    routes::reports::TRIGGERS,
    state::AppState,
};
use axum::{
    extract::{FromRequestParts, Path, State},
    http::request::Parts,
    routing::post,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/jobs/claim", post(claim_job))
        .route("/jobs/{id}/renew", post(renew_job))
        .route("/jobs/{id}/progress", post(progress_job))
        .route("/jobs/{id}/complete", post(complete_job))
        .route("/jobs/{id}/fail", post(fail_job))
        .route("/events/claim", post(claim_events))
        .route("/events/{id}/process", post(process_event))
        .route("/scheduler/tick", post(tick))
        .route("/legacy/import", post(crate::routes::artifacts::legacy_import))
        .route("/whoami", post(whoami))
}

/// A worker identified by its token (CALLERWHALE_WORKER_TOKENS=name=token,...).
pub struct Worker(pub String);

impl FromRequestParts<AppState> for Worker {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let presented = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Worker "))
            .ok_or(ApiError::Unauthenticated)?;
        let presented_hash = Sha256::digest(presented.as_bytes());
        // Compare digests so the comparison takes the same time whatever the token.
        for (name, token) in &state.config.worker_tokens {
            if Sha256::digest(token.as_bytes()) == presented_hash {
                return Ok(Worker(name.clone()));
            }
        }
        Err(ApiError::Unauthenticated)
    }
}

async fn whoami(Worker(name): Worker) -> Json<Value> {
    Json(json!({ "worker": name }))
}

// ------------------------------------------------------------------------------------------------------------ jobs

#[derive(Deserialize)]
struct Claim {
    queues: Vec<String>,
    #[serde(default = "lease")]
    lease_seconds: i32,
}

fn lease() -> i32 {
    60
}

async fn claim_job(State(state): State<AppState>, Worker(worker): Worker, Json(body): Json<Claim>) -> ApiResult<Json<Value>> {
    let lease = body.lease_seconds.clamp(10, 900);
    let claimed: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT id, org_id FROM turf_claim_job($1, $2, $3)").bind(&body.queues).bind(&worker).bind(lease).fetch_optional(&state.db).await?;
    let Some((id, org)) = claimed else { return Ok(Json(json!({ "job": null }))) };
    let mut tx = db::begin(&state.db, &Scope::system(org)).await?;
    let job: Value = sqlx::query_scalar("SELECT to_jsonb(j) FROM jobs j WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "job": job })))
}

#[derive(Deserialize)]
struct JobCall {
    org_id: Uuid,
    #[serde(default)]
    lease_seconds: Option<i32>,
    #[serde(default)]
    progress: Option<f32>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    output: Value,
    #[serde(default)]
    error: String,
    #[serde(default)]
    retry: bool,
}

async fn held(tx: &mut db::Tx, id: Uuid, worker: &str) -> ApiResult<Value> {
    sqlx::query_scalar("SELECT to_jsonb(j) FROM jobs j WHERE id = $1 AND lease_owner = $2 AND status = 'running' FOR UPDATE")
        .bind(id)
        .bind(worker)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| ApiError::Conflict("This worker no longer holds the job's lease".into()))
}

async fn renew_job(State(state): State<AppState>, Worker(worker): Worker, Path(id): Path<Uuid>, Json(body): Json<JobCall>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    held(&mut tx, id, &worker).await?;
    let cancel: bool = sqlx::query_scalar("UPDATE jobs SET lease_until = now() + make_interval(secs => $2) WHERE id = $1 RETURNING cancel_requested")
        .bind(id)
        .bind(body.lease_seconds.unwrap_or(60).clamp(10, 900))
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "cancel_requested": cancel })))
}

async fn progress_job(State(state): State<AppState>, Worker(worker): Worker, Path(id): Path<Uuid>, Json(body): Json<JobCall>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    held(&mut tx, id, &worker).await?;
    let cancel: bool = sqlx::query_scalar("UPDATE jobs SET progress = $2, message = $3 WHERE id = $1 RETURNING cancel_requested")
        .bind(id)
        .bind(body.progress.unwrap_or(0.0).clamp(0.0, 1.0))
        .bind(&body.message)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "cancel_requested": cancel })))
}

async fn complete_job(State(state): State<AppState>, Worker(worker): Worker, Path(id): Path<Uuid>, Json(body): Json<JobCall>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let job = held(&mut tx, id, &worker).await?;
    let cancelled = job["cancel_requested"] == json!(true);
    sqlx::query("UPDATE jobs SET status = $2, progress = 1, output = $3, finished_at = now(), lease_owner = NULL WHERE id = $1")
        .bind(id)
        .bind(if cancelled { "cancelled" } else { "done" })
        .bind(&body.output)
        .execute(&mut *tx)
        .await?;
    let mut c = Change::new("job", id, "job.completed");
    c.after = Some(json!({ "kind": job["kind"], "status": if cancelled { "cancelled" } else { "done" } }));
    record(&mut tx, c).await?;
    // A finished import publishes its dataset: the rules engine's "import published" trigger.
    if job["kind"] == "import" && !cancelled {
        if let Some(dataset) = body.output.get("dataset_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok()) {
            sqlx::query("UPDATE datasets SET status = 'Published' WHERE id = $1").bind(dataset).execute(&mut *tx).await?;
            record(&mut tx, Change::new("dataset", dataset, "dataset.published")).await?;
        }
    }
    tx.commit().await?;
    Ok(Json(json!({ "status": if cancelled { "cancelled" } else { "done" } })))
}

async fn fail_job(State(state): State<AppState>, Worker(worker): Worker, Path(id): Path<Uuid>, Json(body): Json<JobCall>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let job = held(&mut tx, id, &worker).await?;
    let attempts = job["attempts"].as_i64().unwrap_or(1);
    let max = job["max_attempts"].as_i64().unwrap_or(3);
    let again = body.retry && attempts < max && job["cancel_requested"] != json!(true);
    // Retries back off: 30 s, 2 min, 8 min ...
    let status: String = sqlx::query_scalar(
        "UPDATE jobs SET status = CASE WHEN $2 THEN 'queued' ELSE 'failed' END, message = $3, lease_owner = NULL, lease_until = NULL, \
           run_after = CASE WHEN $2 THEN now() + make_interval(secs => 30 * power(4, attempts - 1)) ELSE run_after END, \
           finished_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1 RETURNING status",
    )
    .bind(id)
    .bind(again)
    .bind(body.error.chars().take(2000).collect::<String>())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "status": status })))
}

// ----------------------------------------------------------------------------------------------- events and rules

#[derive(Deserialize)]
struct EventClaim {
    #[serde(default = "batch")]
    limit: i32,
    #[serde(default = "lease")]
    lease_seconds: i32,
}

fn batch() -> i32 {
    50
}

async fn claim_events(State(state): State<AppState>, Worker(worker): Worker, Json(body): Json<EventClaim>) -> ApiResult<Json<Value>> {
    let claimed: Vec<(i64, Uuid)> = sqlx::query_as("SELECT id, org_id FROM turf_claim_events($1, $2, $3)")
        .bind(&worker)
        .bind(body.limit.clamp(1, 500))
        .bind(body.lease_seconds.clamp(10, 900))
        .fetch_all(&state.db)
        .await?;
    let mut events = Vec::new();
    for (id, org) in claimed {
        let mut tx = db::begin(&state.db, &Scope::system(org)).await?;
        let event: Value = sqlx::query_scalar("SELECT to_jsonb(e) - 'payload' FROM outbox_events e WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        events.push(event);
    }
    Ok(Json(json!({ "events": events })))
}

#[derive(Deserialize)]
struct Process {
    org_id: Uuid,
}

/// Most rule actions an event may start before its effects stop starting rules: bounds rule loops.
const MAX_DEPTH: i32 = 3;

/// Runs every enabled rule listening to this event's kind, once per rule version, then marks the event processed.
async fn process_event(State(state): State<AppState>, Worker(worker): Worker, Path(id): Path<i64>, Json(body): Json<Process>) -> ApiResult<Json<Value>> {
    let system = Scope::system(body.org_id);
    let mut tx = db::begin(&state.db, &system).await?;
    let event: Value = sqlx::query_scalar("SELECT to_jsonb(e) FROM outbox_events e WHERE id = $1 AND claimed_by = $2 FOR UPDATE")
        .bind(id)
        .bind(&worker)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::Conflict("This worker does not hold the event".into()))?;
    if !event["processed_at"].is_null() {
        return Ok(Json(json!({ "already_processed": true })));
    }
    let kind = event["kind"].as_str().unwrap_or("").to_string();
    let depth = event["depth"].as_i64().unwrap_or(0) as i32;
    let rules: Vec<Value> = if TRIGGERS.contains(&kind.as_str()) {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM rules r WHERE enabled AND trigger = $1 ORDER BY created_by, id").bind(&kind).fetch_all(&mut *tx).await?
    } else {
        vec![]
    };
    let lead_id = event["lead_id"].as_str().and_then(|s| Uuid::parse_str(s).ok());
    let lead: Value = match lead_id {
        Some(lead) => sqlx::query_scalar("SELECT to_jsonb(l) FROM leads l WHERE id = $1 AND deleted_at IS NULL").bind(lead).fetch_optional(&mut *tx).await?.unwrap_or(Value::Null),
        None => Value::Null,
    };
    tx.commit().await?;
    let mut runs = Vec::new();
    for rule in rules {
        let rule_id = Uuid::parse_str(rule["id"].as_str().unwrap_or_default()).unwrap_or_default();
        let version = rule["version"].as_i64().unwrap_or(1) as i32;
        let matched = !lead.is_null() && conditions_match(&rule["conditions"], &lead, &event["payload"]);
        let mut results = Vec::new();
        let mut error = None;
        if matched && depth >= MAX_DEPTH {
            error = Some("Stopped: rule actions were starting more rules".to_string());
        } else if matched {
            let actions = rule["actions"].as_array().cloned().unwrap_or_default();
            for (index, action) in actions.iter().enumerate() {
                match act(&state, &system, &rule, action, &lead, id, index, depth + 1).await {
                    Ok(result) => results.push(json!({ "type": action["type"], "status": result.status, "message": result.message })),
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                }
            }
        }
        let mut tx = db::begin(&state.db, &system).await?;
        sqlx::query(
            "INSERT INTO rule_runs (org_id, rule_id, rule_version, event_id, matched, actions, error) VALUES (turf_org(), $1, $2, $3, $4, $5, $6) \
             ON CONFLICT (rule_id, rule_version, event_id, dry_run) DO NOTHING",
        )
        .bind(rule_id)
        .bind(version)
        .bind(id)
        .bind(matched)
        .bind(json!(results))
        .bind(&error)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        runs.push(json!({ "rule_id": rule_id, "matched": matched, "actions": results, "error": error }));
    }
    let mut tx = db::begin(&state.db, &system).await?;
    sqlx::query("UPDATE outbox_events SET processed_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "runs": runs })))
}

/// A stable operation id per (rule, version, event, action): a retried event never repeats an action.
fn action_id(rule: Uuid, version: i32, event: i64, index: usize) -> Uuid {
    let digest = Sha256::digest(format!("rule:{rule}:{version}:{event}:{index}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

#[allow(clippy::too_many_arguments)]
async fn act(state: &AppState, system: &Scope, rule: &Value, action: &Value, lead: &Value, event: i64, index: usize, depth: i32) -> ApiResult<ops::OpResult> {
    let rule_id = Uuid::parse_str(rule["id"].as_str().unwrap_or_default()).unwrap_or_default();
    let version = rule["version"].as_i64().unwrap_or(1) as i32;
    let lead_id = lead["id"].clone();
    let assignee = lead["assignee_id"].as_str().and_then(|s| Uuid::parse_str(s).ok());
    let mut scope = system.clone();
    let (kind, payload) = match action["type"].as_str().unwrap_or("") {
        "create_task" => {
            let due = Utc::now() + chrono::Duration::hours(action["due_in_hours"].as_i64().unwrap_or(24).clamp(0, 24 * 365));
            let to = action["assign_to"].as_str().and_then(|s| Uuid::parse_str(s).ok()).or(assignee);
            ("task.create", json!({ "lead_id": lead_id, "title": action["title"].as_str().unwrap_or("Follow up"), "type": action["task_type"].as_str().unwrap_or("Task"),
                                     "priority": action["priority"].as_str().unwrap_or("Normal"), "due_at": due.to_rfc3339(), "assignee_id": to }))
        }
        "assign" => {
            let to = match action["to"].as_str().unwrap_or("") {
                "round_robin" | "workload" => pick_assignee(state, system, action).await?,
                other => Uuid::parse_str(other).ok(),
            };
            let Some(to) = to else { return Err(ApiError::bad("No one is available to assign")) };
            ("lead.assign", json!({ "ids": [lead_id], "assignee_id": to, "team_id": action["team_id"], "reason": format!("Rule: {}", rule["name"].as_str().unwrap_or("")) }))
        }
        "notify" => {
            let to = match action["to"].as_str().unwrap_or("assignee") {
                "assignee" => assignee,
                other => Uuid::parse_str(other).ok(),
            };
            let Some(to) = to else { return Err(ApiError::bad("No one to notify")) };
            let mut tx = db::begin(&state.db, system).await?;
            let op = action_id(rule_id, version, event, index);
            let fresh: Option<Uuid> = sqlx::query_scalar(
                "INSERT INTO operations (id, org_id, kind, payload, status) VALUES ($1, turf_org(), 'notify', '{}', 'applied') ON CONFLICT DO NOTHING RETURNING id",
            )
            .bind(op)
            .fetch_optional(&mut *tx)
            .await?;
            if fresh.is_some() {
                sqlx::query("INSERT INTO notifications (org_id, user_id, kind, text, entity, entity_id) VALUES (turf_org(), $1, 'rule', $2, 'lead', $3)")
                    .bind(to)
                    .bind(action["text"].as_str().unwrap_or("A rule needs your attention"))
                    .bind(lead["id"].as_str().and_then(|s| Uuid::parse_str(s).ok()))
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            return Ok(ops::OpResult { id: op, status: if fresh.is_some() { "applied" } else { "duplicate" }.into(), original_status: None, result: Value::Null, message: None });
        }
        "request_handoff" => {
            // The handoff is from the lead's owner, on their behalf.
            scope.user_id = assignee;
            ("handoff.request", json!({ "lead_id": lead_id, "to_user": action["to_user"], "note": action["note"].as_str().unwrap_or("Requested by a rule") }))
        }
        "move_stage" => ("lead.update", json!({ "id": lead_id, "changes": { "stage": action["stage"] } })),
        "send_template" => {
            let mut tx = db::begin(&state.db, system).await?;
            let template: Option<(String, bool)> =
                sqlx::query_as("SELECT body, approved FROM templates WHERE id = $1").bind(action["template_id"].as_str().and_then(|s| Uuid::parse_str(s).ok())).fetch_optional(&mut *tx).await?;
            tx.commit().await?;
            let (body, approved) = template.ok_or_else(|| ApiError::bad("The template no longer exists"))?;
            if !approved {
                return Err(ApiError::bad("Only approved templates are sent by rules"));
            }
            // Queued as a draft; the communication adapters send it after rechecking suppression (plan 3.5).
            ("message.draft", json!({ "lead_id": lead_id, "channel": action["channel"].as_str().unwrap_or("email"), "body": body }))
        }
        other => return Err(ApiError::bad(format!("{other} is not an action"))),
    };
    let actor = Actor { scope, label: format!("Rule: {}", rule["name"].as_str().unwrap_or("")), depth };
    let op = Op { id: action_id(rule_id, version, event, index), kind: kind.into(), payload, claimed_at: None, queued_offline: false, device_id: "rules".into() };
    ops::apply(&state.db, &actor, op).await
}

/// Round robin across people with the "call" capability in a team (or the organization), or the least loaded.
async fn pick_assignee(state: &AppState, system: &Scope, action: &Value) -> ApiResult<Option<Uuid>> {
    let team = action["team_id"].as_str().and_then(|s| Uuid::parse_str(s).ok());
    let mut tx = db::begin(&state.db, system).await?;
    let people: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT m.user_id, (SELECT count(*) FROM leads l WHERE l.assignee_id = m.user_id AND l.deleted_at IS NULL AND l.stage <> 'Closed') \
         FROM memberships m JOIN roles r ON r.org_id = m.org_id AND r.key = ANY(m.roles) \
         WHERE m.org_id = turf_org() AND 'call' = ANY(r.capabilities) AND NOT ('call' = ANY(m.restrictions)) AND ($1::uuid IS NULL OR $1 = ANY(m.team_ids)) \
         GROUP BY m.user_id ORDER BY m.user_id",
    )
    .bind(team)
    .fetch_all(&mut *tx)
    .await?;
    if people.is_empty() {
        return Ok(None);
    }
    let chosen = if action["to"] == "workload" {
        people.iter().min_by_key(|(id, open)| (*open, *id)).map(|(id, _)| *id)
    } else {
        let key = format!("round_robin:{}", team.map(|t| t.to_string()).unwrap_or_default());
        let last: Option<Uuid> = sqlx::query_scalar("SELECT last_user FROM assignment_cursors WHERE key = $1 FOR UPDATE").bind(&key).fetch_optional(&mut *tx).await?.flatten();
        let next = match last.and_then(|l| people.iter().position(|(id, _)| *id == l)) {
            Some(i) => people[(i + 1) % people.len()].0,
            None => people[0].0,
        };
        sqlx::query("INSERT INTO assignment_cursors (org_id, key, last_user) VALUES (turf_org(), $1, $2) ON CONFLICT (org_id, key) DO UPDATE SET last_user = $2")
            .bind(&key)
            .bind(next)
            .execute(&mut *tx)
            .await?;
        Some(next)
    };
    tx.commit().await?;
    Ok(chosen)
}

/// Whether every condition holds. Fields come from the lead, or from the event with an "event." prefix.
pub fn conditions_match(conditions: &Value, lead: &Value, event: &Value) -> bool {
    let Some(list) = conditions.as_array() else { return true };
    list.iter().all(|condition| {
        let field = condition["field"].as_str().unwrap_or("");
        let actual = match field.strip_prefix("event.") {
            Some(path) => path.split('.').fold(event, |v, key| &v[key]),
            None => &lead[field],
        };
        let expected = &condition["value"];
        match condition["op"].as_str().unwrap_or("") {
            "eq" => loose_eq(actual, expected),
            "ne" => !loose_eq(actual, expected),
            "in" => expected.as_array().map(|values| values.iter().any(|v| loose_eq(actual, v))).unwrap_or(false),
            "contains" => actual.as_str().zip(expected.as_str()).map(|(a, e)| a.to_lowercase().contains(&e.to_lowercase())).unwrap_or(false),
            "gt" => number(actual).zip(number(expected)).map(|(a, e)| a > e).unwrap_or(false),
            "lt" => number(actual).zip(number(expected)).map(|(a, e)| a < e).unwrap_or(false),
            "older_than_hours" => actual
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .zip(number(expected))
                .map(|(at, hours)| (Utc::now() - at.with_timezone(&Utc)).num_minutes() as f64 > hours * 60.0)
                .unwrap_or(false),
            "exists" => !actual.is_null() && actual != &json!(""),
            _ => false,
        }
    })
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    a == b || number(a).zip(number(b)).map(|(x, y)| x == y).unwrap_or(false)
}

// -------------------------------------------------------------------------------------------------------- scheduler

/// Called by the Go scheduler every minute: emits task.overdue and handoff overdue events once, and queues
/// scheduled reports that are due.
async fn tick(State(state): State<AppState>, Worker(_): Worker) -> ApiResult<Json<Value>> {
    let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT turf_orgs_with_due_work()").fetch_all(&state.db).await?;
    let (mut overdue_tasks, mut overdue_handoffs, mut reports) = (0, 0, 0);
    for org in orgs {
        let mut tx = db::begin(&state.db, &Scope::system(org)).await?;
        let tasks: Vec<(Uuid, Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
            "UPDATE tasks SET overdue_emitted_at = now() WHERE id IN (SELECT id FROM tasks WHERE done_at IS NULL AND overdue_emitted_at IS NULL AND due_at < now() LIMIT 1000 FOR UPDATE SKIP LOCKED) \
             RETURNING id, lead_id, assignee_id",
        )
        .fetch_all(&mut *tx)
        .await?;
        for (id, lead, _) in &tasks {
            let mut c = Change::new("task", *id, "task.overdue");
            c.lead_id = *lead;
            record(&mut tx, c).await?;
        }
        overdue_tasks += tasks.len();
        let handoffs: Vec<(Uuid, Uuid, Uuid, Uuid)> = sqlx::query_as(
            "UPDATE handoffs SET overdue_emitted_at = now() WHERE status = 'Requested' AND overdue_emitted_at IS NULL AND due_at < now() RETURNING id, lead_id, from_user, to_user",
        )
        .fetch_all(&mut *tx)
        .await?;
        for (id, lead, from, to) in &handoffs {
            for user in [from, to] {
                sqlx::query("INSERT INTO notifications (org_id, user_id, kind, text, entity, entity_id) VALUES (turf_org(), $1, 'handoff', 'A handoff is overdue', 'handoff', $2)")
                    .bind(user)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            let mut c = Change::new("handoff", *id, "handoff.overdue");
            c.lead_id = Some(*lead);
            record(&mut tx, c).await?;
        }
        overdue_handoffs += handoffs.len();
        let due: Vec<(Uuid, Uuid)> = sqlx::query_as(
            "UPDATE saved_reports SET last_sent_at = now() WHERE schedule IS NOT NULL AND (last_sent_at IS NULL OR last_sent_at < now() - CASE schedule \
               WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '1 month' END) RETURNING id, owner_id",
        )
        .fetch_all(&mut *tx)
        .await?;
        for (report, owner) in &due {
            sqlx::query("INSERT INTO jobs (org_id, kind, queue, input, created_by) VALUES (turf_org(), 'report', 'python', $1, $2)")
                .bind(json!({ "saved_report_id": report }))
                .bind(owner)
                .execute(&mut *tx)
                .await?;
        }
        reports += due.len();
        tx.commit().await?;
    }
    Ok(Json(json!({ "overdue_tasks": overdue_tasks, "overdue_handoffs": overdue_handoffs, "reports_queued": reports })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditions_cover_operators_and_event_fields() {
        let lead = json!({ "stage": "Qualified", "value_amount": "250000.00", "updated_at": "2020-01-01T00:00:00Z", "email": "" });
        let event = json!({ "after": { "outcome": "Transfer" } });
        let all = json!([
            { "field": "stage", "op": "in", "value": ["Qualified", "Interested"] },
            { "field": "value_amount", "op": "gt", "value": 200000 },
            { "field": "updated_at", "op": "older_than_hours", "value": 48 },
            { "field": "event.after.outcome", "op": "eq", "value": "Transfer" },
        ]);
        assert!(conditions_match(&all, &lead, &event));
        assert!(!conditions_match(&json!([{ "field": "email", "op": "exists" }]), &lead, &event));
        assert!(!conditions_match(&json!([{ "field": "stage", "op": "bogus" }]), &lead, &event));
    }

    #[test]
    fn action_ids_are_stable_and_distinct() {
        let rule = Uuid::nil();
        assert_eq!(action_id(rule, 1, 7, 0), action_id(rule, 1, 7, 0));
        assert_ne!(action_id(rule, 1, 7, 0), action_id(rule, 2, 7, 0));
        assert_ne!(action_id(rule, 1, 7, 0), action_id(rule, 1, 7, 1));
    }
}
