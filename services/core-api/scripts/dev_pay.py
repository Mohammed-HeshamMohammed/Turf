"""Development only: plays the payment provider and confirms (or fails) a checkout, signing the webhook exactly as a
real provider integration must: HMAC-SHA256 of the raw body with CALLERWHALE_BILLING_WEBHOOK_SECRET.

    python services/core-api/scripts/dev_pay.py <payment_id> <amount_cents> [failed] [http://127.0.0.1:8088]

The website's account page shows the command with the right payment id and amount after a checkout.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

if len(sys.argv) < 3:
    sys.exit(__doc__)
payment, amount = sys.argv[1], int(sys.argv[2])
failed = len(sys.argv) > 3 and sys.argv[3] == "failed"
base = (sys.argv[4] if len(sys.argv) > 4 else sys.argv[3] if len(sys.argv) > 3 and sys.argv[3].startswith("http") else "http://127.0.0.1:8088").rstrip("/")
def setting(name: str) -> str:
    """From the environment, else env/core-api.env (env/README.md), where run-api.sh reads it too."""
    if os.environ.get(name):
        return os.environ[name]
    path = Path(__file__).resolve().parents[3] / "env" / "core-api.env"
    for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"Set {name}, or run node tools/env-init.mjs (see env/README.md)")


secret = setting("CALLERWHALE_BILLING_WEBHOOK_SECRET")

event = {"event_id": "dev-" + uuid.uuid4().hex, "type": "payment.failed" if failed else "payment.succeeded", "payment_id": payment,
         "amount_cents": amount, "provider_ref": "dev-" + uuid.uuid4().hex[:12]}
body = json.dumps(event).encode()
signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
request = urllib.request.Request(base + "/api/v1/billing/webhook", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-CallerWhale-Signature": signature})
try:
    with urllib.request.urlopen(request) as response:
        print(response.read().decode())
except urllib.error.HTTPError as error:
    sys.exit(f"{error.code}: {error.read().decode()}")
