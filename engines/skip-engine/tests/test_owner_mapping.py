from datetime import date
import csv
import json

import pytest

from callerwhale_matching import skiptrace as engine, assessment
from callerwhale_service.skiptrace import clean_config
from helpers import ok, wait
from test_service_skiptrace import service, run  # noqa: F401


def sample():
    row = {"Owner1 Name": "Ana Lopez", "Owner2 Name": "Ben Ortiz", "Owner1 Phone": "7135553142", "Owner2 Phone": "7135554455",
           "Address": "10 Investment St", "State": "TX", "Zip": "77009", "Mailing Address": "20 Home St", "Mailing City": "Dallas",
           "Mailing State": "TX", "Mailing Zip": "75001", "Owner Type": "Individual", "Vacant?": "Yes", "Status": "Wrong person"}
    return row, engine.suggest([row], {"Zip": "postal_code", "State": "region"})["config"]


def test_numbered_owners_mailing_and_vacancy_are_suggested_and_survive_validation():
    row, config = sample()
    cleaned = clean_config(config, list(row))
    assert cleaned["name_column"] == "Owner1 Name"
    assert cleaned["additional_owners"][0]["name_column"] == "Owner2 Name"
    assert cleaned["phone_owner_map"] == {"Owner1 Phone": 0, "Owner2 Phone": 1}
    assert cleaned["mailing_zip_column"] == "Mailing Zip" and cleaned["zip_column"] == "Zip"
    assert cleaned["mailing_city_column"] == "Mailing City" and cleaned["owner_type_column"] == "Owner Type"
    assert cleaned["vacancy_column"] == "Vacant?"
    assert engine.person_keys(row, engine.owner_config(cleaned, "Owner2 Phone"))[0] == "ben ortiz|77009"
    assert engine.person_keys(row, engine.owner_config(cleaned, "Owner1 Phone"))[0] == "ana lopez|75001"


def test_unassigned_phone_is_not_attributed_to_primary_owner_in_multi_owner_rows():
    row, config = sample()
    config["phone_owner_map"] = {"Owner1 Phone": 0}
    knowledge = engine.Knowledge()
    engine.collect(knowledge, [row], config, "source", "Owners")
    assert not knowledge.people.get("+17135554455")
    report = engine.evaluate([row], [2], config, knowledge, "Owners", date.today(), keep_rows=True)
    choice = next(choice for choice in report["_row_results"][0]["choices"] if choice["column"] == "Owner2 Phone")
    assert any("no assigned owner" in warning for warning in choice["warnings"])
    assert engine.person_keys(row, engine.owner_config(config, "Owner2 Phone")) == (None, None)


def test_wrong_person_status_targets_assigned_secondary_owner():
    row, config = sample()
    config["outcome"] = {"column": "Status", "called_column": "Owner2 Phone", "map": {"wrong person": ["wrong_person"]}}
    config = clean_config(config, list(row))
    knowledge = engine.Knowledge()
    engine.collect(knowledge, [row], config, "source", "Owners")
    event = knowledge.events["+17135554455"][0]
    assert event["person_key"] == "ben ortiz|77009" and not event["scope_unknown"]
    config["phone_owner_map"] = {}
    with pytest.raises(ValueError, match="Map name columns"):
        clean_config(config, list(row))


def test_household_evidence_uses_mailing_address_and_not_vacant_property():
    rows = [{"Name": "Ana Lopez", "Phone": "7135553142", "Address": "10 Empty St", "Mail": "20 Home St", "Zip": "77009", "MailZip": "75001", "Vacant": "Yes"},
            {"Name": "Ben Ortiz", "Phone": "7135553142", "Address": "10 Empty St", "Mail": "30 Other St", "Zip": "77009", "MailZip": "75002", "Vacant": "Yes"}]
    config = {"phone_columns": ["Phone"], "name_column": "Name", "region": "US", "address_column": "Address", "zip_column": "Zip", "mailing_address_column": "Mail", "mailing_zip_column": "MailZip", "vacancy_column": "Vacant"}
    assert assessment.shared_context(rows, config, engine)["+17135553142"]["kind"] == "unrelated_people"
    config["mailing_address_column"] = None
    assert assessment.shared_context(rows, config, engine)["+17135553142"]["kind"] == "unrelated_people"


def test_owner_mapping_rejects_missing_columns_and_invalid_associations():
    row, config = sample()
    config["additional_owners"][0]["mailing_city_column"] = "Missing City"
    with pytest.raises(ValueError, match="Unknown owner column"):
        clean_config(config, list(row))
    config["additional_owners"][0]["mailing_city_column"] = None
    config["phone_owner_map"]["Owner1 Phone"] = 3
    with pytest.raises(ValueError, match="valid owner group"):
        clean_config(config, list(row))


def test_owner_config_survives_save_scan_copy_and_person_specific_call_logs(service, tmp_path):
    row, _ = sample()
    path = tmp_path / "owners.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)
    job = wait(service, ok(service, "dataset.import", path=str(path), name="Owners")["job_id"])
    assert job["state"] == "completed"
    dataset = job["result"]["dataset_id"]
    config = ok(service, "skiptrace.suggest", dataset_id=dataset)["config"]
    saved = ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)
    assert saved["additional_owners"][0]["name_column"] == "Owner2 Name"
    assert ok(service, "skiptrace.suggest", dataset_id=dataset)["config"] == saved
    ok(service, "phone.record_outcome", number="+17135554455", outcome="wrong_person", dataset_id=dataset, row_number=2)
    events = ok(service, "phone.outcomes", number="+17135554455")
    assert events[0]["person_key"] == "ben ortiz|77009"
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=saved)["report"]
    choices = json.loads(report["preview"][0]["raw"]["Phone choices"])
    assert next(choice for choice in choices if choice["column"] == "Owner2 Phone")["quality"] == "wrong"
    assert next(choice for choice in choices if choice["column"] == "Owner1 Phone")["quality"] != "wrong"
    result = run(service, "skiptrace.apply", dataset_id=dataset, config=saved, scan_job_id=report["scan_job_id"])
    copy = ok(service, "dataset.rows", dataset_id=result["dataset_id"])
    assert copy[0]["raw"]["Mailing City"] == "Dallas"
