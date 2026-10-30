use crate::{access::Access, config::Config};
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use uuid::Uuid;

pub type Tx = Transaction<'static, Postgres>;

pub async fn connect(config: &Config) -> anyhow::Result<PgPool> {
    Ok(PgPoolOptions::new()
        .max_connections(32)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&config.database_url)
        .await?)
}

/// Runs the migrations as the owning role (MIGRATION_DATABASE_URL).
pub async fn migrate(config: &Config) -> anyhow::Result<()> {
    anyhow::ensure!(!config.migration_database_url.is_empty(), "MIGRATION_DATABASE_URL is required to migrate");
    let pool = PgPoolOptions::new().max_connections(1).connect(&config.migration_database_url).await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;
    Ok(())
}

/// Who a transaction acts for. Row security reads callerwhale.org_id; callerwhale_visible_lead() reads the rest.
#[derive(Clone, Debug)]
pub struct Scope {
    pub org_id: Uuid,
    pub user_id: Option<Uuid>,
    pub access: Access,
    pub team_ids: Vec<Uuid>,
    pub project_ids: Vec<Uuid>,
}

impl Scope {
    /// A worker or rule acting for the whole organization.
    pub fn system(org_id: Uuid) -> Scope {
        let mut access = Access::default();
        access.scopes.insert("organization".into());
        for capability in crate::access::CAPABILITIES {
            access.capabilities.insert(capability.to_string());
        }
        Scope { org_id, user_id: None, access, team_ids: vec![], project_ids: vec![] }
    }
}

pub async fn begin(pool: &PgPool, scope: &Scope) -> Result<Tx, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let uuids = |ids: &[Uuid]| format!("{{{}}}", ids.iter().map(Uuid::to_string).collect::<Vec<_>>().join(","));
    sqlx::query(
        "SELECT set_config('callerwhale.org_id', $1, true), set_config('callerwhale.user_id', $2, true), set_config('callerwhale.scopes', $3, true), \
         set_config('callerwhale.team_ids', $4, true), set_config('callerwhale.project_ids', $5, true)",
    )
    .bind(scope.org_id.to_string())
    .bind(scope.user_id.map(|id| id.to_string()).unwrap_or_default())
    .bind(scope.access.scope_setting())
    .bind(uuids(&scope.team_ids))
    .bind(uuids(&scope.project_ids))
    .execute(&mut *tx)
    .await?;
    Ok(tx)
}
