"""Skip Tracing verdicts: what is wrong, what is suspicious, what is only unverified, and what is corroborated."""

from datetime import date

from callerwhale_matching import skiptrace as st

TODAY = date(2026, 10, 8)
CONFIG = {
    "phone_columns": ["Phone", "Alt"], "region": "US", "first_name_column": "First", "last_name_column": "Last", "zip_column": "Zip", "state_column": "State",
    "outcome": {"column": "Status", "called_column": "Phone", "map": {
        "dnc: wrong number": ["wrong_number"], "dnc until [date]:not interested": ["do_not_call", "reached"], "interested": ["reached"], "not yet reached": [],
    }},
    "signals": {"shared_number": True, "business_line": True, "area_code_other_state": False},
}


def row(first, last, phone, alt="", status="Not yet reached", zip_code="76707", state="TX"):
    return {"First": first, "Last": last, "Phone": phone, "Alt": alt, "Status": status, "Zip": zip_code, "State": state}


def run(rows, config=CONFIG, extra=None):
    knowledge = st.Knowledge()
    st.collect(knowledge, rows, config, "file-a", "File A")
    for rows_b, config_b, source_id, name in extra or []:
        st.collect(knowledge, rows_b, config_b, source_id, name)
    return st.evaluate(rows, list(range(2, len(rows) + 2)), config, knowledge, "File A", TODAY, keep_rows=True)


def verdict(report, index, column="Phone"):
    return report["_row_results"][index]["columns"][column]["verdict"]


def reasons(report, index, column="Phone"):
    return report["_row_results"][index]["columns"][column]["reasons"]


def test_each_value_gets_one_of_the_four_verdicts_with_reasons():
    rows = [
        row("Ana", "Lopez", "(713) 555-3142"),                                   # valid, nothing else known: unverified
        row("Ben", "Ortiz", "(245) 749-3151"),                                   # no such area code: wrong
        row("Cy", "Young", "(713) 555-4455", status="Interested"),               # a call reached someone: corroborated
        row("Di", "Park", "(713) 555-6677", status="DNC: wrong number"),         # a caller said wrong number: wrong
        row("Ed", "Shaw", "800-555-3141"),                                       # toll-free in a person's list: suspicious
    ]
    report = run(rows)
    assert [verdict(report, i) for i in range(5)] == ["unverified", "wrong", "corroborated", "wrong", "suspicious"]
    assert "Area code 245 is not assigned" in reasons(report, 1)[0]
    assert "wrong number" in reasons(report, 3)[0]
    assert report["verdicts"] == {"wrong": 2, "suspicious": 1, "unverified": 1, "corroborated": 1}


def test_reasons_are_listed_with_what_makes_a_number_wrong_first():
    rows = [row("Ed", "Shaw", "(713) 555-2211", status="Interested")] * 5 + [row("Ben", "Ortiz", "(245) 749-3151"), row("Cy", "Young", "800-555-3141")]
    report = run(rows)
    assert [item["effect"] for item in report["reasons"]] == ["wrong", "suspicious", "corroborated"]
    assert report["reasons"][0]["code"] == "format_not_in_plan" and report["reasons"][-1]["code"] == "reached" and report["reasons"][-1]["count"] == 5


def test_a_valid_number_is_never_called_correct_without_evidence():
    report = run([row("Ana", "Lopez", "(713) 555-3142")])
    assert verdict(report, 0) == "unverified" and reasons(report, 0) == []


def test_a_wrong_number_in_one_row_is_carried_to_every_other_row_with_that_number():
    rows = [row("Di", "Park", "(713) 555-6677", status="DNC: wrong number"), row("Fay", "Bell", "(713) 555-6677"), row("Gus", "Bell", "", "(713) 555-6677")]
    report = run(rows)
    assert verdict(report, 1) == "wrong" and "Marked wrong number 1 time (this file)" in reasons(report, 1)[0]
    assert verdict(report, 2, "Alt") == "wrong", "found through the other phone column too"
    outcomes = report["outcomes"]
    assert (outcomes["carried_rows"], outcomes["carried_wrong_number"]) == (2, 2) and outcomes["known_wrong_numbers"] == 1


def test_outcomes_in_another_file_warn_about_numbers_in_this_one():
    other = [row("Zed", "Yu", "(713) 555-6677", status="DNC: wrong number")]
    report = run([row("Fay", "Bell", "(713) 555-6677")], extra=[(other, CONFIG, "file-b", "File B")])
    assert verdict(report, 0) == "wrong" and "File B" in reasons(report, 0)[0]


