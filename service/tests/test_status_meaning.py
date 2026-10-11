"""Reading call statuses: phrase rules, the person's earlier decisions, and the optional embedding model."""

from __future__ import annotations

import os
import zlib
from pathlib import Path

import numpy as np
import pytest

from helpers import call, ok
from status_wording import LABELLED, UNFAMILIAR
from test_service_skiptrace import FILE_A, make_dataset, service  # noqa: F401
from turf_matching import status_meaning as sm
from turf_matching.skiptrace import normalize_status
from turf_service import skiptrace, status_model


def keys_and_gold(data):
    keys = [normalize_status(text)[0] for text, _ in data]
    return keys, dict(zip(keys, (gold for _, gold in data)))


def measure(readings, gold):
    sure = [key for key in gold if readings[key].sure]
    wrong = [key for key in sure if gold[key] is None or readings[key].outcomes != gold[key]]
    dropped = [key for key in gold if gold[key] and "do_not_call" in gold[key] and "do_not_call" not in readings[key].outcomes]
    return sure, wrong, dropped


def words(texts):
    """A stand-in model: texts with the same words get the same vector."""
    vectors = np.zeros((len(texts), 256), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in text.split():
            vectors[row, zlib.crc32(word.encode()) % 256] += 1
    return vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)


def test_the_rules_confirm_nothing_wrongly_and_never_drop_a_do_not_call():
    keys, gold = keys_and_gold(LABELLED)
    sure, wrong, dropped = measure(sm.read_statuses(keys), gold)
    assert wrong == [] and dropped == []
    assert len(sure) / len(keys) >= 0.8, f"only {len(sure)} of {len(keys)} statuses are settled without the person"


def test_a_dnc_label_with_another_reason_is_always_left_for_the_person():
    for status in ("dnc: interested", "dnc: spanish speaker", "dnc until [date]:not interested", "dnc - listed"):
        reading = sm.read_rules(status)
        assert not reading.sure and "do_not_call" in reading.outcomes and reading.doubt == "dnc_reason", status
    assert sm.read_rules("dnc: do not call") == sm.Reading(["do_not_call"], True, "rules", "")
    assert sm.read_rules("dnc: wrong number").outcomes == ["wrong_number"], "a bad number is blocked already"
    assert sm.dnc_reason("dnc until [date]: not interested") == "not interested" and sm.dnc_reason("dnc list") is None


def test_abbreviations_and_phrases_are_spelled_out_once():
    assert sm.spell_out("LVM w/ wife") == "left voicemail with wife" and sm.spell_out("Wrong #") == "wrong number"
    assert sm.read_rules("not interested").outcomes == ["reached"], "not read as interested and not"
    assert sm.read_rules("deceased").outcomes == [], "“cease” inside a word is not an opt-out"
    assert sm.read_rules("not yet reached").outcomes == [] and sm.read_rules("not reached").outcomes == ["no_answer"]
    assert not sm.read_rules("vm - call back").sure, "a message asking for a call back is not a conversation"


def test_the_persons_decision_wins_and_is_matched_without_punctuation():
    memory = {sm.canonical("DNC: interested"): {"key": "dnc: interested", "outcomes": ["reached"], "list": "March leads"}}
    reading = sm.read_statuses(["dnc - interested"], memory)["dnc - interested"]
    assert reading == sm.Reading(["reached"], True, "memory", "You chose this on “March leads”")


def test_the_model_settles_unknown_words_only_when_it_agrees_with_the_rules():
    agrees = sm.combine(sm.read_rules("left voicemail for owner jim"), 0.9, "left voicemail", ["voicemail"], False, True)
    assert agrees.sure and agrees.source == "rules+model"
    unsure_neighbours = sm.combine(sm.read_rules("left voicemail for owner jim"), 0.9, "left voicemail", ["voicemail"], False, False)
    assert not unsure_neighbours.sure
    far = sm.combine(sm.read_rules("left voicemail for owner jim"), sm.AGREE - 0.01, "left voicemail", ["voicemail"], False, True)
    assert not far.sure


def test_a_confident_model_that_disagrees_sends_the_status_to_the_person_and_keeps_dnc():
    rules = sm.read_rules("do not call")
    reading = sm.combine(rules, 0.95, "interested", ["reached"], False, True)
    assert not reading.sure and reading.doubt == "model_disagrees" and "do_not_call" in reading.outcomes
    gains = sm.combine(sm.read_rules("interested"), 0.95, "stop calling me", ["do_not_call"], False, True)
    assert not gains.sure and gains.outcomes == ["do_not_call", "reached"], "a possible opt-out is kept, not dropped"
    assert sm.combine(sm.read_rules("dnc: interested"), 0.99, "interested", ["reached"], False, True).doubt == "dnc_reason"


def test_the_model_guesses_only_from_the_persons_own_decisions():
    unknown = sm.read_rules("owner in hospital")
    assert sm.combine(unknown, 0.99, "hospital", ["reached"], False, True) == unknown, "built-in examples never fill in a meaning"
    guess = sm.combine(unknown, 0.85, "owner hospitalized", [], True, True)
    assert not guess.sure and guess.doubt == "guess"
    assert sm.combine(unknown, 0.97, "owner hospitalized", [], True, True).sure
    memory = {"hospital owner": {"key": "hospital owner", "outcomes": [], "list": "A"}}
    assert sm.read_statuses(["owner hospital"], memory, words)["owner hospital"].source == "model"


