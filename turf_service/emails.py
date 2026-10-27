"""Email addresses, checked the way phones are: what can be told without sending anyone a message.

Each address gets one verdict:

- ``invalid``     not an email address
- ``typo``        the domain is one letter away from a common provider ("gmial.com"); the fix is suggested
- ``disposable``  a throwaway domain (a public-domain list kept in data/disposable_domains.txt)
- ``no_mail``     the domain cannot receive mail: it has no mail server (MX) and no address at all
- ``role``        a shared box such as info@ or sales@; it can work, but it rarely reaches the owner
- ``ok``          nothing above, and the domain takes mail
- ``pending``     the domain is being looked up; ask again in a moment
- ``unknown``     the lookup failed (no internet); everything else was still checked

Only the domain leaves the computer, in an ordinary DNS lookup, and each domain's answer is kept in app data for a
month. Mailboxes are never probed by talking to mail servers: the answers are unreliable and can get a computer's
address blocked.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from functools import lru_cache
from pathlib import Path

from .projects import app_data_dir

log = logging.getLogger(__name__)

ADDRESS = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
ROLES = frozenset("""admin administrator billing contact customerservice enquiries hello help helpdesk hr info inquiries jobs mail
marketing media no-reply noreply office orders postmaster press reception sales service support team webmaster""".split())
COMMON = ("gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "live.com", "msn.com", "comcast.net",
          "att.net", "sbcglobal.net", "verizon.net", "me.com", "ymail.com", "bellsouth.net", "charter.net", "cox.net", "protonmail.com")
CACHE_DAYS = 30
_lock = threading.Lock()
_pending: set[str] = set()


@lru_cache(maxsize=1)
def disposable_domains() -> frozenset[str]:
    path = Path(__file__).parent / "data" / "disposable_domains.txt"
    return frozenset(line.strip().lower() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#"))


def _one_edit_apart(a: str, b: str) -> bool:
    """One letter added, dropped, changed, or two neighbours swapped."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [index for index in range(len(a)) if a[index] != b[index]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    short, long = sorted((a, b), key=len)
    return any(long[:index] + long[index + 1:] == short for index in range(len(long)))


def typo_of(domain: str) -> str | None:
    if domain in COMMON:
        return None
    for common in COMMON:
        if _one_edit_apart(domain, common):
            return common
    name, _, ending = domain.rpartition(".")
    for common in COMMON:  # "gmail.co", "yahoo.con"
        common_name, _, common_ending = common.rpartition(".")
        if name == common_name and ending != common_ending:
            return common
    return None


# ------------------------------------------------------------------------------------------------- the domain

def _cache_path() -> Path:
    return app_data_dir() / "email-domains.json"


def _cache() -> dict:
    try:
        return json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(domain: str, takes_mail: bool | None) -> None:
    with _lock:
        cache = _cache()
        cache[domain] = {"mail": takes_mail, "at": time.time()}
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(cache), encoding="utf-8")
        partial.replace(path)


def takes_mail(domain: str) -> bool | None:
    """Whether a domain can receive mail: an MX record, or failing that an address (RFC 5321). None if unknown."""
    import dns.exception
    import dns.resolver

    resolver = dns.resolver.Resolver()
    resolver.lifetime = 4.0
    try:
        answers = resolver.resolve(domain, "MX")
        return any(str(answer.exchange).strip(".") for answer in answers)  # a "null MX" (".") says no mail
    except (dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
        return False
    except dns.resolver.NoAnswer:
        pass
    except dns.exception.DNSException:
        return None
    try:
        resolver.resolve(domain, "A")
        return True
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        return False
    except dns.exception.DNSException:
        return None


def _look_up(domains: list[str], resolve=None) -> dict[str, bool | None]:
    resolve = resolve or takes_mail
    answers: dict[str, bool | None] = {}
    for domain in domains:
        try:
            answer = resolve(domain)
        except Exception:  # a broken resolver must not stop the others
            log.exception("Mail lookup failed for %s", domain)
            answer = None
        _save(domain, answer)
        answers[domain] = answer
        with _lock:
            _pending.discard(domain)
    return answers


def domain_states(domains: set[str], resolve=None, background: bool = True) -> dict[str, bool | None | str]:
    """True or False for domains known (from the last month), "pending" for the ones being looked up now."""
    cache, now = _cache(), time.time()
    states: dict[str, bool | None | str] = {}
    todo = []
    for domain in domains:
        entry = cache.get(domain)
        if entry and now - entry["at"] < CACHE_DAYS * 86_400 and entry["mail"] is not None:
            states[domain] = entry["mail"]
            continue
        with _lock:
            if domain in _pending:
                states[domain] = "pending"
                continue
            _pending.add(domain)
        todo.append(domain)
        states[domain] = "pending"
    if todo:
        if background:
            threading.Thread(target=_look_up, args=(todo, resolve), name="email-domains", daemon=True).start()
        else:
            states.update(_look_up(todo, resolve))
    return states


# ------------------------------------------------------------------------------------------------ an address

def check(addresses: object, resolve=None, background: bool = True) -> dict[str, dict]:
    """A verdict for each address given (at most 20,000 at a time)."""
    if not isinstance(addresses, list):
        raise ValueError("Give a list of email addresses")
    cleaned = {str(address): str(address).strip().lower() for address in addresses[:20_000]}
    results: dict[str, dict] = {}
    to_resolve: dict[str, str] = {}
    for original, address in cleaned.items():
        if not ADDRESS.match(address):
            results[original] = {"verdict": "invalid", "why": "Not an email address"}
            continue
        local, domain = address.rsplit("@", 1)
        suggestion = typo_of(domain)
        if suggestion:
            results[original] = {"verdict": "typo", "why": f"Probably {local}@{suggestion}", "suggestion": f"{local}@{suggestion}"}
        elif domain in disposable_domains() or any(domain.endswith("." + item) for item in ("mailinator.com", "guerrillamail.com")):
            results[original] = {"verdict": "disposable", "why": "A throwaway address"}
        else:
            to_resolve[original] = domain
    states = domain_states(set(to_resolve.values()), resolve, background) if to_resolve else {}
    for original, domain in to_resolve.items():
        state = states.get(domain)
        local = cleaned[original].rsplit("@", 1)[0]
        if state == "pending":
            results[original] = {"verdict": "pending", "why": "Checking that the domain takes mail"}
        elif state is False:
            results[original] = {"verdict": "no_mail", "why": f"{domain} cannot receive email"}
        elif state is None:
            results[original] = {"verdict": "unknown", "why": "Could not check the domain (no internet?)"}
        elif local.split("+")[0] in ROLES:
            results[original] = {"verdict": "role", "why": "A shared box; it rarely reaches the owner"}
        else:
            results[original] = {"verdict": "ok", "why": "The domain takes mail"}
    return results
