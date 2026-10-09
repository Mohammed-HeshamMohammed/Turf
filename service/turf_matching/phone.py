"""One way to read a phone number, used by cleanup, matching and the Skip Tracing tab.

All country rules come from Google's libphonenumber (the `phonenumbers` package): calling codes, prefixes, lengths and
number types. Nothing about a country's numbering plan is written here. What is written here is the part libphonenumber
does not do for spreadsheet data: undoing what Excel did to a number, splitting a cell that holds several numbers,
reading the `00` / `011` dialling prefix, and turning the library's checks into reasons a person can read.

A valid number is a number that follows its country's numbering plan. It is not proof that the number is connected or
that it belongs to a given person.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

import phonenumbers
from phonenumbers import PhoneNumberFormat, PhoneNumberType, ValidationResult, shortnumberinfo

PHONE_VERSION = 1
METADATA_VERSION = phonenumbers.__version__

TYPE_NAMES = {
    PhoneNumberType.FIXED_LINE: "landline", PhoneNumberType.MOBILE: "mobile", PhoneNumberType.FIXED_LINE_OR_MOBILE: "landline or mobile",
    PhoneNumberType.TOLL_FREE: "toll-free", PhoneNumberType.PREMIUM_RATE: "premium rate", PhoneNumberType.SHARED_COST: "shared cost",
    PhoneNumberType.VOIP: "VoIP", PhoneNumberType.PERSONAL_NUMBER: "personal number", PhoneNumberType.PAGER: "pager",
    PhoneNumberType.UAN: "company number", PhoneNumberType.VOICEMAIL: "voicemail", PhoneNumberType.UNKNOWN: "unknown",
}
# Types that are not a person's own line. A person's phone column rarely means to hold one of these.
BUSINESS_TYPES = frozenset({"toll-free", "premium rate", "shared cost", "personal number", "pager", "company number", "voicemail"})

# Why a number is not valid, in plain words. `{region}` is the country's name where one is known.
REASONS = {
    "empty": "No number",
    "no_digits": "Contains no digits",
    "unreadable": "Could not be read as a phone number",
    "too_short": "Too short for {place}",
    "too_long": "Too long for {place}",
    "bad_length": "Wrong number of digits for {place}",
    "bad_country_code": "The country code is not one that exists",
    "not_in_plan": "Not a number {place} uses: the prefix or area code is not assigned",
    "short_code": "A short service number (such as 911), not a person's phone",
    "placeholder": "A placeholder or made-up number",
    "damaged": "Damaged by a spreadsheet: digits were lost and cannot be recovered",
}

_PLAIN = re.compile(r"[\d\s().+\-]+")
_EXTENSION = re.compile(r"(?:\s*(?:ext\.?|extension|x|#)\s*(\d{1,6}))\s*$", re.IGNORECASE)
_SEPARATORS = re.compile(r"\s*(?:/|;|\||\n|\r|&|\bor\b|\band\b)\s*", re.IGNORECASE)
_FLOAT = re.compile(r"^\+?\d+\.0+$")
_SCIENTIFIC = re.compile(r"^\+?\d(?:\.\d+)?[eE]\+?\d+$")
_ONLY_REPEAT = re.compile(r"^(\d)\1+$")
# The prefixes people dial before a country code when calling abroad. A number written with one of them is tried as
# "+" followed by the rest, but only after it has failed as a home number: 011 is also an ordinary area code in India
# and Brazil, so it must never be rewritten when the number is valid as written.
_DIAL_PREFIX = re.compile(r"^(00|011)(?=[1-9])")
# 555-0100 to 555-0199 are reserved for fiction in the North American plan.
_FICTIONAL_NANP = re.compile(r"^\d{3}55501\d{2}$")


@dataclass(frozen=True)
class PhoneInfo:
    raw: str
    e164: str | None = None
    region: str | None = None
    country_code: int | None = None
    national: str | None = None
    international: str | None = None
    extension: str | None = None
    valid: bool = False
    type: str | None = None
    reason: str | None = None
    detail: str = ""
    # What had to be assumed or repaired to read the number, for example "country taken from the Country column".
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def business_line(self) -> bool:
        return self.type in BUSINESS_TYPES


def region_name(region: str | None) -> str:
    """A country's name, from libphonenumber's own geocoding data when it is installed; otherwise its code."""
    if not region:
        return "this country"
    try:
        from phonenumbers import geocoder

        example = phonenumbers.example_number(region)
        name = geocoder.country_name_for_number(example, "en") if example else ""
        return name or region
    except Exception:  # noqa: BLE001 - names are a convenience; the code is always available
        return region


def _place(region: str | None, country_code: int | None = None) -> str:
    if region:
        return region_name(region)
    return f"+{country_code}" if country_code else "this country"


def undo_spreadsheet_damage(text: str) -> tuple[str, tuple[str, ...], str | None]:
    """Excel turns phone numbers into floats ("7135550142.0") and scientific notation ("7.135550142E9"), and drops
    digits past the 15th. The first two are repaired exactly; a number that has lost digits is reported, not guessed."""
    notes: list[str] = []
    if _FLOAT.match(text):
        notes.append("removed a trailing .0 left by a spreadsheet")
        return text.split(".")[0].lstrip("+"), tuple(notes), None
    if _SCIENTIFIC.match(text):
        try:
            whole = format(Decimal(text.lstrip("+")), "f")
        except InvalidOperation:
            return text, (), "damaged"
        if "." in whole:
            return text, (), "damaged"
        notes.append("rebuilt the digits from scientific notation")
        # A mantissa with few digits and a big exponent (1.23E+11) has lost digits: Excel rounded them away.
        mantissa = re.split(r"[eE]", text.lstrip("+"))[0].replace(".", "")
        if len(mantissa) < 10 and len(whole.rstrip("0")) < len(whole) - 3:
            return text, (), "damaged"
        return whole, tuple(notes), None
    return text, (), None


def _strip_extension(text: str) -> tuple[str, str | None]:
    match = _EXTENSION.search(text)
    return (text[: match.start()].strip(), match.group(1)) if match else (text, None)


def split_cell(value: object) -> list[str]:
    """One cell can hold several numbers ("713-555-0142 / 713-555-0199"). Returns each piece, trimmed."""
    text = re.sub(r"\s+", " ", str(value if value is not None else "")).strip()
    if not text:
        return []
    pieces = [piece.strip(" ,.") for piece in _SEPARATORS.split(text) if piece.strip(" ,.")]
    if len(pieces) == 1 and "," in text and all(_PLAIN.fullmatch(part.strip()) for part in text.split(",")) and len(text.split(",")) > 1:
        # "7135550142, 7135550199": a comma between two whole numbers
        parts = [part.strip() for part in text.split(",")]
        if all(len(re.sub(r"\D", "", part)) >= 7 for part in parts):
            return parts
    return pieces


def _placeholder(national: str, country_code: int | None) -> bool:
    """Made-up numbers: the last seven digits all the same, whole-number runs such as 1234567890, and the fictional
    555-0100 to 555-0199 range of the North American plan."""
    if len(national) >= 7 and _ONLY_REPEAT.match(national[-7:]):
        return True
    if national in ("1234567890", "0123456789", "0987654321", "9876543210"):
        return True
    return country_code == 1 and bool(_FICTIONAL_NANP.match(national))


def region_from_country(value: object) -> str | None:
    """A region code from a Country column: an ISO code ("EG", "gb") or a country's name in English."""
    text = str(value or "").strip()
    if not text:
        return None
    upper = text.upper()
    if len(upper) == 2 and upper in phonenumbers.SUPPORTED_REGIONS:
        return upper
    if upper in ("UK", "GREAT BRITAIN", "ENGLAND", "SCOTLAND", "WALES", "NORTHERN IRELAND"):
        return "GB"
    if upper in ("USA", "U.S.", "U.S.A.", "UNITED STATES", "UNITED STATES OF AMERICA", "AMERICA"):
        return "US"
    try:
        from phonenumbers import geocoder

        key = text.casefold()
        if key not in _COUNTRY_NAMES:
            for code in phonenumbers.SUPPORTED_REGIONS:
                example = phonenumbers.example_number(code)
                if example:
                    _COUNTRY_NAMES.setdefault(geocoder.country_name_for_number(example, "en").casefold(), code)
        return _COUNTRY_NAMES.get(key)
    except Exception:  # noqa: BLE001
        return None


