"""Whether a phone number is a mobile or a landline. This is a place for a lookup service, not a service: with none set up
(LINE_TYPE_PROVIDER empty, the default) nothing is looked up and the import goes on as it always did.

To add a provider, write a function that takes a list of phone numbers (digits, as the cleaning makes them) and returns
{number: kind} for the numbers it knows, where kind is one of KINDS, and register it here under a name:

    PROVIDERS["name"] = function

then set LINE_TYPE_PROVIDER=name on the worker. A number the provider does not answer for simply has no line type."""
import os
from typing import Callable

KINDS = {"mobile", "landline", "voip", "other"}
BATCH = 500  # numbers handed to the provider at a time

PROVIDERS: dict[str, Callable[[list[str]], dict[str, str]]] = {}


def provider() -> Callable[[list[str]], dict[str, str]] | None:
    """The configured lookup, or None when there is none (or the name is not registered)."""
    return PROVIDERS.get(os.environ.get("LINE_TYPE_PROVIDER", "").strip())