def test_do_not_call_blocks_until_its_date_and_then_stops():
    rows = [
        row("Ana", "Lopez", "(713) 555-3142", status="DNC until 10/15/2026:Not interested"),   # still active on 2026-10-08
        row("Ben", "Ortiz", "(713) 555-4455", status="DNC until 09/16/2025:Not interested"),   # ended last year
        row("Cy", "Young", "(713) 555-6677", status="DNC until 12/01/2026:Not interested"),
    ]
    report = run(rows)
    assert verdict(report, 0) == "wrong" and "until 2026-10-15" in reasons(report, 0)[0]
    assert verdict(report, 1) == "corroborated", "an expired mark no longer blocks, and the person was reached"
    assert any("ended on 2025-09-16" in text for text in reasons(report, 1))
    assert report["outcomes"]["do_not_call_numbers"] == 2 and report["outcomes"]["expired_do_not_call_numbers"] == 1


def test_a_number_marked_do_not_call_elsewhere_is_wrong_for_a_row_not_yet_called():
    other = [row("Ana", "Lopez", "(713) 555-3142", status="DNC until 12/01/2026:Not interested")]
    report = run([row("Ana", "Lopez", "(713) 555-3142")], extra=[(other, CONFIG, "file-b", "File B")])
    assert verdict(report, 0) == "wrong" and "do-not-call list in File B until 2026-12-01" in reasons(report, 0)[0]
    assert report["outcomes"]["carried_do_not_call"] == 1


def test_conflicting_outcomes_make_a_number_suspicious_not_wrong():
    rows = [row("Di", "Park", "(713) 555-6677", status="DNC: wrong number"), row("Di", "Park", "(713) 555-6677", status="Interested")]
    report = run(rows)
    assert verdict(report, 0) == "corroborated" or verdict(report, 0) == "suspicious"
    assert any("wrong number" in text and "reached" in text for text in reasons(report, 0))


def test_a_number_shared_by_different_families_is_suspicious_but_a_household_is_not():
    rows = [
        row("Ana", "Lopez", "(713) 555-3142"), row("Bo", "Reyes", "(713) 555-3142"),            # two families on one number
        row("Cy", "Young", "(713) 555-4455"), row("Dee", "Young", "(713) 555-4455"),            # one family, two people
    ]
    report = run(rows)
    assert verdict(report, 0) == "suspicious" and "Listed for 2 different people" in reasons(report, 0)[0]
    assert verdict(report, 2) == "unverified" and verdict(report, 3) == "unverified"


def test_files_that_agree_on_a_person_and_number_corroborate_it_but_a_copy_of_the_same_file_does_not():
    rows = [row("Ana", "Lopez", "(713) 555-3142")]
    other = [row("Ana", "Lopez", "(713) 555-3142")]
    agreed = run(rows, extra=[(other, CONFIG, "file-b", "File B")])
    assert verdict(agreed, 0) == "corroborated" and "2 different files" in reasons(agreed, 0)[0]
    copy = run(rows, extra=[(other, CONFIG, "file-a", "File A copy")])
    assert verdict(copy, 0) == "unverified", "identical content counts once"


def test_damaged_and_invalid_values_are_wrong_with_the_reason():
    rows = [row("Ana", "Lopez", "1.23457E+11"), row("Ben", "Ortiz", "555-3142"), row("Cy", "Young", "(713) 555-0142"), row("Di", "Park", "7135553142.0")]
    report = run(rows)
    assert [verdict(report, i) for i in range(4)] == ["wrong", "wrong", "wrong", "unverified"]
    assert "Damaged by a spreadsheet" in reasons(report, 0)[0] and "area code is missing" in reasons(report, 1)[0]
    assert "placeholder" in reasons(report, 2)[0].lower() or "made-up" in reasons(report, 2)[0].lower()
    assert {item["note"] for item in report["repairs"]} == {"removed a trailing .0 left by a spreadsheet"}


