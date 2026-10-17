"""Road alerts: City of Toronto road restrictions plus the work zones our own footage found.

The city feed (RoDARS, open data) is fetched at most every 15 minutes and kept on disk, so a
dead network still plans with the last copy. Its JSON sometimes carries invalid escapes, which are
repaired before parsing. Dashcam work zones come from canonical `work_zone` issues.

Severity, which decides what routing steers around (>= AVOID_AT) or only warns about (>= WARN_AT):
road closed both ways 5, road closed one way or hazard 4, construction both ways 3, one lane 2.
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import json
import logging
from pathlib import Path
import re
import time

import httpx

from app import config, store
from app.geo.distance import LatLon, covered_m, km, length_m, metres_to_line, segments_near
from app.models import Hazard, RouteWarning

log = logging.getLogger(__name__)
TTL_S = 15 * 60
TIMEOUT_S = 8.0
CACHE_FILE = "road_restrictions.json"
AVOID_AT = 4
WARN_AT = 3
CITY_HIT_M = 15.0          # a path this close to a closed stretch runs along it…
CITY_OVERLAP_M = 60.0      # …for at least this far (or 60% of a short stretch): crossing it covers only ~30 m
DASHCAM_HIT_M = 40.0
SHIFT_HOURS = (8 * 60, 16 * 60)
TORONTO = ZoneInfo("America/Toronto")
_DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_WINDOW = re.compile(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})")
_BAD_ESCAPE = re.compile(r'\\(?!["\\/bfnrtu])')
_city: list[Hazard] = []
_fetched = 0.0


def _severity(kind: str, directions: str) -> int:
    both = directions == "BOTH_DIRECTIONS"
    if kind == "ROAD_CLOSED":
        return 5 if both else 4
    if kind == "HAZARD":
        return 4
    return 3 if both else 2


def in_shift(row: dict, day: str) -> bool:
    """Whether the restriction applies during today's shift. Rows without a schedule count as always on.

    The feed gives scheduleEveryday or schedule<Weekday> as "HH:MM-HH:MM" (overnight windows wrap);
    a row with day schedules but none for today is off today.
    """
    days = {d: row.get(f"schedule{d}") for d in _DAYS}
    window = row.get("scheduleEveryday") or days.get(day)
    if not window:
        return not any(days.values())
    match = _WINDOW.search(str(window))
    if not match:
        return True
    h1, m1, h2, m2 = map(int, match.groups())
    start, end = h1 * 60 + m1, h2 * 60 + m2
    spans = [(start, end)] if start < end else [(start, 24 * 60), (0, end)] if start > end else [(0, 24 * 60)]
    return any(a < SHIFT_HOURS[1] and b > SHIFT_HOURS[0] for a, b in spans)


def _polyline(raw) -> list[LatLon]:
    """geoPolyline is "[lon,lat],[lon,lat],…" (sometimes already a list)."""
    try:
        pairs = json.loads(f"[{raw}]") if isinstance(raw, str) else raw or []
        return [(float(lat), float(lon)) for lon, lat in pairs]
    except (ValueError, TypeError):
        return []


def parse_city(text: str, now_ms: float | None = None) -> list[Hazard]:
    """Restrictions active today and during the shift, from the raw feed text; malformed rows are skipped."""
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    day = _DAYS[datetime.fromtimestamp(now_ms / 1000, TORONTO).weekday()]
    data = json.loads(_BAD_ESCAPE.sub(r"\\\\", text))
    out = []
    for row in data.get("Closure", []) if isinstance(data, dict) else []:
        try:
            start, end = int(row.get("startTime") or 0), int(row.get("endTime") or 0)
            if row.get("expired") or start > now_ms or (end and end < now_ms) or not in_shift(row, day):
                continue
            kind = str(row.get("type") or "CONSTRUCTION")
            schedule = row.get("scheduleEveryday") or row.get("workPeriod")
            out.append(Hazard(
                id=f"city:{row['id']}", source="city", kind=kind, label=str(row.get("name") or row.get("road") or "Road restriction"),
                lat=float(row["latitude"]), lon=float(row["longitude"]), path=_polyline(row.get("geoPolyline")),
                severity=_severity(kind, str(row.get("directionsAffected") or "")),
                detail=" · ".join(str(x) for x in (row.get("directionsAffected", "").replace("_", " ").lower(), schedule,
                                                     row.get("contractor")) if x) or None,
                until=datetime.fromtimestamp(end / 1000, timezone.utc) if end else None))
        except (KeyError, ValueError, TypeError):
            continue
    return out


def _cache_path() -> Path:
    return Path(config.STATE_DIR) / CACHE_FILE


async def city() -> list[Hazard]:
    """Active city restrictions; the last good copy (memory, then disk) when the feed is down."""
    global _city, _fetched
    url = config.ROAD_RESTRICTIONS_URL
    if not url or url.lower() == "off":
        return []
    if _city and time.time() - _fetched < TTL_S:
        return _city
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": "raightway-dispatch"}) as client:
            response = await client.get(url)
        response.raise_for_status()
        _city, _fetched = parse_city(response.text), time.time()
        try:
            path = _cache_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.with_suffix(".tmp").write_text(json.dumps([h.model_dump(mode="json") for h in _city]))
            path.with_suffix(".tmp").replace(path)
        except OSError:
            pass
        log.info("Road restrictions: %d active", len(_city))
    except Exception as exc:
        log.warning("Road restrictions fetch failed (%s); using the last copy", config.redact(exc))
        if not _city:
            try:
                _city = [Hazard.model_validate(h) for h in json.loads(_cache_path().read_text())]
            except (OSError, ValueError):
                _city = []
        _fetched = time.time() - TTL_S + 60      # retry in a minute, not on every request
    return _city


def dashcam() -> list[Hazard]:
    return [Hazard(id=i.id, source="dashcam", kind="work_zone", label=i.description, lat=i.lat, lon=i.lon,
                   severity=i.severity, detail=f"Seen on camera {i.sightings}×")
            for i in store.canonical_issues() if i.category == "work_zone" and getattr(i, "verdict", None) != "rejected" and i.lat is not None and i.lon is not None]


async def near(points: list[LatLon], radius_km: float = 1.5, min_severity: int = WARN_AT) -> list[Hazard]:
    """Hazards worth knowing about within radius_km of any of the points, worst first."""
    if not points:
        return []
    found = [h for h in [*await city(), *dashcam()]
             if h.severity >= min_severity and any(km((h.lat, h.lon), p) <= radius_km for p in points)]
    # The feed often lists one closure per direction or block under the same name: keep the worst.
    seen, out = set(), []
    for h in sorted(found, key=lambda h: (-h.severity, h.source != "dashcam")):
        if h.source == "dashcam" or h.label not in seen:
            seen.add(h.label)
            out.append(h)
    return out


def _box(line: list[LatLon], pad: float = 0.001) -> tuple[float, float, float, float]:
    lats, lons = [p[0] for p in line], [p[1] for p in line]
    return min(lats) - pad, max(lats) + pad, min(lons) - pad, max(lons) + pad


def hits(path: list[LatLon], hazards: list[Hazard], skip: set[str] = frozenset()) -> list[Hazard]:
    """The hazards a path runs through (city stretches within 25 m, dashcam points within 40 m)."""
    if len(path) < 2:
        return []
    s, n, w, e = _box(path)
    out = []
    for h in hazards:
        if h.id in skip or not (s <= h.lat <= n and w <= h.lon <= e):
            continue
        if h.source == "city" and len(h.path) > 1:
            need = min(CITY_OVERLAP_M, 0.6 * length_m(h.path))
            nearby = segments_near(path, _box(h.path, pad=0.0003))
            if covered_m(h.path, nearby, CITY_HIT_M) >= max(need, 1.0):
                out.append(h)
        elif metres_to_line((h.lat, h.lon), path) <= (DASHCAM_HIT_M if h.source == "dashcam" else CITY_HIT_M):
            out.append(h)
    return out


def warnings(hit: list[Hazard], avoided: list[Hazard], limit: int = 8) -> list[RouteWarning]:
    """Avoided closures first, then what is still on the way, worst and dashcam first; one per label."""
    ranked = sorted([*((h, True) for h in avoided), *((h, False) for h in hit)],
                    key=lambda x: (not x[1], -x[0].severity, x[0].source != "dashcam"))
    seen, out = set(), []
    for h, was_avoided in ranked:
        if h.id not in seen and h.label not in seen:
            seen |= {h.id, h.label}
            out.append(RouteWarning(hazard_id=h.id, label=h.label, source=h.source, avoided=was_avoided))
    return out[:limit]
