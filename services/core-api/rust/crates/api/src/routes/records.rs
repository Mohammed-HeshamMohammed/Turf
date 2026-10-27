//! Scoped reads (plan 2.3, 3.2–3.4). Every query goes through turf_visible_lead(), so lists, searches, counts and
//! dashboards show only what the person may see.

use crate::{
    auth::Ctx,
    cache,
    db::{self, Scope},
    error::{ApiError, ApiResult},
    ops::redact_lead,
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/leads", get(leads))
        .route("/leads/{id}", get(lead))
        .route("/tasks", get(tasks))
        .route("/calendar", get(calendar))
        .route("/deals", get(deals))
        .route("/handoffs", get(handoffs))
        .route("/conversations", get(conversations))
        .route("/conversations/{id}", get(conversation))
        .route("/notifications", get(notifications))
        .route("/dashboard", get(dashboard))
        .route("/search", get(search))
}

fn external(scope: &Scope) -> bool {
    !scope.access.scopes.is_empty() && scope.access.scopes.iter().all(|s| s == "shared")
}

#[derive(Deserialize, Default)]
pub struct LeadQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    assignee: String,
    #[serde(default)]
    team: Option<Uuid>,
    #[serde(default)]
    project: Option<Uuid>,
    #[serde(default)]
    dataset: Option<Uuid>,
    /// The last id of the previous page.
    #[serde(default)]
    after: Option<Uuid>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    due: String,
}

/// Leads in pages of up to 500, ordered by id for stable keyset paging.
async fn leads(State(state): State<AppState>, ctx: Ctx, Query(query): Query<LeadQuery>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let assignee: Option<Uuid> = match query.assignee.as_str() {
        "" | "unassigned" => None,
        "me" => Some(ctx.user_id),
        other => Some(Uuid::parse_str(other).map_err(|_| ApiError::bad("assignee is not valid"))?),
    };
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(l) || jsonb_build_object('property', to_jsonb(p), \
           'calls', (SELECT count(*) FROM call_events c WHERE c.lead_id = l.id), \
           'last_call', (SELECT jsonb_build_object('outcome', c.outcome, 'code', c.code, 'occurred_at', c.occurred_at) FROM call_events c WHERE c.lead_id = l.id ORDER BY c.occurred_at DESC LIMIT 1)) \
         FROM leads l LEFT JOIN properties p ON p.id = l.property_id \
         WHERE turf_visible_lead(l.id) \
           AND ($1 = '' OR l.name ILIKE '%' || $1 || '%' OR l.phone LIKE '%' || $1 || '%' OR l.email ILIKE '%' || $1 || '%' OR p.address ILIKE '%' || $1 || '%') \
           AND ($2 = '' OR l.stage = $2) \
           AND ($3 = '' OR ($3 = 'unassigned' AND l.assignee_id IS NULL) OR l.assignee_id = $4) \
           AND ($5::uuid IS NULL OR l.team_id = $5) AND ($6::uuid IS NULL OR l.project_id = $6) \
           AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM lead_sources s WHERE s.lead_id = l.id AND s.dataset_id = $7)) \
           AND ($8::uuid IS NULL OR l.id > $8) \
           AND ($9 = '' OR ($9 = 'today' AND l.next_action_at < date_trunc('day', now()) + interval '1 day') OR ($9 = 'overdue' AND l.next_action_at < now())) \
         ORDER BY l.id LIMIT $10",
    )
    .bind(query.q.trim())
    .bind(&query.stage)
    .bind(&query.assignee)
    .bind(assignee)
    .bind(query.team)
    .bind(query.project)
    .bind(query.dataset)
    .bind(query.after)
    .bind(&query.due)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let more = rows.len() as i64 > limit;
    let page: Vec<Value> = rows.into_iter().take(limit as usize).map(|lead| redact_lead(lead, &scope)).collect();
    let next = if more { page.last().and_then(|l| l.get("id").cloned()) } else { None };
    Ok(Json(json!({ "leads": page, "next": next })))
}

