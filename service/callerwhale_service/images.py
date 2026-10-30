"""Pictures of properties: ones stored inside a list's cells, and a free aerial view when a list has none.

A list may carry its pictures as links (handled on the screen) or as the picture itself, written into the cell as a
`data:image/...;base64,...` value or bare base64. Such a cell can be hundreds of kilobytes, and the screen reads every
row, so rows on their way to the screen carry a short reference instead (`callerwhale-image:<name>`); the picture is saved
once in the project's `artifacts/images` folder and handed over on its own when shown. The list's own rows are never
changed: downloads and exports read them as imported.

The aerial view is USGS NAIP orthoimagery (public domain, no key): the property from above, about 0.6 m per pixel.
It is fetched in the background, because the first request for a place can take several seconds, and kept on this
computer so each place is fetched once. Only the coordinates are sent.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import math
import re
import threading
import time
import urllib.request
from pathlib import Path

from .projects import app_data_dir
from .storage import ProjectStore

log = logging.getLogger(__name__)

TOKEN = "callerwhale-image:"
# Raster formats only: an SVG can carry script, so it is never accepted.
_MIME = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
_DATA_URI = re.compile(r"data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})", re.IGNORECASE)
_SIGNATURES = (("/9j/", "jpg"), ("iVBORw0KGgo", "png"), ("R0lGOD", "gif"), ("UklGR", "webp"))
_BARE = re.compile(r"^[A-Za-z0-9+/=\s]+$")
_NAME = re.compile(r"^[0-9a-f]{32}\.(png|jpg|gif|webp)$")
MIN_EMBEDDED = 120  # shorter cells are never pictures


def _decode(text: str) -> bytes | None:
    try:
        return base64.b64decode(re.sub(r"\s+", "", text), validate=True)
    except (binascii.Error, ValueError):
        return None


def embedded_pictures(value: object) -> list[tuple[str, bytes]]:
    """The pictures written into a cell, as (extension, bytes). Links are not pictures here; the screen handles them."""
    if not isinstance(value, str) or len(value) < MIN_EMBEDDED:
        return []
    found = []
    for match in _DATA_URI.finditer(value):
        data = _decode(match.group(2))
        if data:
            kind = match.group(1).lower().replace("jpeg", "jpg")
            found.append((kind, data))
    if found:
        return found
    text = value.strip()
    for signature, kind in _SIGNATURES:
        if text.startswith(signature) and _BARE.match(text):
            data = _decode(text)
            return [(kind, data)] if data else []
    return []


def _images_dir(store: ProjectStore) -> Path:
    return store.project_root / "artifacts" / "images"


def _save(store: ProjectStore, kind: str, data: bytes) -> str:
    name = f"{hashlib.sha256(data).hexdigest()[:32]}.{kind}"
    target = _images_dir(store) / name
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(target.suffix + ".part")
        partial.write_bytes(data)
        partial.replace(target)
    return name


def for_screen(store: ProjectStore, raw: dict) -> dict:
    """A row with each picture written into a cell replaced by a reference to its saved copy."""
    changed = None
    for column, value in raw.items():
        pictures = embedded_pictures(value)
        if pictures:
            changed = changed or dict(raw)
            changed[column] = "\n".join(TOKEN + _save(store, kind, data) for kind, data in pictures)
    return changed or raw


def embedded(store: ProjectStore, name: object) -> dict:
    """One saved picture, as a data URL the screen can show."""
    name = str(name).removeprefix(TOKEN)
    if not _NAME.match(name):
        raise ValueError("Not a picture saved by Caller Whale")
    path = _images_dir(store) / name
    if not path.is_file():
        raise ValueError("This picture is no longer in the project")
    kind = name.rsplit(".", 1)[1]
    return {"data_url": f"data:{_MIME[kind]};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"}


# ------------------------------------------------------------------------------------------------- aerial view

AERIAL_SERVICE = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
AERIAL_SIZE = (480, 320)
AERIAL_SPAN_M = (150.0, 100.0)  # width and height of ground shown: the lot and its neighbours
RETRY_AFTER = 600
_aerial_lock = threading.Lock()
_aerial_jobs: dict[str, float] = {}     # place -> when its fetch started
_aerial_failed: dict[str, float] = {}   # place -> when its fetch failed


def _aerial_dir() -> Path:
    return app_data_dir() / "aerial"


def _place(lat: float, lon: float) -> str:
    return f"{lat:.5f}_{lon:.5f}"


def aerial_bbox(lat: float, lon: float) -> tuple[float, float, float, float]:
    """The box of ground around a point, in degrees: west, south, east, north."""
    half_w = AERIAL_SPAN_M[0] / 2 / (111_320 * max(0.2, math.cos(math.radians(lat))))
    half_h = AERIAL_SPAN_M[1] / 2 / 110_574
    return lon - half_w, lat - half_h, lon + half_w, lat + half_h


def _fetch_aerial(lat: float, lon: float, target: Path, opener=urllib.request.urlopen) -> None:
    west, south, east, north = aerial_bbox(lat, lon)
    query = (f"?bbox={west:.6f},{south:.6f},{east:.6f},{north:.6f}&bboxSR=4326&imageSR=3857"
             f"&size={AERIAL_SIZE[0]},{AERIAL_SIZE[1]}&format=jpg&f=image")
    with opener(AERIAL_SERVICE + query, timeout=60) as response:  # noqa: S310 - fixed https address
        data = response.read()
        kind = response.headers.get("Content-Type", "") if hasattr(response, "headers") else "image/jpeg"
    if not data.startswith(b"\xff\xd8") or "image" not in kind:
        raise ValueError("The aerial service did not send a picture")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    partial.write_bytes(data)
    partial.replace(target)


def aerial(lat: object, lon: object, opener=urllib.request.urlopen, background: bool = True) -> dict:
    """The aerial picture of a place: {"data_url"} when it is on this computer, else {"pending": true} while it is
    fetched in the background, or {"unavailable": reason}."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ValueError("A place needs a latitude and a longitude") from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("A place needs a latitude and a longitude")
    place = _place(lat, lon)
    target = _aerial_dir() / f"{place}.jpg"
    if target.is_file():
        return {"data_url": "data:image/jpeg;base64," + base64.b64encode(target.read_bytes()).decode("ascii"), "credit": "USGS aerial"}
    with _aerial_lock:
        failed = _aerial_failed.get(place)
        if failed and time.time() - failed < RETRY_AFTER:
            return {"unavailable": "The aerial view could not be fetched; it is tried again later"}
        if place in _aerial_jobs:
            return {"pending": True}
        _aerial_jobs[place] = time.time()

    def work() -> None:
        try:
            _fetch_aerial(lat, lon, target, opener)
        except Exception as error:  # offline, a proxy, no imagery there: the screen shows a plain icon
            log.warning("No aerial view for %s: %s", place, error)
            with _aerial_lock:
                _aerial_failed[place] = time.time()
        finally:
            with _aerial_lock:
                _aerial_jobs.pop(place, None)

    if not background:
        work()
        return aerial(lat, lon, opener, background=False) if target.is_file() else {"unavailable": "The aerial view could not be fetched"}
    threading.Thread(target=work, name="aerial-view", daemon=True).start()
    return {"pending": True}
