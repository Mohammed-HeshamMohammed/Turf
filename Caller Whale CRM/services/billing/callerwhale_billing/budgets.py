"""Build step 22: budgets for teams, people and clients inside the agency's allowance (D120, D121, D122, D123, D135).

A use (call minutes, texts) is checked against every budget it falls under (the lead's team, the person who made it, the lead's client)
and, for minutes, against the plan's allowance; then charged once per request id. A budget that would be passed refuses it with
402 budget_reached, naming which one, and the person can ask for it to be raised."""

from datetime import datetime
from uuid import UUID, uuid4

from psycopg.rows import dict_row

from .store import Refused, Store, month_of

KINDS = ("minutes", "texts", "ai")  # ai: one use of the in-app assistant (step 26, D323)
# The most assistant uses one person may make in a day, against runaway use (D323). Use about a lead is charged to its team and client;
# use about nothing in particular (a "how do I" question) only to the person and the agency's allowance (D372).
AI_DAILY_CAP = 200
SCOPES = ("team", "person", "client")
WHOSE = {"team": "Your team's", "person": "Your own", "client": "This client's"}


def use(store: Store, org: UUID, kind: str, amount: int, request_id: UUID, team: UUID | None, user: UUID | None, client: UUID | None,
        now: datetime, check_only: bool) -> dict:
    if kind not in KINDS:
        raise Refused(400, "bad_request", "kind is minutes, texts or ai")
    if not 1 <= amount <= 100_000:
        raise Refused(400, "bad_request", "Use 1 to 100,000 at a time.")
    start, end = month_of(now)
    subjects = {"team": team, "person": user, "client": client}
    with store.pool.connection() as conn, conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT amount FROM billing.usage WHERE org_id = %s AND kind = %s AND request_id = %s", (org, kind, request_id))
        earlier = cur.fetchone()
        if earlier is not None and not check_only:
            return {"ok": True, "duplicate": True}
        if kind == "ai" and user is not None:
            day = now.replace(hour=0, minute=0, second=0, microsecond=0)
            cur.execute("SELECT coalesce(sum(amount), 0)::bigint AS used FROM billing.usage WHERE org_id = %s AND kind = 'ai' AND user_id = %s AND at >= %s",
                        (org, user, day))
            if cur.fetchone()["used"] + amount > AI_DAILY_CAP:
                raise Refused(429, "daily_cap", f"You have used the assistant {AI_DAILY_CAP} times today, the most one person may. It opens again tomorrow.")
        # The budgets this use falls under, locked so two uses cannot both take the last of one.
        cur.execute(
            "SELECT scope, subject_id, monthly FROM billing.budgets WHERE org_id = %s AND kind = %s AND "
            "((scope = 'team' AND subject_id = %s) OR (scope = 'person' AND subject_id = %s) OR (scope = 'client' AND subject_id = %s)) "
            "ORDER BY scope FOR UPDATE",
            (org, kind, team, user, client),
        )
        for budget in cur.fetchall():
            column = {"team": "team_id", "person": "user_id", "client": "client_id"}[budget["scope"]]
            cur.execute(
                f"SELECT coalesce(sum(amount), 0)::bigint AS used FROM billing.usage WHERE org_id = %s AND kind = %s AND {column} = %s AND at >= %s AND at < %s",
                (org, kind, subjects[budget["scope"]], start, end),
            )
            used = cur.fetchone()["used"]
            if used + amount > budget["monthly"]:
                left = max(0, budget["monthly"] - used)
                raise Refused(402, "budget_reached",
                              f"{WHOSE[budget['scope']]} {kind} budget for this month is used up ({left:,} left). Ask your team lead or the owner to raise it.")
    if kind == "minutes" and not check_only:
        # The agency's own allowance (the plan's minutes), as before.
        store.reserve("minutes", org, amount, request_id, "call", now)
    if check_only:
        return {"ok": True, "duplicate": False}
    with store.pool.connection() as conn, conn.transaction():
        conn.execute(
            "INSERT INTO billing.usage (org_id, kind, amount, team_id, user_id, client_id, request_id, at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (org_id, kind, request_id) DO NOTHING",
            (org, kind, amount, team, user, client, request_id, now),
        )
    return {"ok": True, "duplicate": False}


def set_budget(store: Store, org: UUID, scope: str, subject: UUID, kind: str, monthly: int | None, set_by: UUID | None) -> None:
    if scope not in SCOPES or kind not in KINDS:
        raise Refused(400, "bad_request", "scope is team, person or client; kind is minutes, texts or ai")
    if monthly is not None and not 0 <= monthly <= 100_000_000:
        raise Refused(400, "bad_request", "A monthly budget is 0 or more, or null to remove it.")
    with store.pool.connection() as conn, conn.transaction():
        if monthly is None:
            conn.execute("DELETE FROM billing.budgets WHERE org_id = %s AND scope = %s AND subject_id = %s AND kind = %s", (org, scope, subject, kind))
            conn.execute("UPDATE billing.raise_requests SET closed_at = now() WHERE org_id = %s AND scope = %s AND subject_id = %s AND kind = %s AND closed_at IS NULL",
                         (org, scope, subject, kind))
            return
        conn.execute(
            "INSERT INTO billing.budgets (org_id, scope, subject_id, kind, monthly, set_by) VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (org_id, scope, subject_id, kind) DO UPDATE SET monthly = excluded.monthly, set_by = excluded.set_by, updated_at = now()",
            (org, scope, subject, kind, monthly, set_by),
        )
        # Raising a budget answers the requests to raise it.
        conn.execute("UPDATE billing.raise_requests SET closed_at = now() WHERE org_id = %s AND scope = %s AND subject_id = %s AND kind = %s AND closed_at IS NULL",
                     (org, scope, subject, kind))


def budgets(store: Store, org: UUID, now: datetime) -> list[dict]:
    start, end = month_of(now)
    with store.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT b.scope, b.subject_id, b.kind, b.monthly, coalesce((SELECT sum(u.amount) FROM billing.usage u WHERE u.org_id = b.org_id AND u.kind = b.kind "
            "AND u.at >= %s AND u.at < %s AND CASE b.scope WHEN 'team' THEN u.team_id WHEN 'person' THEN u.user_id ELSE u.client_id END = b.subject_id), 0)::bigint AS used "
            "FROM billing.budgets b WHERE b.org_id = %s ORDER BY b.scope, b.subject_id, b.kind",
            (start, end, org),
        )
        return [{**row, "subject_id": str(row["subject_id"])} for row in cur.fetchall()]


def ask_raise(store: Store, org: UUID, scope: str, subject: UUID, kind: str, asked_by: UUID, note: str, now: datetime) -> str:
    if scope not in SCOPES or kind not in KINDS:
        raise Refused(400, "bad_request", "scope is team, person or client; kind is minutes, texts or ai")
    rid = uuid4()
    with store.pool.connection() as conn, conn.transaction():
        conn.execute(
            "INSERT INTO billing.raise_requests (id, org_id, scope, subject_id, kind, asked_by, note, at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (rid, org, scope, subject, kind, asked_by, note.strip()[:500], now),
        )
    return str(rid)


def raise_requests(store: Store, org: UUID) -> list[dict]:
    with store.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT id, scope, subject_id, kind, asked_by, note, at FROM billing.raise_requests WHERE org_id = %s AND closed_at IS NULL ORDER BY at", (org,))
        return [{k: (str(v) if isinstance(v, UUID) else v) for k, v in row.items()} for row in cur.fetchall()]
