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

/// Applies ordered database setup scripts using the schema owner's connection.
/// Keeps SQLx's checksums and PostgreSQL lock, with our clearly named history table.
pub async fn setup_database(config: &Config) -> anyhow::Result<()> {
    use sqlx::{Connection, Executor, Row};
    use sqlx::migrate::Migrate;
    anyhow::ensure!(!config.database_setup_url.is_empty(), "DATABASE_SETUP_URL is required for database setup");
    let mut connection = sqlx::PgConnection::connect(&config.database_setup_url).await?;
    // Same database-wide lock as previous releases, including during rolling updates.
    connection.lock().await?;
    let mut tx = connection.begin().await?;
    let legacy: bool = sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL").fetch_one(&mut *tx).await?;
    let current: bool = sqlx::query_scalar("SELECT to_regclass('public.database_setup_history') IS NOT NULL").fetch_one(&mut *tx).await?;
    anyhow::ensure!(!(legacy && current), "Two database setup history tables exist; reconcile them before starting");
    if legacy {
        sqlx::query("ALTER TABLE public._sqlx_migrations RENAME TO database_setup_history").execute(&mut *tx).await?;
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS public.database_setup_history (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)").execute(&mut *tx).await?;
    let scripts = sqlx::migrate!("../../database_setup");
    let history = sqlx::query("SELECT version, checksum, success FROM public.database_setup_history ORDER BY version").fetch_all(&mut *tx).await?;
    for row in &history {
        let version: i64 = row.try_get("version")?;
        anyhow::ensure!(row.try_get::<bool, _>("success")?, "Database update {version} previously failed");
        let script = scripts.iter().find(|s| s.version == version).ok_or_else(|| anyhow::anyhow!("Applied database update {version} has no matching script"))?;
        anyhow::ensure!(row.try_get::<Vec<u8>, _>("checksum")?.as_slice() == script.checksum.as_ref(), "Database update {version} checksum changed; restore the original script");
    }
    for script in scripts.iter() {
        if history.iter().any(|row| row.get::<i64, _>("version") == script.version) { continue; }
        anyhow::ensure!(!script.no_tx, "Database update {} needs a nontransactional runner", script.version);
        let start = std::time::Instant::now();
        (&mut *tx).execute(script.sql.as_ref()).await?;
        sqlx::query("INSERT INTO public.database_setup_history (version, description, success, checksum, execution_time) VALUES ($1, $2, true, $3, $4)")
            .bind(script.version).bind(script.description.as_ref()).bind(script.checksum.as_ref()).bind(start.elapsed().as_nanos().min(i64::MAX as u128) as i64).execute(&mut *tx).await?;
    }
    // Scripts and history commit together. Any error rolls back the complete setup.
    tx.commit().await?;
    connection.unlock().await?;
    connection.close().await?;
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
