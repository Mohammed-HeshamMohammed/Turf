"""The real SQL against a real PostgreSQL. Set TEST_DATABASE_URL to an empty database billing may set up; without it these
tests are skipped."""

import os
import threading
import unittest
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from callerwhale_billing import db
from callerwhale_billing.store import Refused, Store

URL = os.environ.get("TEST_DATABASE_URL", "")
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


@unittest.skipUnless(URL, "TEST_DATABASE_URL is not set")
class StoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pool = db.open_pool(URL)
        db.apply_setup(cls.pool)
        db.apply_setup(cls.pool)  # a second start changes nothing
        with cls.pool.connection() as conn:
            conn.execute(
                "INSERT INTO billing.plans (key, name, seats, monthly_minutes, price_minor, currency, provider_price_id) "
                "VALUES ('trial', 'Trial', 2, 100, 0, 'USD', NULL), ('starter', 'Starter', 3, 1000, 4900, 'USD', 'pri_starter') "
                "ON CONFLICT (key) DO UPDATE SET seats = excluded.seats, monthly_minutes = excluded.monthly_minutes"
            )
            conn.commit()
        cls.store = Store(cls.pool)

    @classmethod
    def tearDownClass(cls):
        cls.pool.close()

    def test_minutes_stop_at_the_plan_and_retries_count_once(self):
        org = uuid4()
        self.assertTrue(self.store.start_trial(org, "trial", 14, NOW))
        self.assertFalse(self.store.start_trial(org, "trial", 14, NOW), "a workspace keeps its subscription")
        request = uuid4()
        first = self.store.reserve("minutes", org, 60, request, "call", NOW)
        again = self.store.reserve("minutes", org, 60, request, "call", NOW)
        self.assertEqual((first.used, again.duplicate, again.used), (60, True, 60))
        with self.assertRaises(Refused) as refused:
            self.store.reserve("minutes", org, 60, uuid4(), "call", NOW)
        self.assertEqual(refused.exception.code, "limit_reached")
        with self.assertRaises(Refused) as conflict:
            self.store.reserve("minutes", org, 10, request, "call", NOW)
        self.assertEqual(conflict.exception.code, "conflict")
        self.assertEqual(self.store.standing(org, NOW)["minutes_used"], 60)

    def test_the_ready_made_plans_are_there_and_a_membership_keeps_only_the_limits_that_differ(self):
        keys = {p["key"]: p for p in self.store.plans()}
        self.assertTrue({"solo", "duo", "team", "pro", "custom"} <= set(keys))
        self.assertEqual(keys["solo"]["limits"]["active_leads"], 1_000_000)
        self.assertIsNone(keys["solo"]["limits"]["clients"], "clients are unlimited")
        org = uuid4()
        given = self.store.assign_membership(org, "solo", "free", 14, 12, None, NOW, {"seats": 4, "active_leads": 1_000_000, "monthly_minutes": None}, "staff")
        self.assertEqual(given["overrides"], {"seats": 4, "monthly_minutes": None}, "a value equal to the plan's is not stored")
        self.assertEqual(self.store.standing(org, NOW)["seats"], 4)
        self.assertFalse(self.store.reserve("minutes", org, 50_000, uuid4(), "", NOW).limited, "unlimited minutes are not counted against")
        again = self.store.assign_membership(org, "duo", "free", 14, 12, None, NOW, {}, "staff")
        self.assertEqual((again["overrides"], again["limits"]["seats"]), ({}, 2), "giving a membership again replaces the overrides")
        self.assertEqual(self.store.entitlements(uuid4())["plan"], None)
        with self.assertRaises(Refused):
            self.store.assign_membership(org, "solo", "free", 14, 12, None, NOW, {"seats": 0})
        with self.assertRaises(Refused):
            self.store.assign_membership(org, "solo", "free", 14, 12, None, NOW, {"nonsense": 1})

    def test_two_requests_cannot_both_take_the_last_minutes(self):
        org = uuid4()
        self.store.start_trial(org, "trial", 14, NOW)
        results = []

        def take():
            try:
                results.append(self.store.reserve("minutes", org, 60, uuid4(), "", NOW).used)
            except Refused as r:
                results.append(r.code)

        threads = [threading.Thread(target=take) for _ in range(2)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(map(str, results)), ["60", "limit_reached"])

    def test_an_expired_trial_needs_paying(self):
        org = uuid4()
        self.store.start_trial(org, "trial", 14, NOW)
        later = NOW + timedelta(days=15)
        self.assertTrue(self.store.standing(org, later)["payment_required"])
        with self.assertRaises(Refused) as refused:
            self.store.reserve("minutes", org, 1, uuid4(), "", later)
        self.assertEqual(refused.exception.code, "payment_required")

    def test_credits_reset_each_month(self):
        person = uuid4()
        self.assertFalse(self.store.reserve("credits", person, 5, uuid4(), "", NOW).limited, "no limit, no counting")
        self.store.set_credit_limit(person, 10)
        self.store.reserve("credits", person, 10, uuid4(), "", NOW)
        with self.assertRaises(Refused):
            self.store.reserve("credits", person, 1, uuid4(), "", NOW)
        self.assertEqual(self.store.reserve("credits", person, 1, uuid4(), "", NOW + timedelta(days=30)).used, 1)

    def test_the_ledger_is_append_only(self):
        with self.pool.connection() as conn:
            with self.assertRaises(Exception):
                conn.execute("DELETE FROM billing.ledger")
            conn.rollback()

    def test_paddle_events_apply_once(self):
        org = str(uuid4())
        event = {
            "event_id": "evt_" + org, "event_type": "subscription.activated",
            "data": {"id": "sub_" + org, "status": "active", "custom_data": {"org_id": org}, "items": [{"price": {"id": "pri_starter"}}],
                     "current_billing_period": {"starts_at": "2026-11-01T00:00:00Z", "ends_at": "2026-12-01T00:00:00Z"}},
        }
        self.assertEqual(self.store.record_webhook("paddle", event), (True, org))
        self.assertEqual(self.store.record_webhook("paddle", event), (False, None))
        standing = self.store.standing(uuid4().__class__(org), NOW)
        self.assertEqual((standing["plan"], standing["status"], standing["payment_required"]), ("starter", "active", False))
        self.assertEqual((standing["provider_paid"], standing["payer_id"]), (True, None))

    def test_the_payer_comes_from_the_checkout_and_stays_until_another_pays(self):
        org, payer, new_owner = str(uuid4()), str(uuid4()), str(uuid4())
        period = {"starts_at": "2026-11-01T00:00:00Z", "ends_at": "2026-12-01T00:00:00Z"}
        def event(n, custom):
            return {"event_id": f"evt_{n}_{org}", "event_type": "subscription.updated",
                    "data": {"id": "sub_" + org, "status": "active", "custom_data": {"org_id": org, **custom}, "items": [{"price": {"id": "pri_starter"}}], "current_billing_period": period}}
        self.store.record_webhook("paddle", event(1, {"payer_id": payer}))
        self.store.record_webhook("paddle", event(2, {}))
        self.assertEqual(self.store.standing(UUID(org), NOW)["payer_id"], payer, "an event that names no payer keeps the one there")
        self.store.record_webhook("paddle", event(3, {"payer_id": new_owner}))
        self.assertEqual(self.store.standing(UUID(org), NOW)["payer_id"], new_owner)
        self.store.record_webhook("paddle", event(4, {"payer_id": "not-an-id"}))
        self.assertEqual(self.store.standing(UUID(org), NOW)["payer_id"], new_owner)


    def test_budgets_stop_a_team_and_a_person_and_raising_answers_the_request(self):
        from callerwhale_billing import budgets
        org, team, agent, other = uuid4(), uuid4(), uuid4(), uuid4()
        budgets.set_budget(self.store, org, "team", team, "texts", 3, None)
        budgets.set_budget(self.store, org, "person", agent, "texts", 2, None)
        use = lambda who, rid=None, check=False: budgets.use(self.store, org, "texts", 1, rid or uuid4(), team, who, None, NOW, check)
        rid = uuid4()
        use(agent, rid)
        self.assertTrue(use(agent, rid)["duplicate"], "the same text is charged once")
        use(agent)
        with self.assertRaises(Refused) as refused:
            use(agent, check=True)
        self.assertEqual((refused.exception.status, refused.exception.code), (402, "budget_reached"))
        use(other)  # the team still has one
        with self.assertRaises(Refused):
            use(other)
        listed = {(b["scope"], b["subject_id"]): b["used"] for b in budgets.budgets(self.store, org, NOW)}
        self.assertEqual(listed[("team", str(team))], 3)
        self.assertEqual(listed[("person", str(agent))], 2)
        budgets.ask_raise(self.store, org, "team", team, "texts", other, "Busy week", NOW)
        self.assertEqual(len(budgets.raise_requests(self.store, org)), 1)
        budgets.set_budget(self.store, org, "team", team, "texts", 10, None)
        self.assertEqual(budgets.raise_requests(self.store, org), [], "raising the budget answers the request")
        use(other)

if __name__ == "__main__":
    unittest.main()
