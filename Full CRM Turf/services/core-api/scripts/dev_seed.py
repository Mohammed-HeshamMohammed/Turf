"""Seeds a local development server with an organization, people in each role and sample leads.

    python services/core-api/scripts/dev_seed.py [http://127.0.0.1:8088] [http://127.0.0.1:8101]

The first address is the core API, the second the auth service; both must be running (scripts/run-api.sh and the auth
service with AUTH_DEV_TOKENS=true). Accounts are made at auth, which is the only place an account or a session exists;
the core API only sees their access tokens. Only for fresh local databases (bootstrap is refused once an organization
exists). The accounts below are test accounts for these development servers; the owner's MFA secret is written to
services/core-api/scripts/.dev-accounts.json (git-ignored) so local tools can produce its sign-in code.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import struct
import sys
import time
import urllib.request
import uuid
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8088").rstrip("/")
AUTH = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8101").rstrip("/")
PASSWORD = "local-dev-password-1"
PEOPLE = [("caller", "Maya Chen"), ("closer", "Alex Rivera"), ("manager", "Lena Brooks"), ("researcher", "Ben Carter"), ("client", "Taylor Reed")]
LEADS = [
    ("Sarah Johnson", "1842 Palm Avenue", "Tampa", "+18135550101"),
    ("Michael Bennett", "620 Willow Street", "Tampa", "+18135550102"),
    ("David Brooks", "221 Magnolia Lane", "Tampa", "+18135550104"),
    ("Angela Lewis", "48 Oak Hollow Road", "Clearwater", "+18135550105"),
]


def call(base: str, method: str, path: str, body: object | None = None, token: str | None = None, org: str | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if org:
        headers["X-Turf-Org"] = org
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode()
    return json.loads(text) if text else {}


class Person:
    """Someone signed in with auth, acting in one organization of the core API."""

    def __init__(self, email: str, name: str) -> None:
        self.email = email
        reply = call(AUTH, "POST", "/v1/accounts", {"email": email, "password": PASSWORD, "name": name, "kind": "desktop"})
        self.id = reply["user"]["id"]
        self.token = reply["access_token"]
        self.org: str | None = None
        if reply.get("verification_token"):
            call(AUTH, "POST", "/v1/email/verify", {"token": reply["verification_token"]})
            self.sign_in()

    def sign_in(self, code: str | None = None) -> None:
        body = {"email": self.email, "password": PASSWORD, "kind": "desktop"}
        if code:
            body["code"] = code
        self.token = call(AUTH, "POST", "/v1/sessions", body)["access_token"]

    def auth(self, method: str, path: str, body: object | None = None) -> dict:
        return call(AUTH, method, path, body, self.token)

    def api(self, method: str, path: str, body: object | None = None) -> dict:
        return call(BASE, method, path, body, self.token, self.org)


def totp(secret: str) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def main() -> None:
    owner = Person("owner@turf.localhost", "Jordan Ellis")
    # Two-step sign-in is turned on at auth; signing in again with a code gives a token that says it was passed.
    secret = owner.auth("POST", "/v1/mfa/setup", {})["secret"]
    codes = owner.auth("POST", "/v1/mfa/confirm", {"code": totp(secret)})["recovery_codes"]
    owner.sign_in(totp(secret))
    owner.org = owner.api("POST", "/api/v1/auth/bootstrap", {"organization": "Oak & Palm Partners", "timezone": "America/New_York"})["organization_id"]
    team = owner.api("GET", "/api/v1/admin/teams")[0]["id"]
    owner.api("POST", "/api/v1/projects", {"name": "Tampa absentee owners", "qualification_fields": []})
    ids = {}
    for role, name in PEOPLE:
        invite = owner.api("POST", "/api/v1/admin/members", {"email": f"{role}@turf.localhost", "roles": [role], "team_ids": [team]})
        person = Person(f"{role}@turf.localhost", name)
        person.api("POST", "/api/v1/invitations/join", {"token": invite["token"]})
        ids[role] = person.id
    for index, (name, address, city, phone) in enumerate(LEADS):
        lead = owner.api("POST", "/api/v1/ops", {"id": str(uuid.uuid4()), "kind": "lead.create",
                                                 "payload": {"name": name, "address": address, "city": city, "region": "FL", "phone": phone,
                                                             "assignee_id": ids["caller"] if index < 3 else ids["closer"]}})
        assert lead["status"] == "applied", lead
    accounts = {"base": BASE, "auth": AUTH, "password": PASSWORD, "organization_id": owner.org,
                "owner": {"email": "owner@turf.localhost", "totp_secret": secret, "recovery_codes": codes},
                "people": {role: f"{role}@turf.localhost" for role, _ in PEOPLE}}
    target = Path(__file__).with_name(".dev-accounts.json")
    target.write_text(json.dumps(accounts, indent=2))
    print(f"Seeded {BASE} (accounts at {AUTH}; password in {target.name}): owner@turf.localhost (MFA) and " + ", ".join(accounts["people"].values()))


if __name__ == "__main__":
    main()