/// One lead with everything around it: property, owner, sources, calls, notes, tasks, deal, handoffs, history.
async fn lead(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let lead: Value = sqlx::query_scalar("SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 AND turf_visible_lead(l.id)")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("The lead"))?;
    let ext = external(&scope);
    let one = |sql: &'static str| sqlx::query_scalar::<_, Option<Value>>(sql).bind(id);
    let property = one("SELECT to_jsonb(p) FROM leads l JOIN properties p ON p.id = l.property_id WHERE l.id = $1").fetch_one(&mut *tx).await.ok().flatten();
    let contact = if ext { None } else { one("SELECT to_jsonb(c) FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = $1").fetch_one(&mut *tx).await.ok().flatten() };
    let list = |sql: &'static str| sqlx::query_scalar::<_, Value>(sql).bind(id).bind(ext);
    let notes = list("SELECT to_jsonb(n) FROM notes n WHERE n.lead_id = $1 AND (NOT $2 OR n.visibility = 'shared') ORDER BY n.occurred_at").fetch_all(&mut *tx).await?;
    let calls = if ext { vec![] } else { list("SELECT to_jsonb(c) FROM call_events c WHERE c.lead_id = $1 AND NOT $2 ORDER BY c.occurred_at").fetch_all(&mut *tx).await? };
    let tasks = list("SELECT to_jsonb(t) FROM tasks t WHERE t.lead_id = $1 AND (NOT $2 OR t.shared_external) ORDER BY t.due_at NULLS LAST").fetch_all(&mut *tx).await?;
    let handoffs = if ext { vec![] } else { list("SELECT to_jsonb(h) FROM handoffs h WHERE h.lead_id = $1 AND NOT $2 ORDER BY h.created_at").fetch_all(&mut *tx).await? };
    let sources = if ext {
        vec![]
    } else {
        list("SELECT jsonb_build_object('dataset_id', s.dataset_id, 'row_number', s.row_number, 'legacy_key', s.legacy_key, 'dataset', d.name) \
              FROM lead_sources s LEFT JOIN datasets d ON d.id = s.dataset_id WHERE s.lead_id = $1 AND NOT $2")
            .fetch_all(&mut *tx)
            .await?
    };
    let assignments = if ext { vec![] } else { list("SELECT to_jsonb(a) FROM assignments a WHERE a.lead_id = $1 AND NOT $2 ORDER BY a.at").fetch_all(&mut *tx).await? };
    let history = if ext {
        vec![]
    } else {
        list("SELECT jsonb_build_object('action', a.action, 'actor', a.actor_label, 'at', a.at, 'occurred_at', a.occurred_at, 'entity', a.entity) \
              FROM audit_events a WHERE (a.entity_id = $1 OR (a.after->>'lead_id')::uuid = $1) AND NOT $2 ORDER BY a.id DESC LIMIT 200")
            .fetch_all(&mut *tx)
            .await?
    };
    let deal = if scope.access.can("finance") && !ext { one("SELECT to_jsonb(d) FROM deals d WHERE d.lead_id = $1").fetch_one(&mut *tx).await.ok().flatten() } else { None };
    let suppressed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM suppressions s, leads l WHERE l.id = $1 AND s.address = l.phone AND l.phone <> '' AND (s.until IS NULL OR s.until >= current_date))",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    Ok(Json(json!({
        "lead": redact_lead(lead, &scope), "property": property, "contact": contact, "notes": notes, "calls": calls, "tasks": tasks,
        "handoffs": handoffs, "sources": sources, "assignments": assignments, "history": history, "deal": deal,
        // Contact restrictions sit beside the communication controls (plan 3.2).
        "contact_restrictions": { "suppressed": suppressed },
    })))
}

#[derive(Deserialize, Default)]
struct TaskQuery {
    #[serde(default)]
    due: String,
    #[serde(default)]
    mine: bool,
    #[serde(default)]
    done: bool,
}

async fn tasks(State(state): State<AppState>, ctx: Ctx, Query(query): Query<TaskQuery>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(t) || jsonb_build_object('lead_name', l.name, 'overdue', t.done_at IS NULL AND t.due_at < now()) FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id \
         WHERE ((t.lead_id IS NULL AND (t.assignee_id = $1 OR 'organization' = ANY(string_to_array(current_setting('turf.scopes', true), ',')))) OR turf_visible_lead(t.lead_id)) \
           AND (NOT turf_external() OR t.shared_external) \
           AND (NOT $2 OR t.assignee_id = $1) AND ($3 OR t.done_at IS NULL) \
           AND ($4 = '' OR ($4 = 'today' AND t.due_at < date_trunc('day', now()) + interval '1 day') OR ($4 = 'overdue' AND t.due_at < now()) \
                OR ($4 = 'week' AND t.due_at < now() + interval '7 days')) \
         ORDER BY t.due_at NULLS LAST, t.created_at LIMIT 1000",
    )
    .bind(ctx.user_id)
    .bind(query.mine)
    .bind(query.done)
    .bind(&query.due)
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct Range {
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
}

