//! Content-addressed files (plan 2.2, 2.6) and the legacy project import (plan 4, milestone 2).
//!
//! Uploads stream to a temporary file while the SHA-256 is computed, then move into place; a partial upload never
//! becomes visible. Downloads check the record they belong to on every request.

use crate::{
    auth::Ctx,
    db::{self, Scope},
    error::{ApiError, ApiResult},
    record::{record, Change},
    routes::internal::Worker,
    state::AppState,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new().route("/artifacts", post(upload)).route("/artifacts/{sha256}", get(download))
}

fn stored_path(state: &AppState, org: Uuid, sha: &str) -> PathBuf {
    PathBuf::from(&state.config.artifact_dir).join(org.to_string()).join(&sha[..2]).join(sha)
}

#[derive(Deserialize)]
struct UploadQuery {
    name: String,
    #[serde(default)]
    lead_id: Option<Uuid>,
    #[serde(default)]
    visibility: String,
}

async fn upload(State(state): State<AppState>, ctx: Ctx, Query(query): Query<UploadQuery>, request: axum::extract::Request) -> ApiResult<Json<Value>> {
    let scope = ctx.scope()?;
    if !scope.access.can("edit") && !scope.access.can("import") && !scope.access.can("publicComment") {
        return Err(ApiError::forbidden("Your role cannot add files"));
    }
    let media_type = request.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    if let Some(lead) = query.lead_id {
        let mut tx = db::begin(&state.db, &scope).await?;
        let visible: bool = sqlx::query_scalar("SELECT turf_visible_lead($1)").bind(lead).fetch_one(&mut *tx).await?;
        if !visible {
            return Err(ApiError::not_found("The lead"));
        }
    }
    let temp_dir = PathBuf::from(&state.config.artifact_dir).join("incoming");
    tokio::fs::create_dir_all(&temp_dir).await.map_err(anyhow::Error::from)?;
    let temp = temp_dir.join(Uuid::new_v4().to_string());
    let mut file = tokio::fs::File::create(&temp).await.map_err(anyhow::Error::from)?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut stream = request.into_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(ApiError::bad("The upload was interrupted"));
            }
        };
        hasher.update(&chunk);
        size += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(anyhow::Error::from)?;
    }
    file.flush().await.map_err(anyhow::Error::from)?;
    drop(file);
    if size == 0 {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(ApiError::bad("The file is empty"));
    }
    let sha = hex::encode(hasher.finalize());
    let target = stored_path(&state, scope.org_id, &sha);
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(anyhow::Error::from)?;
    }
    if tokio::fs::metadata(&target).await.is_ok() {
        let _ = tokio::fs::remove_file(&temp).await;
    } else {
        tokio::fs::rename(&temp, &target).await.map_err(anyhow::Error::from)?;
    }
    // External uploads are always shared with the internal team; internal files are internal unless chosen.
    let external = scope.access.scopes.iter().all(|s| s == "shared");
    let visibility = if external || query.visibility == "shared" { "shared" } else { "internal" };
    let mut tx = db::begin(&state.db, &scope).await?;
    let artifact: Value = sqlx::query_scalar(
        "INSERT INTO artifacts (sha256, org_id, name, media_type, size, lead_id, visibility, uploaded_by, complete) VALUES ($1, turf_org(), $2, $3, $4, $5, $6, $7, true) \
         ON CONFLICT (org_id, sha256) DO UPDATE SET complete = true RETURNING to_jsonb(artifacts.*) - 'org_id'",
    )
    .bind(&sha)
    .bind(query.name.trim())
    .bind(&media_type)
    .bind(size as i64)
    .bind(query.lead_id)
    .bind(visibility)
    .bind(ctx.user_id)
    .fetch_one(&mut *tx)
    .await?;
    let mut c = Change::new("artifact", query.lead_id.unwrap_or(scope.org_id), "artifact.added");
    c.actor_id = Some(ctx.user_id);
    c.actor_label = &ctx.label;
    c.lead_id = query.lead_id;
    c.after = Some(json!({ "sha256": sha, "name": query.name }));
    record(&mut tx, c).await?;
    tx.commit().await?;
    Ok(Json(artifact))
}

