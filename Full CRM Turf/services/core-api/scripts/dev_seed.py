"""Seeds a local development server with an organization, people in each role and sample leads.

    python services/core-api/scripts/dev_seed.py [http://127.0.0.1:8088]

Only for a fresh local database (bootstrap is refused once an organization exists). The accounts below are test
accounts for this development server; the owner's MFA secret is written to services/core-api/scripts/.dev-accounts.json
(git-ignored) so local tools can produce its sign-in code.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.cookiejar
import json
import struct
import sys
import time
import urllib.request
import uuid
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8088").rstrip("/")
PASSWORD = "local-dev-password-1"
PEOPLE = [("caller", "Maya Chen"), ("closer", "Alex Rivera"), ("manager", "Lena Brooks"), ("researcher", "Ben Carter"), ("client", "Taylor Reed")]
LEADS = [
    ("Sarah Johnson", "1842 Palm Avenue", "Tampa", "+18135550101"),
    ("Michael Bennett", "620 Willow Street", "Tampa", "+18135550102"),
    ("David Brooks", "221 Magnolia Lane", "Tampa", "+18135550104"),
    ("Angela Lewis", "48 Oak Hollow Road", "Clearwater", "+18135550105"),
]


class Session:
    def __init__(self) -> None:
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method: str, path: str, body: object | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json", "X-Turf-Request": "1"})
        with self.opener.open(request, timeout=30) as response:
            text = response.read().decode()
        return json.loads(text) if text else {}


def totp(secret: str) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def main() -> None:
    owner = Session()
    owner.call("POST", "/api/v1/auth/bootstrap", {"organization": "Oak & Palm Partners", "email": "owner@turf.localhost", "display_name": "Jordan Ellis",
                                                  "password": PASSWORD, "timezone": "America/New_York"})
    secret = owner.call("POST", "/api/v1/auth/mfa/setup", {})["secret"]
    codes = owner.call("POST", "/api/v1/auth/mfa/confirm", {"code": totp(secret)})["recovery_codes"]
    team = owner.call("GET", "/api/v1/admin/teams")[0]["id"]
    owner.call("POST", "/api/v1/projects", {"name": "Tampa absentee owners", "qualification_fields": []})
    ids = {}
    sessions = {}
    for role, name in PEOPLE:
        invite = owner.call("POST", "/api/v1/admin/members", {"email": f"{role}@turf.localhost", "roles": [role], "team_ids": [team]})
        person = Session()
        ids[role] = person.call("POST", "/api/v1/auth/invitations/accept", {"token": invite["token"], "display_name": name, "password": PASSWORD})["user_id"]
        sessions[role] = person
    for index, (name, address, city, phone) in enumerate(LEADS):
        lead = owner.call("POST", "/api/v1/ops", {"id": str(uuid.uuid4()), "kind": "lead.create",
                                                  "payload": {"name": name, "address": address, "city": city, "region": "FL", "phone": phone,
                                                              "assignee_id": ids["caller"] if index < 3 else ids["closer"]}})
        assert lead["status"] == "applied", lead
    accounts = {"base": BASE, "password": PASSWORD, "owner": {"email": "owner@turf.localhost", "totp_secret": secret, "recovery_codes": codes},
                "people": {role: f"{role}@turf.localhost" for role, _ in PEOPLE}}
    target = Path(__file__).with_name(".dev-accounts.json")
    target.write_text(json.dumps(accounts, indent=2))
    print(f"Seeded {BASE}. Accounts (password in {target.name}): owner@turf.localhost (MFA) and " + ", ".join(accounts["people"].values()))


if __name__ == "__main__":
    main()
