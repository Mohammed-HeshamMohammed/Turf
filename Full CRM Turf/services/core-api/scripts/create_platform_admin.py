"""Makes someone a platform administrator of this Turf server: the people who run Turf the service. They get their own
workspace with no plan limits and the Customers page listing every organization (never their CRM records).

    TURF_ADMIN_PASSWORD=... python services/core-api/scripts/create_platform_admin.py <email> "<name>" ["<workspace name>"]

Without TURF_ADMIN_PASSWORD it asks for the password. The account is made through the API's own sign-up (so the
password is hashed and checked like any other), then promoted directly in the database with the owning role:
MIGRATION_DATABASE_URL, by default the local development one. An existing account is only promoted.
They set up an authenticator code at their first sign-in, as every owner does.
"""

from __future__ import annotations

import getpass
import json
import os
import sys
import urllib.error
import urllib.request

import psycopg

if len(sys.argv) < 3:
    sys.exit(__doc__)
email, name = sys.argv[1].strip().lower(), sys.argv[2].strip()
workspace = sys.argv[3].strip() if len(sys.argv) > 3 else "Turf HQ"
base = os.environ.get("TURF_API", "http://localhost:8088").rstrip("/")
database = os.environ.get("MIGRATION_DATABASE_URL", "postgres://turf_owner:turf_owner@127.0.0.1:55432/turf")

with psycopg.connect(database) as db:
    exists = db.execute("SELECT 1 FROM users WHERE email = %s", (email,)).fetchone()

if not exists:
    password = os.environ.get("TURF_ADMIN_PASSWORD") or getpass.getpass("Password (12+ characters): ")
    body = json.dumps({"email": email, "display_name": name, "password": password, "organization": workspace}).encode()
    request = urllib.request.Request(base + "/api/v1/auth/signup", data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request).read()
    except urllib.error.HTTPError as error:
        sys.exit(f"Sign-up refused ({error.code}): {json.loads(error.read() or b'{}').get('error', {}).get('message', '')}")

with psycopg.connect(database) as db:
    user = db.execute(
        "UPDATE users SET platform_admin = true, email_verified_at = coalesce(email_verified_at, now()) WHERE email = %s RETURNING id",
        (email,),
    ).fetchone()[0]
    # Their own workspaces carry no plan: the same as a self-hosted organization, with no trial clock or minute limit.
    orgs = db.execute("SELECT org_id FROM memberships WHERE user_id = %s AND 'owner' = ANY(roles)", (user,)).fetchall()
    for (org,) in orgs:
        db.execute("DELETE FROM subscriptions WHERE org_id = %s", (org,))
        db.execute("UPDATE organizations SET account_kind = 'business' WHERE id = %s", (org,))

print(f"{email} is a platform administrator ({len(orgs)} workspace{'s' if len(orgs) != 1 else ''} without limits).")