def test_the_best_phone_skips_wrong_numbers_and_prefers_corroborated_ones():
    rows = [row("Ana", "Lopez", "(245) 749-3151", "(713) 555-3142"), row("Ben", "Ortiz", "(713) 555-4455", "(713) 555-6677", status="Interested")]
    report = run(rows)
    first, second = report["_row_results"]
    assert first["best"][0] == "Alt" and first["best"][1]["e164"] == ["+17135553142"]
    assert second["best"][0] == "Phone" and second["best"][1]["verdict"] == "corroborated"
    assert report["rows_with_callable_number"] == 2
    assert run([row("Ana", "Lopez", "(245) 749-3151")])["_row_results"][0]["best"] is None


def test_the_column_report_says_which_column_is_worth_using():
    rows = [row("A", "One", "(713) 555-3142", "(713) 555-3142"), row("B", "Two", "(713) 555-4455", "(713) 555-4455"), row("C", "Three", "(713) 555-6677", "(713) 555-8899"),
            row("D", "Four", "(713) 555-9911", "(713) 555-9911")]
    report = run(rows)
    phone, alt = report["columns"]
    assert phone["verdict_text"] == "Useful" and phone["filled"] == 4 and phone["adds_info_share"] == 1
    assert alt["adds_info"] == 1 and "Often repeats" in alt["verdict_text"]
    empty = run([row("A", "One", "(713) 555-3142")] + [row("B", "Two", "", "") for _ in range(20)])
    assert empty["columns"][0]["verdict_text"] == "Mostly empty"


def test_a_country_column_applies_the_rules_of_that_country():
    config = {**CONFIG, "country_column": "Country", "outcome": None}
    rows = [{"First": "Mo", "Last": "Ali", "Phone": "010 1234 5678", "Alt": "", "Country": "Egypt"},
            {"First": "Sam", "Last": "Ray", "Phone": "013 1234 5678", "Alt": "", "Country": "Egypt"},
            {"First": "Jo", "Last": "Lee", "Phone": "07400 123456", "Alt": "", "Country": "United Kingdom"}]
    report = run(rows, config)
    assert [verdict(report, i) for i in range(3)] == ["unverified", "wrong", "unverified"]
    assert report["countries"] == {"EG": 1, "GB": 1} and "Egypt uses" in reasons(report, 1)[0]


def test_warning_signs_are_measured_against_the_outcomes_in_the_data():
    rows = []
    for index in range(60):   # shared numbers go wrong more often here
        number = f"(713) 555-{4000 + index}"
        rows.append(row("Ana", "Lopez", number, status="DNC: wrong number" if index < 40 else "Interested"))
        rows.append(row("Bo", "Reyes", number, status="Not yet reached"))
    for index in range(100):  # other numbers go wrong rarely
        number = f"(713) 555-{7000 + index}"
        rows.append(row("Cy", f"Young{index}", number, status="DNC: wrong number" if index < 5 else "Interested"))
    report = run(rows)
    signs = {item["code"]: item for item in report["signals"]}
    assert signs["shared_number"]["contacted"] == 60 and signs["shared_number"]["predictive"] is True
    assert signs["shared_number"]["lift"] > 1.15 and signs["business_line"]["enough_data"] is False
    assert signs["same_as_other_column"]["measured_only"] is True
    assert report["outcomes"]["baseline_wrong_rate"] == round(45 / 160, 4)


def test_statuses_are_grouped_without_their_dates_and_given_a_suggested_meaning():
    table = st.status_table(["DNC until 10/15/2025:Not interested", "DNC until 09/16/2025:Not interested", "DNC: wrong number", "Not yet reached", "Interested", "Left voicemail", ""])
    by_key = {item["key"]: item for item in table}
    assert by_key["dnc until [date]:not interested"]["count"] == 2 and by_key["dnc until [date]:not interested"]["outcomes"] == ["do_not_call", "reached"]
    assert by_key["dnc: wrong number"]["outcomes"] == ["wrong_number"] and by_key["not yet reached"]["outcomes"] == [] and by_key["interested"]["outcomes"] == ["reached"]
    assert by_key["left voicemail"]["outcomes"] == ["voicemail"], "recorded as activity; it does not show the number is right"
    assert by_key["interested"]["sure"] and by_key["left voicemail"]["sure"] and not by_key["dnc until [date]:not interested"]["sure"]
    key, until = st.normalize_status("DNC until 10/15/2025:Not interested")
    assert until == date(2025, 10, 15) and st.normalize_status("DNC until 15/10/2025", day_first=True)[1] == date(2025, 10, 15)
    assert st.normalize_status("DNC until 2025-10-15")[1] == date(2025, 10, 15) and st.normalize_status("DNC")[1] is None


