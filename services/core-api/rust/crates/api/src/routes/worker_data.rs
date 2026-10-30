//! Data routes for the Python worker (imports, Skip Tracing, reports). Each call names its organization and acts
//! either as the system or, for a person's job, with that person's own scope, so a report never shows a person more
//! than they could see themselves.

use crate::{
    access::Access,
    db::{self, Scope},
    error::{ApiError, ApiResult},
    record::{record, Change},
    routes::{internal::Worker, reports},
    state::AppState,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::post,
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
    Router::new()
        .route("/reports/run", post(run_saved_report))
        .route("/datasets", post(create_dataset))
        .route("/datasets/{id}/rows", post(add_rows))
        .route("/datasets/{id}/rows/read", post(read_rows))
        .route("/datasets/{id}/leads", post(add_leads))
        .route("/datasets/{id}/verdicts", post(verdicts))
        .route("/jobs/{id}/artifact", post(job_artifact))
        .route("/artifacts/read", post(read_artifact))
}

/// The scope a member has in an organization, as their session would.
pub async fn scope_for(state: &AppState, org: Uuid, user: Uuid) -> ApiResult<Scope> {
    let mut tx = db::begin(&state.db, &Scope::system(org)).await?;
    let membership: Option<(Vec<String>, Vec<String>, Vec<Uuid>, Vec<Uuid>)> =
        sqlx::query_as("SELECT roles, restrictions, team_ids, project_ids FROM memberships WHERE org_id = callerwhale_org() AND user_id = $1")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    let (roles, restrictions, team_ids, project_ids) = membership.ok_or_else(|| ApiError::forbidden("That person is no longer a member"))?;
    let grants: Vec<(Vec<String>, String)> =
        sqlx::query_as("SELECT capabilities, scope FROM roles WHERE org_id = callerwhale_org() AND key = ANY($1)").bind(&roles).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let access = Access::combine(grants.iter().map(|(c, s)| (&c[..], s.as_str())), &restrictions);
    Ok(Scope { org_id: org, user_id: Some(user), access, team_ids, project_ids })
}

#[derive(Deserialize)]
struct RunReport {
    org_id: Uuid,
    saved_report_id: Uuid,
}

async fn run_saved_report(State(state): State<AppState>, Worker(_): Worker, Json(body): Json<RunReport>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let saved: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM saved_reports r WHERE id = $1")
        .bind(body.saved_report_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("The saved report"))?;
    tx.commit().await?;
    let owner = Uuid::parse_str(saved["owner_id"].as_str().unwrap_or_default()).map_err(|_| ApiError::bad("owner"))?;
    let scope = scope_for(&state, body.org_id, owner).await?;
    let kind = saved["kind"].as_str().unwrap_or("");
    if kind == "revenue" && !scope.access.can("finance") {
        return Err(ApiError::forbidden("The report's owner no longer has the finance permission"));
    }
    if !scope.access.can("export") {
        return Err(ApiError::forbidden("The report's owner no longer has the export permission"));
    }
    let filters: reports::ReportQuery = serde_json::from_value(saved["filters"].clone()).unwrap_or_default();
    let mut tx = db::begin(&state.db, &scope).await?;
    let rows = reports::run_report(&mut tx, kind, &filters).await?;
    tx.commit().await?;
    Ok(Json(json!({ "name": saved["name"], "kind": kind, "format": saved["format"], "owner_id": owner, "rows": rows })))
}

#[derive(Deserialize)]
struct NewDataset {
    org_id: Uuid,
    name: String,
    #[serde(default)]
    project_id: Option<Uuid>,
    #[serde(default)]
    mapping: Value,
    #[serde(default)]
    artifact_sha256: Option<String>,
    #[serde(default)]
    row_count: i32,
}

async fn create_dataset(State(state): State<AppState>, Worker(_): Worker, Json(body): Json<NewDataset>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO datasets (org_id, project_id, name, artifact_sha256, mapping, row_count) VALUES (callerwhale_org(), $1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(body.project_id)
    .bind(body.name.trim())
    .bind(&body.artifact_sha256)
    .bind(if body.mapping.is_null() { json!({}) } else { body.mapping })
    .bind(body.row_count)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "dataset_id": id })))
}

