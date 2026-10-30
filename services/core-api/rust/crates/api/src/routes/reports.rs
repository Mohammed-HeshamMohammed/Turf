//! Reports, saved/scheduled reports, rules and background jobs (plan 3.6).

use crate::{
    auth::Ctx,
    db,
    error::{ApiError, ApiResult},
    record::{record, Change},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/reports/{kind}", get(report))
        .route("/saved-reports", get(saved).post(save_report))
        .route("/saved-reports/{id}", put(update_saved).delete(delete_saved))
        .route("/rules", get(rules).post(create_rule))
        .route("/rules/{id}", put(update_rule))
        .route("/rules/{id}/runs", get(rule_runs))
        .route("/rules/{id}/dry-run", post(dry_run))
        .route("/jobs", get(jobs).post(enqueue))
        .route("/jobs/{id}", get(job))
        .route("/jobs/{id}/cancel", post(cancel_job))
        .route("/exports/leads.csv", get(export_leads))
}

#[derive(Deserialize, Default)]
pub struct ReportQuery {
    #[serde(default)]
    from: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    to: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    format: String,
    #[serde(default)]
    team: Option<Uuid>,
}

/// The SQL for each report. Every one is scoped by callerwhale_visible_lead().
fn report_sql(kind: &str) -> Option<&'static str> {
    Some(match kind {
        // Contact rate and outcomes per agent.
        "outcomes" => "SELECT coalesce(c.agent_label, '') AS agent, c.outcome, count(*) AS calls, \
            round(100.0 * count(*) FILTER (WHERE c.meaning = 'reached') / nullif(count(*), 0), 1) AS reached_pct \
            FROM call_events c JOIN leads l ON l.id = c.lead_id WHERE callerwhale_visible_lead(c.lead_id) AND c.occurred_at >= $1 AND c.occurred_at < $2 \
            AND ($3::uuid IS NULL OR l.team_id = $3) GROUP BY 1, 2 ORDER BY 1, 3 DESC",
        // Source performance: how each list converts.
        "sources" => "SELECT coalesce(d.name, l.source) AS source, count(DISTINCT l.id) AS leads, \
            count(DISTINCT l.id) FILTER (WHERE EXISTS (SELECT 1 FROM call_events c WHERE c.lead_id = l.id AND c.meaning = 'reached')) AS contacted, \
            count(DISTINCT l.id) FILTER (WHERE l.stage IN ('Qualified', 'Closed')) AS qualified, \
            count(DISTINCT dl.id) FILTER (WHERE dl.stage = 'Closed won') AS won \
            FROM leads l LEFT JOIN lead_sources s ON s.lead_id = l.id LEFT JOIN datasets d ON d.id = s.dataset_id LEFT JOIN deals dl ON dl.lead_id = l.id \
            WHERE callerwhale_visible_lead(l.id) AND l.created_at < $2 AND ($3::uuid IS NULL OR l.team_id = $3) AND $1 IS NOT NULL GROUP BY 1 ORDER BY 2 DESC",
        // Qualification and accepted handoffs.
        "handoffs" => "SELECT h.status, count(*) AS handoffs, round(avg(extract(epoch FROM h.decided_at - h.created_at) / 3600)::numeric, 1) AS hours_to_decide \
            FROM handoffs h JOIN leads l ON l.id = h.lead_id WHERE callerwhale_visible_lead(h.lead_id) AND h.created_at >= $1 AND h.created_at < $2 \
            AND ($3::uuid IS NULL OR l.team_id = $3) GROUP BY 1 ORDER BY 2 DESC",
        // Missed follow-ups: callbacks and tasks past due and still open.
        "missed" => "SELECT coalesce(u.display_name, 'Unassigned') AS person, t.type, count(*) AS missed \
            FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN leads l ON l.id = t.lead_id \
            WHERE t.done_at IS NULL AND t.due_at < now() AND t.due_at >= $1 AND t.due_at < $2 AND (t.lead_id IS NULL OR callerwhale_visible_lead(t.lead_id)) \
            AND ($3::uuid IS NULL OR l.team_id = $3) GROUP BY 1, 2 ORDER BY 3 DESC",
        // Stage aging for leads.
        "aging" => "SELECT l.stage, count(*) AS leads, round(avg(extract(epoch FROM now() - l.updated_at) / 86400)::numeric, 1) AS avg_days_since_change \
            FROM leads l WHERE callerwhale_visible_lead(l.id) AND l.created_at < $2 AND $1 IS NOT NULL AND ($3::uuid IS NULL OR l.team_id = $3) GROUP BY 1 ORDER BY 2 DESC",
        // Workload per person.
        "workload" => "SELECT coalesce(u.display_name, 'Unassigned') AS person, count(*) FILTER (WHERE l.stage <> 'Closed') AS open_leads, \
            (SELECT count(*) FROM tasks t WHERE t.assignee_id = l.assignee_id AND t.done_at IS NULL) AS open_tasks \
            FROM leads l LEFT JOIN users u ON u.id = l.assignee_id WHERE callerwhale_visible_lead(l.id) AND $1 IS NOT NULL AND $2 IS NOT NULL \
            AND ($3::uuid IS NULL OR l.team_id = $3) GROUP BY u.display_name, l.assignee_id ORDER BY 2 DESC",
        // Deal outcomes and recorded revenue: needs the finance permission.
        "revenue" => "SELECT d.stage, count(*) AS deals, coalesce(sum(d.amount), 0) AS amount, coalesce(sum(d.fee), 0) AS recorded_revenue, d.currency \
            FROM deals d JOIN leads l ON l.id = d.lead_id WHERE callerwhale_visible_lead(d.lead_id) AND d.created_at >= $1 AND d.created_at < $2 \
            AND ($3::uuid IS NULL OR l.team_id = $3) GROUP BY d.stage, d.currency ORDER BY 2 DESC",
        _ => return None,
    })
}

