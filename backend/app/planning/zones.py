"""Planning zones: the City's 25 wards (bundled) and areas drawn in the console.

zones_wards.json holds the City of Toronto Open Data "City Wards" (25-ward model) boundaries, simplified
(Douglas-Peucker, ~15 m; outer rings only). Drawn zones live in state/zones.json ({"added": [Zone…]}),
written atomically like the site edits. Point-in-polygon is plain ray casting (no shapely needed); a job is
in a zone set when it is inside any polygon of any zone.
"""
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

from app import config
from app.models import Zone

log = logging.getLogger(__name__)
WARDS_FILE = Path(__file__).with_name("zones_wards.json")
DRAWN = "drawn"                               # id of an inline polygon sent with a request
MAX_POINTS = 200
_lock = threading.RLock()
_cache: tuple[Zone, ...] | None = None
LatLon = tuple[float, float]


def overlay_path() -> Path:
    return config.STATE_DIR / "zones.json"


def wards() -> tuple[Zone, ...]:
    doc = json.loads(WARDS_FILE.read_text())
    return tuple(Zone.model_validate({**z, "source": doc["source"], "source_url": doc.get("source_url")})
                 for z in doc["zones"])


def _read() -> list[dict]:
    try:
        return list(json.loads(overlay_path().read_text()).get("added") or [])
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        log.warning("Drawn zones unreadable (%s); ignoring them", config.redact(exc))
        return []


def _write(added: list[dict]) -> None:
    path = overlay_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".zones-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"added": added}, f)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load() -> tuple[Zone, ...]:
    global _cache
    with _lock:
        if _cache is None:
            drawn = []
            for raw in _read():
                try:
                    drawn.append(Zone.model_validate(raw))
                except ValueError as exc:
                    log.warning("Ignoring a bad drawn zone (%s)", config.redact(exc))
            _cache = wards() + tuple(drawn)
        return _cache


def _invalidate() -> None:
    global _cache
    _cache = None


def get(zone_id: str) -> Zone | None:
    return next((z for z in load() if z.id == zone_id), None)


def clean(polygon: list) -> list[LatLon]:
    """A drawn ring as (lat, lon) points inside Toronto; raises ValueError when it can't be a polygon."""
    from app.planning.facilities import TORONTO_BOX
    lat0, lat1, lon0, lon1 = TORONTO_BOX
    ring = [(round(float(p[0]), 6), round(float(p[1]), 6)) for p in polygon][:MAX_POINTS]
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        raise ValueError("A zone needs at least three points")
    if not all(lat0 <= a <= lat1 and lon0 <= b <= lon1 for a, b in ring):
        raise ValueError("The zone is outside the City of Toronto")
    return ring


def add(label: str, polygon: list) -> Zone:
    with _lock:
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:28] or "zone"
        zone = Zone(id=f"zone-{slug}-{uuid.uuid4().hex[:4]}", label=label.strip()[:80] or "Drawn area", kind="custom",
                    polygons=[clean(polygon)], source="Drawn in the console", custom=True)
        added = _read()
        added.append(zone.model_dump())
        _write(added)
        _invalidate()
        return zone


def update(zone_id: str, label: str | None = None, polygon: list | None = None) -> Zone:
    with _lock:
        added = _read()
        row = next((a for a in added if a.get("id") == zone_id), None)
        if row is None:
            raise KeyError(zone_id)                # wards are official and read-only
        zone = Zone.model_validate(row)
        zone = zone.model_copy(update={k: v for k, v in {"label": (label or "").strip()[:80] or None,
                                                         "polygons": [clean(polygon)] if polygon else None}.items() if v})
        _write([zone.model_dump() if a.get("id") == zone_id else a for a in added])
        _invalidate()
        return zone


def remove(zone_id: str) -> None:
    with _lock:
        added = _read()
        kept = [a for a in added if a.get("id") != zone_id]
        if len(kept) == len(added):
            raise KeyError(zone_id)
        _write(kept)
        _invalidate()


# ---- Geometry ----

def inside(point: LatLon, ring: list[LatLon]) -> bool:
    """Ray casting: is the point inside the ring (lat, lon)? Points on an edge may fall either way."""
    lat, lon = point
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        (ai, oi), (aj, oj) = ring[i], ring[j]
        if (ai > lat) != (aj > lat) and lon < (oj - oi) * (lat - ai) / (aj - ai) + oi:
            hit = not hit
        j = i
    return hit


def bbox(ring: list[LatLon]) -> tuple[float, float, float, float]:
    lats, lons = [p[0] for p in ring], [p[1] for p in ring]
    return min(lats), max(lats), min(lons), max(lons)


class Focus:
    """The union of the chosen zones; `contains` answers point-in-zone quickly (bbox first)."""

    def __init__(self, zones: list[Zone]):
        self.zones = zones
        self.rings = [(bbox(r), r) for z in zones for r in z.polygons if len(r) >= 3]

    @property
    def ids(self) -> list[str]:
        return [z.id for z in self.zones]

    @property
    def labels(self) -> list[str]:
        return [z.label for z in self.zones]

    def contains(self, point: LatLon) -> bool:
        lat, lon = point
        return any(a <= lat <= b and c <= lon <= d and inside(point, ring) for (a, b, c, d), ring in self.rings)


def focus(zone_ids: list[str] | None, polygon: list | None = None) -> Focus | None:
    """The chosen zones (unknown ids ignored) plus an inline drawn polygon, or None for the whole city."""
    chosen = [z for z in (get(i) for i in (zone_ids or [])) if z is not None]
    if polygon:
        chosen.append(Zone(id=DRAWN, label="Drawn area", kind="custom", polygons=[clean(polygon)], source="Drawn in the console"))
    return Focus(chosen) if chosen else None


_ward_focus: list[tuple[Zone, Focus]] | None = None


def ward_of(point: LatLon) -> Zone | None:
    """The official ward a point is in, or None outside the city."""
    global _ward_focus
    if _ward_focus is None:
        _ward_focus = [(z, Focus([z])) for z in wards()]
    return next((z for z, f in _ward_focus if f.contains(point)), None)
