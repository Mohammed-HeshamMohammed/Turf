import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def test_health_names_the_service(self) -> None:
        with urllib.request.urlopen(self.base + "/healthz") as res:
            self.assertEqual(res.status, 200)
            self.assertEqual(json.load(res), {"ok": True, "service": "importing-lists"})

    def test_a_stalled_sender_is_cut_off(self) -> None:
        self.assertEqual(server.Handler.timeout, 60)

    def test_version_is_reported(self) -> None:
        status, body = server.route("GET", "/version")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"service": "importing-lists", "version": "0.3.0"})

    def test_unknown_paths_are_not_found(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.base + "/nope")
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(server.route("POST", "/healthz")[0], 404)


JOB = "11111111-1111-4111-8111-111111111111"


class InternalRoutesTest(unittest.TestCase):
    """The routes the importing worker fetches uploads with (split 1)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"IMPORT_DIR": self.tmp.name, "IMPORT_FILE_TOKEN": "shared-test-token"})
        env.start()
        self.addCleanup(env.stop)
        self.folder = Path(self.tmp.name) / JOB
        self.folder.mkdir()
        (self.folder / "0.part").write_bytes(b"abc")
        (self.folder / "1.part").write_bytes(b"de")
        (self.folder / "incoming-x").write_bytes(b"half")

    def call(self, path: str, method: str = "GET", token: str | None = "shared-test-token"):
        headers = {} if token is None else {"x-import-token": token}
        return urllib.request.urlopen(urllib.request.Request(self.base + path, method=method, headers=headers), timeout=5)

    def test_the_worker_lists_and_fetches_the_pieces(self) -> None:
        with self.call(f"/internal/jobs/{JOB}/files") as res:
            self.assertEqual(json.load(res), {"files": {"0.part": 3, "1.part": 2}})
        with self.call(f"/internal/jobs/{JOB}/files/1.part") as res:
            self.assertEqual(res.read(), b"de")

    def test_the_worker_lets_the_files_go(self) -> None:
        with self.call(f"/internal/jobs/{JOB}/files", "DELETE") as res:
            self.assertEqual(json.load(res), {"deleted": True})
        self.assertFalse(self.folder.exists())

    def test_without_the_token_nothing_is_served(self) -> None:
        for token in (None, "wrong"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.call(f"/internal/jobs/{JOB}/files/0.part", token=token)
            self.assertEqual(caught.exception.code, 403)
        with patch.dict(os.environ, {"IMPORT_FILE_TOKEN": ""}):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.call(f"/internal/jobs/{JOB}/files", token="")
            self.assertEqual(caught.exception.code, 403)
        self.assertTrue(self.folder.exists())

    def test_only_upload_files_are_served(self) -> None:
        for name in ("incoming-x", "..", "2.part"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.call(f"/internal/jobs/{JOB}/files/{name}")
            self.assertEqual(caught.exception.code, 404, name)


class SweepTest(unittest.TestCase):
    def test_files_of_finished_or_unknown_uploads_go_and_new_folders_stay(self) -> None:
        import upload_api

        class Conn:
            def __init__(self, rows):
                self.rows = rows

            def execute(self, _query, args):
                row = self.rows.get(args[1])
                return type("R", (), {"fetchone": lambda _self: row})()

            def commit(self):
                pass

        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"IMPORT_DIR": tmp}):
            names = {"a": {"status": "failed", "old": False}, "b": {"status": "queued", "old": False},
                     "c": {"status": "mapping", "old": True}, "d": None, "e": None}
            for name in names:
                (Path(tmp) / name).mkdir()
                if name != "e":
                    os.utime(Path(tmp) / name, (0, 0))
            removed = upload_api.sweep_files(Conn(names))
            self.assertEqual(removed, 3)
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ["b", "e"])


if __name__ == "__main__":
    unittest.main()