#[derive(Deserialize)]
struct Rows {
    org_id: Uuid,
    rows: Vec<RowIn>,
}

#[derive(Deserialize)]
struct RowIn {
    row_number: i32,
    raw: Value,
}

/// Source rows are immutable: a row number already stored is never changed.
async fn add_rows(State(state): State<AppState>, Worker(_): Worker, Path(id): Path<Uuid>, Json(body): Json<Rows>) -> ApiResult<Json<Value>> {
    if body.rows.len() > 2000 {
        return Err(ApiError::bad("Send at most 2000 rows at a time"));
    }
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let mut added = 0;
    for row in &body.rows {
        added += sqlx::query("INSERT INTO source_rows (org_id, dataset_id, row_number, raw) VALUES (callerwhale_org(), $1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(row.row_number)
            .bind(&row.raw)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    }
    tx.commit().await?;
    Ok(Json(json!({ "added": added })))
}

#[derive(Deserialize)]
struct ReadRows {
    org_id: Uuid,
    #[serde(default)]
    after: i32,
    #[serde(default)]
    limit: Option<i64>,
}

async fn read_rows(State(state): State<AppState>, Worker(_): Worker, Path(id): Path<Uuid>, Json(body): Json<ReadRows>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let dataset: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM datasets d WHERE id = $1").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(|| ApiError::not_found("The dataset"))?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('row_number', row_number, 'raw', raw) FROM source_rows WHERE dataset_id = $1 AND row_number > $2 ORDER BY row_number LIMIT $3",
    )
    .bind(id)
    .bind(body.after)
    .bind(body.limit.unwrap_or(1000).clamp(1, 5000))
    .fetch_all(&mut *tx)
    .await?;
    Ok(Json(json!({ "dataset": dataset, "rows": rows })))
}

#[derive(Deserialize)]
struct Leads {
    org_id: Uuid,
    /// The person who started the import; their leads go to them, or to the unassigned queue.
    #[serde(default)]
    created_by: Option<Uuid>,
    #[serde(default)]
    assign_to_creator: bool,
    leads: Vec<LeadIn>,
}

#[derive(Deserialize)]
struct LeadIn {
    row_number: i32,
    name: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    unit: String,
    #[serde(default)]
    city: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    zip: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    parcel: String,
    #[serde(default)]
    value: Option<f64>,
    #[serde(default)]
    verdict: Option<String>,
}

