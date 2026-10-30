"""Skip tracing (server). Scaffold: it answers /healthz and /version using only the standard library."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVICE = "skip-tracing"
VERSION = "0.1.0"


def route(method: str, path: str) -> tuple[int, dict]:
    """The status and JSON body for a request."""
    if method == "GET" and path == "/healthz":
        return 200, {"ok": True, "service": SERVICE}
    if method == "GET" and path == "/version":
        return 200, {"service": SERVICE, "version": VERSION}
    return 404, {"error": "Not found."}


class Handler(BaseHTTPRequestHandler):
    def _reply(self, method: str) -> None:
        status, body = route(method, self.path.split("?", 1)[0])
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 (the name the standard library calls)
        self._reply("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._reply("POST")

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        print(f"{SERVICE}: {format % args}")


def main() -> None:
    port = int(os.environ.get("PORT", "8112"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"{SERVICE} listening on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
