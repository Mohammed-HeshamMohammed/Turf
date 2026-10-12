"""A property's FEMA flood zone, from the National Flood Hazard Layer (free, no key).

FEMA's service answers connections from the United States only; from elsewhere it closes the connection. Users outside
the US turn on a US VPN on their computer, and the screen tells them so. Only coordinates are sent. Answers are kept in
app data; a failed attempt is not, so "try again" works as soon as the VPN is on.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .projects import app_data_dir

log = logging.getLogger(__name__)

SERVICE = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
NEEDS_US = "FEMA only answers connections from the United States. Turn on a US VPN, then try again."
_lock = threading.Lock()
_pending: set[str] = set()
_failed: dict[str, str] = {}


def _cache_path() -> Path:
    return app_data_dir() / "flood-zones.json"


def _cache() -> dict:
    try:
        return json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _keep(place: str, answer: dict) -> None:
    with _lock:
        cache = _cache()
        cache[place] = answer
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(cache), encoding="utf-8")
        partial.replace(path)


def meaning(zone: str, special: bool) -> dict:
    """What a FEMA zone means for an owner."""
    zone = zone.strip().upper()
    if special or zone.startswith(("A", "V")):
        return {"zone": zone, "risk": "high", "text": f"High-risk flood zone ({zone}): flood insurance is usually required with a mortgage"}
    if zone.startswith("X"):
        return {"zone": zone, "risk": "low", "text": f"Moderate or low flood risk (zone {zone})"}
    if zone == "D":
        return {"zone": zone, "risk": "unknown", "text": "Flood risk not studied here (zone D)"}
    return {"zone": zone, "risk": "unknown", "text": f"Zone {zone}"}


def zone_at(lat: float, lon: float, opener=urllib.request.urlopen) -> dict:
    query = urllib.parse.urlencode({"geometry": f"{lon:.6f},{lat:.6f}", "geometryType": "esriGeometryPoint", "inSR": 4326,
                                    "spatialRel": "esriSpatialRelIntersects", "outFields": "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
                                    "returnGeometry": "false", "f": "json"})
    with opener(f"{SERVICE}?{query}", timeout=60) as response:  # noqa: S310 - fixed https address
        answer = json.loads(response.read().decode("utf-8"))
    if "error" in answer:
        raise ValueError(answer["error"].get("message") or "FEMA answered with an error")
    features = answer.get("features") or []
    if not features:
        return {"zone": "", "risk": "none", "text": "Not in a mapped flood zone"}
    first = features[0].get("attributes") or {}
    return meaning(str(first.get("FLD_ZONE") or ""), str(first.get("SFHA_TF") or "").upper() == "T")


def _why(error: Exception) -> str:
    text = str(error)
    if isinstance(error, (ConnectionResetError, ConnectionRefusedError)) or "10054" in text or "forcibly closed" in text or "reset" in text.lower() \
            or (isinstance(error, urllib.error.HTTPError) and error.code in (403, 451)):
        return NEEDS_US
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)):
        return "FEMA could not be reached. Check the internet connection (and a US VPN, outside the US), then try again."
    return f"FEMA's answer could not be read: {text}"


def flood_of(lat: object, lon: object, force: bool = False, opener=urllib.request.urlopen, background: bool = True) -> dict:
    """{"zone", "risk", "text"} when known, {"pending": true} while asked, or {"unavailable": why}."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ValueError("A place needs a latitude and a longitude") from None
    place = f"{lat:.5f},{lon:.5f}"
    known = _cache().get(place)
    if known:
        return known
    with _lock:
        if place in _failed and not force:
            return {"unavailable": _failed[place]}
        if place in _pending:
            return {"pending": True}
        _failed.pop(place, None)
        _pending.add(place)

    def work() -> None:
        try:
            _keep(place, zone_at(lat, lon, opener))
        except Exception as error:
            log.warning("No flood zone for %s: %s", place, error)
            with _lock:
                _failed[place] = _why(error)
        finally:
            with _lock:
                _pending.discard(place)

    if not background:
        work()
        return flood_of(lat, lon, opener=opener, background=False) if place not in _failed else {"unavailable": _failed[place]}
    threading.Thread(target=work, name="flood-zone", daemon=True).start()
    return {"pending": True}
