from pathlib import Path
from callerwhale_service.storage import ProjectStore


def test_setup_history_rename_preserves_completed_updates(tmp_path):
    store = ProjectStore(tmp_path / "project.sqlite3")
    scripts = Path(__file__).resolve().parents[1] / "database_setup"
    try:
        applied = store.setup_database(scripts)
        assert applied
        store._connection.execute("ALTER TABLE database_setup_history RENAME TO schema_migrations")
        store._connection.commit()
        assert store.pending_database_updates(scripts) == []
        assert store.setup_database(scripts) == []
        assert store._connection.execute("SELECT COUNT(*) FROM database_setup_history").fetchone()[0] == len(applied)
        assert store._connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").fetchone() is None
    finally:
        store.close()