async fn download(State(state): State<AppState>, ctx: Ctx, Path(sha): Path<String>) -> ApiResult<Response> {
    let scope = ctx.scope()?;
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::not_found("The file"));
    }
    let mut tx = db::begin(&state.db, &scope).await?;
    let found: Option<(String, String)> = sqlx::query_as(
        "SELECT name, media_type FROM artifacts a WHERE sha256 = $1 AND complete \
           AND (a.lead_id IS NULL AND (a.uploaded_by = $2 OR 'organization' = ANY(string_to_array(current_setting('turf.scopes', true), ','))) OR turf_visible_lead(a.lead_id)) \
           AND (NOT turf_external() OR a.visibility = 'shared')",
    )
    .bind(&sha)
    .bind(ctx.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (name, media_type) = found.ok_or_else(|| ApiError::not_found("The file"))?;
    let file = tokio::fs::File::open(stored_path(&state, scope.org_id, &sha)).await.map_err(|_| ApiError::not_found("The file"))?;
    let safe_name: String = name.chars().filter(|c| c.is_alphanumeric() || " ._-".contains(*c)).collect();
    Ok((
        [
            (header::CONTENT_TYPE, media_type),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{safe_name}\"")),
            (header::CACHE_CONTROL, "private, max-age=300".to_string()),
            (header::HeaderName::from_static("x-content-type-options"), "nosniff".to_string()),
        ],
        Body::from_stream(tokio_util_stream(file)),
    )
        .into_response())
}

fn tokio_util_stream(file: tokio::fs::File) -> impl futures::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    futures::stream::unfold(file, |mut file| async move {
        use tokio::io::AsyncReadExt;
        let mut buffer = vec![0u8; 64 * 1024];
        match file.read(&mut buffer).await {
            Ok(0) => None,
            Ok(n) => {
                buffer.truncate(n);
                Some((Ok(buffer), file))
            }
            Err(error) => Some((Err(error), file)),
        }
    })
}

// ---------------------------------------------------------------------------------------------- legacy import

#[derive(Deserialize)]
pub struct LegacyImport {
    org_id: Uuid,
    project: LegacyProject,
    #[serde(default)]
    datasets: Vec<LegacyDataset>,
    #[serde(default)]
    leads: Vec<LegacyLead>,
    /// Manual do-not-call and wrong-number marks, per number.
    #[serde(default)]
    marks: Vec<LegacyMark>,
    /// Validate and count without keeping anything (plan 4: hidden until validation completes).
    #[serde(default)]
    dry_run: bool,
}

#[derive(Deserialize)]
struct LegacyProject {
    legacy_id: String,
    name: String,
}

#[derive(Deserialize)]
struct LegacyDataset {
    legacy_id: String,
    name: String,
    #[serde(default)]
    artifact_sha256: Option<String>,
    #[serde(default)]
    mapping: Value,
    #[serde(default)]
    rows: Vec<LegacyRow>,
    #[serde(default)]
    row_count: i32,
}

#[derive(Deserialize)]
struct LegacyRow {
    row_number: i32,
    raw: Value,
}

#[derive(Deserialize)]
struct LegacyLead {
    legacy_key: String,
    name: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    city: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    zip: String,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    callback_on: Option<String>,
    #[serde(default)]
    callback_note: String,
    #[serde(default)]
    sources: Vec<LegacySource>,
    #[serde(default)]
    notes: Vec<LegacyNote>,
    #[serde(default)]
    calls: Vec<LegacyCall>,
}

#[derive(Deserialize)]
struct LegacySource {
    dataset: String,
    row_number: i32,
}