def test_the_setup_is_suggested_from_the_columns_and_values():
    rows = [row("Ana", "Lopez", "(713) 555-3142", "(713) 555-4455", "Interested"), row("Bo", "Reyes", "(713) 555-6677", "", "Not yet reached")]
    suggestion = st.suggest(rows, {})
    assert suggestion["config"]["phone_columns"] == ["Phone", "Alt"] and suggestion["outcome_candidates"][0]["column"] == "Status"
    roles = {"Phone": "phone", "First": "first_name", "Last": "last_name", "Zip": "postal_code", "State": "region"}
    config = st.suggest(rows, roles)["config"]
    assert config["phone_columns"] == ["Phone"] and config["last_name_column"] == "Last" and config["state_column"] == "State"


def test_numeric_identifiers_are_not_suggested_as_phone_columns():
    rows = [{"APN": "7135553142", "Account ID": "7135554455", "Phone": "7135556677"}]
    assert st.suggest(rows, {})["config"]["phone_columns"] == ["Phone"]


def test_a_phone_from_another_country_than_the_address_is_suspicious_but_the_plus_one_countries_agree():
    rows = [
        {"First": "Ana", "Last": "Lopez", "Phone": "+44 7400 123456", "Alt": "", "Zip": "76707", "State": "TX"},      # a UK number at a Texas address
        {"First": "Ben", "Last": "Ortiz", "Phone": "+1 416 555 3142", "Alt": "", "Zip": "77009", "State": "TX"},      # Canadian area code: still +1
        {"First": "Cy", "Last": "Young", "Phone": "+44 7400 654321", "Alt": "", "Zip": "77009", "State": ""},        # a bare ZIP says nothing about the country
    ]
    report = run(rows, {**CONFIG, "outcome": None})
    assert [verdict(report, i) for i in range(3)] == ["suspicious", "unverified", "unverified"]
    assert reasons(report, 0) == ["The phone is from United Kingdom (+44); the address is in United States"]
    turned_off = run(rows[:1], {**CONFIG, "outcome": None, "signals": {"country_mismatch": False}})
    assert verdict(turned_off, 0) == "unverified"


def test_the_address_tells_how_to_read_a_number_that_does_not_say_its_country():
    uk = {"First": "Jo", "Last": "Lee", "Phone": "07400 123456", "Alt": "", "Zip": "SW1A 1AA", "State": ""}
    texas = {"First": "Al", "Last": "Roe", "Phone": "07400 123456", "Alt": "", "Zip": "76707", "State": "TX"}
    canada = {"First": "Em", "Last": "Fox", "Phone": "(416) 555-3142", "Alt": "", "Zip": "M5V 2T6", "State": ""}
    report = run([uk, texas, canada], {**CONFIG, "outcome": None})
    assert [verdict(report, i) for i in range(3)] == ["unverified", "wrong", "unverified"]
    assert report["countries"] == {"CA": 1, "GG": 1} or "GB" in report["countries"] or "GG" in report["countries"]
    assert {item["note"] for item in report["repairs"]} >= {"country taken from the postcode (GB)", "country taken from the postal code (CA)"}
    assert "Not a number" in reasons(report, 1)[0] or "Too" in reasons(report, 1)[0] or "Wrong number of digits" in reasons(report, 1)[0]


def test_the_country_column_outranks_what_the_state_and_postal_code_suggest():
    assert st.address_region({"C": "Egypt", "State": "TX"}, {"country_column": "C", "state_column": "State"}) == ("EG", "the Country column")
    assert st.address_region({"Zip": "SW1A 1AA"}, {"zip_column": "Zip"}) == ("GB", "the postcode")
    assert st.address_region({"Zip": "76707-1234"}, {"zip_column": "Zip"}) == ("US", "the ZIP code")
    assert st.address_region({"State": "Texas"}, {"state_column": "State"}) == ("US", "the state")
    assert st.address_region({"State": "Cairo", "Zip": "11511"}, {"state_column": "State", "zip_column": "Zip"}) == (None, "")
    assert st.address_region({"C": "Atlantis"}, {"country_column": "C"}) == (None, "")


