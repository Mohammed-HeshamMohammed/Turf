"""The real SQL against a real PostgreSQL. Set TEST_DATABASE_URL to an empty database billing may set up; without it these
tests are skipped."""

import os
import threading
import unittest
from datetime import UTC, datetime, timedelta
from uuid import uuid4

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
                "VALUES ('trial', 'Trial', 2, 100, 0, 'USD', NULL), ('starter', 'Starter', 3, 1000, 4900, 'USD', 'pri_starter') ON CONFLICT DO NOTHING"
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


if __name__ == "__main__":
    unittest.main()
