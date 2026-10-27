import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

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

    def test_version_is_reported(self) -> None:
        status, body = server.route("GET", "/version")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"service": "importing-lists", "version": "0.1.0"})

    def test_unknown_paths_are_not_found(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.base + "/nope")
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(server.route("POST", "/healthz")[0], 404)


if __name__ == "__main__":
    unittest.main()
