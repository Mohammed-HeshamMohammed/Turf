"""What the US Census says about the area around a property: its census tract (a few thousand people), and with a free
Census key, the tract's median household income, share of owner-occupied homes, median home value and vacancy.

The tract comes from the Census geocoder, which needs no key. The figures come from the American Community Survey
(5-year estimates) through api.census.gov, which now asks for a key; it is free at api.census.gov/data/key_signup.html.
The key is kept on this computer only, in app data, readable by its owner alone. Only coordinates and the tract are
sent, never names or contacts. Answers are kept in app data, so each place and each tract is asked once; the first
answer comes in the background.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .projects import app_data_dir

log = logging.getLogger(__name__)

GEOGRAPHIES = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"
ACS = "https://api.census.gov/data/{year}/acs/acs5"
ACS_YEARS = (2024, 2023)  # the newest 5-year release first
FIGURES = {
    "B19013_001E": "median_income", "B25003_001E": "occupied", "B25003_002E": "owner_occupied", "B25077_001E": "median_value",
    "B25002_001E": "housing_units", "B25002_003E": "vacant",
}
_lock = threading.Lock()
_pending: set[str] = set()
_failed: dict[str, float] = {}
RETRY_AFTER = 600


# ------------------------------------------------------------------------------------------------------ the key

def _key_file() -> Path:
    return app_data_dir() / "census-settings.json"


def _saved_key() -> str:
    try:
        return str(json.loads(_key_file().read_text("utf-8")).get("key") or "")
    except (OSError, ValueError):
        return ""


def key_status() -> dict:
    return {"configured": bool(_saved_key())}


def set_key(key: object) -> dict:
    """Keeps the person's free Census key (or removes it, given an empty one), readable by this account only."""
    key = str(key or "").strip()
    if key and not re.fullmatch(r"[0-9a-fA-F]{40}", key):
        raise ValueError("A Census key is 40 letters and digits, as in the email from the Census Bureau")
    path = _key_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            json.dump({"key": key}, handle)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    with _lock:
        _failed.clear()
    return key_status()


# ------------------------------------------------------------------------------------------------- the answers

def _cache_path() -> Path:
    return app_data_dir() / "census-areas.json"


def _cache() -> dict:
    try:
        return json.loads(_cache_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {"places": {}, "tracts": {}}


def _store(section: str, key: str, value) -> None:
    with _lock:
        cache = _cache()
        cache.setdefault(section, {})[key] = value
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(cache), encoding="utf-8")
        partial.replace(path)


def _get_json(url: str, opener) -> object:
    with opener(url, timeout=60) as response:  # noqa: S310 - fixed https addresses
        body = response.read().decode("utf-8")
    if not body.lstrip().startswith(("{", "[")):
        raise ValueError("The Census service did not answer with data (is the key right?)")
    return json.loads(body)


def tract_of(lat: float, lon: float, opener=urllib.request.urlopen) -> dict | None:
    query = urllib.parse.urlencode({"x": f"{lon:.6f}", "y": f"{lat:.6f}", "benchmark": "Public_AR_Current", "vintage": "Current_Current",
                                    "layers": "Census Tracts", "format": "json"})
    answer = _get_json(f"{GEOGRAPHIES}?{query}", opener)
    tracts = (answer.get("result", {}).get("geographies", {}) or {}).get("Census Tracts") or []
    if not tracts:
        return None
    tract = tracts[0]
    return {"geoid": tract["GEOID"], "state": tract["STATE"], "county": tract["COUNTY"], "tract": tract["TRACT"], "name": tract.get("NAME", "")}


def figures_of(tract: dict, key: str, opener=urllib.request.urlopen) -> dict:
    last_error: Exception | None = None
    for year in ACS_YEARS:
        query = urllib.parse.urlencode({"get": ",".join(FIGURES), "for": f"tract:{tract['tract']}", "in": f"state:{tract['state']} county:{tract['county']}", "key": key})
        try:
            rows = _get_json(f"{ACS.format(year=year)}?{query}", opener)
        except Exception as error:  # this year's release may not be out; try the one before
            last_error = error
            continue
        header, values = rows[0], rows[1]
        raw = {FIGURES[name]: values[header.index(name)] for name in FIGURES}
        number = lambda value: float(value) if value not in (None, "") and float(value) >= 0 else None  # noqa: E731 - -666666666 means no estimate
        figures = {name: number(value) for name, value in raw.items()}
        share = lambda part, whole: round(part / whole, 3) if part is not None and whole else None  # noqa: E731
        return {
            "year": year, "median_income": figures["median_income"], "median_value": figures["median_value"],
            "owner_occupied_share": share(figures["owner_occupied"], figures["occupied"]), "vacant_share": share(figures["vacant"], figures["housing_units"]),
        }
    raise ValueError(str(last_error) if last_error else "No Census figures for this tract")


def area_of(lat: object, lon: object, opener=urllib.request.urlopen, background: bool = True) -> dict:
    """{"tract", "figures", "needs_key"} for a place when known, else {"pending": true} while it is asked in the background,
    or {"unavailable": reason}."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ValueError("A place needs a latitude and a longitude") from None
    place = f"{lat:.4f},{lon:.4f}"
    key = _saved_key()
    cache = _cache()
    tract = cache["places"].get(place)
    if place in cache["places"]:
        if tract is None:
            return {"unavailable": "The Census has no tract for this place"}
        if not key:
            return {"tract": tract, "figures": None, "needs_key": True}
        figures = cache["tracts"].get(tract["geoid"])
        if figures:
            return {"tract": tract, "figures": figures, "needs_key": False}
    with _lock:
        failed = _failed.get(place)
        if failed and time.time() - failed < RETRY_AFTER:
            return {"unavailable": "The Census could not be reached; it is tried again later"}
        if place in _pending:
            return {"pending": True}
        _pending.add(place)

    def work() -> None:
        try:
            found = _cache()["places"].get(place) if place in _cache()["places"] else tract_of(lat, lon, opener)
            _store("places", place, found)
            if found and key and not _cache()["tracts"].get(found["geoid"]):
                _store("tracts", found["geoid"], figures_of(found, key, opener))
        except Exception as error:
            log.warning("No Census area for %s: %s", place, error)
            with _lock:
                _failed[place] = time.time()
        finally:
            with _lock:
                _pending.discard(place)

    if not background:
        work()
        with _lock:
            failed = place in _failed
        return {"unavailable": "The Census could not be reached"} if failed else area_of(lat, lon, opener, background=False)
    threading.Thread(target=work, name="census-area", daemon=True).start()
    return {"pending": True}
