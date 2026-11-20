import unittest
from decimal import Decimal

from callerwhale_billing import money, paddle


class MoneyTest(unittest.TestCase):
    def test_minor_units(self):
        self.assertEqual(money.to_minor("19.99", "USD"), 1999)
        self.assertEqual(money.to_minor(Decimal("0.1") + Decimal("0.2"), "usd"), 30)
        self.assertEqual(money.to_minor("1000", "JPY"), 1000)
        self.assertEqual(money.to_minor("1.2345", "KWD"), 1234)
        self.assertEqual(money.from_minor(1999, "USD"), Decimal("19.99"))
        self.assertEqual(str(money.from_minor(5, "USD")), "0.05")

    def test_half_even_rounding(self):
        self.assertEqual(money.to_minor("0.125", "USD"), 12)
        self.assertEqual(money.to_minor("0.135", "USD"), 14)

    def test_refusals(self):
        with self.assertRaises(TypeError):
            money.to_minor(19.99, "USD")
        for bad in ("abc", "NaN", "Infinity"):
            with self.assertRaises(ValueError):
                money.to_minor(bad, "USD")
        with self.assertRaises(ValueError):
            money.exponent("US")
        self.assertEqual(money.parse_provider_minor("1999"), 1999)
        with self.assertRaises(ValueError):
            money.parse_provider_minor("19.99")


class PaddleSignatureTest(unittest.TestCase):
    secret = "pdl_ntfset_test_secret"
    body = b'{"event_id":"evt_1","event_type":"subscription.created"}'

    def test_a_signed_body_verifies(self):
        header = paddle.sign(self.body, self.secret, 1_800_000_000)
        self.assertTrue(paddle.verify(header, self.body, self.secret, 300, now=1_800_000_010))

    def test_anything_changed_fails(self):
        header = paddle.sign(self.body, self.secret, 1_800_000_000)
        self.assertFalse(paddle.verify(header, self.body + b" ", self.secret, 300, now=1_800_000_000))
        self.assertFalse(paddle.verify(header, self.body, "another secret", 300, now=1_800_000_000))
        self.assertFalse(paddle.verify(header, self.body, self.secret, 300, now=1_800_001_000), "too old")
        self.assertFalse(paddle.verify(None, self.body, self.secret, 300))
        self.assertFalse(paddle.verify("ts=abc;h1=00", self.body, self.secret, 300))
        self.assertFalse(paddle.verify(header, self.body, "", 300, now=1_800_000_000), "no secret set: refuse everything")

    def test_secret_rotation_sends_two_signatures(self):
        old = paddle.sign(self.body, "old secret", 1_800_000_000).split("h1=")[1]
        header = paddle.sign(self.body, self.secret, 1_800_000_000) + ";h1=" + old
        self.assertTrue(paddle.verify(header, self.body, "old secret", 300, now=1_800_000_000))
        self.assertTrue(paddle.verify(header, self.body, self.secret, 300, now=1_800_000_000))


if __name__ == "__main__":
    unittest.main()