pub async fn run_report(tx: &mut db::Tx, kind: &str, query: &ReportQuery) -> ApiResult<Vec<Value>> {
    let sql = report_sql(kind).ok_or_else(|| ApiError::not_found("That report"))?;
    let from = query.from.unwrap_or_else(|| chrono::Utc::now() - chrono::Duration::days(30));
    let to = query.to.unwrap_or_else(chrono::Utc::now);
    let wrapped = format!("SELECT to_jsonb(r) FROM ({sql}) r");
    Ok(sqlx::query_scalar(&wrapped).bind(from).bind(to).bind(query.team).fetch_all(&mut **tx).await?)
}

pub fn csv(rows: &[Value]) -> String {
    let Some(first) = rows.first().and_then(Value::as_object) else { return String::new() };
    let columns: Vec<&String> = first.keys().collect();
    let cell = |value: &Value| {
        let text = match value {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        // Spreadsheet formula injection: a leading =, +, - or @ is quoted as text.
        let text = if text.starts_with(['=', '+', '-', '@']) && text.parse::<f64>().is_err() { format!("'{text}") } else { text };
        if text.contains([',', '"', '\n']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
    };
    let mut out = columns.iter().map(|c| cell(&json!(c))).collect::<Vec<_>>().join(",");
    out.push('\n');
    for row in rows {
        out.push_str(&columns.iter().map(|c| cell(row.get(c.as_str()).unwrap_or(&Value::Null))).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

async fn report(State(state): State<AppState>, ctx: Ctx, Path(kind): Path<String>, Query(query): Query<ReportQuery>) -> ApiResult<Response> {
    let scope = if kind == "revenue" { ctx.require("finance")? } else { ctx.scope()? };
    if query.format == "csv" && !scope.access.can("export") {
        return Err(ApiError::forbidden("Downloading reports needs the export permission"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows = run_report(&mut tx, &kind, &query).await?;
    if query.format == "csv" {
        return Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8"), (header::CONTENT_DISPOSITION, "attachment; filename=\"report.csv\"")], csv(&rows)).into_response());
    }
    Ok(Json(json!({ "kind": kind, "rows": rows })).into_response())
}

async fn export_leads(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Response> {
    let scope = ctx.require("export")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('name', l.name, 'phone', CASE WHEN l.do_not_call THEN '' ELSE l.phone END, 'email', l.email, 'stage', l.stage, \
           'verdict', l.verdict, 'do_not_call', l.do_not_call, 'address', p.address, 'city', p.city, 'region', p.region, 'postal_code', p.postal_code, \
           'assignee', u.display_name, 'next_action_at', l.next_action_at) \
         FROM leads l LEFT JOIN properties p ON p.id = l.property_id LEFT JOIN users u ON u.id = l.assignee_id WHERE callerwhale_visible_lead(l.id) ORDER BY l.name",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut c = Change::new("export", scope.org_id, "leads.exported");
    c.actor_id = Some(ctx.user_id);
    c.actor_label = &ctx.label;
    c.after = Some(json!({ "rows": rows.len() }));
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8"), (header::CONTENT_DISPOSITION, "attachment; filename=\"leads.csv\"")], csv(&rows)).into_response())
}

async fn saved(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM saved_reports r WHERE owner_id = $1 ORDER BY name").bind(ctx.user_id).fetch_all(&mut *tx).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct SavedBody {
    name: String,
    kind: String,
    #[serde(default)]
    filters: Value,
    #[serde(default)]
    schedule: Option<String>,
    #[serde(default = "csv_format")]
    format: String,
}

fn csv_format() -> String {
    "csv".into()
}

fn validate_saved(body: &SavedBody) -> ApiResult<()> {
    if report_sql(&body.kind).is_none() {
        return Err(ApiError::bad(format!("{} is not a report", body.kind)));
    }
    if let Some(schedule) = &body.schedule {
        if !["daily", "weekly", "monthly"].contains(&schedule.as_str()) {
            return Err(ApiError::bad("Schedule must be daily, weekly or monthly"));
        }
    }
    Ok(())
}

async fn save_report(State(state): State<AppState>, ctx: Ctx, Json(body): Json<SavedBody>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    validate_saved(&body)?;
    if body.schedule.is_some() && !scope.access.can("export") {
        return Err(ApiError::forbidden("Scheduled delivery needs the export permission"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let row: Value = sqlx::query_scalar(
        "INSERT INTO saved_reports (org_id, owner_id, name, kind, filters, schedule, format) VALUES (callerwhale_org(), $1, $2, $3, $4, $5, $6) RETURNING to_jsonb(saved_reports.*)",
    )
    .bind(ctx.user_id)
    .bind(body.name.trim())
    .bind(&body.kind)
    .bind(if body.filters.is_null() { json!({}) } else { body.filters.clone() })
    .bind(&body.schedule)
    .bind(&body.format)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}

async fn update_saved(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>, Json(body): Json<SavedBody>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    validate_saved(&body)?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let row: Value = sqlx::query_scalar(
        "UPDATE saved_reports SET name = $3, kind = $4, filters = $5, schedule = $6, format = $7 WHERE id = $1 AND owner_id = $2 RETURNING to_jsonb(saved_reports.*)",
    )
    .bind(id)
    .bind(ctx.user_id)
    .bind(body.name.trim())
    .bind(&body.kind)
    .bind(&body.filters)
    .bind(&body.schedule)
    .bind(&body.format)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("The report"))?;
    tx.commit().await?;
    Ok(Json(row))
}

async fn delete_saved(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let gone = sqlx::query("DELETE FROM saved_reports WHERE id = $1 AND owner_id = $2").bind(id).bind(ctx.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "deleted": gone.rows_affected() == 1 })))
}

