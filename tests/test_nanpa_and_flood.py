"""Number blocks from NANPA's files, and FEMA flood zones."""

from __future__ import annotations

import io
import json
import zipfile
import pytest

from helpers import ok
from test_service_skiptrace import FILE_A, confirmed, make_dataset, run, service  # noqa: F401
from callerwhale_service import flood, nanpa_blocks

UTILIZED = "State\tNPA-NXX\tOcn\tCompany\tRateCenter\tEffectiveDate\tUse\tAssignDate\tInitial/Growth\n" \
           "TX\t713-555\t6214\tSOUTHWESTERN BELL\tHOUSTON\t\tAS\t\tI\n" \
           "TX\t713-200\t6214\tSOUTHWESTERN BELL\tHOUSTON\t\tAS\t\tI\n" \
           "TX\t713-999\t\t\t\t\tVC\t\t\n"


def test_assigned_blocks_are_read_from_a_nanpa_file(tmp_path):
    blocks = nanpa_blocks.read_blocks("allutlzd.txt", UTILIZED)
    assert blocks["713"] == {"assigned": {"555", "200"}, "free": {"999"}}
    assert nanpa_blocks.read_blocks("npa_nxx.csv", "NPA,NXX,Status\n281,555,AS\n")["281"]["assigned"] == {"555"}
    assert nanpa_blocks.read_blocks("available.txt", "713 432\n")["713"] == {"assigned": set(), "free": {"432"}}
    archive = tmp_path / "allutlzd.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("allutlzd.txt", UTILIZED)
    assert nanpa_blocks.import_file(archive) == {"area_codes": 1, "assigned": 2, "free": 1}
    assert nanpa_blocks.unassigned("+17135553142") is None
    assert nanpa_blocks.unassigned("+17134443142").startswith("The block 713-444 is not assigned to any carrier")
    assert nanpa_blocks.unassigned("+18325553142") is None, "area codes not in the file are not judged"
    assert nanpa_blocks.status()["area_codes"] == 1


def test_a_number_in_an_unassigned_block_is_suspicious_in_a_check(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Blocks", FILE_A)
    config = confirmed(service, dataset)
    path = tmp_path / "allutlzd.txt"
    path.write_text(UTILIZED.replace("713-200", "713-201"), encoding="utf-8")  # 713-555 assigned, nothing else in 713
    run(service, "nanpa_blocks.import", path=str(path))
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert any(reason["code"] == "unassigned_block" for reason in report["reasons"]) is False, "every FILE_A 713 number is in 713-555"
    path.write_text(UTILIZED.replace("713-555", "713-556"), encoding="utf-8")
    run(service, "nanpa_blocks.import", path=str(path))
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert any(reason["code"] == "unassigned_block" for reason in report["reasons"])


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_a_flood_zone_is_read_and_kept():
    asked = []

    def fema(url, timeout):
        asked.append(url)
        return Answer(json.dumps({"features": [{"attributes": {"FLD_ZONE": "AE", "ZONE_SUBTY": "", "SFHA_TF": "T"}}]}).encode())

    answer = flood.flood_of(29.76, -95.37, opener=fema, background=False)
    assert answer["risk"] == "high" and answer["zone"] == "AE" and "FEMA" in answer["text"]
    assert flood.flood_of(29.76, -95.37, opener=fema, background=False) == answer and len(asked) == 1
    assert flood.meaning("X", False)["risk"] == "low" and flood.meaning("D", False)["risk"] == "unknown"


def test_outside_the_us_fema_asks_for_a_us_vpn_and_try_again_asks_anew():
    def refused(url, timeout):
        raise ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")

    assert flood.flood_of(10.0, 20.0, opener=refused, background=False) == {"unavailable": flood.NEEDS_US}
    assert flood.flood_of(10.0, 20.0, opener=refused, background=False) == {"unavailable": flood.NEEDS_US}, "not asked again on its own"

    def fema(url, timeout):
        return Answer(json.dumps({"features": []}).encode())

    assert flood.flood_of(10.0, 20.0, force=True, opener=fema, background=False)["risk"] == "unknown"


def test_unavailable_codes_are_retained_and_separate_columns_are_read():
    blocks = nanpa_blocks.read_blocks("codes.csv", "NPA,NXX,Use\n713,555,UA\n713,200,AS\n713,432,VC\n")
    assert blocks["713"] == {"assigned": {"555", "200"}, "free": {"432"}}
    assert nanpa_blocks.read_blocks("codes.csv", "713,200\n713,201\n")["713"]["assigned"] == {"200", "201"}


def test_available_only_file_flags_explicit_codes_without_judging_unknown_blocks(tmp_path):
    path = tmp_path / "available.txt"
    path.write_text("713 432\n", encoding="utf-8")
    nanpa_blocks.import_file(path)
    assert nanpa_blocks.unassigned("+17134323142")
    assert nanpa_blocks.unassigned("+17134443142") is None


def test_new_number_blocks_invalidate_a_reviewed_scan(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Blocks", FILE_A)
    config = confirmed(service, dataset)
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    path = tmp_path / "allutlzd.txt"
    path.write_text(UTILIZED, encoding="utf-8")
    run(service, "nanpa_blocks.import", path=str(path))
    assert ok(service, "skiptrace.freshness", dataset_id=dataset)["fingerprint"] != report["fingerprint"]


@pytest.mark.parametrize("lat,lon", [(float("nan"), 0), (0, float("inf")), (91, 0), (0, -181)])
def test_invalid_coordinates_never_ask_fema(lat, lon):
    def should_not_run(*args, **kwargs):
        pytest.fail("Invalid coordinates were sent to FEMA")
    with pytest.raises(ValueError, match="Latitude"):
        flood.flood_of(lat, lon, opener=should_not_run, background=False)


def test_missing_data_is_unknown_and_overlapping_zones_keep_the_high_risk():
    def answer(features):
        return lambda url, timeout: Answer(json.dumps({"features": features}).encode())
    empty = flood.flood_of(30, -95, opener=answer([]), background=False)
    assert empty["risk"] == "unknown" and "does not establish low" in empty["text"]
    zones = [{"attributes": {"FLD_ZONE": "X", "SFHA_TF": "F"}}, {"attributes": {"FLD_ZONE": "AE", "SFHA_TF": "T"}}]
    assert flood.flood_of(30, -95, force=True, opener=answer(zones), background=False)["risk"] == "high"
    assert flood.meaning("AREA NOT INCLUDED", False)["risk"] == "unknown"
