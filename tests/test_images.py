"""Pictures written into cells, and the free aerial view of a place."""

from __future__ import annotations

import base64
import io

import pytest

from helpers import call, ok
from test_service_skiptrace import make_dataset, service  # noqa: F401
from turf_service import images

# The smallest real PNG: one pixel.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
PNG_B64 = base64.b64encode(PNG).decode()
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200


def padded(text: str) -> str:
    return text + " " * max(0, images.MIN_EMBEDDED - len(text))


def test_pictures_written_into_a_cell_are_found_and_links_are_left_alone():
    assert images.embedded_pictures(padded(f"data:image/png;base64,{PNG_B64}")) == [("png", PNG)]
    two = padded(f"data:image/png;base64,{PNG_B64}\ndata:image/jpeg;base64,{base64.b64encode(JPEG).decode()}")
    assert [kind for kind, _ in images.embedded_pictures(two)] == ["png", "jpg"]
    assert images.embedded_pictures(base64.b64encode(JPEG).decode()) == [("jpg", JPEG)], "bare base64 is known by its start"
    assert images.embedded_pictures(padded(f'<img src="data:image/png;base64,{PNG_B64}">')) == [("png", PNG)]
    assert images.embedded_pictures(padded("https://photos.example.com/a.jpg")) == []
    assert images.embedded_pictures(padded("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")) == [], "an SVG can carry script"
    assert images.embedded_pictures("short") == [] and images.embedded_pictures(12) == []


def test_rows_reach_the_screen_with_a_reference_and_the_picture_is_handed_over_alone(service, tmp_path):
    cell = f"data:image/png;base64,{PNG_B64}" + " " * 100
    dataset = make_dataset(service, tmp_path, "Pictures", [["Ana", "Lopez", "(713) 555-3142", "", "77009", "TX", cell]])
    raw = ok(service, "dataset.rows", dataset_id=dataset)[0]["raw"]
    token = raw["Status"]
    assert token.startswith(images.TOKEN) and len(token) < 60
    picture = ok(service, "images.embedded", name=token)
    assert base64.b64decode(picture["data_url"].split(",", 1)[1]) == PNG
    assert not call(service, "images.embedded", name="../../dataforge.sqlite3")["ok"]
    assert not call(service, "images.embedded", name="0" * 32 + ".png")["ok"]


class FakeResponse(io.BytesIO):
    headers = {"Content-Type": "image/jpeg"}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_the_aerial_view_is_fetched_once_and_kept(monkeypatch):
    asked = []

    def opener(url, timeout):
        asked.append(url)
        return FakeResponse(JPEG)

    first = images.aerial(29.743519, -95.40684, opener=opener, background=False)
    assert first["data_url"].startswith("data:image/jpeg;base64,") and first["credit"] == "USGS aerial"
    assert "bboxSR=4326" in asked[0] and "f=image" in asked[0]
    again = images.aerial(29.743519, -95.40684, opener=opener, background=False)
    assert again == first and len(asked) == 1, "a place is fetched once"
    west, south, east, north = images.aerial_bbox(29.74, -95.4)
    assert round((north - south) * 110_574) == 100 and 140 < (east - west) * 111_320 * 0.8683 < 160
    with pytest.raises(ValueError):
        images.aerial("north", None)


def test_a_failed_aerial_fetch_is_not_retried_at_once():
    def opener(url, timeout):
        raise OSError("offline")

    assert "unavailable" in images.aerial(10.0, 10.0, opener=opener, background=False)
    assert "unavailable" in images.aerial(10.0, 10.0, opener=opener, background=False)
    images._aerial_failed.clear()
