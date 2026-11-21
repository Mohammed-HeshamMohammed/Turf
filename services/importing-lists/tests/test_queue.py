"""What a waiting upload is told about the queue. Needs a disposable PostgreSQL (CRM_TEST_ADMIN_URL, a superuser) and builds crm-core's
tables from its numbered scripts, so it is skipped without one."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import upload_api  # noqa: E402

ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


@unittest.skipUnless(os.environ.get("CRM_TEST_ADMIN_URL"), "set CRM_TEST_ADMIN_URL to run the database test")
class QueueTest(unittest.TestCase):
    def setUp(self) -> None:
        import psycopg
        from psycopg.rows import dict_row

        self.conn = psycopg.connect(os.environ["CRM_TEST_ADMIN_URL"], row_factory=dict_row)  # the upload API reads with dict rows
        self.addCleanup(self.conn.close)
        self.conn.execute("DROP SCHEMA IF EXISTS crm CASCADE; DROP SCHEMA IF EXISTS importing CASCADE; CREATE SCHEMA crm; SET search_path = crm, public")
        for script in sorted((HERE.parent / "crm-core" / "migrations").glob("*.sql")):
            self.conn.execute(script.read_text(encoding="utf8"))
        self.conn.execute("INSERT INTO crm.orgs (id, name) VALUES (%s, 'Test')", (ORG,))
        self.conn.commit()

    def queue(self) -> str:
        job = self.conn.execute("""INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, status)
                                   VALUES (%s, '11111111-1111-4111-8111-111111111111', 'Austin', 'owners.csv', 70, 70, 1, 'queued')
                                   RETURNING id::text""", (ORG,)).fetchone()["id"]
        self.conn.commit()
        return job

    def test_a_waiting_import_can_see_the_one_in_front_of_it(self) -> None:
        front = self.queue()
        waiting = self.queue()
        # the worker has taken the first one and is on its repeats
        self.conn.execute("""UPDATE importing.jobs SET status = 'loading', heartbeat_at = now(),
                             progress = '{"phase":"matching","done":10000,"total":10000,"step":"repeats"}'::jsonb WHERE id = %s""", (front,))
        self.conn.commit()
        info = upload_api.queue_info(self.conn, {"organization_id": ORG}, {"id": waiting})
        self.assertEqual(info["ahead"], 1)
        self.assertEqual(info["running"]["id"], front)
        self.assertEqual(info["running"]["phase"], "matching")
        self.assertEqual(info["running"]["done"], 10000)
        # another workspace is told only that something is running
        other = upload_api.queue_info(self.conn, {"organization_id": "99999999-9999-4999-8999-999999999999"}, {"id": waiting})
        self.assertEqual(other["running"], {"other_workspace": True, "idle_seconds": other["running"]["idle_seconds"]})


if __name__ == "__main__":
    unittest.main()