#[derive(Deserialize)]
struct LegacyNote {
    legacy_id: String,
    body: String,
    at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
struct LegacyCall {
    legacy_id: String,
    phone: String,
    outcome: String,
    meaning: String,
    at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
struct LegacyMark {
    number: String,
    mark: String,
    #[serde(default)]
    until: Option<chrono::NaiveDate>,
}

fn legacy_uuid(kind: &str, id: &str) -> Uuid {
    let digest = Sha256::digest(format!("legacy:{kind}:{id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// Desktop project stages ("new", "contacted", ...) to CRM stages.
fn stage_of(legacy: &str) -> &'static str {
    match legacy.to_lowercase().as_str() {
        "contacted" | "called" => "Contacted",
        "interested" | "warm" | "hot" => "Interested",
        "qualified" | "appointment" | "offer" => "Qualified",
        "closed" | "dead" | "not_interested" | "do_not_call" | "sold" => "Closed",
        _ => "New",
    }
}

/// Imports one desktop project. Re-running it adds nothing twice: every record has an id derived from its legacy id.
/// Unknown historical actors are "Legacy import"; leads enter the unassigned queue (plan 4).
pub async fn legacy_import(State(state): State<AppState>, Worker(_): Worker, Json(body): Json<LegacyImport>) -> ApiResult<Json<Value>> {
    let system = Scope::system(body.org_id);
    let mut tx = db::begin(&state.db, &system).await?;
    let project_id = legacy_uuid("project", &body.project.legacy_id);
    sqlx::query("INSERT INTO projects (id, org_id, name) VALUES ($1, turf_org(), $2) ON CONFLICT (id) DO NOTHING")
        .bind(project_id)
        .bind(&body.project.name)
        .execute(&mut *tx)
        .await?;
    let mut counts = json!({ "datasets": 0, "rows": 0, "leads": 0, "notes": 0, "calls": 0, "marks": 0, "skipped_leads": 0 });
    let mut dataset_ids = std::collections::HashMap::new();
    for dataset in &body.datasets {
        let id = legacy_uuid("dataset", &dataset.legacy_id);
        dataset_ids.insert(dataset.legacy_id.clone(), id);
        let fresh = sqlx::query(
            "INSERT INTO datasets (id, org_id, project_id, name, artifact_sha256, legacy_id, row_count, mapping, status) \
             VALUES ($1, turf_org(), $2, $3, $4, $5, $6, $7, 'Published') ON CONFLICT (id) DO NOTHING",
        )
        .bind(id)
        .bind(project_id)
        .bind(&dataset.name)
        .bind(&dataset.artifact_sha256)
        .bind(&dataset.legacy_id)
        .bind(dataset.row_count.max(dataset.rows.len() as i32))
        .bind(if dataset.mapping.is_null() { json!({}) } else { dataset.mapping.clone() })
        .execute(&mut *tx)
        .await?
        .rows_affected();
        counts["datasets"] = json!(counts["datasets"].as_i64().unwrap_or(0) + fresh as i64);
        for row in &dataset.rows {
            let added = sqlx::query("INSERT INTO source_rows (org_id, dataset_id, row_number, raw) VALUES (turf_org(), $1, $2, $3) ON CONFLICT DO NOTHING")
                .bind(id)
                .bind(row.row_number)
                .bind(&row.raw)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            counts["rows"] = json!(counts["rows"].as_i64().unwrap_or(0) + added as i64);
        }
    }
    for lead in &body.leads {
        if lead.name.trim().is_empty() && lead.phone.trim().is_empty() {
            counts["skipped_leads"] = json!(counts["skipped_leads"].as_i64().unwrap_or(0) + 1);
            continue;
        }
        let lead_id = legacy_uuid("lead", &lead.legacy_key);
        let property: Option<Uuid> = if lead.address.is_empty() {
            None
        } else {
            let id = legacy_uuid("property", &lead.legacy_key);
            sqlx::query("INSERT INTO properties (id, org_id, address, city, region, postal_code) VALUES ($1, turf_org(), $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING")
                .bind(id)
                .bind(&lead.address)
                .bind(&lead.city)
                .bind(&lead.region)
                .bind(&lead.zip)
                .execute(&mut *tx)
                .await?;
            Some(id)
        };
        let callback = lead.callback_on.as_deref().and_then(|d| chrono::NaiveDate::parse_from_str(&d[..d.len().min(10)], "%Y-%m-%d").ok()).map(|d| d.and_hms_opt(9, 0, 0).unwrap().and_utc());
        let added = sqlx::query(
            "INSERT INTO leads (id, org_id, project_id, property_id, name, phone, email, stage, source, next_action, next_action_at) \
             VALUES ($1, turf_org(), $2, $3, $4, $5, $6, $7, 'Legacy import', $8, $9) ON CONFLICT (id) DO NOTHING",
        )
        .bind(lead_id)
        .bind(project_id)
        .bind(property)
        .bind(if lead.name.trim().is_empty() { lead.phone.trim() } else { lead.name.trim() })
        .bind(&lead.phone)
        .bind(&lead.email)
        .bind(stage_of(&lead.stage))
        .bind(if callback.is_some() { if lead.callback_note.is_empty() { "Callback" } else { lead.callback_note.as_str() } } else { "" })
        .bind(callback)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if added == 1 {
            counts["leads"] = json!(counts["leads"].as_i64().unwrap_or(0) + 1);
            let mut c = Change::new("lead", lead_id, "lead.created");
            c.actor_label = "Legacy import";
            c.lead_id = Some(lead_id);
            record(&mut tx, c).await?;
            if let Some(at) = callback {
                sqlx::query("INSERT INTO tasks (org_id, lead_id, title, type, due_at) VALUES (turf_org(), $1, $2, 'Callback', $3)")
                    .bind(lead_id)
                    .bind(format!("Callback: {}", lead.name.trim()))
                    .bind(at)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        for (index, source) in lead.sources.iter().enumerate() {
            let dataset = dataset_ids.get(&source.dataset).copied();
            // The legacy key is kept once, as the lead's alias; other sources are plain lineage.
            sqlx::query("INSERT INTO lead_sources (org_id, lead_id, dataset_id, row_number, legacy_key) VALUES (turf_org(), $1, $2, $3, $4) ON CONFLICT DO NOTHING")
                .bind(lead_id)
                .bind(dataset)
                .bind(source.row_number)
                .bind(if index == 0 { Some(lead.legacy_key.as_str()) } else { None })
                .execute(&mut *tx)
                .await?;
        }
        for note in &lead.notes {
            let added = sqlx::query(
                "INSERT INTO notes (org_id, lead_id, author_label, body, occurred_at, operation_id) VALUES (turf_org(), $1, 'Legacy import', $2, $3, $4) ON CONFLICT (operation_id) DO NOTHING",
            )
            .bind(lead_id)
            .bind(&note.body)
            .bind(note.at)
            .bind(legacy_uuid("note", &note.legacy_id))
            .execute(&mut *tx)
            .await?
            .rows_affected();
            counts["notes"] = json!(counts["notes"].as_i64().unwrap_or(0) + added as i64);
        }
        for call in &lead.calls {
            let meaning = match call.meaning.as_str() {
                m @ ("reached" | "voicemail" | "no_answer" | "wrong_number" | "wrong_person" | "disconnected" | "do_not_call") => m,
                _ => "no_answer",
            };
            let added = sqlx::query(
                "INSERT INTO call_events (org_id, lead_id, agent_label, phone, outcome, meaning, source, occurred_at, operation_id) \
                 VALUES (turf_org(), $1, 'Legacy import', $2, $3, $4, 'legacy', $5, $6) ON CONFLICT (operation_id) DO NOTHING",
            )
            .bind(lead_id)
            .bind(&call.phone)
            .bind(&call.outcome)
            .bind(meaning)
            .bind(call.at)
            .bind(legacy_uuid("call", &call.legacy_id))
            .execute(&mut *tx)
            .await?
            .rows_affected();
            counts["calls"] = json!(counts["calls"].as_i64().unwrap_or(0) + added as i64);
        }
    }
    for mark in &body.marks {
        let channel_reason = match mark.mark.as_str() {
            "do_not_call" => Some("Do not call (legacy mark)"),
            "wrong_number" => None,
            _ => None,
        };
        if let Some(reason) = channel_reason {
            sqlx::query("INSERT INTO suppressions (org_id, channel, address, reason, until) VALUES (turf_org(), 'all', $1, $2, $3) ON CONFLICT DO NOTHING")
                .bind(&mark.number)
                .bind(reason)
                .bind(mark.until)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE leads SET do_not_call = true, verdict = 'Do not call' WHERE phone = $1").bind(&mark.number).execute(&mut *tx).await?;
        } else if mark.mark == "wrong_number" {
            sqlx::query("UPDATE leads SET verdict = 'Wrong number' WHERE phone = $1 AND verdict = 'Unverified'").bind(&mark.number).execute(&mut *tx).await?;
        }
        counts["marks"] = json!(counts["marks"].as_i64().unwrap_or(0) + 1);
    }
    if body.dry_run {
        tx.rollback().await?;
        return Ok(Json(json!({ "dry_run": true, "would_import": counts })));
    }
    tx.commit().await?;
    Ok(Json(json!({ "dry_run": false, "imported": counts, "project_id": project_id })))
}
