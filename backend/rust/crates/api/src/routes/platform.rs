//! For the people who run Turf the service: every customer organization with its plan, usage, seats and payments.
//! Never their CRM records. Platform administrators are marked in the database by hand (see
//! backend/scripts/create_platform_admin.py), never through the API.

use crate::{
    auth::Ctx,
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new().route("/platform/organizations", get(organizations))
}

type Row = (
    Uuid,
    String,
    String,
    chrono::DateTime<chrono::Utc>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i32>,
    i64,
    Option<chrono::DateTime<chrono::Utc>>,
    i64,
    Option<String>,
    i64,
);

async fn organizations(State(state): State<AppState>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let admin: bool = sqlx::query_scalar("SELECT platform_admin FROM users WHERE id = $1").bind(ctx.user_id).fetch_one(&state.db).await?;
    if !admin {
        return Err(ApiError::forbidden("Only Turf's platform administrators can see this"));
    }
    // Seeing every customer always needs the second sign-in step, whatever the person's role in their own workspace.
    if !ctx.mfa_enrolled || !ctx.mfa_passed {
        return Err(ApiError::MfaRequired);
    }
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM turf_platform_overview($1)").bind(ctx.user_id).fetch_all(&state.db).await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|(id, name, kind, created, plan, status, seats, included, used, period_end, members, owner, paid)| {
            // A period that has run out is shown as ended, whatever the stored status still says.
            let lapsed = period_end.is_some_and(|end| end < chrono::Utc::now()) && matches!(status.as_deref(), Some("active" | "trialing"));
            let status = if lapsed { Some("expired".to_string()) } else { status.clone() };
            json!({ "id": id, "name": name, "account_kind": kind, "created_at": created, "plan": plan, "status": status, "seats": seats,
                    "minutes_included": included, "minutes_used": used, "period_end": period_end, "members": members,
                    "owner_email": owner, "paid_cents": paid })
        })
        .collect();
    let paying = list.iter().filter(|o| o["status"] == "active").count();
    let trials = list.iter().filter(|o| o["status"] == "trialing").count();
    let revenue: i64 = rows.iter().map(|r| r.12).sum();
    Ok(Json(json!({ "organizations": list, "totals": { "organizations": list.len(), "paying": paying, "trials": trials, "paid_cents": revenue } })))
}