// ------------------------------------------------------------------------------------------------------------ rules

pub const TRIGGERS: &[&str] = &[
    "dataset.published", "lead.qualified", "lead.stage_changed", "lead.created", "lead.assigned", "handoff.requested", "handoff.accepted",
    "task.overdue", "call.recorded", "message.received", "deal.stage_changed",
];
pub const ACTIONS: &[&str] = &["create_task", "assign", "notify", "request_handoff", "move_stage", "send_template"];
const OPERATORS: &[&str] = &["eq", "ne", "in", "contains", "gt", "lt", "older_than_hours", "exists"];

fn validate_rule(body: &RuleBody) -> ApiResult<()> {
    if !TRIGGERS.contains(&body.trigger.as_str()) {
        return Err(ApiError::bad(format!("{} is not a trigger", body.trigger)));
    }
    let conditions = body.conditions.as_array().ok_or_else(|| ApiError::bad("conditions must be a list"))?;
    if conditions.len() > 20 {
        return Err(ApiError::bad("Use at most 20 conditions"));
    }
    for condition in conditions {
        let op = condition.get("op").and_then(Value::as_str).unwrap_or("");
        if condition.get("field").and_then(Value::as_str).unwrap_or("").is_empty() || !OPERATORS.contains(&op) {
            return Err(ApiError::bad("Each condition needs a field and an operator"));
        }
    }
    let actions = body.actions.as_array().ok_or_else(|| ApiError::bad("actions must be a list"))?;
    if actions.is_empty() || actions.len() > 10 {
        return Err(ApiError::bad("Use 1 to 10 actions"));
    }
    for action in actions {
        let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
        if !ACTIONS.contains(&kind) {
            return Err(ApiError::bad(format!("{kind} is not an action")));
        }
    }
    Ok(())
}

