import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class ServerTest(unittest.TestCase):
    def test_health_names_the_service(self) -> None:
        self.assertEqual(server.route("GET", "/healthz"), (200, {"ok": True, "service": "importing-worker"}))

    def test_health_fails_when_a_worker_loop_has_stopped(self) -> None:
        class Stopped:
            @staticmethod
            def loops_alive() -> bool:
                return False

        server.worker = Stopped()
        try:
            status, body = server.route("GET", "/healthz")
        finally:
            server.worker = None
        self.assertEqual(status, 503)
        self.assertFalse(body["ok"])

    def test_status_names_the_jobs_being_worked_on(self) -> None:
        import threading

        class Running:
            _active_lock = threading.Lock()
            _active = {"b", "a"}
            _loops = [1, 2, 3]

        server.worker = Running()
        try:
            self.assertEqual(server.route("GET", "/status"), (200, {"service": "importing-worker", "workers": 3, "working_on": ["a", "b"]}))
        finally:
            server.worker = None

    def test_version_is_reported(self) -> None:
        self.assertEqual(server.route("GET", "/version"), (200, {"service": "importing-worker", "version": "0.1.0"}))

    def test_unknown_paths_are_not_found(self) -> None:
        self.assertEqual(server.route("GET", "/nope")[0], 404)
        self.assertEqual(server.route("POST", "/healthz")[0], 404)


if __name__ == "__main__":
    unittest.main()