/// Tasks, callbacks and appointments in a time range, for the calendar.
async fn calendar(State(state): State<AppState>, ctx: Ctx, Query(range): Query<Range>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    if range.to < range.from || range.to - range.from > chrono::Duration::days(93) {
        return Err(ApiError::bad("Choose a range of up to three months"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', t.id, 'title', t.title, 'type', t.type, 'due_at', t.due_at, 'timezone', t.timezone, 'lead_id', t.lead_id, \
           'assignee_id', t.assignee_id, 'done', t.done_at IS NOT NULL) FROM tasks t \
         WHERE t.due_at >= $1 AND t.due_at < $2 AND ((t.lead_id IS NULL AND t.assignee_id = $3) OR turf_visible_lead(t.lead_id)) AND (NOT turf_external() OR t.shared_external) \
         ORDER BY t.due_at",
    )
    .bind(range.from)
    .bind(range.to)
    .bind(ctx.user_id)
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn deals(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.require("finance")?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(d) || jsonb_build_object('lead_name', l.name, 'assignee_id', l.assignee_id, 'days_in_stage', \
           extract(day FROM now() - coalesce((SELECT max(a.at) FROM audit_events a WHERE a.entity_id = d.id AND a.action = 'deal.stage_changed'), d.created_at))) \
         FROM deals d JOIN leads l ON l.id = d.lead_id WHERE turf_visible_lead(d.lead_id) ORDER BY d.created_at",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn handoffs(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    if external(&scope) {
        return Ok(Json(json!([])));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    // Requested handoffs past their due time are reported as overdue.
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(h) || jsonb_build_object('lead_name', l.name, 'status', CASE WHEN h.status = 'Requested' AND h.due_at < now() THEN 'Overdue' ELSE h.status END) \
         FROM handoffs h JOIN leads l ON l.id = h.lead_id WHERE turf_visible_lead(h.lead_id) ORDER BY h.created_at DESC LIMIT 500",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn conversations(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(c) || jsonb_build_object('lead_name', l.name, 'preview', (SELECT left(m.body, 140) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1)) \
         FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id \
         WHERE (c.lead_id IS NULL OR turf_visible_lead(c.lead_id)) AND (NOT turf_external() OR c.shared_external) ORDER BY c.updated_at DESC LIMIT 500",
    )
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

async fn conversation(State(state): State<AppState>, ctx: Ctx, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let conversation: Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM conversations c WHERE c.id = $1 AND (c.lead_id IS NULL OR turf_visible_lead(c.lead_id)) AND (NOT turf_external() OR c.shared_external)",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("The conversation"))?;
    let messages: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE m.conversation_id = $1 ORDER BY m.created_at").bind(id).fetch_all(&mut *tx).await?;
    Ok(Json(json!({ "conversation": conversation, "messages": messages })))
}

async fn notifications(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(n) FROM notifications n WHERE n.user_id = $1 AND (n.entity <> 'lead' OR n.entity_id IS NULL OR turf_visible_lead(n.entity_id)) ORDER BY n.created_at DESC LIMIT 200",
    )
    .bind(ctx.user_id)
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!(rows)))
}

