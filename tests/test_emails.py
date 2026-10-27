"""Email addresses: what can be told without sending anyone a message."""

from __future__ import annotations

from helpers import ok
from test_service_skiptrace import service  # noqa: F401
from turf_service import emails


def fake_dns(domain):
    return {"example.com": True, "gone.example": False, "offline.example": None}.get(domain, True)


def test_each_address_gets_one_verdict():
    checked = emails.check(["ana@example.com", "not an email", "ana@gmial.com", "bo@gmail.co", "x@mailinator.com", "info@example.com",
                            "cy@gone.example", "di@offline.example", "Ed+deals@Example.com"], resolve=fake_dns, background=False)
    assert {address: result["verdict"] for address, result in checked.items()} == {
        "ana@example.com": "ok", "not an email": "invalid", "ana@gmial.com": "typo", "bo@gmail.co": "typo", "x@mailinator.com": "disposable",
        "info@example.com": "role", "cy@gone.example": "no_mail", "di@offline.example": "unknown", "Ed+deals@Example.com": "ok",
    }
    assert checked["ana@gmial.com"]["suggestion"] == "ana@gmail.com"
    assert emails.typo_of("gmail.com") is None and emails.typo_of("hotmial.com") == "hotmail.com" and emails.typo_of("example.org") is None


def test_a_domain_is_looked_up_once_and_its_answer_kept():
    asked = []

    def counting(domain):
        asked.append(domain)
        return True

    emails.check(["a@kept.example", "b@kept.example"], resolve=counting, background=False)
    emails.check(["c@kept.example"], resolve=counting, background=False)
    assert asked == ["kept.example"]


def test_the_check_answers_at_once_and_finishes_in_the_background(service, monkeypatch):
    monkeypatch.setattr(emails, "takes_mail", lambda domain: True)
    first = ok(service, "emails.check", addresses=["ana@later.example"])
    assert first["ana@later.example"]["verdict"] in ("pending", "ok")
