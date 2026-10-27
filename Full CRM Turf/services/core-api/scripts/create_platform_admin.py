"""Makes someone a platform administrator of this Turf server: the people who run Turf the service. They get the
Customers page listing every organization (never their CRM records), and their own workspaces lose their plan limits.

    python services/core-api/scripts/create_platform_admin.py <email>

Accounts live only in the auth service, so the person signs up there first (the website or the app) and opens the CRM
once, which gives this server its copy of them. This script then promotes that copy directly in the database with the
owning role: MIGRATION_DATABASE_URL, by default the local development one. When the server requires MFA they also need
two-step sign-in turned on at auth to see the Customers page.
"""

from __future__ import annotations

import os
import sys

import psycopg

if len(sys.argv) < 2:
    sys.exit(__doc__)
email = sys.argv[1].strip().lower()
database = os.environ.get("MIGRATION_DATABASE_URL", "postgres://turf_owner:turf_owner@127.0.0.1:55432/turf")

with psycopg.connect(database) as db:
    row = db.execute(
        "UPDATE users SET platform_admin = true, email_verified_at = coalesce(email_verified_at, now()) WHERE email = %s RETURNING id",
        (email,),
    ).fetchone()
    if row is None:
        sys.exit(f"{email} has not used this server yet. Sign up with the auth service and open the CRM once, then run this again.")
    user = row[0]
    # Their own workspaces carry no plan: the same as a self-hosted organization, with no trial clock or minute limit.
    orgs = db.execute("SELECT org_id FROM memberships WHERE user_id = %s AND 'owner' = ANY(roles)", (user,)).fetchall()
    for (org,) in orgs:
        db.execute("DELETE FROM subscriptions WHERE org_id = %s", (org,))
        db.execute("UPDATE organizations SET account_kind = 'business' WHERE id = %s", (org,))

print(f"{email} is a platform administrator ({len(orgs)} workspace{'s' if len(orgs) != 1 else ''} without limits).")
