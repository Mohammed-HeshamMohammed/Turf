"""Where a list's rows are on the map.

Two sources, both from the US Census Bureau:

- The centre of a row's ZIP code, from a file shipped with Turf (data/zip_centres.csv, built by
  tools/build_zip_centres.py). Works offline. The file also says which state or states each ZIP lies in, so a row
  whose ZIP and state disagree can be left off the map.
- The exact address, from the Bureau's public geocoder. This sends street, city, state and ZIP (never names or phone
  numbers) over the internet, so it only runs when the person asks for it. An answer is kept only when the geocoder
  matched the address and its match is in the same state and ZIP as the row. Answers are remembered in the project
  folder (turf/geocodes.json), by address, so a list made from another needs nothing looked up again.

This file is Turf's own; it is not a copy from DataForge.
"""

from __future__ import annotations

import csv
import io
import json
import re
import urllib.parse
import urllib.request
import uuid
from functools import lru_cache
from pathlib import Path

from .jobs import JobContext, JobKind, JobValidationError
from .projects import app_data_dir
from .storage import ProjectStore

GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
BENCHMARK = "Public_AR_Current"
# The geocoder takes up to 10,000 addresses a request. Smaller requests answer sooner, show progress, and lose less
# when one fails.
BATCH = 1000
TIMEOUT_SECONDS = 600


# ---------------------------------------------------------------- ZIP centres

@lru_cache(maxsize=1)
def _centres() -> dict[str, tuple[float, float, tuple[str, ...]]]:
    path = Path(__file__).resolve().parent / "data" / "zip_centres.csv"
    centres = {}
    with path.open(encoding="utf-8", newline="") as handle:
        for zip_code, latitude, longitude, states in csv.reader(handle):
            centres[zip_code] = (float(latitude), float(longitude), tuple(states.split("|")))
    return centres


def normal_zip(value: object) -> str | None:
    """The five-digit ZIP in a value, or None. A ZIP+4 loses its last four; a ZIP a spreadsheet stripped of leading zeros gets them back."""
    text = str(value if value is not None else "").strip()
    match = re.match(r"^(\d{3,5})(?:\.0+)?(?:-\d{4})?$", text)
    if not match:
        long_form = re.match(r"^(\d{5})\d{4}$", text)
        return long_form.group(1) if long_form else None
    return match.group(1).zfill(5)


def zip_centres(zips: list[object]) -> dict[str, dict]:
    """The centre and states of each ZIP asked for that the file knows. Keys are the values as they were sent."""
    centres = _centres()
    found = {}
    for value in zips:
        centre = centres.get(normal_zip(value) or "")
        if centre:
            found[str(value)] = {"lat": centre[0], "lon": centre[1], "states": list(centre[2])}
    return found


# ---------------------------------------------------------------- ZIP outlines

# The Census Bureau's map service, which gives the outline of a ZIP Code Tabulation Area. Only ZIP codes are sent.
OUTLINES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query"
# Outlines are smoothed to about 30 metres and five decimal places: plenty for a map, a fraction of the size.
OUTLINE_DETAIL = {"geometryPrecision": "5", "maxAllowableOffset": "0.0003"}
OUTLINE_BATCH = 40


def _outline_dir() -> Path:
    path = app_data_dir() / "map" / "outlines"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _fetch_outlines(zips: list[str]) -> dict[str, dict]:
    """Asks the map service for the outlines of some ZIPs. Returns the ones it has."""
    query = {"where": "ZCTA5 IN (" + ",".join(f"'{zip_code}'" for zip_code in zips) + ")", "outFields": "ZCTA5", "f": "geojson", **OUTLINE_DETAIL}
    request = urllib.request.Request(OUTLINES, data=urllib.parse.urlencode(query).encode("utf-8"))
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed https address
        answer = json.loads(response.read().decode("utf-8"))
    return {feature["properties"]["ZCTA5"]: feature["geometry"] for feature in answer.get("features", []) if feature.get("geometry")}


