"""Importing worker: reads, cleans and loads the lists people upload. A container of its own (split 1, D389): the upload service
(importing-lists) takes the pieces in, and this one fetches each finished upload from it and does the heavy work. It answers /healthz,
/version and /status; nothing outside the private network reaches it."""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVICE = "importing-worker"
VERSION = "0.1.0"
worker = None  # the worker module, set by main(), so the health tests need neither polars nor a database


def route(method: str, path: str) -> tuple[int, dict]:
    """The status and JSON body for a request."""
    if method == "GET" and path == "/healthz":
        if worker is not None and not worker.loops_alive():
            return 503, {"ok": False, "service": SERVICE, "error": "An import worker loop has stopped."}
        return 200, {"ok": True, "service": SERVICE}
    if method == "GET" and path == "/version":
        return 200, {"service": SERVICE, "version": VERSION}
    if method == "GET" and path == "/status":
        if worker is None:
            return 200, {"service": SERVICE, "workers": 0, "working_on": []}
        with worker._active_lock:
            active = sorted(worker._active)
        return 200, {"service": SERVICE, "workers": len(worker._loops), "working_on": active}
    return 404, {"error": "Not found."}


class Handler(BaseHTTPRequestHandler):
    timeout = 30

    def _reply(self, method: str) -> None:
        self._cw_started = time.perf_counter()
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
    port = int(os.environ.get("PORT", "8119"))
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise SystemExit("set DATABASE_URL: the import worker's own login on the CRM database")
    if not os.environ.get("IMPORT_FILE_TOKEN"):
        print(json.dumps({"level": "WARN", "message": "IMPORT_FILE_TOKEN is not set: uploads are read from IMPORT_DIR only, not fetched from importing-lists"}), flush=True)
    global worker
    import worker as loaded

    worker = loaded
    threading.Thread(target=worker.run_forever, args=(url,), daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"{SERVICE} listening on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
