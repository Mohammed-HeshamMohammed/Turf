"""The billing service's HTTP API. Public requests (plans, the payment provider's webhook) arrive through the gateway; private
ones come from Caller Whale's own services, each with its own token from BILLING_TOKENS."""

import hmac
import json
import logging
import time
import urllib.request
from datetime import UTC, datetime
from typing import Callable
from uuid import UUID

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import SERVICE, VERSION, paddle
from .config import CALLER_RIGHTS, Settings
from .store import Refused

log = logging.getLogger("billing")


class ReserveBody(BaseModel):
    kind: str
    account_id: UUID
    amount: int
    request_id: UUID
    detail: str = Field(default="", max_length=200)


class CreditLimitBody(BaseModel):
    monthly_credits: int | None = Field(default=None, ge=0, le=1_000_000_000)


class TrialBody(BaseModel):
    plan: str = "trial"
    days: int = Field(default=14, ge=1, le=90)


def tell_authorization(settings: Settings, org: str, standing: dict) -> None:
    """Passes a workspace's standing to the authorization service, so every grant follows the plan. A failure is logged and
    retried by the next webhook or standing check; it never loses the payment record, which is already stored."""
    if not settings.authz_url:
        return
    body = json.dumps({"suspended": False, "payment_required": bool(standing.get("payment_required"))}).encode()
    req = urllib.request.Request(f"{settings.authz_url}/v1/orgs/{org}/standing", data=body, method="PUT",
                                 headers={"Authorization": f"Bearer {settings.authz_token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            res.read()
    except OSError as error:
        log.error("could not tell the authorization service about workspace %s: %s", org, error)


def create_app(settings: Settings, store, now: Callable[[], datetime] = lambda: datetime.now(UTC), notify=tell_authorization) -> FastAPI:
    app = FastAPI(title="Caller Whale billing", version=VERSION, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        """Method, path, status and time only: never headers or bodies (Design notes/Runtime logs.md)."""
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            if not (request.url.path == "/healthz" and status < 400):
                print(json.dumps({"cw_event": "request", "method": request.method, "path": request.url.path, "status": status,
                                  "duration_seconds": round(time.perf_counter() - started, 6)}), flush=True)

    @app.exception_handler(Refused)
    async def refused(_: Request, error: Refused):
        return JSONResponse({"error": error.message, "code": error.code}, status_code=error.status, headers={"Cache-Control": "no-store"})

    @app.exception_handler(RequestValidationError)
    async def unreadable(_: Request, __: RequestValidationError):
        return JSONResponse({"error": "That request could not be read.", "code": "bad_request"}, status_code=400)

    def caller(right: str):
        def check(authorization: str = Header(default="")) -> str:
            token = authorization.removeprefix("Bearer ")
            name = next((n for t, n in settings.tokens.items() if hmac.compare_digest(t, token)), None)
            if name is None:
                log.warning("refused a request without a known caller token")
                raise Refused(401, "unknown_caller", "This request is for Caller Whale's own services.")
            if right not in CALLER_RIGHTS[name]:
                raise Refused(403, "not_allowed", "This service may not make that request.")
            return name

        return Depends(check)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "service": SERVICE}

    @app.get("/version")
    def version():
        return {"service": SERVICE, "version": VERSION}

    @app.get("/api/v1/plans")
    def plans():
        return {"plans": store.plans()}

    @app.post("/api/v1/billing/webhook")
    async def paddle_webhook(request: Request, paddle_signature: str | None = Header(default=None)):
        body = await request.body()
        if not paddle.verify(paddle_signature, body, settings.paddle_webhook_secret, settings.paddle_tolerance_seconds):
            log.warning("refused a webhook whose signature does not match")
            raise Refused(401, "bad_signature", "The signature does not match.")
        try:
            event = json.loads(body)
        except ValueError as error:
            raise Refused(400, "bad_request", "The body is not JSON.") from error
        new, org = store.record_webhook("paddle", event)
        if org:
            notify(settings, org, store.standing(UUID(org), now()))
        return {"ok": True, "duplicate": not new}

    @app.post("/v1/reservations")
    def reserve(body: ReserveBody, _: str = caller("reserve")):
        return store.reserve(body.kind, body.account_id, body.amount, body.request_id, body.detail, now()).as_json()

    @app.get("/v1/orgs/{org_id}/standing")
    def standing(org_id: UUID, _: str = caller("standing")):
        return store.standing(org_id, now())

    @app.put("/v1/orgs/{org_id}/trial")
    def trial(org_id: UUID, body: TrialBody, _: str = caller("subscribe")):
        opened = store.start_trial(org_id, body.plan, body.days, now())
        current = store.standing(org_id, now())
        if opened:
            notify(settings, str(org_id), current)
        return {"opened": opened, "standing": current}

    @app.put("/v1/people/{user_id}/credit-limit")
    def credit_limit(user_id: UUID, body: CreditLimitBody, _: str = caller("credits")):
        store.set_credit_limit(user_id, body.monthly_credits)
        return {"user_id": str(user_id), "monthly_credits": body.monthly_credits}

    return app
