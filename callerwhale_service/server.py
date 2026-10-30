"""Process entry point: JSON lines over stdin/stdout, for the desktop host and the dev server.

    python -m callerwhale_service.server [--resources <folder holding migrations/>]
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

from .api import SERVICE_ROOT, Service
from .logs import log


def serve_stdio(service: Service) -> None:
    # The host speaks UTF-8. Redirected Windows pipes otherwise default to the ANSI code page (cp1252), which
    # cannot encode every character a list can hold, and would crash the service mid-reply.
    sys.stdin.reconfigure(encoding="utf-8")
    protocol_out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", write_through=True)
    sys.stdout = sys.stderr  # nothing but protocol lines may reach the host's stdout
    for line in sys.stdin:
        line = line.lstrip("﻿")  # some hosts prefix the first write with a UTF-8 byte order mark
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            response = {"schema_version": 1, "ok": False, "error": {"code": "invalid_json", "message": "Request is not valid JSON"}}
        else:
            response = {"id": request.get("id"), **service.handle(request)}
        protocol_out.write(json.dumps(response, default=str, ensure_ascii=False) + "\n")
        protocol_out.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", type=Path, default=SERVICE_ROOT, help="directory containing migrations/")
    args = parser.parse_args()
    service = Service(args.resources / "migrations")
    service.open_recent()
    log("info", "service.started", mode="stdio")
    serve_stdio(service)


if __name__ == "__main__":
    main()
