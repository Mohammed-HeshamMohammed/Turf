import json
import unittest
from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from callerwhale_billing import config, paddle
from callerwhale_billing.app import create_app
from callerwhale_billing.store import Refused, Reservation

CORE = "core-api-token-0123456789abcdef0123456789"
WORKER = "worker-token-0123456789abcdef0123456789ab"
AUTH = "auth-token-0123456789abcdef0123456789abcd"
SECRET = "pdl_ntfset_test_secret"
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


class FakeStore:
    """The store's answers, without a database (tests/test_store_db.py runs the real SQL)."""

    def __init__(self):
        self.events = {}
        self.reserved = []
        self.limits = {}
        self.assigned = []

    def plans(self):
        return [{"key": "starter", "name": "Starter", "price": "49.00", "currency": "USD"}]

    def standing(self, org_id, now):
        return {"org_id": str(org_id), "payment_required": False}

    def reserve(self, kind, account_id, amount, request_id, detail, now):
        if amount > 100:
            raise Refused(402, "limit_reached", "Not enough minutes left this period.")
        self.reserved.append((kind, account_id, amount, request_id))
        return Reservation(limited=True, used=amount, allowed=100)

    def assign_membership(self, org_id, plan, payment, days, months, amount_minor, now):
        if plan != "starter":
            raise Refused(400, "bad_request", f"{plan} is not a plan.")
        self.assigned.append((org_id, plan, payment, days, months, amount_minor))
        return {"org_id": str(org_id), "plan": plan, "payment": payment, "status": "active"}

    def summary(self, now):
        return {"subscriptions": [], "revenue_by_month": [], "usage_this_month": {}, "top_usage": [], "allowances": []}

    def set_credit_limit(self, user_id, monthly):
        self.limits[user_id] = monthly

    def start_trial(self, org_id, plan, days, now):
        return True

    def record_webhook(self, provider, event):
        new = event["event_id"] not in self.events
        self.events[event["event_id"]] = event
        org = (event.get("data") or {}).get("custom_data", {}).get("org_id")
        return new, org if new else None


