"""Small helpers for driving the service through its command API in tests."""

from __future__ import annotations

import time

from callerwhale_service.api import Service


def call(svc: Service, command: str, **payload):
    return svc.handle({"schema_version": 1, "command": command, "payload": payload})


def ok(svc: Service, command: str, **payload):
    response = call(svc, command, **payload)
    assert response["ok"], response
    return response["result"]


def wait(svc: Service, job_id: str, timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = ok(svc, "job.get", job_id=job_id)
        if job["state"] in ("completed", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")
