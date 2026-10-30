"""The API's internal routes over HTTP, with the worker's token. Standard library only."""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class ApiError(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"API answered {status}: {body[:300]}")
        self.status = status
        self.body = body

    @property
    def transient(self) -> bool:
        """Worth retrying: the API was busy or restarting, not refusing the work."""
        return self.status in (0, 429, 502, 503, 504)


class Client:
    def __init__(self, base: str, token: str, timeout: float = 60.0) -> None:
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _send(self, method: str, path: str, data: bytes | None, content_type: str) -> bytes:
        request = urllib.request.Request(self.base + "/internal" + path, data=data, method=method,
                                         headers={"Content-Type": content_type, "Authorization": "Worker " + self.token})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise ApiError(error.code, error.read().decode("utf-8", "replace")) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            raise ApiError(0, str(error)) from None

    def post(self, path: str, body: object) -> dict:
        raw = self._send("POST", path, json.dumps(body).encode(), "application/json")
        return json.loads(raw) if raw else {}

    def upload(self, path: str, data: bytes, media_type: str) -> dict:
        return json.loads(self._send("POST", path, data, media_type) or b"{}")

    def download(self, org_id: str, sha256: str) -> bytes:
        return self._send("POST", "/artifacts/read", json.dumps({"org_id": org_id, "sha256": sha256}).encode(), "application/json")