async fn rules(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM rules r ORDER BY name").fetch_all(&mut *tx).await?;
    Ok(Json(json!({ "rules": rows, "triggers": TRIGGERS, "actions": ACTIONS, "operators": OPERATORS })))
}

#[derive(Deserialize)]
struct RuleBody {
    name: String,
    trigger: String,
    #[serde(default = "empty_list")]
    conditions: Value,
    actions: Value,
    #[serde(default = "yes")]
    enabled: bool,
}

fn empty_list() -> Value {
    json!([])
}
fn yes() -> bool {
    true
}

async fn create_rule(State(state): State<AppState>, ctx: Ctx, Json(body): Json<RuleBody>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    validate_rule(&body)?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rule: Value = sqlx::query_scalar(
        "INSERT INTO rules (org_id, name, trigger, conditions, actions, enabled, created_by) VALUES (callerwhale_org(), $1, $2, $3, $4, $5, $6) RETURNING to_jsonb(rules.*)",
    )
    .bind(body.name.trim())
    .bind(&body.trigger)
    .bind(&body.conditions)
    .bind(&body.actions)
    .bind(body.enabled)
    .bind(ctx.user_id)
    .fetch_one(&mut *tx)
    .await?;
    let id = Uuid::parse_str(rule["id"].as_str().unwrap_or_default()).unwrap_or_default();
    let mut c = Change::new("rule", id, "rule.created");
    c.actor_id = Some(ctx.user_id);
    c.actor_label = &ctx.label;
    c.after = Some(rule.clone());
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(Json(rule))
}

/// Every edit is a new version; history and runs keep the version they used.
async fn update_rule(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>, Json(body): Json<RuleBody>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    validate_rule(&body)?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM rules r WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(|| ApiError::not_found("The rule"))?;
    let rule: Value = sqlx::query_scalar(
        "UPDATE rules SET name = $2, trigger = $3, conditions = $4, actions = $5, enabled = $6, version = version + 1, updated_at = now() WHERE id = $1 RETURNING to_jsonb(rules.*)",
    )
    .bind(id)
    .bind(body.name.trim())
    .bind(&body.trigger)
    .bind(&body.conditions)
    .bind(&body.actions)
    .bind(body.enabled)
    .fetch_one(&mut *tx)
    .await?;
    let mut c = Change::new("rule", id, "rule.changed");
    c.actor_id = Some(ctx.user_id);
    c.actor_label = &ctx.label;
    c.before = Some(before);
    c.after = Some(rule.clone());
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(Json(rule))
}

