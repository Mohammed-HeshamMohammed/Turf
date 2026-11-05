"""Everything billing reads and writes, as one class so the web layer never writes SQL. Each method is one transaction."""

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from . import money
from .paddle import STATUSES

log = logging.getLogger("billing")

# Subscription states in which the workspace can be used.
GOOD_STANDING = {"trialing", "active"}


class Refused(Exception):
    """A request the rules refuse: the code programs read and the sentence people read."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def month_of(now: datetime) -> tuple[datetime, datetime]:
    """The calendar month (UTC) that contains now: credits reset on the first."""
    start = datetime(now.year, now.month, 1, tzinfo=UTC)
    end = datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=UTC)
    return start, end


@dataclass
class Reservation:
    limited: bool
    duplicate: bool = False
    used: int = 0
    allowed: int | None = None

    def as_json(self) -> dict:
        body = {"limited": self.limited, "duplicate": self.duplicate}
        if self.limited:
            body.update(used=self.used, allowed=self.allowed, remaining=max(0, (self.allowed or 0) - self.used))
        return body


class Store:
    def __init__(self, pool: ConnectionPool):
        self.pool = pool

    def plans(self) -> list[dict]:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT key, name, seats, monthly_minutes, price_minor, currency FROM billing.plans WHERE active ORDER BY price_minor, key")
            rows = cur.fetchall()
        for row in rows:
            row["price"] = str(money.from_minor(row["price_minor"], row["currency"]))
        return rows

    def summary(self, now: datetime) -> dict:
        """What the platform owner's dashboard shows: money taken, who is on which plan, and what is being used. Totals only: no card
        or payment-provider details, and people appear by id."""
        start, end = month_of(now)
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT s.plan_key, p.name, p.currency, p.price_minor, s.status, count(*)::int AS workspaces "
                "FROM billing.subscriptions s JOIN billing.plans p ON p.key = s.plan_key GROUP BY 1, 2, 3, 4, 5 ORDER BY workspaces DESC"
            )
            subscriptions = cur.fetchall()
            cur.execute(
                "SELECT to_char(date_trunc('month', at), 'YYYY-MM') AS month, currency, coalesce(sum(amount_minor), 0)::bigint AS amount_minor, count(*)::int AS payments "
                "FROM billing.payments WHERE status IN ('completed', 'paid', 'billed') AND at >= %s GROUP BY 1, 2 ORDER BY 1",
                (now - timedelta(days=365),),
            )
            revenue = cur.fetchall()
            cur.execute(
                "SELECT kind, coalesce(sum(amount), 0)::bigint AS total FROM billing.ledger WHERE at >= %s AND at < %s GROUP BY kind", (start, end)
            )
            usage = {row["kind"]: row["total"] for row in cur.fetchall()}
            cur.execute(
                "SELECT account_id::text AS account_id, kind, sum(amount)::bigint AS total FROM billing.ledger WHERE at >= %s AND at < %s "
                "GROUP BY 1, 2 ORDER BY total DESC LIMIT 20",
                (start, end),
            )
            top = cur.fetchall()
            # How close each workspace is to the minutes its plan includes, in the plan's current period: the nearest first. The
            # dashboard uses it to show who needs extra minutes bought for them, and what the minutes past the allowance cost.
            cur.execute(
                "SELECT org_id, plan_key, allowed, status, used FROM ("
                "SELECT s.org_id::text AS org_id, s.plan_key, p.monthly_minutes AS allowed, s.status, "
                "coalesce((SELECT sum(l.amount) FROM billing.ledger l WHERE l.account_id = s.org_id AND l.kind = 'minutes' "
                "AND l.at >= s.period_start AND l.at < s.period_end), 0)::bigint AS used "
                "FROM billing.subscriptions s JOIN billing.plans p ON p.key = s.plan_key "
                "WHERE s.status IN ('active', 'trialing', 'past_due') AND p.monthly_minutes > 0"
                ") nearest ORDER BY used::numeric / allowed DESC, org_id LIMIT 100"
            )
            allowances = cur.fetchall()
        return {
            "as_of": now.isoformat(), "subscriptions": subscriptions, "revenue_by_month": revenue, "usage_this_month": usage,
            "top_usage": top, "allowances": allowances,
        }

    def standing(self, org_id: UUID, now: datetime) -> dict:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT s.plan_key, s.status, s.period_start, s.period_end, p.seats, p.monthly_minutes FROM billing.subscriptions s "
                "JOIN billing.plans p ON p.key = s.plan_key WHERE s.org_id = %s",
                (org_id,),
            )
            sub = cur.fetchone()
            if sub is None:
                return {"org_id": str(org_id), "plan": None, "limited": False, "payment_required": False}
            cur.execute(
                "SELECT coalesce(sum(amount), 0)::bigint AS used FROM billing.ledger WHERE account_id = %s AND kind = 'minutes' AND at >= %s AND at < %s",
                (org_id, sub["period_start"], sub["period_end"]),
            )
            used = cur.fetchone()["used"]
        unpaid = sub["status"] not in GOOD_STANDING or sub["period_end"] <= now
        return {
            "org_id": str(org_id), "plan": sub["plan_key"], "status": sub["status"], "period_end": sub["period_end"].isoformat(),
            "seats": sub["seats"], "minutes_allowed": sub["monthly_minutes"], "minutes_used": used, "limited": True, "payment_required": unpaid,
        }

    def reserve(self, kind: str, account_id: UUID, amount: int, request_id: UUID, detail: str, now: datetime) -> Reservation:
        """Takes call minutes (account = workspace) or desktop credits (account = person) from this period's allowance, once
        per request id. The allowance row stays locked until the use is written, so two requests cannot both take the last unit."""
        if kind not in ("minutes", "credits"):
            raise Refused(400, "bad_request", "kind is minutes or credits")
        if not 1 <= amount <= 10_000_000:
            raise Refused(400, "bad_request", "Use 1 to 10,000,000 at a time.")
        detail = detail.strip()[:200]
        with self.pool.connection() as conn, conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            if kind == "minutes":
                cur.execute(
                    "SELECT s.status, s.period_start, s.period_end, p.monthly_minutes AS allowed FROM billing.subscriptions s "
                    "JOIN billing.plans p ON p.key = s.plan_key WHERE s.org_id = %s FOR UPDATE OF s",
                    (account_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return Reservation(limited=False)  # a workspace without a plan here has no minute limit (self-hosted)
                if row["status"] not in GOOD_STANDING or row["period_end"] <= now:
                    raise Refused(402, "payment_required", "This workspace's plan needs paying before calls can start.")
                start, end, allowed = row["period_start"], row["period_end"], row["allowed"]
            else:
                cur.execute("SELECT monthly_credits AS allowed FROM billing.credit_limits WHERE user_id = %s FOR UPDATE", (account_id,))
                row = cur.fetchone()
                if row is None:
                    return Reservation(limited=False)  # people not given a credit limit have none
                (start, end), allowed = month_of(now), row["allowed"]
            cur.execute("SELECT amount FROM billing.ledger WHERE account_id = %s AND kind = %s AND request_id = %s", (account_id, kind, request_id))
            earlier = cur.fetchone()
            cur.execute(
                "SELECT coalesce(sum(amount), 0)::bigint AS used FROM billing.ledger WHERE account_id = %s AND kind = %s AND at >= %s AND at < %s",
                (account_id, kind, start, end),
            )
            used = cur.fetchone()["used"]
            if earlier is not None:
                if earlier["amount"] != amount:
                    raise Refused(409, "conflict", "That request id was already used for a different amount.")
                return Reservation(limited=True, duplicate=True, used=used, allowed=allowed)
            if used + amount > allowed:
                left = max(0, allowed - used)
                raise Refused(402, "limit_reached", f"Not enough {kind} left this period: {left:,} left, and this needs {amount:,}.")
            cur.execute(
                "INSERT INTO billing.ledger (account_id, kind, amount, request_id, detail, at) VALUES (%s, %s, %s, %s, %s, %s)",
                (account_id, kind, amount, request_id, detail, now),
            )
            return Reservation(limited=True, used=used + amount, allowed=allowed)

    def set_credit_limit(self, user_id: UUID, monthly_credits: int | None) -> None:
        with self.pool.connection() as conn, conn.transaction():
            if monthly_credits is None:
                conn.execute("DELETE FROM billing.credit_limits WHERE user_id = %s", (user_id,))
            else:
                conn.execute(
                    "INSERT INTO billing.credit_limits (user_id, monthly_credits) VALUES (%s, %s) "
                    "ON CONFLICT (user_id) DO UPDATE SET monthly_credits = excluded.monthly_credits, updated_at = now()",
                    (user_id, monthly_credits),
                )

    def start_trial(self, org_id: UUID, plan_key: str, days: int, now: datetime) -> bool:
        """Opens a trial for a new workspace. A workspace that already has a subscription keeps it."""
        with self.pool.connection() as conn, conn.transaction():
            cur = conn.execute(
                "INSERT INTO billing.subscriptions (org_id, plan_key, status, period_start, period_end) "
                "SELECT %s, key, 'trialing', %s, %s FROM billing.plans WHERE key = %s AND active ON CONFLICT (org_id) DO NOTHING",
                (org_id, now, now + timedelta(days=days), plan_key),
            )
            if cur.rowcount == 0:
                exists = conn.execute("SELECT 1 FROM billing.plans WHERE key = %s AND active", (plan_key,)).fetchone()
                if exists is None:
                    raise Refused(400, "bad_request", f"{plan_key} is not a plan.")
                return False
            return True

    def record_webhook(self, provider: str, event: dict) -> tuple[bool, str | None]:
        """Stores a provider event once and applies it. Returns (new, org whose standing changed)."""
        event_id, event_type = str(event.get("event_id") or ""), str(event.get("event_type") or "")
        if not event_id or not event_type:
            raise Refused(400, "bad_request", "The event has no id or type.")
        with self.pool.connection() as conn, conn.transaction():
            cur = conn.execute(
                "INSERT INTO billing.webhook_events (provider, event_id, event_type, payload) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                (provider, event_id, event_type, json.dumps(event)),
            )
            if cur.rowcount == 0:
                return False, None
            org = self._apply(conn, provider, event_type, event.get("data") or {})
            conn.execute("UPDATE billing.webhook_events SET processed_at = now() WHERE provider = %s AND event_id = %s", (provider, event_id))
            return True, org

    def _apply(self, conn, provider: str, event_type: str, data: dict) -> str | None:
        org = (data.get("custom_data") or {}).get("org_id")
        if event_type.startswith("subscription."):
            status = STATUSES.get(str(data.get("status")))
            period = data.get("current_billing_period") or {}
            items = data.get("items") or []
            price = ((items[0] if items else {}).get("price") or {}).get("id")
            if not org or status is None:
                log.warning("subscription event %s without a workspace or a known status: kept, not applied", event_type)
                return None
            plan = conn.execute("SELECT key FROM billing.plans WHERE provider_price_id = %s", (price,)).fetchone()
            if plan is None:
                log.warning("subscription event %s names a price that is no plan here: kept, not applied", event_type)
                return None
            starts, ends = period.get("starts_at"), period.get("ends_at")
            if not starts or not ends:
                # A canceled or paused subscription can have no current period: keep the old one and change the status only.
                conn.execute(
                    "UPDATE billing.subscriptions SET status = %s, provider = %s, provider_subscription_id = %s, updated_at = now() WHERE org_id = %s",
                    (status, provider, data.get("id"), org),
                )
                return org
            conn.execute(
                "INSERT INTO billing.subscriptions (org_id, plan_key, status, period_start, period_end, provider, provider_subscription_id) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (org_id) DO UPDATE SET plan_key = excluded.plan_key, status = excluded.status, "
                "period_start = excluded.period_start, period_end = excluded.period_end, provider = excluded.provider, "
                "provider_subscription_id = excluded.provider_subscription_id, updated_at = now()",
                (org, plan[0], status, starts, ends, provider, data.get("id")),
            )
            return org
        if event_type == "transaction.completed":
            totals = (data.get("details") or {}).get("totals") or {}
            currency = str(data.get("currency_code") or "").upper()
            amount = totals.get("grand_total")
            if not data.get("id") or amount is None or len(currency) != 3:
                log.warning("transaction event without an id, amount or currency: kept, not applied")
                return None
            conn.execute(
                "INSERT INTO billing.payments (org_id, provider, provider_payment_id, amount_minor, currency, status, at) "
                "VALUES (%s, %s, %s, %s, %s, 'completed', coalesce(%s::timestamptz, now())) ON CONFLICT DO NOTHING",
                (org, provider, data["id"], money.parse_provider_minor(amount), currency, data.get("billed_at")),
            )
            return None
        return None
