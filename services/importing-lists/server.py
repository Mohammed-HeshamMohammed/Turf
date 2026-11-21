"""Importing lists: the upload service. It takes uploads in, in pieces, and keeps them in its own volume; the importing worker
(services/importing-worker, its own container since split 1) fetches each finished upload from here and does the reading and loading."""
import json
import os
import threading
import time
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import upload_api

SERVICE = "importing-lists"
VERSION = "0.3.0"
SWEEP_SECONDS = 600


def route(method: str, path: str) -> tuple[int, dict]:
    """The status and JSON body for a request."""
    if method == "GET" and path == "/healthz":
        return 200, {"ok": True, "service": SERVICE}
    if method == "GET" and path == "/version":
        return 200, {"service": SERVICE, "version": VERSION}
    return 404, {"error": "Not found."}


class Handler(BaseHTTPRequestHandler):
    # A sender that stalls for a minute is cut off, so slow or stuck uploads cannot hold threads for ever.
    timeout = 60

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

    def _internal(self, method: str) -> bool:
        """The routes the importing worker uses to fetch an upload and let it go. Never sent here by the gateway."""
        path = self.path.split("?", 1)[0]
        if not path.startswith("/internal/"):
            return False
        self._cw_started = time.perf_counter()
        try:
            upload_api.internal(self)
            if method == "GET" and (match := re.fullmatch(r"/internal/jobs/([0-9a-fA-F-]{36})/files", path)):
                body = upload_api.list_files(match.group(1))
            elif method == "GET" and (match := re.fullmatch(r"/internal/jobs/([0-9a-fA-F-]{36})/files/([A-Za-z0-9.]+)", path)):
                self._send_file(upload_api.file_path(*match.groups()))
                return True
            elif method == "DELETE" and (match := re.fullmatch(r"/internal/jobs/([0-9a-fA-F-]{36})/files", path)):
                body = upload_api.delete_files(match.group(1))
            else:
                raise upload_api.APIError(404, "Not found.", "not_found")
            status = 200
        except upload_api.APIError as error:
            status, body = error.status, {"error": {"code": error.code, "message": str(error)}}
        except OSError:
            import traceback
            traceback.print_exc()
            status, body = 500, {"error": {"code": "files_unavailable", "message": "The files could not be read."}}
        self._send(status, body)
        return True

    def _send_file(self, path) -> None:
        with open(path, "rb") as source:
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-length", str(path.stat().st_size))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            while block := source.read(1 << 20):
                self.wfile.write(block)

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
        if self._internal("GET") or self._upload("GET"):
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

    def do_DELETE(self) -> None:  # noqa: N802
        if self._internal("DELETE"):
            return
        self._reply("DELETE")

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


def sweep_forever() -> None:
    """Every ten minutes, removes the files of uploads that are cancelled, failed or older than IMPORT_KEEP_FILE_DAYS."""
    while True:
        try:
            with upload_api.database() as conn:
                removed = upload_api.sweep_files(conn)
            if removed:
                print(json.dumps({"level": "INFO", "message": "removed the files of finished uploads", "folders": removed}), flush=True)
        except Exception as error:  # the sweep must keep running; the uploads do not depend on it
            print(json.dumps({"level": "WARN", "message": "upload file cleanup could not finish", "error": str(error)}), flush=True)
        time.sleep(SWEEP_SECONDS)


def main() -> None:
    port = int(os.environ.get("PORT", "8111"))
    if not os.environ.get("DATABASE_URL"):
        raise SystemExit("set DATABASE_URL: the importer's own login on the CRM database")
    if not os.environ.get("IMPORT_FILE_TOKEN"):
        print(json.dumps({"level": "WARN", "message": "IMPORT_FILE_TOKEN is not set: the importing worker cannot fetch uploads from here"}), flush=True)
    threading.Thread(target=sweep_forever, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"{SERVICE} listening on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