async fn rule_runs(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM rule_runs r WHERE rule_id = $1 ORDER BY id DESC LIMIT 200").bind(id).fetch_all(&mut *tx).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct DryRun {
    /// A lead to test the conditions against.
    lead_id: Uuid,
}

/// Evaluates a rule's conditions against a lead without acting (plan 3.6, dry runs).
async fn dry_run(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>, Json(body): Json<DryRun>) -> ApiResult<Json<Value>> {
    let scope = ctx.require("rules")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rule: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM rules r WHERE id = $1").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(|| ApiError::not_found("The rule"))?;
    let lead: Value = sqlx::query_scalar("SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 AND callerwhale_visible_lead(l.id)")
        .bind(body.lead_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("The lead"))?;
    let matched = crate::routes::internal::conditions_match(&rule["conditions"], &lead, &json!({}));
    Ok(Json(json!({ "matched": matched, "would_run": if matched { rule["actions"].clone() } else { json!([]) } })))
}

// ------------------------------------------------------------------------------------------------------------- jobs

const JOB_KINDS: &[(&str, &str, &str)] = &[
    // (kind, queue, capability needed to start it)
    ("skiptrace", "python", "import"),
    ("import", "python", "import"),
    ("match", "native", "import"),
    ("report", "python", "export"),
    ("transcribe", "python", "call"),
    ("media", "media", "call"),
];

#[derive(Deserialize)]
struct Enqueue {
    kind: String,
    #[serde(default)]
    input: Value,
}

async fn enqueue(State(state): State<AppState>, ctx: Ctx, Json(body): Json<Enqueue>) -> ApiResult<Json<Value>> {
    let (_, queue, capability) = JOB_KINDS.iter().find(|(k, _, _)| *k == body.kind).ok_or_else(|| ApiError::bad(format!("{} is not a job", body.kind)))?;
    let scope = ctx.require(capability)?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let job: Value = sqlx::query_scalar("INSERT INTO jobs (org_id, kind, queue, input, created_by) VALUES (callerwhale_org(), $1, $2, $3, $4) RETURNING to_jsonb(jobs.*)")
        .bind(&body.kind)
        .bind(queue)
        .bind(&body.input)
        .bind(ctx.user_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(job))
}

async fn jobs(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(j) - 'input' - 'lease_owner' FROM jobs j WHERE created_by = $1 OR $2 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(ctx.user_id)
    .bind(scope.access.can("admin"))
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn job(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let row: Value = sqlx::query_scalar("SELECT to_jsonb(j) - 'lease_owner' FROM jobs j WHERE id = $1 AND (created_by = $2 OR $3)")
        .bind(id)
        .bind(ctx.user_id)
        .bind(scope.access.can("admin"))
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("The job"))?;
    Ok(Json(row))
}

async fn cancel_job(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let row: Value = sqlx::query_scalar(
        "UPDATE jobs SET cancel_requested = true, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, \
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END \
         WHERE id = $1 AND (created_by = $2 OR $3) AND status IN ('queued', 'running') RETURNING to_jsonb(jobs.*) - 'lease_owner'",
    )
    .bind(id)
    .bind(ctx.user_id)
    .bind(scope.access.can("admin"))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("A running job"))?;
    tx.commit().await?;
    Ok(Json(row))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_neutralizes_formulas() {
        let rows = vec![json!({ "name": "=HYPERLINK(\"x\")", "n": 3, "note": "a,b" }), json!({ "name": "-5", "n": null, "note": "line\nbreak" })];
        let out = csv(&rows);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "n,name,note");
        assert_eq!(lines[1], "3,\"'=HYPERLINK(\"\"x\"\")\",\"a,b\"");
        assert!(out.contains(",-5,"));
    }
}
