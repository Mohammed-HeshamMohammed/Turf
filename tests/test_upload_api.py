"""Upload pieces must exist on worker storage before the job can be queued."""
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import upload_api  # noqa: E402

JOB_ID = "11111111-1111-4111-8111-111111111111"
ORG_ID = "22222222-2222-4222-8222-222222222222"
USER_ID = "33333333-3333-4333-8333-333333333333"


class FakeConnection:
    def __init__(self, size):
        self.job = {"id": JOB_ID, "status": "uploading", "size": size, "total_chunks": 1}
        self.pieces = {}
        self.queued = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, query, args):
        if query.startswith("INSERT INTO importing.chunks"):
            self.pieces[args[1]] = {"n": args[1], "size": args[2]}
        elif query.startswith("UPDATE importing.jobs SET status"):
            self.job["status"] = "queued"
            self.queued = True
        elif query.startswith("SELECT n, size"):
            return FakeResult(list(self.pieces.values()))
        elif query.startswith("SELECT id::text"):
            return FakeResult([self.job])
        elif query.startswith(("SELECT count(*) AS n", "SELECT coalesce(sum(size)")):
            return FakeResult([{"n": 0}])
        elif query.startswith("INSERT INTO importing.jobs"):
            return FakeResult([{"id": JOB_ID}])
        return FakeResult([])


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows

    def __iter__(self):
        return iter(self.rows)


class Handler:
    def __init__(self, data, digest=None):
        self.rfile = io.BytesIO(data)
        self.headers = {"Content-Length": str(len(data)), "x-chunk-sha256": digest or hashlib.sha256(data).hexdigest()}


class UploadTest(unittest.TestCase):
    def test_a_list_the_disk_could_not_hold_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"IMPORT_DIR": tmp}),                 patch.object(upload_api.shutil, "disk_usage", return_value=type("U", (), {"free": 1 << 20})()):
            with self.assertRaises(upload_api.APIError) as caught:
                upload_api.check_space(10 << 20)
        self.assertEqual(caught.exception.status, 507)

    def test_a_full_disk_while_a_piece_arrives_is_a_clear_refusal(self):
        import errno

        class Full(Handler):
            def __init__(self):
                super().__init__(b"abc")
                self.rfile = type("R", (), {"read": lambda self, n: (_ for _ in ()).throw(OSError(errno.ENOSPC, "full"))})()

        conn = FakeConnection(3)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"IMPORT_DIR": tmp}),                 patch.object(upload_api, "database", return_value=conn),                 patch.object(upload_api, "get_job", side_effect=lambda *_: dict(conn.job)):
            with self.assertRaises(upload_api.APIError) as caught:
                upload_api.chunk(Full(), {"organization_id": ORG_ID, "user": {"id": USER_ID}}, JOB_ID, "0")
        self.assertEqual(caught.exception.status, 507)

    def test_start_creates_project_through_core_and_job_in_worker_database(self):
        body = json.dumps({"filename": "owners.csv", "size": 42, "name": "Owners"}).encode()
        handler = Handler(body)
        me = {"organization_id": ORG_ID, "user": {"id": USER_ID}, "capabilities": ["import"], "team_ids": []}
        conn = FakeConnection(42)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"IMPORT_DIR": tmp}), \
                patch.object(upload_api, "database", return_value=conn), \
                patch.object(upload_api, "core_request", return_value={"id": ORG_ID}) as core:
            with patch.object(upload_api, "get_job", side_effect=lambda *_: dict(conn.job)):
                job = upload_api.start(handler, me)
                self.assertEqual(job["id"], JOB_ID)
                self.assertEqual(job["received"], [])
                self.assertTrue((Path(tmp) / JOB_ID).is_dir())
                core.assert_called_once_with(handler, "POST", "/api/v1/projects", {"name": "Owners"})

    def test_only_worker_owned_complete_pieces_can_be_queued(self):
        data = b"name,phone\nPat,555-0100\n"
        me = {"organization_id": ORG_ID, "user": {"id": USER_ID}, "capabilities": ["import"]}
        conn = FakeConnection(len(data))
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"IMPORT_DIR": tmp}), \
                patch.object(upload_api, "database", return_value=conn):
            with patch.object(upload_api, "get_job", side_effect=lambda *_: dict(conn.job)):
                with self.assertRaises(upload_api.APIError):
                    upload_api.complete(me, JOB_ID)
                with self.assertRaises(upload_api.APIError) as damaged:
                    upload_api.chunk(Handler(data, hashlib.sha256(b"wrong").hexdigest()), me, JOB_ID, "0")
                self.assertEqual(damaged.exception.status, 422)
                self.assertEqual(list(Path(tmp).rglob("*.part")), [])
                self.assertEqual(upload_api.chunk(Handler(data), me, JOB_ID, "0"), {"n": 0, "stored": True})
                piece = Path(tmp) / JOB_ID / "0.part"
                self.assertEqual(piece.read_bytes(), data)
                self.assertEqual(upload_api.reply(conn, me, JOB_ID)["received"], [0])
                piece.unlink()
                self.assertEqual(upload_api.reply(conn, me, JOB_ID)["received"], [])
                with self.assertRaises(upload_api.APIError):
                    upload_api.complete(me, JOB_ID)
                self.assertFalse(conn.queued)
                piece.write_bytes(data)
                self.assertEqual(upload_api.complete(me, JOB_ID)["status"], "queued")
                self.assertTrue(conn.queued)


if __name__ == "__main__":
    unittest.main()
