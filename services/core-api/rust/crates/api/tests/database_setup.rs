mod common;
use callerwhale_api::db::setup_database;

#[tokio::test]
async fn setup_preserves_history_and_refuses_changed_or_failed_updates() {
    let Some(cfg) = common::config(false) else { eprintln!("database setup test needs TEST_DATABASE_URL and TEST_DATABASE_SETUP_URL"); return; };
    setup_database(&cfg).await.unwrap();
    let owner = sqlx::PgPool::connect(&cfg.database_setup_url).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM database_setup_history").fetch_one(&owner).await.unwrap();
    assert!(count > 0);
    sqlx::query("ALTER TABLE database_setup_history RENAME TO _sqlx_migrations").execute(&owner).await.unwrap();
    setup_database(&cfg).await.unwrap();
    setup_database(&cfg).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM database_setup_history").fetch_one(&owner).await.unwrap(), count);
    let checksum: Vec<u8> = sqlx::query_scalar("SELECT checksum FROM database_setup_history WHERE version = 1").fetch_one(&owner).await.unwrap();
    sqlx::query("UPDATE database_setup_history SET checksum = ''::bytea WHERE version = 1").execute(&owner).await.unwrap();
    assert!(setup_database(&cfg).await.unwrap_err().to_string().contains("checksum changed"));
    sqlx::query("UPDATE database_setup_history SET checksum = $1, success = false WHERE version = 1").bind(&checksum).execute(&owner).await.unwrap();
    assert!(setup_database(&cfg).await.unwrap_err().to_string().contains("previously failed"));
    sqlx::query("UPDATE database_setup_history SET success = true WHERE version = 1").execute(&owner).await.unwrap();
    setup_database(&cfg).await.unwrap();
    // A failed adoption must roll back the table rename as well as any script work.
    sqlx::query("UPDATE database_setup_history SET checksum = ''::bytea WHERE version = 1").execute(&owner).await.unwrap();
    sqlx::query("ALTER TABLE database_setup_history RENAME TO _sqlx_migrations").execute(&owner).await.unwrap();
    assert!(setup_database(&cfg).await.is_err());
    assert!(sqlx::query_scalar::<_, bool>("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL AND to_regclass('public.database_setup_history') IS NULL").fetch_one(&owner).await.unwrap());
    sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = 1").bind(&checksum).execute(&owner).await.unwrap();
    setup_database(&cfg).await.unwrap();
    let (one, two) = tokio::join!(setup_database(&cfg), setup_database(&cfg));
    one.unwrap(); two.unwrap();
}
