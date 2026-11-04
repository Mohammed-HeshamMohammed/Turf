"""Paddle's signed webhooks. Paddle sends `Paddle-Signature: ts=<unix seconds>;h1=<hex>` where h1 is HMAC-SHA256, keyed with the
notification destination's secret, of "<ts>:<raw body>". During a secret rotation there can be several h1 values."""

import hashlib
import hmac
import time


def verify(header: str | None, body: bytes, secret: str, tolerance_seconds: int, now: float | None = None) -> bool:
    """True when the body is exactly what Paddle signed with this secret, recently enough."""
    if not header or not secret:
        return False
    timestamp, signatures = None, []
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "ts":
            timestamp = value
        elif name == "h1" and value:
            signatures.append(value)
    if timestamp is None or not timestamp.isdigit() or not signatures:
        return False
    current = time.time() if now is None else now
    if abs(current - int(timestamp)) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b":" + body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in signatures)


def sign(body: bytes, secret: str, timestamp: int) -> str:
    """The header Paddle would send for this body (for tests and for replaying recorded samples)."""
    digest = hmac.new(secret.encode(), str(timestamp).encode() + b":" + body, hashlib.sha256).hexdigest()
    return f"ts={timestamp};h1={digest}"


# Paddle subscription statuses, and ours. Paddle's "trialing" and "active" mean the workspace can be used.
STATUSES = {"trialing": "trialing", "active": "active", "past_due": "past_due", "paused": "paused", "canceled": "canceled"}