def test_the_country_sign_is_measured_against_outcomes_like_the_others():
    rows = []
    for i in range(120):
        abroad = i % 2 == 1
        number = f"+44 7400 {100000 + i}" if abroad else f"(713) 555-{1000 + i}"
        status = "DNC: wrong number" if abroad and i % 4 == 1 else "Interested"      # half of the foreign numbers were wrong, none of the others
        rows.append({"First": f"P{i}", "Last": f"Q{i}", "Phone": number, "Alt": "", "Zip": "76707", "State": "TX", "Status": status})
    report = run(rows)
    sign = next(item for item in report["signals"] if item["code"] == "country_mismatch")
    assert sign["contacted"] == 60 and sign["counted"] is True and sign["enough_data"] is True
    assert sign["wrong_rate"] == 0.5 and sign["lift"] == 2.0 and sign["predictive"] is True


def test_a_do_not_call_alone_does_not_claim_that_a_person_was_reached():
    suggested = {key: st.suggest_outcomes(key) for key in (
        "dnc: do not call", "dnc: sold", "dnc until [date]:not interested", "wrong number", "number disconnected", "opt out", "not yet reached",
        "left voicemail", "interested", "no answer", "unsubscribe", "something no dialer has ever written",
    )}
    assert suggested["dnc: do not call"] == ["do_not_call"] and suggested["opt out"] == ["do_not_call"] and suggested["unsubscribe"] == ["do_not_call"]
    assert suggested["dnc: sold"] == ["do_not_call", "reached"] and suggested["dnc until [date]:not interested"] == ["do_not_call", "reached"]
    assert suggested["wrong number"] == ["wrong_number"] and suggested["number disconnected"] == ["disconnected"]
    assert suggested["not yet reached"] == [] and suggested["left voicemail"] == ["voicemail"] and suggested["no answer"] == ["no_answer"] and suggested["interested"] == ["reached"]
    assert suggested["something no dialer has ever written"] == [], "unknown wording is left for the person to choose"


def test_a_family_is_found_from_shared_name_words_in_any_layout():
    full = {"name_column": "Name", "phone_columns": ["Phone"], "outcome": None}
    one_number = lambda names: [{"Name": name, "Phone": "(713) 555-3142"} for name in names]  # noqa: E731
    assert st.count_families([st._name_tokens(n) for n in ("Ana Lopez", "Bo Reyes")]) == 2
    assert st.count_families([st._name_tokens(n) for n in ("Cy Young", "Dee Young", "Ed Young Jr.")]) == 1
    assert st.count_families([st._name_tokens(n) for n in ("Maria Trejo Labra Soto", "Luis Trejo")]) == 1, "a compound surname still shares a word"
    assert st.count_families([st._name_tokens(n) for n in ("محمد علي", "علي حسن", "سارة خالد")]) == 2, "any script works"
    household = run(one_number(["Cy Young", "Dee Young"]), full)
    strangers = run(one_number(["Ana Lopez", "Bo Reyes"]), full)
    assert verdict(household, 0) == "unverified" and verdict(strangers, 0) == "suspicious"


def test_a_sign_predicts_only_when_its_difference_is_bigger_than_chance_allows():
    def rows_with(sign_wrong: int, sign_total: int, other_wrong: int, other_total: int):
        out = []
        for i in range(sign_total):
            out.append({"First": f"A{i}", "Last": f"B{i}", "Phone": "+44 7400 %06d" % i, "Alt": "", "Zip": "76707", "State": "TX", "Status": "DNC: wrong number" if i < sign_wrong else "Interested"})
        for i in range(other_total):
            out.append({"First": f"C{i}", "Last": f"D{i}", "Phone": f"(713) 555-{2000 + i}", "Alt": "", "Zip": "76707", "State": "TX", "Status": "DNC: wrong number" if i < other_wrong else "Interested"})
        return out

    def sign(report):
        return next(item for item in report["signals"] if item["code"] == "country_mismatch")

    small = sign(run(rows_with(7, 20 + 30, 20, 200)))                    # 30 rows, a few more wrong than usual: could be luck
    assert small["enough_data"] is False
    unclear = sign(run(rows_with(15, 60, 45, 200)))                      # 25% against 22.5%: a small difference on 60 rows
    assert unclear["enough_data"] is True and unclear["predictive"] is False and unclear["z"] < 2
    clear = sign(run(rows_with(40, 60, 40, 200)))                        # 67% against 20%
    assert clear["predictive"] is True and clear["z"] >= 2