@pytest.fixture()
def real_model(monkeypatch):
    folder = Path(os.environ.get("LOCALAPPDATA", "")) / "Turf" / "models" / "potion-base-8M"
    monkeypatch.setenv("TURF_STATUS_MODEL", str(folder))
    embed = status_model.embedder()
    if embed is None:
        pytest.skip("the status model is not fetched (python tools/fetch_status_model.py)")
    return embed


def test_with_the_model_nothing_is_confirmed_wrongly_and_more_is_settled(real_model):
    keys, gold = keys_and_gold(LABELLED + UNFAMILIAR)
    rules_sure, _, _ = measure(sm.read_statuses(keys), gold)
    sure, wrong, dropped = measure(sm.read_statuses(keys, embed=real_model), gold)
    assert wrong == [] and dropped == []
    assert len(sure) >= len(rules_sure)


def test_the_thresholds_have_room_on_both_sides(real_model, monkeypatch):
    keys, gold = keys_and_gold(LABELLED + UNFAMILIAR)
    for agree in (sm.AGREE - 0.1, sm.AGREE + 0.05):
        monkeypatch.setattr(sm, "AGREE", agree)
        assert measure(sm.read_statuses(keys, embed=real_model), gold)[1] == [], f"a wrong confirmation at AGREE={agree}"


def test_a_decision_on_one_list_settles_the_same_wording_on_the_next(service, tmp_path, monkeypatch):
    monkeypatch.setattr(skiptrace, "embedder", lambda: None)
    first = make_dataset(service, tmp_path, "First", [*FILE_A, ["Fe", "Ng", "(713) 555-1212", "", "77022", "TX", "Owner in hospital"]])
    statuses = {item["key"]: item for item in ok(service, "skiptrace.suggest", dataset_id=first)["statuses"]}
    assert statuses["interested"]["confirmed"] and statuses["interested"]["source"] == "rules"
    assert not statuses["owner in hospital"]["confirmed"] and not statuses["dnc until [date]:not interested"]["confirmed"]
    ok(service, "skiptrace.remember", dataset_id=first, decisions={"owner in hospital": [], "dnc until [date]:not interested": ["do_not_call", "reached"]})
    second = make_dataset(service, tmp_path, "Second", [["Gi", "Ox", "(713) 555-3434", "", "77023", "TX", "Owner  in hospital!"],
                                                         ["Ha", "Po", "(713) 555-5656", "", "77024", "TX", "DNC until 01/05/2027: Not interested"]])
    later = {item["key"]: item for item in ok(service, "skiptrace.suggest", dataset_id=second)["statuses"]}
    assert later["owner in hospital!"]["confirmed"] and later["owner in hospital!"]["why"] == "You chose this on “First”"
    assert later["dnc until [date]: not interested"]["confirmed"] and later["dnc until [date]: not interested"]["outcomes"] == ["do_not_call", "reached"]
    ok(service, "skiptrace.remember", dataset_id=first, decisions={"owner in hospital": None})
    again = {item["key"]: item for item in ok(service, "skiptrace.suggest", dataset_id=second)["statuses"]}
    assert not again["owner in hospital!"]["confirmed"]
    assert not call(service, "skiptrace.remember", dataset_id=first, decisions={"x": ["wrong_number", "reached"]})["ok"]
    assert not call(service, "skiptrace.remember", dataset_id=first, decisions={"x": ["maybe"]})["ok"]


def test_wrong_person_is_left_for_the_person_until_a_name_column_is_mapped(service, tmp_path, monkeypatch):
    monkeypatch.setattr(skiptrace, "embedder", lambda: None)
    dataset = make_dataset(service, tmp_path, "Names", [["Ana", "Lopez", "(713) 555-3142", "", "77009", "TX", "Wrong person"]])
    named = next(item for item in ok(service, "skiptrace.statuses", dataset_id=dataset, column="Status") if item["key"] == "wrong person")
    assert named["outcomes"] == ["wrong_person"] and named["confirmed"]
    nameless = ok(service, "skiptrace.statuses", dataset_id=dataset, column="Status", names_mapped=False)[0]
    assert nameless["outcomes"] == [] and not nameless["confirmed"] and nameless["doubt"] == "names"


def test_a_saved_meaning_that_differs_is_asked_again_and_an_ignored_one_stays_ignored(service, tmp_path, monkeypatch):
    monkeypatch.setattr(skiptrace, "embedder", lambda: None)
    dataset = make_dataset(service, tmp_path, "Saved", FILE_A)
    config = ok(service, "skiptrace.suggest", dataset_id=dataset)["config"]
    config["outcome"] = {"column": "Status", "called_column": "Phone", "map": {"interested": ["do_not_call"], "not yet reached": []}}
    ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)
    statuses = {item["key"]: item for item in ok(service, "skiptrace.suggest", dataset_id=dataset)["statuses"]}
    assert statuses["interested"]["outcomes"] == ["do_not_call"] and not statuses["interested"]["confirmed"] and statuses["interested"]["doubt"] == "saved"
    assert statuses["not yet reached"]["confirmed"] and statuses["not yet reached"]["why"] == "Ignored on this list"