class AppTest(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.told = []
        settings = config.Settings(database_url="postgres://x", tokens={CORE: "core-api", WORKER: "worker", AUTH: "auth"}, paddle_webhook_secret=SECRET)
        app = create_app(settings, self.store, now=lambda: NOW, notify=lambda s, org, standing: self.told.append(org))
        self.client = TestClient(app)

    def test_health_and_plans_are_public(self):
        self.assertEqual(self.client.get("/healthz").json(), {"ok": True, "service": "billing"})
        self.assertEqual(self.client.get("/api/v1/plans").json()["plans"][0]["key"], "starter")

    def test_private_requests_need_a_caller_token_with_the_right(self):
        body = {"kind": "minutes", "account_id": str(uuid4()), "amount": 5, "request_id": str(uuid4())}
        self.assertEqual(self.client.post("/v1/reservations", json=body).status_code, 401)
        self.assertEqual(self.client.post("/v1/reservations", json=body, headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertEqual(self.client.post("/v1/reservations", json=body, headers={"Authorization": f"Bearer {WORKER}"}).status_code, 403)
        res = self.client.post("/v1/reservations", json=body, headers={"Authorization": f"Bearer {CORE}"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["remaining"], 95)

    def test_the_auth_service_may_read_a_workspaces_standing_for_its_members(self):
        url = f"/v1/orgs/{uuid4()}/standing"
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, headers={"Authorization": f"Bearer {AUTH}"}).status_code, 200)

    def test_the_summary_is_for_the_auth_service_only(self):
        url = "/v1/admin/summary"
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, headers={"Authorization": f"Bearer {CORE}"}).status_code, 403)
        res = self.client.get(url, headers={"Authorization": f"Bearer {AUTH}"})
        self.assertEqual((res.status_code, res.json()["subscriptions"]), (200, []))

    def test_a_membership_is_given_by_the_auth_service_only(self):
        org = uuid4()
        url, body = f"/v1/admin/orgs/{org}/membership", {"plan": "starter", "payment": "manual", "months": 3, "amount_minor": 14700}
        self.assertEqual(self.client.put(url, json=body).status_code, 401)
        self.assertEqual(self.client.put(url, json=body, headers={"Authorization": f"Bearer {CORE}"}).status_code, 403)
        res = self.client.put(url, json=body, headers={"Authorization": f"Bearer {AUTH}"})
        self.assertEqual((res.status_code, res.json()["payment"]), (200, "manual"))
        self.assertEqual(self.store.assigned, [(org, "starter", "manual", 14, 3, 14700)])
        self.assertEqual(self.told, [str(org)], "authorization hears about the new standing")
        for bad in ({"plan": "starter", "payment": "gift"}, {"plan": "starter", "payment": "trial", "days": 0}, {"plan": "starter", "payment": "free", "months": 99}):
            self.assertEqual(self.client.put(url, json=bad, headers={"Authorization": f"Bearer {AUTH}"}).status_code, 400)
        self.assertEqual(self.client.put(url, json={"plan": "nope", "payment": "trial"}, headers={"Authorization": f"Bearer {AUTH}"}).status_code, 400)

    def test_refusals_keep_their_code(self):
        body = {"kind": "minutes", "account_id": str(uuid4()), "amount": 500, "request_id": str(uuid4())}
        res = self.client.post("/v1/reservations", json=body, headers={"Authorization": f"Bearer {CORE}"})
        self.assertEqual((res.status_code, res.json()["code"]), (402, "limit_reached"))
        res = self.client.post("/v1/reservations", json={"kind": "minutes"}, headers={"Authorization": f"Bearer {CORE}"})
        self.assertEqual((res.status_code, res.json()["code"]), (400, "bad_request"))

    def webhook(self, event, secret=SECRET):
        body = json.dumps(event).encode()
        header = paddle.sign(body, secret, int(datetime.now(UTC).timestamp()))
        return self.client.post("/api/v1/billing/webhook", content=body, headers={"Paddle-Signature": header, "Content-Type": "application/json"})

    def test_webhooks_must_be_signed_and_apply_once(self):
        org = str(uuid4())
        event = {"event_id": "evt_1", "event_type": "subscription.updated", "data": {"custom_data": {"org_id": org}}}
        self.assertEqual(self.webhook(event, secret="wrong").status_code, 401)
        self.assertEqual(self.store.events, {})
        first = self.webhook(event)
        self.assertEqual((first.status_code, first.json()["duplicate"]), (200, False))
        self.assertEqual(self.told, [org], "authorization hears about the new standing")
        again = self.webhook(event)
        self.assertEqual(again.json()["duplicate"], True)
        self.assertEqual(self.told, [org], "a redelivery changes nothing")

    def test_credit_limits_and_trials(self):
        user = uuid4()
        res = self.client.put(f"/v1/people/{user}/credit-limit", json={"monthly_credits": 500}, headers={"Authorization": f"Bearer {CORE}"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.store.limits[UUID(str(user))], 500)
        res = self.client.put(f"/v1/orgs/{uuid4()}/trial", json={}, headers={"Authorization": f"Bearer {CORE}"})
        self.assertEqual(res.json()["opened"], True)
        self.assertEqual(len(self.told), 1)


class OpenApiTest(unittest.TestCase):
    def test_the_file_matches_the_code(self):
        from pathlib import Path

        text = (Path(__file__).resolve().parent.parent / "openapi.yaml").read_text(encoding="utf-8")
        written = json.loads(text.split("\n", 1)[1])
        current = create_app(config.Settings(database_url="x"), store=None).openapi()
        self.assertEqual(written, current, "regenerate openapi.yaml (see README)")


class SettingsTest(unittest.TestCase):
    def test_settings(self):
        s = config.load({"DATABASE_URL": "postgres://x", "BILLING_TOKENS": f"core-api={CORE}"})
        self.assertEqual((s.port, s.tokens[CORE], s.paddle_tolerance_seconds), (8103, "core-api", 300))
        for bad in (
            {},
            {"DATABASE_URL": "x", "BILLING_TOKENS": "stranger=" + CORE},
            {"DATABASE_URL": "x", "BILLING_TOKENS": "core-api=short"},
            {"DATABASE_URL": "x", "BILLING_TOKENS": f"core-api={CORE},worker={CORE}"},
            {"DATABASE_URL": "x", "BILLING_TOKENS": f"auth={AUTH},auth={AUTH[::-1]},auth={CORE}"},
            {"DATABASE_URL": "x", "AUTHZ_URL": "http://authz:8104"},
            {"DATABASE_URL": "x", "PADDLE_WEBHOOK_TOLERANCE_SECONDS": "1"},
        ):
            with self.assertRaises(config.SettingsError):
                config.load(bad)


class AddMonthsTest(unittest.TestCase):
    def test_a_month_later_is_the_same_day_or_the_last_day_of_that_month(self):
        from callerwhale_billing.store import add_months

        self.assertEqual(add_months(datetime(2026, 11, 5, 9, tzinfo=UTC), 3), datetime(2027, 2, 5, 9, tzinfo=UTC))
        self.assertEqual(add_months(datetime(2026, 1, 31, tzinfo=UTC), 1), datetime(2026, 2, 28, tzinfo=UTC))
        self.assertEqual(add_months(datetime(2026, 12, 15, tzinfo=UTC), 1), datetime(2027, 1, 15, tzinfo=UTC))
        self.assertEqual(add_months(datetime(2026, 11, 5, tzinfo=UTC), 12), datetime(2027, 11, 5, tzinfo=UTC))


class TokenRotationTest(unittest.TestCase):
    def test_a_caller_may_hold_two_tokens_while_one_is_replaced(self):
        old, new = AUTH, AUTH[::-1]
        tokens = config.parse_tokens(f"auth={old}, auth={new}")
        self.assertEqual(tokens, {old: "auth", new: "auth"})


if __name__ == "__main__":
    unittest.main()