/// Role dashboards (plan 3.4), cached in Redis for 30 seconds under the access and data revisions.
async fn dashboard(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let data_revision: i64 = sqlx::query_scalar("SELECT data_revision FROM organizations WHERE id = $1").bind(scope.org_id).fetch_one(&state.db).await?;
    let key = cache::key(scope.org_id, ctx.access_revision, data_revision, &format!("dashboard:{}", ctx.user_id));
    if let Some(mut cached) = state.cache.get::<Value>(&key).await {
        cached["cached"] = json!(true);
        return Ok(Json(cached));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let me = ctx.user_id;
    let summary: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object( \
           'my_leads', (SELECT count(*) FROM leads l WHERE l.assignee_id = $1 AND turf_visible_lead(l.id) AND l.stage <> 'Closed'), \
           'visible_leads', (SELECT count(*) FROM leads l WHERE turf_visible_lead(l.id)), \
           'unassigned', (SELECT count(*) FROM leads l WHERE l.assignee_id IS NULL AND turf_visible_lead(l.id)), \
           'due_callbacks', (SELECT count(*) FROM tasks t WHERE t.assignee_id = $1 AND t.type = 'Callback' AND t.done_at IS NULL AND t.due_at < date_trunc('day', now()) + interval '1 day'), \
           'overdue_tasks', (SELECT count(*) FROM tasks t WHERE t.done_at IS NULL AND t.due_at < now() AND (t.lead_id IS NULL OR turf_visible_lead(t.lead_id)) AND (t.assignee_id = $1 OR $2)), \
           'pending_handoffs', (SELECT count(*) FROM handoffs h WHERE h.status = 'Requested' AND turf_visible_lead(h.lead_id)), \
           'handoffs_for_me', (SELECT count(*) FROM handoffs h WHERE h.status = 'Requested' AND h.to_user = $1), \
           'calls_today', (SELECT count(*) FROM call_events c WHERE c.agent_id = $1 AND c.occurred_at >= date_trunc('day', now())), \
           'my_outcomes', (SELECT coalesce(jsonb_object_agg(outcome, n), '{}') FROM (SELECT outcome, count(*) n FROM call_events c WHERE c.agent_id = $1 AND c.occurred_at >= now() - interval '7 days' GROUP BY outcome) o), \
           'stages', (SELECT coalesce(jsonb_object_agg(stage, n), '{}') FROM (SELECT stage, count(*) n FROM leads l WHERE turf_visible_lead(l.id) GROUP BY stage) s), \
           'workload', CASE WHEN $2 THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', w.assignee_id, 'open', w.n)), '[]') FROM \
              (SELECT assignee_id, count(*) n FROM leads l WHERE turf_visible_lead(l.id) AND l.assignee_id IS NOT NULL AND l.stage <> 'Closed' GROUP BY assignee_id) w) ELSE '[]'::jsonb END, \
           'unreviewed_imports', (SELECT count(*) FROM datasets d WHERE d.status = 'Imported'), \
           'failed_jobs', (SELECT count(*) FROM jobs j WHERE j.status = 'failed' AND j.created_at > now() - interval '7 days'), \
           'appointments', (SELECT count(*) FROM tasks t WHERE t.type = 'Appointment' AND t.done_at IS NULL AND t.assignee_id = $1))",
    )
    .bind(me)
    .bind(scope.access.can("assign"))
    .fetch_one(&mut *tx)
    .await?;
    let mut summary = summary;
    if scope.access.can("finance") {
        let money: Value = sqlx::query_scalar(
            "SELECT jsonb_build_object('pipeline', (SELECT coalesce(jsonb_object_agg(stage, jsonb_build_object('count', n, 'amount', a)), '{}') FROM \
               (SELECT d.stage, count(*) n, coalesce(sum(d.amount), 0) a FROM deals d WHERE turf_visible_lead(d.lead_id) GROUP BY d.stage) p), \
             'recorded_revenue', (SELECT coalesce(sum(d.fee), 0) FROM deals d WHERE d.stage = 'Closed won' AND turf_visible_lead(d.lead_id)))",
        )
        .fetch_one(&mut *tx)
        .await?;
        summary["finance"] = money;
    }
    summary["generated_at"] = json!(chrono::Utc::now());
    state.cache.put(&key, &summary, 30).await;
    summary["cached"] = json!(false);
    Ok(Json(summary))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(State(state): State<AppState>, ctx: Ctx, Query(query): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    let q = query.q.trim();
    if q.len() < 2 {
        return Ok(Json(json!({ "leads": [], "tasks": [] })));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let leads: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', l.id, 'name', l.name, 'stage', l.stage, 'address', p.address) FROM leads l LEFT JOIN properties p ON p.id = l.property_id \
         WHERE turf_visible_lead(l.id) AND (l.name ILIKE '%' || $1 || '%' OR l.phone LIKE '%' || $1 || '%' OR l.email ILIKE '%' || $1 || '%' OR p.address ILIKE '%' || $1 || '%') LIMIT 30",
    )
    .bind(q)
    .fetch_all(&mut *tx)
    .await?;
    let tasks: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', t.id, 'title', t.title, 'due_at', t.due_at) FROM tasks t \
         WHERE t.title ILIKE '%' || $1 || '%' AND ((t.lead_id IS NULL AND t.assignee_id = $2) OR turf_visible_lead(t.lead_id)) AND (NOT turf_external() OR t.shared_external) LIMIT 30",
    )
    .bind(q)
    .bind(ctx.user_id)
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!({ "leads": leads, "tasks": tasks })))
}
