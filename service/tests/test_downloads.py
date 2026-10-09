"""Recovery downloads retain exact uploads and every saved checked version."""
import base64
import csv
import io
import json
import zipfile

import pytest

from helpers import call, ok, wait
from test_service_skiptrace import FILE_A, confirmed, make_dataset, run, service  # noqa: F401


def download(service, dataset, version):
    info = ok(service, "dataset.download", dataset_id=dataset, version=version)
    parts = []
    offset = 0
    while offset < info["size"]:
        data = base64.b64decode(ok(service, "dataset.download_chunk", dataset_id=dataset, version=version, hash=info["hash"], offset=offset)["data"])
        assert data
        parts.append(data)
        offset += len(data)
    return info, b"".join(parts)


def test_original_exact_bytes_after_local_loss_and_project_reopen(service, tmp_path):
    path = tmp_path / "original.CSV"
    original = b'\xef\xbb\xbfName,Phone,Blank\r\n"Ana, Lopez",7135553142,\r\n,,\r\n'
    path.write_bytes(original)
    dataset = run(service, "dataset.import", path=str(path))["dataset_id"]
    path.unlink()
    root = service.project["root_path"]
    ok(service, "project.open", path=root)
    info, recovered = download(service, dataset, "original")
    assert info["filename"] == "original.CSV" and recovered == original
    # The full upload is recoverable even though empty cells/rows were tidied on import.
    assert len(ok(service, "dataset.rows", dataset_id=dataset)) == 1


def test_each_version_stays_downloadable_and_original_survives_parent_deletion(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Sources", FILE_A)
    original = (tmp_path / "Sources.csv").read_bytes()
    config = confirmed(service, dataset)
    first = run(service, "skiptrace.apply", dataset_id=dataset, config=config, name="Version one")["dataset_id"]
    first_info, first_bytes = download(service, first, "checked")
    ok(service, "marks.set", number="+17135553142", mark="do_not_call")
    second = run(service, "skiptrace.apply", dataset_id=dataset, config=config, name="Version two")["dataset_id"]
    second_info, second_bytes = download(service, second, "checked")
    assert first_bytes != second_bytes
    assert first_info["filename"] == "Version one.csv" and second_info["filename"] == "Version two.csv"
    ok(service, "project.open", path=service.project["root_path"])
    assert download(service, first, "checked")[1] == first_bytes
    for copy in (first, second):
        parsed = list(csv.DictReader(io.StringIO(download(service, copy, "checked")[1].decode("utf-8-sig"))))
        stored = ok(service, "dataset.rows", dataset_id=copy)
        assert len(parsed) == len(FILE_A)
        assert set(parsed[0]) == set(stored[0]["raw"])
        assert parsed == [{key: "" if value is None else str(value) for key, value in row["raw"].items()} for row in stored]
    ok(service, "dataset.delete", dataset_id=dataset)
    assert download(service, first, "original")[1] == original
    assert download(service, second, "original")[1] == original


def test_old_checked_copies_use_retained_snapshot_without_retracing(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, "Older", FILE_A)
    copy = run(service, "skiptrace.apply", dataset_id=dataset, config=confirmed(service, dataset), name="Old copy")["dataset_id"]
    expected = download(service, copy, "checked")[1]
    row = service.store._connection.execute("SELECT derivation_json FROM datasets WHERE id=?", (copy,)).fetchone()
    derivation = json.loads(row[0])
    derivation.pop("checked_file")
    derivation.pop("original_file")
    with service.store._connection:
        service.store._connection.execute("UPDATE datasets SET derivation_json=? WHERE id=?", (json.dumps(derivation), copy))
    from turf_service import skiptrace
    monkeypatch.setattr(skiptrace, "_evaluate", lambda *args, **kwargs: pytest.fail("Downloads must not retrace"))
    assert download(service, copy, "checked")[1] != b""
    parsed = lambda content: list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
    assert parsed(download(service, copy, "checked")[1]) == parsed(expected)
    assert download(service, copy, "original")[1] == (tmp_path / "Older.csv").read_bytes()


def test_archive_original_returns_entire_zip(service, tmp_path):
    path = tmp_path / "input.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("input.csv", "Name,Phone\nAna,7135553142\n")
        archive.writestr("notes.txt", "Keep this too")
    original = path.read_bytes()
    dataset = run(service, "dataset.import", path=str(path))["dataset_id"]
    path.unlink()
    assert download(service, dataset, "original")[1] == original


def test_chunk_bounds_integrity_and_desktop_save(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Download", FILE_A)
    info, original = download(service, dataset, "original")
    for changes in ({"hash": "0" * 64}, {"offset": -1}, {"offset": info["size"] + 1}):
        response = call(service, "dataset.download_chunk", **{"dataset_id": dataset, "version": "original", "hash": info["hash"], "offset": 0, **changes})
        assert not response["ok"]
    target = tmp_path / "recovered.csv"
    ok(service, "dataset.download_save", dataset_id=dataset, version="original", hash=info["hash"], path=str(target))
    assert target.read_bytes() == original
    protected = call(service, "dataset.download_save", dataset_id=dataset, version="original", hash=info["hash"], path=str(service.store.database_path))
    assert not protected["ok"]
    path = service.store.project_root / "artifacts" / "sha256" / info["hash"][:2] / (info["hash"] + ".csv")
    path.write_bytes(b"corrupted")
    assert "integrity" in call(service, "dataset.download", dataset_id=dataset, version="original")["error"]["message"]
    path.unlink()
    assert "missing" in call(service, "dataset.download", dataset_id=dataset, version="original")["error"]["message"]


def test_large_original_is_transferred_in_bounded_chunks(service, tmp_path):
    path = tmp_path / "large.csv"
    original = b"Name,Phone\n" + b"Ana,7135553142\n" + b"\n" * (1024 * 1024 + 10)
    path.write_bytes(original)
    dataset = run(service, "dataset.import", path=str(path))["dataset_id"]
    info, recovered = download(service, dataset, "original")
    assert recovered == original
    first = ok(service, "dataset.download_chunk", dataset_id=dataset, version="original", hash=info["hash"], offset=0)
    assert len(base64.b64decode(first["data"])) == 1024 * 1024
