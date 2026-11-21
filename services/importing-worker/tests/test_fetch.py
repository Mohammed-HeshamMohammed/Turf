"""The worker fetches each finished upload from the upload service (importing-lists), checking every piece (split 1)."""
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import readers  # noqa: E402
import worker  # noqa: E402

JOB = "11111111-1111-4111-8111-111111111111"
PIECES = [b"name,phone\nPat,5125550100\n", b"Sam,5125550101\n"]


class Uploads(BaseHTTPRequestHandler):
    files: dict[str, bytes] = {}
    deleted: list[str] = []
    served: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        if self.headers.get("x-import-token") != "t":
            return self._send(403, b"{}")
        prefix = f"/internal/jobs/{JOB}/files"
        if self.path == prefix:
            return self._send(200, json.dumps({"files": {k: len(v) for k, v in self.files.items()}}).encode())
        name = self.path.removeprefix(prefix + "/")
        if name in self.files:
            self.served.append(name)
            return self._send(200, self.files[name])
        self._send(404, b"{}")

    def do_DELETE(self) -> None:  # noqa: N802
        self.deleted.append(self.path)
        self._send(200, b'{"deleted": true}')

    def _send(self, status: int, data: bytes) -> None:
        self.send_response(status)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:
        pass


class Conn:
    """The two statements fetch_upload runs: the pieces' sizes and fingerprints, and the cancel check."""

    def __init__(self, pieces):
        self.pieces = pieces

    def cursor(self):
        conn = self

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def execute(self, query, _args):
                self.query = query

            def fetchall(self):
                return [(n, len(p), hashlib.sha256(p).hexdigest()) for n, p in enumerate(conn.pieces)]

            def fetchone(self):
                return (False,)

        return Cursor()

    def commit(self):
        pass


class FetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Uploads)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name) / JOB
        Uploads.files, Uploads.deleted, Uploads.served = {f"{n}.part": p for n, p in enumerate(PIECES)}, [], []
        for name, value in {"API_URL": f"http://127.0.0.1:{self.httpd.server_address[1]}", "FILE_TOKEN": "t", "IMPORT_DIR": Path(self.tmp.name)}.items():
            change = patch.object(worker, name, value)
            change.start()
            self.addCleanup(change.stop)

    def job(self) -> dict:
        return {"id": JOB, "total_chunks": len(PIECES), "filename": "owners.csv"}

    def test_the_pieces_are_fetched_joined_and_let_go(self) -> None:
        source = worker.source_file(Conn(PIECES), self.job())
        self.assertEqual(source.read_bytes(), b"".join(PIECES))
        self.assertEqual(Uploads.deleted, [f"/internal/jobs/{JOB}/files"])

    def test_pieces_already_here_are_not_fetched_again(self) -> None:
        self.folder.mkdir()
        (self.folder / "0.part").write_bytes(PIECES[0])
        worker.fetch_upload(Conn(PIECES), self.job(), self.folder, ".csv")
        self.assertEqual(Uploads.served, ["1.part"])

    def test_a_damaged_piece_is_not_kept(self) -> None:
        Uploads.files["1.part"] = b"Sam,5125550199\n"
        with patch.object(worker.time, "sleep"), self.assertRaises(RuntimeError):
            worker.fetch_upload(Conn(PIECES), self.job(), self.folder, ".csv")
        self.assertFalse((self.folder / "1.part").exists())
        self.assertEqual(Uploads.served.count("1.part"), 3)

    def test_a_file_the_upload_service_no_longer_has_is_said_plainly(self) -> None:
        del Uploads.files["1.part"]
        with self.assertRaises(FileNotFoundError):
            worker.fetch_upload(Conn(PIECES), self.job(), self.folder, ".csv")

    def test_a_list_joined_before_the_split_comes_over_whole(self) -> None:
        Uploads.files = {"source.utf8.csv": b"".join(PIECES)}
        worker.fetch_upload(Conn(PIECES), self.job(), self.folder, ".csv")
        self.assertEqual(readers.prepare(self.folder, [len(p) for p in PIECES], ".csv").read_bytes(), b"".join(PIECES))

    def test_without_the_token_nothing_is_fetched(self) -> None:
        with patch.object(worker, "FILE_TOKEN", ""):
            worker.fetch_upload(Conn(PIECES), self.job(), self.folder, ".csv")
            worker.release_upload(JOB)
        self.assertEqual((Uploads.served, Uploads.deleted), ([], []))


if __name__ == "__main__":
    unittest.main()
