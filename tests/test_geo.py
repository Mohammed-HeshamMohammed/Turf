"""Places for rows: ZIP centres from the shipped file, exact addresses through the geocoder (replaced here, so no test goes online)."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pytest

from helpers import call, ok, wait
from turf_service import geo
from turf_service.api import Service

COLUMNS = {"street": "Address", "city": "City", "state": "State", "zip": "Zip"}


def test_zip_values_are_read_as_five_digits() -> None:
    assert [geo.normal_zip(value) for value in ["77009", "77009-1234", "770091234", 77009, "7009.0", " 601 ", "TX", "", None, "12"]] == [
        "77009", "77009", "77009", "77009", "07009", "00601", None, None, None, None,
    ]


def test_zip_centres_come_with_their_states() -> None:
    found = geo.zip_centres(["77009", "85713-1200", 601, "00000", "nope"])
    assert set(found) == {"77009", "85713-1200", "601"}
    assert found["77009"]["states"] == ["TX"] and found["85713-1200"]["states"] == ["AZ"] and found["601"]["states"] == ["PR"]
    # Houston's 77009 is north of downtown: about 29.8 N, 95.4 W.
    assert abs(found["77009"]["lat"] - 29.795) < 0.05 and abs(found["77009"]["lon"] + 95.37) < 0.05


def project_with_addresses(tmp_path: Path) -> tuple[Service, str]:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    path = tmp_path / "homes.csv"
    path.write_text(
        "Name,Address,City,State,Zip\n"
        "Ada,1718 Everett St,Houston,TX,77009\n"
        "Grace,1721 Chestnut St,Houston,TX,77009\n"
        "Alan,1 Nowhere Rd,Houston,TX,77009\n"
        "Mary,9 Elm St,Houston,TX,77009\n"          # the geocoder will place this one in another ZIP
        "Twin,1718  everett st,HOUSTON,tx,77009-1111\n"  # the same address as Ada's, written differently
        "Blank,,Houston,TX,77009\n",
        encoding="utf-8",
    )
    job = wait(svc, ok(svc, "dataset.import", path=str(path))["job_id"])
    return svc, job["result"]["dataset_id"]


def fake_geocoder(sent_batches: list):
    def send(batch):
        sent_batches.append(batch)
        out = io.StringIO()
        writer = csv.writer(out)
        for identifier, (street, city, state, zip_code) in batch:
            given = f"{street}, {city}, {state}, {zip_code}"
            if "Nowhere" in street:
                writer.writerow([identifier, given, "No_Match"])
            elif "Elm" in street:
                writer.writerow([identifier, given, "Match", "Non_Exact", "9 ELM ST, HOUSTON, TX, 77008", "-95.41,29.80", "1", "L"])
            else:
                writer.writerow([identifier, given, "Match", "Exact", f"{street.upper()}, HOUSTON, TX, 77009", "-95.3601,29.7801", "1", "L"])
        return out.getvalue()
    return send


def test_addresses_are_looked_up_once_and_kept_only_when_state_and_zip_agree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    svc, dataset_id = project_with_addresses(tmp_path)
    sent: list = []
    monkeypatch.setattr(geo, "_send_batch", fake_geocoder(sent))

    before = ok(svc, "geo.located", dataset_id=dataset_id, columns=COLUMNS)
    assert before == {"exact": {}, "addresses_to_look_up": 4, "rows_without_an_address": 1, "not_found": []}

    job = wait(svc, ok(svc, "geo.locate", dataset_id=dataset_id, columns=COLUMNS)["job_id"])
    assert job["state"] == "completed", job
    assert {key: job["result"][key] for key in ("looked_up", "found", "not_found")} == {"looked_up": 4, "found": 2, "not_found": 2}
    # Only the address goes out: no names, and the two spellings of one address are sent once.
    assert [address for _, address in sent[0]] == [
        ("1718 Everett St", "Houston", "TX", "77009"), ("1721 Chestnut St", "Houston", "TX", "77009"),
        ("1 Nowhere Rd", "Houston", "TX", "77009"), ("9 Elm St", "Houston", "TX", "77009"),
    ]
    progress = [event["payload"] for event in job["events"] if event["payload"].get("stage") == "locating_addresses"]
    assert progress[-1] == {"stage": "locating_addresses", "done": 4, "total": 4, "found": 2}

    after = ok(svc, "geo.located", dataset_id=dataset_id, columns=COLUMNS)
    # Rows 2, 3 and 6 (the twin) have a place; the unmatched one and the one matched in another ZIP do not.
    not_found = after.pop("not_found")
    assert after == {"exact": {"2": [29.7801, -95.3601], "3": [29.7801, -95.3601], "6": [29.7801, -95.3601]}, "addresses_to_look_up": 0, "rows_without_an_address": 1}
    assert len(not_found) == 2, "the two addresses looked up and not found are named"

    # Nothing is asked twice, and the answers are in the project folder.
    again = wait(svc, ok(svc, "geo.locate", dataset_id=dataset_id, columns=COLUMNS)["job_id"])
    assert again["result"]["looked_up"] == 0 and len(sent) == 1
    kept = json.loads((tmp_path / "project" / "turf" / "geocodes.json").read_text(encoding="utf-8"))
    assert kept["1 nowhere rd|houston|tx|77009"] is None and kept["1718 everett st|houston|tx|77009"] == [29.7801, -95.3601]


def test_a_lookup_needs_a_street_column_and_a_zip_or_city_and_state(tmp_path: Path) -> None:
    svc, dataset_id = project_with_addresses(tmp_path)
    assert call(svc, "geo.locate", dataset_id=dataset_id, columns={"zip": "Zip"})["error"]["code"] == "invalid_request"
    assert call(svc, "geo.locate", dataset_id=dataset_id, columns={"street": "Address", "city": "City"})["error"]["code"] == "invalid_request"
    assert call(svc, "geo.locate", dataset_id="nothing", columns=COLUMNS)["error"]["code"] == "invalid_request"


def test_a_failed_request_fails_the_job_and_keeps_what_was_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    svc, dataset_id = project_with_addresses(tmp_path)
    monkeypatch.setattr(geo, "BATCH", 2)
    good = fake_geocoder([])
    calls = {"count": 0}

    def flaky(batch):
        calls["count"] += 1
        if calls["count"] == 2:
            raise OSError("no connection")
        return good(batch)

    monkeypatch.setattr(geo, "_send_batch", flaky)
    job = wait(svc, ok(svc, "geo.locate", dataset_id=dataset_id, columns=COLUMNS)["job_id"])
    assert job["state"] == "failed" and "no connection" in job["error"]
    # The first batch's answers were saved, so trying again only asks for the rest.
    assert ok(svc, "geo.located", dataset_id=dataset_id, columns=COLUMNS)["addresses_to_look_up"] == 2


SQUARE = {"type": "Polygon", "coordinates": [[[-95.4, 29.7], [-95.3, 29.7], [-95.3, 29.8], [-95.4, 29.8], [-95.4, 29.7]]]}


def test_zip_outlines_are_fetched_once_and_then_kept_for_offline_use(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[list[str]] = []

    def fetch(zips):
        asked.append(list(zips))
        return {zip_code: SQUARE for zip_code in zips if zip_code != "85713"}  # the service has nothing for one of them

    monkeypatch.setattr(geo, "_fetch_outlines", fetch)
    first = geo.zip_outlines(["77009", "77009-1234", "85713", "00000", "junk"])
    # Only real ZIPs are asked about, each once, however it was written; answers come back under the values sent.
    assert asked == [["77009", "85713"]]
    assert first == {"outlines": {"77009": SQUARE, "77009-1234": SQUARE}, "unavailable": 0}

    # Now with no connection: what was fetched before still comes back, and nothing is asked for again.
    def offline(zips):
        raise OSError("no connection")

    monkeypatch.setattr(geo, "_fetch_outlines", offline)
    assert geo.zip_outlines(["77009", "85713"]) == {"outlines": {"77009": SQUARE}, "unavailable": 0}
    # A ZIP never seen before cannot be drawn offline, and is counted.
    assert geo.zip_outlines(["77009", "78745"]) == {"outlines": {"77009": SQUARE}, "unavailable": 1}
