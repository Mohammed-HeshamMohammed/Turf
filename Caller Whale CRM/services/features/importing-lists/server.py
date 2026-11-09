"""Importing lists (server): answers /healthz and /version, and runs the import worker (worker.py) beside them."""
import json
import os
import threading
import time
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import upload_api

SERVICE = "importing-lists"
VERSION = "0.2.0"


def route(method: str, path: str) -> tuple[int, dict]:
    """The status and JSON body for a request."""
    if method == "GET" and path == "/healthz":
        return 200, {"ok": True, "service": SERVICE}
    if method == "GET" and path == "/version":
        return 200, {"service": SERVICE, "version": VERSION}
    return 404, {"error": "Not found."}


class Handler(BaseHTTPRequestHandler):
    def _upload(self, method: str) -> bool:
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/v1/imports"):
            return False
        self._cw_started = time.perf_counter()
        try:
            me = upload_api.principal(self)
            if method == "POST" and path == "/api/v1/imports":
                body = upload_api.start(self, me)
            elif method == "GET" and (match := re.fullmatch(r"/api/v1/imports/([0-9a-fA-F-]{36})", path)):
                with upload_api.database() as conn:
                    body = upload_api.reply(conn, me, match.group(1))
            elif method == "PUT" and (match := re.fullmatch(r"/api/v1/imports/([0-9a-fA-F-]{36})/chunks/(\d+)", path)):
                body = upload_api.chunk(self, me, *match.groups())
            elif method == "POST" and (match := re.fullmatch(r"/api/v1/imports/([0-9a-fA-F-]{36})/complete", path)):
                body = upload_api.complete(me, match.group(1))
            else:
                raise upload_api.APIError(404, "Not found.", "not_found")
            status = 200
        except upload_api.APIError as error:
            status, body = error.status, {"error": {"code": error.code, "message": str(error)}}
        except Exception:
            # A traceback stays in the worker log, never in the browser response.
            import traceback
            traceback.print_exc()
            status, body = 500, {"error": {"code": "import_unavailable", "message": "The import service could not finish that request. Try again."}}
        self._send(status, body)
        return True

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _reply(self, method: str) -> None:
        self._cw_started = time.perf_counter()
        status, body = route(method, self.path.split("?", 1)[0])
        self._send(status, body)

    def do_GET(self) -> None:  # noqa: N802 (the name the standard library calls)
        if self._upload("GET"):
            return
        self._reply("GET")

    def do_POST(self) -> None:  # noqa: N802
        if self._upload("POST"):
            return
        self._reply("POST")

    def do_PUT(self) -> None:  # noqa: N802
        if self._upload("PUT"):
            return
        self._reply("PUT")

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        if format.startswith('"%s" %s %s') and len(args) >= 2:
            status = int(args[1])
            path = self.path.split("?", 1)[0].split("#", 1)[0]
            if path == "/healthz" and status < 400:
                return
            print(json.dumps({"cw_event": "request", "method": self.command, "path": path,
                              "status": status, "duration_seconds": max(0, time.perf_counter() - getattr(self, "_cw_started", time.perf_counter()))}), flush=True)
        else:
            print(json.dumps({"level": "WARN", "message": format % args}), flush=True)


def main() -> None:
    port = int(os.environ.get("PORT", "8111"))
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise SystemExit("set DATABASE_URL: the import worker's own login on the CRM database")
    import worker  # imported here so the health tests need neither polars nor a database

    threading.Thread(target=worker.run_forever, args=(url,), daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"{SERVICE} listening on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
