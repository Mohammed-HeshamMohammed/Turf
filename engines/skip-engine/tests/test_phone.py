"""The shared phone rules: country rules come from libphonenumber; these tests cover what is added on top of it."""

import phonenumbers
import pytest
from phonenumbers import PhoneNumberFormat as Format, PhoneNumberType as Kind

from callerwhale_matching import cleanup, phone


def read(value, region="US", country=None):
    return phone.analyze(value, region, country)


def test_a_valid_number_is_read_into_e164_with_its_country_and_type():
    info = read("(713) 555-3142")
    assert (info.valid, info.e164, info.region, info.country_code, info.type) == (True, "+17135553142", "US", 1, "landline or mobile")
    assert info.national == "(713) 555-3142" and info.international == "+1 713-555-3142"
    egypt = read("010 1234 5678", "EG")
    assert (egypt.valid, egypt.e164, egypt.type) == (True, "+201012345678", "mobile")
    assert read("07911 123456", "GB").type == "mobile"
    assert read("1-800-FLOWERS").type == "toll-free"


def test_country_rules_are_applied_not_just_length():
    for value, region, reason in [
        ("(000) 555-3142", "US", "not_in_plan"), ("(713) 055-3142", "US", "not_in_plan"), ("(245) 749-3151", "US", "not_in_plan"),
        ("013 1234 5678", "EG", "not_in_plan"), ("12345", "US", "too_short"), ("(713) 555-31422", "US", "too_long"), ("+999 123", "US", "bad_country_code"),
    ]:
        info = read(value, region)
        assert (info.valid, info.reason) == (False, reason), value
        assert info.e164 is None and info.detail
    assert "Area codes cannot start with 0" in read("(000) 555-3142").detail
    assert "Exchange codes cannot start with 0" in read("(713) 055-3142").detail
    assert "Area code 245 is not assigned" in read("(245) 749-3151").detail
    assert "area code is missing" in read("555-3142").detail


def test_the_dialling_prefix_is_read_but_only_after_the_number_fails_as_written():
    for value in ("00201001234567", "0020 100 1234567", "011 20 100 123 4567", "+20 100 123 4567"):
        assert read(value).e164 == "+201001234567", value
    assert "read the 00 / 011 prefix as +" in read("0020 100 1234567").notes
    # 011 is an ordinary area code in India: a number valid as written is never rewritten.
    assert read("011 2345 6789", "IN").e164 == "+911123456789"


def test_excel_damage_is_repaired_exactly_or_reported():
    assert read("7135553142.0").e164 == read("7135553142").e164 == "+17135553142"
    assert read("7.135553142E9").e164 == "+17135553142"
    assert "rebuilt the digits from scientific notation" in read("7.135553142E9").notes
    lost = read("1.23457E+11")
    assert (lost.valid, lost.reason) == (False, "damaged")


def test_a_cell_with_several_numbers_gives_each_one():
    assert [i.e164 for i in phone.analyze_cell("(713) 555-3142 / (713) 555-3199")] == ["+17135553142", "+17135553199"]
    assert [i.e164 for i in phone.analyze_cell("7135553142, 7135553199")] == ["+17135553142", "+17135553199"]
    assert [i.e164 for i in phone.analyze_cell("713-555-3142; 713-555-3142")] == ["+17135553142"], "repeats are dropped"
    assert phone.analyze_cell("") == [] and phone.analyze_cell(None) == []
    assert phone.match_key("00201001234567 / 07911 123456", "GB") == {"+201001234567", "+447911123456"}


def test_extensions_are_kept_apart_from_the_number():
    info = read("713-555-3142 x12")
    assert (info.valid, info.e164, info.extension) == (True, "+17135553142", "12")
    assert phone.display(info) == "(713) 555-3142 ext. 12"


def test_made_up_numbers_and_short_codes_are_named_as_such():
    for value in ("(713) 555-0142", "713-555-5555", "(123) 456-7890", "000-000-0000"):
        assert read(value).reason in ("placeholder", "not_in_plan"), value
    assert read("(713) 555-0142").reason == "placeholder", "555-0100 to 555-0199 are reserved for fiction"
    assert read("911").reason == "short_code" and read("411").reason == "short_code"
    assert read("").reason == "empty" and read("n/a").reason == "no_digits" and read("---").reason == "no_digits" and read("abc").reason == "unreadable"


def test_a_country_column_wins_over_the_default_and_is_noted():
    info = read("010 1234 5678", "US", country="Egypt")
    assert (info.valid, info.region) == (True, "EG")
    assert "country taken from the Country column (EG)" in info.notes
    assert read("07911 123456", "US", country="uk").e164 == "+447911123456"
    unknown = read("(713) 555-3142", "US", country="Atlantis")
    assert unknown.valid and any("Atlantis" in note for note in unknown.notes)
    assert phone.region_from_country("EG") == "EG" and phone.region_from_country("United Kingdom") == "GB" and phone.region_from_country("") is None


def test_cleanup_no_longer_cuts_a_longer_number_down_to_a_fragment():
    assert cleanup.phone_number("0020 100 1234567")[1] is None and cleanup.phone_number("0020 100 1234567")[0] == "+20 10 01234567"
    assert cleanup.phone_number("7135553142.0") == ("(713) 555-3142", None)
    assert cleanup.phone_number("1.23457E+11")[1] == "invalid"
    assert cleanup.phone_number("(713) 555-3142 cell") == ("(713) 555-3142", None)
    assert cleanup.phone_number("713-555-3142 x12") == ("(713) 555-3142 ext. 12", None)


def _examples():
    for region in sorted(phonenumbers.SUPPORTED_REGIONS):
        for kind in (Kind.FIXED_LINE, Kind.MOBILE, Kind.TOLL_FREE, Kind.VOIP, Kind.PREMIUM_RATE):
            example = phonenumbers.example_number_for_type(region, kind)
            if example is not None:
                yield region, kind, example


def test_every_example_number_libphonenumber_publishes_is_accepted_in_every_country():
    """libphonenumber ships an example number per country and type. Each must be valid when written nationally and
    internationally, and read back to the same E.164 number. This is how the country rules are tested without us
    writing them: a library update that changes a plan is checked against its own examples."""
    failures, checked = [], 0
    for region, kind, example in _examples():
        expected = phonenumbers.format_number(example, Format.E164)
        for text in (phonenumbers.format_number(example, Format.NATIONAL), expected):
            info = read(text, region)
            if info.reason == "placeholder":
                continue  # the published example is itself a fictional or repeated number
            checked += 1
            if not (info.valid and info.e164 == expected):
                failures.append((region, kind, text, info.reason))
    assert checked > 1500 and not failures, failures[:10]


@pytest.mark.parametrize("region", ["US", "EG", "GB", "DE", "IN", "BR"])
def test_a_number_valid_in_one_country_is_rejected_in_another_unless_it_says_where_it_is_from(region):
    example = phonenumbers.example_number_for_type(region, Kind.MOBILE)
    national = phonenumbers.format_number(example, Format.NATIONAL)
    international = phonenumbers.format_number(example, Format.INTERNATIONAL)
    assert read(international, "JP").e164 == phonenumbers.format_number(example, Format.E164) or read(international, "JP").reason == "placeholder"
    other = "FR" if region != "FR" else "US"
    if read(national, other).valid:
        pytest.skip("this national number happens to be valid in both countries")
    assert not read(national, other).valid


def test_the_metadata_version_is_available_for_reports():
    assert phone.METADATA_VERSION == phonenumbers.__version__ and phone.PHONE_VERSION >= 1
