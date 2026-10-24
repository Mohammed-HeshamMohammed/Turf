"""Development only: plays the payment provider and confirms (or fails) a checkout, signing the webhook exactly as a
real provider integration must: HMAC-SHA256 of the raw body with TURF_BILLING_WEBHOOK_SECRET.

    python backend/scripts/dev_pay.py <payment_id> <amount_cents> [failed] [http://127.0.0.1:8088]

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

if len(sys.argv) < 3:
    sys.exit(__doc__)
payment, amount = sys.argv[1], int(sys.argv[2])
failed = len(sys.argv) > 3 and sys.argv[3] == "failed"
base = (sys.argv[4] if len(sys.argv) > 4 else sys.argv[3] if len(sys.argv) > 3 and sys.argv[3].startswith("http") else "http://127.0.0.1:8088").rstrip("/")
secret = os.environ.get("TURF_BILLING_WEBHOOK_SECRET", "dev-webhook-secret-change-me-000000")

event = {"event_id": "dev-" + uuid.uuid4().hex, "type": "payment.failed" if failed else "payment.succeeded", "payment_id": payment,
         "amount_cents": amount, "provider_ref": "dev-" + uuid.uuid4().hex[:12]}
body = json.dumps(event).encode()
signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
request = urllib.request.Request(base + "/api/v1/billing/webhook", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Turf-Signature": signature})
try:
    with urllib.request.urlopen(request) as response:
        print(response.read().decode())
except urllib.error.HTTPError as error:
    sys.exit(f"{error.code}: {error.read().decode()}")
