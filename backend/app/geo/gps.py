"""PIE GPS lookups from data/gps.csv (1 Hz rows written by scripts/load_gps.py).

Drives are "setXX/video_YYYY" and t is seconds from that PIE clip's start (frame / 30).
"""
import bisect
import csv
import logging
import math
import os
from pathlib import Path
import re
from threading import Lock

from app import config

log = logging.getLogger(__name__)
DATA_DIR = Path(os.environ.get("CITYMAINT_DATA_DIR") or config.BACKEND_DIR.parent / "data")
GPS_CSV = DATA_DIR / "gps.csv"
EARTH_M = 6371000.0
MAX_GAP_S = 5.0                  # don't interpolate across dropped stretches longer than this
EDGE_S = 1.0                     # tolerance past the first/last 1 Hz row (the clip's last second)
_NAME = re.compile(r"(set\d+)_(video_\d+)_t(\d+(?:\.\d+)?)(?:\.mp4)?", re.IGNORECASE)
_lock = Lock()
_tracks: dict[str, tuple[list[float], list[tuple[float, float, float, float]]]] | None = None
_mtime: float | None = None


def parse_upload_name(filename: str) -> tuple[str, float] | None:
    """"set04_video_0008_t0310.mp4" -> ("set04/video_0008", 310.0); anything else -> None."""
    match = _NAME.fullmatch(Path(str(filename).replace("\\", "/")).name)
    return (f"{match[1].lower()}/{match[2].lower()}", float(match[3])) if match else None


def _stat() -> float | None:
    try:
        return GPS_CSV.stat().st_mtime
    except OSError:
        return None


def _load() -> dict:
    """Loaded once; reloaded only if gps.csv appears or changes (scripts can run while the API is up)."""
    global _tracks, _mtime
    mtime = _stat()
    if _tracks is not None and mtime == _mtime:
        return _tracks
    with _lock:
        if _tracks is not None and mtime == _mtime:
            return _tracks
        _mtime = mtime
        rows: dict[str, list] = {}
        try:
            with GPS_CSV.open(newline="") as f:
                for row in csv.DictReader(f):
                    try:
                        rows.setdefault(row["drive"], []).append(
                            (float(row["t"]), float(row["lat"]), float(row["lon"]),
                             float(row["heading"] or 0), float(row["speed"] or 0)))
                    except (KeyError, TypeError, ValueError):
                        continue
        except OSError as exc:
            if _tracks is None:
                log.warning("GPS unavailable, pins and tracks stay empty (%s)", config.redact(exc))
        tracks = {}
        for drive, points in rows.items():
            points.sort()
            tracks[drive] = ([p[0] for p in points], [p[1:] for p in points])
        if tracks:
            log.info("GPS loaded: %d drives, %d rows", len(tracks), sum(len(t) for t, _ in tracks.values()))
        _tracks = tracks
        return _tracks


def drives() -> list[str]:
    return sorted(_load())


def samples(drive: str, start_s: float, end_s: float) -> list[tuple[float, float, float, float, float]]:
    """Raw 1 Hz rows (t, lat, lon, heading, speed km/h) with start_s <= t <= end_s."""
    track = _load().get(drive)
    if not track:
        return []
    times, points = track
    lo, hi = bisect.bisect_left(times, start_s), bisect.bisect_right(times, end_s)
    return [(times[i], *points[i]) for i in range(lo, hi)]


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return EARTH_M * math.hypot(x, y)


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compass bearing in degrees, clockwise from north."""
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.degrees(math.atan2(x, y)) % 360


def project(lat: float, lon: float, heading: float, metres: float) -> tuple[float, float]:
    b = math.radians(heading)
    lat2 = lat + math.degrees(metres * math.cos(b) / EARTH_M)
    lon2 = lon + math.degrees(metres * math.sin(b) / (EARTH_M * math.cos(math.radians(lat))))
    return lat2, lon2


def _lerp_angle(a: float, b: float, f: float) -> float:
    return (a + ((b - a + 180) % 360 - 180) * f) % 360


def locate(drive: str, t: float, ahead_m: float = 10) -> tuple[float, float, float] | None:
    """(lat, lon, heading) at clip time t, projected ahead_m along the direction of travel.

    The direction is the course over ground when the car moves between the bracketing rows,
    else the logged heading_angle (Verify on the day: its convention is assumed compass degrees).
    """
    track = _load().get(drive) if drive else None
    if not track or t is None or not math.isfinite(t):
        return None
    times, points = track
    if t < times[0] - EDGE_S or t > times[-1] + EDGE_S:
        return None
    i = bisect.bisect_right(times, t)
    if i == 0 or i == len(times):              # inside the edge tolerance: clamp to the end row
        j = 0 if i == 0 else len(times) - 1
        lat, lon, heading = points[j][:3]
        a, b = (j, j + 1) if j + 1 < len(times) else (j - 1, j)
    else:
        a, b = i - 1, i
        if times[b] - times[a] > MAX_GAP_S:
            return None
        f = (t - times[a]) / (times[b] - times[a])
        (lat1, lon1, h1, _), (lat2, lon2, h2, _) = points[a], points[b]
        lat, lon, heading = lat1 + (lat2 - lat1) * f, lon1 + (lon2 - lon1) * f, _lerp_angle(h1, h2, f)
    if 0 <= a < b < len(times) and times[b] - times[a] <= MAX_GAP_S:
        (lat1, lon1, *_), (lat2, lon2, *_) = points[a], points[b]
        if distance_m(lat1, lon1, lat2, lon2) >= 1.0:
            heading = bearing(lat1, lon1, lat2, lon2)
    if ahead_m:
        lat, lon = project(lat, lon, heading, ahead_m)
    return round(lat, 7), round(lon, 7), round(heading, 1)


def track(drive: str, start_s: float, duration_s: float) -> list[tuple[float, float]]:
    """[(lat, lon)] about once a second over [start_s, start_s + duration_s]; [] without GPS."""
    if not drive or not _load().get(drive) or duration_s is None or duration_s < 0:
        return []
    steps = [start_s + k for k in range(int(duration_s) + 1)]
    if steps[-1] < start_s + duration_s:
        steps.append(start_s + duration_s)
    points = []
    for t in steps:
        point = locate(drive, t, ahead_m=0)
        if point and (not points or points[-1] != point[:2]):
            points.append(point[:2])
    return points