fn row_uuid(dataset: Uuid, row: i32, kind: &str) -> Uuid {
    let digest = Sha256::digest(format!("import:{kind}:{dataset}:{row}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// One lead per imported row; a retried batch creates nothing twice (ids are derived from dataset and row).
async fn add_leads(State(state): State<AppState>, Worker(_): Worker, Path(dataset): Path<Uuid>, Json(body): Json<Leads>) -> ApiResult<Json<Value>> {
    if body.leads.len() > 2000 {
        return Err(ApiError::bad("Send at most 2000 leads at a time"));
    }
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM datasets WHERE id = $1").bind(dataset).fetch_optional(&mut *tx).await?.flatten();
    let team: Option<Uuid> = match body.created_by {
        Some(user) => sqlx::query_scalar("SELECT team_ids[1] FROM memberships WHERE org_id = callerwhale_org() AND user_id = $1").bind(user).fetch_optional(&mut *tx).await?.flatten(),
        None => None,
    };
    let assignee = if body.assign_to_creator { body.created_by } else { None };
    let mut created = 0;
    for lead in &body.leads {
        if lead.name.trim().is_empty() && lead.phone.trim().is_empty() && lead.address.trim().is_empty() {
            continue;
        }
        let (lat, lon) = match (lead.latitude, lead.longitude) {
            (Some(a), Some(b)) if (-90.0..=90.0).contains(&a) && (-180.0..=180.0).contains(&b) => (Some(a), Some(b)),
            _ => (None, None),
        };
        let property = row_uuid(dataset, lead.row_number, "property");
        sqlx::query(
            "INSERT INTO properties (id, org_id, address, unit, city, region, postal_code, country, parcel, latitude, longitude, location_source) \
             VALUES ($1, callerwhale_org(), $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $9 IS NULL THEN 'none' ELSE 'supplied' END) ON CONFLICT (id) DO NOTHING",
        )
        .bind(property)
        .bind(&lead.address)
        .bind(&lead.unit)
        .bind(&lead.city)
        .bind(&lead.region)
        .bind(&lead.zip)
        .bind(&lead.country)
        .bind(&lead.parcel)
        .bind(lat)
        .bind(lon)
        .execute(&mut *tx)
        .await?;
        let id = row_uuid(dataset, lead.row_number, "lead");
        let name = if lead.name.trim().is_empty() { lead.address.trim().to_string() } else { lead.name.trim().to_string() };
        let fresh = sqlx::query(
            "INSERT INTO leads (id, org_id, project_id, team_id, property_id, assignee_id, name, phone, email, source, value_amount, verdict) \
             VALUES ($1, callerwhale_org(), $2, $3, $4, $5, $6, $7, $8, (SELECT name FROM datasets WHERE id = $9), $10, coalesce($11, 'Unverified')) ON CONFLICT (id) DO NOTHING",
        )
        .bind(id)
        .bind(project)
        .bind(team)
        .bind(property)
        .bind(assignee)
        .bind(&name)
        .bind(&lead.phone)
        .bind(&lead.email)
        .bind(dataset)
        .bind(lead.value.map(|v| rust_decimal::Decimal::from_f64_retain(v).unwrap_or_default().round_dp(2)))
        .bind(&lead.verdict)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if fresh == 1 {
            sqlx::query("INSERT INTO lead_sources (org_id, lead_id, dataset_id, row_number) VALUES (callerwhale_org(), $1, $2, $3) ON CONFLICT DO NOTHING")
                .bind(id)
                .bind(dataset)
                .bind(lead.row_number)
                .execute(&mut *tx)
                .await?;
            let mut c = Change::new("lead", id, "lead.created");
            c.actor_id = body.created_by;
            c.actor_label = "Import";
            c.lead_id = Some(id);
            record(&mut tx, c).await?;
            created += 1;
        }
    }
    tx.commit().await?;
    Ok(Json(json!({ "created": created })))
}

#[derive(Deserialize)]
struct Verdicts {
    org_id: Uuid,
    verdicts: Vec<VerdictIn>,
}

#[derive(Deserialize)]
struct VerdictIn {
    row_number: i32,
    verdict: String,
    #[serde(default)]
    do_not_call: bool,
    #[serde(default)]
    phone: Option<String>,
}

const VERDICTS: &[&str] = &["Ready to call", "Unverified", "Wrong number", "Possible duplicate", "Needs review", "No phone", "Do not call"];

/// Skip Tracing results for an imported list's leads. A do-not-call is only ever added, never lifted, here.
async fn verdicts(State(state): State<AppState>, Worker(_): Worker, Path(dataset): Path<Uuid>, Json(body): Json<Verdicts>) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let mut changed = 0;
    for verdict in &body.verdicts {
        if !VERDICTS.contains(&verdict.verdict.as_str()) {
            return Err(ApiError::bad(format!("{} is not a verdict", verdict.verdict)));
        }
        let leads: Vec<Uuid> = sqlx::query_scalar("SELECT lead_id FROM lead_sources WHERE dataset_id = $1 AND row_number = $2")
            .bind(dataset)
            .bind(verdict.row_number)
            .fetch_all(&mut *tx)
            .await?;
        for lead in leads {
            let updated = sqlx::query(
                "UPDATE leads SET verdict = CASE WHEN do_not_call OR $3 THEN 'Do not call' ELSE $2 END, do_not_call = do_not_call OR $3, \
                   phone = coalesce(nullif($4, ''), phone), version = version + 1, updated_at = now() \
                 WHERE id = $1 AND (verdict IS DISTINCT FROM $2 OR ($3 AND NOT do_not_call) OR (nullif($4, '') IS NOT NULL AND phone <> $4))",
            )
            .bind(lead)
            .bind(&verdict.verdict)
            .bind(verdict.do_not_call)
            .bind(&verdict.phone)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if updated == 1 {
                let mut c = Change::new("lead", lead, "lead.updated");
                c.actor_label = "Skip Tracing";
                c.lead_id = Some(lead);
                c.after = Some(json!({ "verdict": verdict.verdict, "do_not_call": verdict.do_not_call }));
                record(&mut tx, c).await?;
                changed += 1;
            }
        }
    }
    tx.commit().await?;
    Ok(Json(json!({ "changed": changed })))
}

#[derive(Deserialize)]
struct ArtifactQuery {
    org_id: Uuid,
    name: String,
    #[serde(default = "octets")]
    media_type: String,
}

fn octets() -> String {
    "application/octet-stream".into()
}

fn artifact_path(state: &AppState, org: Uuid, sha: &str) -> PathBuf {
    PathBuf::from(&state.config.artifact_dir).join(org.to_string()).join(&sha[..2]).join(sha)
}

/// A file a job produced (a report, an export). It belongs to whoever started the job, who is told it is ready.
async fn job_artifact(
    State(state): State<AppState>,
    Worker(worker): Worker,
    Path(job): Path<Uuid>,
    Query(query): Query<ArtifactQuery>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let mut tx = db::begin(&state.db, &Scope::system(query.org_id)).await?;
    let owner: Option<Option<Uuid>> = sqlx::query_scalar("SELECT created_by FROM jobs WHERE id = $1 AND lease_owner = $2 AND status = 'running'")
        .bind(job)
        .bind(&worker)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    let owner = owner.ok_or_else(|| ApiError::Conflict("This worker no longer holds the job's lease".into()))?;
    let incoming = PathBuf::from(&state.config.artifact_dir).join("incoming");
    tokio::fs::create_dir_all(&incoming).await.map_err(anyhow::Error::from)?;
    let temp = incoming.join(Uuid::new_v4().to_string());
    let mut file = tokio::fs::File::create(&temp).await.map_err(anyhow::Error::from)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut stream = request.into_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(ApiError::bad("The upload was interrupted"));
        };
        hasher.update(&chunk);
        size += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(anyhow::Error::from)?;
    }
    file.flush().await.map_err(anyhow::Error::from)?;
    drop(file);
    let sha = hex::encode(hasher.finalize());
    let target = artifact_path(&state, query.org_id, &sha);
    tokio::fs::create_dir_all(target.parent().unwrap()).await.map_err(anyhow::Error::from)?;
    if tokio::fs::metadata(&target).await.is_ok() {
        let _ = tokio::fs::remove_file(&temp).await;
    } else {
        tokio::fs::rename(&temp, &target).await.map_err(anyhow::Error::from)?;
    }
    let mut tx = db::begin(&state.db, &Scope::system(query.org_id)).await?;
    sqlx::query(
        "INSERT INTO artifacts (sha256, org_id, name, media_type, size, uploaded_by, complete) VALUES ($1, callerwhale_org(), $2, $3, $4, $5, true) \
         ON CONFLICT (org_id, sha256) DO UPDATE SET complete = true",
    )
    .bind(&sha)
    .bind(&query.name)
    .bind(&query.media_type)
    .bind(size as i64)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    if let Some(user) = owner {
        sqlx::query("INSERT INTO notifications (org_id, user_id, kind, text, entity, entity_id) VALUES (callerwhale_org(), $1, 'job', $2, 'job', $3)")
            .bind(user)
            .bind(format!("{} is ready", query.name))
            .bind(job)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "sha256": sha, "size": size })))
}

#[derive(Deserialize)]
struct ReadArtifact {
    org_id: Uuid,
    sha256: String,
}

async fn read_artifact(State(state): State<AppState>, Worker(_): Worker, Json(body): Json<ReadArtifact>) -> ApiResult<Response> {
    if body.sha256.len() != 64 || !body.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::not_found("The file"));
    }
    let mut tx = db::begin(&state.db, &Scope::system(body.org_id)).await?;
    let found: Option<String> = sqlx::query_scalar("SELECT media_type FROM artifacts WHERE sha256 = $1 AND complete").bind(&body.sha256).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    let media_type = found.ok_or_else(|| ApiError::not_found("The file"))?;
    let bytes = tokio::fs::read(artifact_path(&state, body.org_id, &body.sha256)).await.map_err(|_| ApiError::not_found("The file"))?;
    Ok(([(header::CONTENT_TYPE, media_type)], Body::from(bytes)).into_response())
}
