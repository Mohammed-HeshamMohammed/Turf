use callerwhale_auth::{connect, setup_database};

#[tokio::test]
async fn setup_history_survives_the_table_rename_and_restarts() {
    let db = connect("sqlite::memory:").await.unwrap();
    setup_database(&db).await.unwrap();
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM database_setup_history").fetch_one(&db).await.unwrap();
    assert_eq!(before, 5);
    sqlx::query("ALTER TABLE database_setup_history RENAME TO schema_migrations").execute(&db).await.unwrap();
    setup_database(&db).await.unwrap();
    setup_database(&db).await.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM database_setup_history").fetch_one(&db).await.unwrap();
    assert_eq!(after, before);
    let old: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'").fetch_one(&db).await.unwrap();
    assert_eq!(old, 0);
}
