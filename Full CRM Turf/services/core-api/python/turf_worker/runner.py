"""The job loop: claim, keep the lease while working, report progress, finish or fail (plan 2.3, internal job API).

A job function receives a Job and returns its output. It calls job.progress() now and then; that renews the lease
and raises Cancelled when someone asked for the job to stop.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .client import ApiError, Client

log = logging.getLogger("turf_worker")


class Cancelled(Exception):
    pass


class Refused(Exception):
    """The job's input cannot be worked: failing it again would not help."""


@dataclass
class Job:
    id: str
    org_id: str
    kind: str
    input: dict
    created_by: str | None
    attempts: int
    client: Client
    _cancel: threading.Event = field(default_factory=threading.Event)

    def progress(self, fraction: float, message: str = "") -> None:
        if self._cancel.is_set():
            raise Cancelled()
        answer = self.client.post(f"/jobs/{self.id}/progress", {"org_id": self.org_id, "progress": max(0.0, min(1.0, fraction)), "message": message})
        if answer.get("cancel_requested"):
            self._cancel.set()
            raise Cancelled()


Handler = Callable[[Job], dict]


class Runner:
    def __init__(self, client: Client, handlers: dict[str, Handler], queues: tuple[str, ...] = ("python",), lease_seconds: int = 60) -> None:
        self.client = client
        self.handlers = handlers
        self.queues = list(queues)
        self.lease_seconds = lease_seconds
        self.stopping = threading.Event()

    def claim(self) -> Job | None:
        answer = self.client.post("/jobs/claim", {"queues": self.queues, "lease_seconds": self.lease_seconds})
        row = answer.get("job")
        if not row:
            return None
        return Job(id=row["id"], org_id=row["org_id"], kind=row["kind"], input=row.get("input") or {}, created_by=row.get("created_by"),
                   attempts=row.get("attempts", 1), client=self.client)

    def _keep_lease(self, job: Job, done: threading.Event) -> None:
        while not done.wait(self.lease_seconds / 3):
            try:
                answer = self.client.post(f"/jobs/{job.id}/renew", {"org_id": job.org_id, "lease_seconds": self.lease_seconds})
                if answer.get("cancel_requested"):
                    job._cancel.set()
            except ApiError as error:
                if error.status == 409:  # the lease is gone: someone else may hold the job now
                    job._cancel.set()
                    return
                log.warning("lease renewal failed: %s", error)

    def run_one(self, job: Job) -> str:
        handler = self.handlers.get(job.kind)
        done = threading.Event()
        keeper = threading.Thread(target=self._keep_lease, args=(job, done), daemon=True)
        keeper.start()
        try:
            if handler is None:
                raise Refused(f"This worker does not run {job.kind} jobs")
            output = handler(job)
            self.client.post(f"/jobs/{job.id}/complete", {"org_id": job.org_id, "output": output})
            return "done"
        except Cancelled:
            self.client.post(f"/jobs/{job.id}/complete", {"org_id": job.org_id, "output": {"cancelled": True}})
            return "cancelled"
        except Refused as error:
            self._fail(job, str(error), retry=False)
            return "failed"
        except ApiError as error:
            self._fail(job, str(error), retry=error.transient)
            return "failed"
        except Exception as error:  # an unexpected fault: retried, within the job's attempt limit
            log.exception("job %s failed", job.id)
            self._fail(job, f"{type(error).__name__}: {error}", retry=True)
            return "failed"
        finally:
            done.set()

    def _fail(self, job: Job, message: str, retry: bool) -> None:
        try:
            self.client.post(f"/jobs/{job.id}/fail", {"org_id": job.org_id, "error": message, "retry": retry})
        except ApiError as error:
            # The lease will run out and the job becomes claimable again.
            log.warning("could not report failure of %s: %s", job.id, error)

    def forever(self, idle: float = 2.0) -> None:
        backoff = idle
        while not self.stopping.is_set():
            try:
                job = self.claim()
            except ApiError as error:
                log.warning("claim failed: %s", error)
                backoff = min(backoff * 2, 60.0)
                self.stopping.wait(backoff)
                continue
            backoff = idle
            if job is None:
                self.stopping.wait(idle)
                continue
            log.info("job %s (%s) %s", job.id, job.kind, self.run_one(job))
            time.sleep(0)
