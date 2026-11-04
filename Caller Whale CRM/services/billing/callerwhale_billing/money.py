"""Exact money. Amounts are Decimal in code and whole minor units (cents) in the database; never float. One rounding rule,
half-even, everywhere."""

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

# Digits after the decimal point for currencies that do not use two. Everything else uses two.
_EXPONENTS = {"JPY": 0, "KRW": 0, "VND": 0, "CLP": 0, "ISK": 0, "UGX": 0, "XAF": 0, "XOF": 0, "BHD": 3, "JOD": 3, "KWD": 3, "OMR": 3, "TND": 3}


def exponent(currency: str) -> int:
    code = currency.upper()
    if len(code) != 3 or not code.isalpha():
        raise ValueError(f"{currency!r} is not a currency code")
    return _EXPONENTS.get(code, 2)


def to_minor(amount: Decimal | str | int, currency: str) -> int:
    """A major-unit amount ("19.99") as whole minor units (1999), rounded half-even."""
    if isinstance(amount, float):
        raise TypeError("money is never a float")
    try:
        value = Decimal(amount)
    except InvalidOperation as error:
        raise ValueError(f"{amount!r} is not an amount") from error
    if not value.is_finite():
        raise ValueError(f"{amount!r} is not an amount")
    scaled = value.scaleb(exponent(currency)).quantize(Decimal(1), rounding=ROUND_HALF_EVEN)
    return int(scaled)


def from_minor(minor: int, currency: str) -> Decimal:
    """Whole minor units (1999) as a major-unit Decimal (19.99) with the currency's digits."""
    digits = exponent(currency)
    return (Decimal(minor).scaleb(-digits)).quantize(Decimal(1).scaleb(-digits))


def parse_provider_minor(text: str) -> int:
    """A provider amount already in minor units, as Paddle sends them ("1999"). Refuses anything but whole numbers."""
    value = str(text).strip()
    if not value.lstrip("-").isdigit():
        raise ValueError(f"{text!r} is not a whole number of minor units")
    return int(value)
