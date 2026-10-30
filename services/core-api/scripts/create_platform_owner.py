"""Sets the platform owner of this Caller Whale server: the owner of the app, who appoints system administrators and manages
every customer workspace from the admin dashboard. There is only ever one, and this script is the only way to set it.

    python services/core-api/scripts/create_platform_owner.py <email>

Run it on the server, once. It uses the owning database role (MIGRATION_DATABASE_URL, by default the local development
one); the API itself can never give a platform role. Accounts live only in the auth service, so the person signs up
there first (the website or the app) and opens Caller Whale once, which gives this server its copy of them. Their own
workspaces lose their plan limits. When the server requires MFA they need two-step sign-in on at auth for the dashboard.

Refused when there is already a platform owner. Handing the app over to someone else is done by hand in the database,
on purpose.
"""

from __future__ import annotations

import os
import sys

import psycopg

if len(sys.argv) < 2:
    sys.exit(__doc__)
email = sys.argv[1].strip().lower()
database = os.environ.get("MIGRATION_DATABASE_URL", "postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:55432/callerwhale")

with psycopg.connect(database) as db:
    current = db.execute("SELECT email::text FROM users WHERE platform_role = 'owner'").fetchone()
    if current:
        sys.exit(f"This server already has a platform owner ({current[0]}).")
    row = db.execute(
        "UPDATE users SET platform_role = 'owner', disabled_at = NULL, email_verified_at = coalesce(email_verified_at, now()) WHERE email = %s RETURNING id",
        (email,),
    ).fetchone()
    if row is None:
        sys.exit(f"{email} has not used this server yet. Sign up with the auth service and open Caller Whale once, then run this again.")
    user = row[0]
    # Their own workspaces carry no plan: no trial clock, seat or minute limit.
    orgs = db.execute("SELECT org_id FROM memberships WHERE user_id = %s AND 'owner' = ANY(roles)", (user,)).fetchall()
    for (org,) in orgs:
        db.execute("DELETE FROM subscriptions WHERE org_id = %s", (org,))
        db.execute("UPDATE organizations SET account_kind = 'business' WHERE id = %s", (org,))

print(f"{email} is the platform owner ({len(orgs)} workspace{'s' if len(orgs) != 1 else ''} without limits).")