_COUNTRY_NAMES: dict[str, str] = {}


def analyze(value: object, region: str | None = "US", country: object = None, country_source: str = "the Country column") -> PhoneInfo:
    """Reads ONE number. Use `analyze_cell` for a cell that may hold several.

    `region` is the country to assume when the number does not say; `country` is the row's own Country value, which
    wins over `region` when it names a country libphonenumber knows. A number that starts with + or 00/011 states its
    own country and ignores both.
    """
    raw = "" if value is None else str(value)
    text = re.sub(r"\s+", " ", raw).strip()
    if not text:
        return PhoneInfo(raw, reason="empty", detail=REASONS["empty"])
    notes: list[str] = []

    text, repair_notes, damaged = undo_spreadsheet_damage(text)
    notes.extend(repair_notes)
    if damaged:
        return PhoneInfo(raw, reason="damaged", detail=REASONS["damaged"], notes=tuple(notes))

    text, extension = _strip_extension(text)
    # Letters are kept only for vanity numbers such as 1-800-FLOWERS; libphonenumber converts them.
    digits = re.sub(r"\D", "", text)
    if not digits and not re.search(r"[A-Za-z]{3,}", text):
        return PhoneInfo(raw, reason="no_digits", detail=REASONS["no_digits"])

    assumed = region_from_country(country) if country not in (None, "") else None
    if country not in (None, "") and assumed is None:
        notes.append(f"country “{country}” is not one libphonenumber knows; used {region}")
    base = assumed or region
    if assumed and assumed != region:
        notes.append(f"country taken from {country_source} ({assumed})")

    stated = text.lstrip().startswith("+")
    candidates = [(text, None if stated else base, ())]
    prefixed = _DIAL_PREFIX.match(digits) if not stated else None
    if prefixed:
        candidates.append(("+" + digits[prefixed.end():], None, ("read the 00 / 011 prefix as +",)))

    chosen = None
    for candidate_text, candidate_region, candidate_notes in candidates:
        try:
            number = phonenumbers.parse(candidate_text, candidate_region)
        except phonenumbers.NumberParseException as error:
            if chosen is None:
                code = "bad_country_code" if error.error_type == phonenumbers.NumberParseException.INVALID_COUNTRY_CODE else "unreadable"
                chosen = (None, candidate_notes, code)
            continue
        if phonenumbers.is_valid_number(number):
            chosen = (number, candidate_notes, None)
            break
        if chosen is None or chosen[0] is None:
            chosen = (number, candidate_notes, None)
    number, extra_notes, failure = chosen
    notes.extend(extra_notes)
    if number is None:
        return PhoneInfo(raw, reason=failure, detail=REASONS[failure], notes=tuple(notes))

    region_code = phonenumbers.region_code_for_number(number) or (None if stated else base)
    place = _place(region_code, number.country_code)
    e164 = phonenumbers.format_number(number, PhoneNumberFormat.E164)
    common = dict(
        raw=raw, e164=e164, region=region_code, country_code=number.country_code, extension=extension, notes=tuple(notes),
        national=phonenumbers.format_number(number, PhoneNumberFormat.NATIONAL),
        international=phonenumbers.format_number(number, PhoneNumberFormat.INTERNATIONAL),
    )
    unusable = {**common, "e164": None, "national": None, "international": None}

    if _placeholder(str(number.national_number), number.country_code):
        return PhoneInfo(**unusable, reason="placeholder", detail=REASONS["placeholder"])
    if phonenumbers.is_valid_number(number):
        kind = phonenumbers.number_type(number)
        return PhoneInfo(**common, valid=True, type=TYPE_NAMES.get(kind, "unknown"))

    if region_code and shortnumberinfo.is_valid_short_number_for_region(number, region_code):
        return PhoneInfo(**unusable, reason="short_code", detail=REASONS["short_code"])
    verdict = phonenumbers.is_possible_number_with_reason(number)
    code = {ValidationResult.TOO_SHORT: "too_short", ValidationResult.TOO_LONG: "too_long", ValidationResult.INVALID_LENGTH: "bad_length",
            ValidationResult.INVALID_COUNTRY_CODE: "bad_country_code"}.get(verdict, "not_in_plan")
    detail = REASONS[code].format(place=place)
    if number.country_code == 1:
        typed = re.sub(r"\D", "", text)[-10:]
        if code == "not_in_plan" and len(typed) == 10:
            detail = (f"Area codes cannot start with {typed[0]}" if typed[0] in "01"
                      else f"Exchange codes cannot start with {typed[3]}" if typed[3] in "01"
                      else f"Area code {typed[:3]} is not assigned in {place}")
        elif code == "not_in_plan" and verdict == ValidationResult.IS_POSSIBLE_LOCAL_ONLY:
            detail = "Only the local part of the number: the area code is missing"
    return PhoneInfo(**unusable, reason=code, detail=detail)


def analyze_cell(value: object, region: str | None = "US", country: object = None, country_source: str = "the Country column") -> list[PhoneInfo]:
    """Every number in a cell, in order, repeats removed. An empty cell gives an empty list."""
    pieces = split_cell(value)
    if not pieces:
        return []
    found: list[PhoneInfo] = []
    seen: set[str] = set()
    for piece in pieces:
        info = analyze(piece, region, country, country_source)
        key = info.e164 or info.raw
        if key in seen:
            continue
        seen.add(key)
        found.append(info)
    return found


def match_key(value: object, region: str | None = "US", country: object = None) -> set[str]:
    """The E.164 numbers in a cell that are valid for their country. Invalid values give no key: a digit string that
    is not a real number must never be allowed to match another row."""
    return {info.e164 for info in analyze_cell(value, region, country) if info.valid and info.e164}


def display(info: PhoneInfo, region: str | None = "US") -> str:
    """How a valid number is shown: national format at home, international abroad, extension kept."""
    if not info.valid:
        return info.raw
    text = info.national if info.region == region else info.international
    return f"{text} ext. {info.extension}" if info.extension else text or info.raw