def zip_outlines(zips: list[object]) -> dict:
    """The outline of each ZIP asked for, by the value as it was sent.

    An outline is fetched once and then kept on this computer (in Turf's own folder, shared by every project), so
    the map can draw areas it has shown before without a connection. `unavailable` counts the ZIPs that could not
    be fetched this time; a ZIP the service has no outline for is remembered as such and not asked for again.
    """
    folder = _outline_dir()
    wanted: dict[str, list[str]] = {}
    for value in zips:
        zip_code = normal_zip(value)
        if zip_code and zip_code in _centres():
            wanted.setdefault(zip_code, []).append(str(value))
    outlines: dict[str, dict] = {}
    missing = []
    for zip_code in wanted:
        try:
            outlines[zip_code] = json.loads((folder / f"{zip_code}.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            missing.append(zip_code)
    unavailable = 0
    for start in range(0, len(missing), OUTLINE_BATCH):
        batch = missing[start:start + OUTLINE_BATCH]
        try:
            fetched = _fetch_outlines(batch)
        except (OSError, ValueError):
            unavailable += len(batch)
            continue
        for zip_code in batch:
            outlines[zip_code] = fetched.get(zip_code)  # None: the service has no outline for it
            (folder / f"{zip_code}.json").write_text(json.dumps(outlines[zip_code], separators=(",", ":")), encoding="utf-8")
    return {
        "outlines": {value: outlines[zip_code] for zip_code, values in wanted.items() if outlines.get(zip_code) for value in values},
        "unavailable": unavailable,
    }


# ---------------------------------------------------------------- exact addresses

def _clean(value: object) -> str:
    return " ".join(str(value if value is not None else "").split())


def _address(raw: dict, columns: dict) -> tuple[str, str, str, str] | None:
    """Street, city, state and ZIP of a row, or None when there is not enough of an address to look up."""
    street = _clean(raw.get(columns.get("street") or ""))
    city = _clean(raw.get(columns.get("city") or ""))
    state = _clean(raw.get(columns.get("state") or "")).upper()
    zip_code = normal_zip(raw.get(columns.get("zip") or "")) or ""
    if not street or not (zip_code or (city and state)):
        return None
    return street, city, state, zip_code


def _key(address: tuple[str, str, str, str]) -> str:
    return "|".join(part.casefold() for part in address)


def _cache_path(store: ProjectStore) -> Path:
    return store.database_path.parent / "turf" / "geocodes.json"


def _load_cache(store: ProjectStore) -> dict[str, list[float] | None]:
    try:
        return json.loads(_cache_path(store).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _save_cache(store: ProjectStore, cache: dict) -> None:
    path = _cache_path(store)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Written beside the file and renamed, so a crash cannot leave half a file.
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def _rows(store: ProjectStore, dataset_id: str) -> list[tuple[int, dict]]:
    found = store._connection.execute("SELECT source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ? ORDER BY source_row_number", (dataset_id,))
    return [(row["source_row_number"], json.loads(row["raw_values_json"])) for row in found]


def located(store: ProjectStore, dataset_id: str, columns: dict) -> dict:
    """What is already known about a list's addresses: the rows with an exact place, and how many addresses are still to look up."""
    cache = _load_cache(store)
    exact, waiting, without, missing = {}, set(), 0, []
    for number, raw in _rows(store, dataset_id):
        address = _address(raw, columns)
        if address is None:
            without += 1
            continue
        key = _key(address)
        if key not in cache:
            waiting.add(key)
        elif cache[key] is not None:
            exact[str(number)] = cache[key]
        else:
            missing.append(number)  # looked up, and the geocoder did not find it
    return {"exact": exact, "addresses_to_look_up": len(waiting), "rows_without_an_address": without, "not_found": missing}


def _send_batch(batch: list[tuple[str, tuple[str, str, str, str]]]) -> str:
    """Posts one batch to the geocoder and returns its CSV answer."""
    body = io.StringIO()
    csv.writer(body).writerows([identifier, *address] for identifier, address in batch)
    boundary = uuid.uuid4().hex
    parts = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\n{BENCHMARK}\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="addresses.csv"\r\nContent-Type: text/csv\r\n\r\n{body.getvalue()}\r\n'
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    request = urllib.request.Request(GEOCODER, data=parts, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https address
        return response.read().decode("utf-8", errors="replace")


def _read_answer(answer: str, sent: dict[str, tuple[str, str, str, str]]) -> dict[str, list[float] | None]:
    """Keeps a place only when the geocoder matched the address in the same state and ZIP as the row gave."""
    places: dict[str, list[float] | None] = {identifier: None for identifier in sent}
    for line in csv.reader(io.StringIO(answer)):
        if len(line) < 6 or line[0] not in sent or line[2] != "Match":
            continue
        _, _, state, zip_code = sent[line[0]]
        matched = [part.strip() for part in line[4].split(",")]
        if len(matched) < 4 or (state and matched[-2].upper() != state) or (zip_code and matched[-1] != zip_code):
            continue
        try:
            longitude, latitude = (float(part) for part in line[5].split(","))
        except ValueError:
            continue
        places[line[0]] = [round(latitude, 6), round(longitude, 6)]
    return places


def _validate(store: ProjectStore, params: dict) -> dict:
    if store._connection.execute("SELECT 1 FROM datasets WHERE id = ?", (params.get("dataset_id"),)).fetchone() is None:
        raise JobValidationError("List not found")
    columns = params.get("columns")
    if not isinstance(columns, dict) or not columns.get("street"):
        raise JobValidationError("Say which column holds the street address")
    if not (columns.get("zip") or (columns.get("city") and columns.get("state"))):
        raise JobValidationError("An address needs a ZIP column, or a city and a state column")
    return params


def _run_locate(context: JobContext) -> dict:
    store, columns = context.store, context.params["columns"]
    cache = _load_cache(store)
    waiting: dict[str, tuple[str, str, str, str]] = {}
    for _, raw in _rows(store, context.params["dataset_id"]):
        address = _address(raw, columns)
        if address is not None and _key(address) not in cache:
            waiting.setdefault(_key(address), address)
    todo = list(waiting.items())
    found = 0
    context.stage("locating_addresses", {"done": 0, "total": len(todo), "found": 0})
    for start in range(0, len(todo), BATCH):
        context.checkpoint()
        batch = todo[start:start + BATCH]
        # The geocoder gets a short number for each address, not the address key.
        sent = {str(index): address for index, (_, address) in enumerate(batch)}
        places = _read_answer(_send_batch(list(sent.items())), sent)
        for index, (key, _) in enumerate(batch):
            cache[key] = places[str(index)]
            found += places[str(index)] is not None
        _save_cache(store, cache)
        context.stage("locating_addresses", {"done": start + len(batch), "total": len(todo), "found": found})
    return {"looked_up": len(todo), "found": found, "not_found": len(todo) - found}


LOCATE_JOB = JobKind(run=_run_locate, validate=_validate)
