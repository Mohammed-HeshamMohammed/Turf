"""The area around a property, from the US Census."""

from __future__ import annotations

import io
import json

import pytest

from turf_service import area

TRACT = {"result": {"geographies": {"Census Tracts": [{"GEOID": "48201410401", "STATE": "48", "COUNTY": "201", "TRACT": "410401", "NAME": "Census Tract 4104.01"}]}}}
ACS = [["B19013_001E", "B25003_001E", "B25003_002E", "B25077_001E", "B25002_001E", "B25002_003E", "state", "county", "tract"],
       ["87500", "2000", "1200", "-666666666", "2200", "200", "48", "201", "410401"]]


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def census(asked):
    def opener(url, timeout):
        asked.append(url)
        return Answer(json.dumps(TRACT if "geocoder" in url else ACS).encode())
    return opener


def test_the_tract_needs_no_key_and_the_figures_wait_for_one():
    asked = []
    first = area.area_of(29.743519, -95.40684, opener=census(asked), background=False)
    assert first == {"tract": {"geoid": "48201410401", "state": "48", "county": "201", "tract": "410401", "name": "Census Tract 4104.01"}, "figures": None, "needs_key": True}
    assert all("key=" not in url for url in asked) and len(asked) == 1


def test_with_a_key_the_tract_figures_are_read_once():
    asked = []
    area.set_key("a" * 40)
    answer = area.area_of(29.743519, -95.40684, opener=census(asked), background=False)
    assert answer["figures"] == {"year": 2024, "median_income": 87500.0, "median_value": None, "owner_occupied_share": 0.6, "vacant_share": 0.091}
    again = area.area_of(29.74352, -95.40684, opener=census(asked), background=False)
    assert again == answer and len(asked) == 2, "the place and the tract are each asked once"
    assert area.key_status() == {"configured": True}


def test_a_key_must_look_like_one():
    with pytest.raises(ValueError):
        area.set_key("not a key")
    assert area.set_key("") == {"configured": False}
