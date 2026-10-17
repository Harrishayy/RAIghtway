"""Small-distance geometry on (lat, lon) pairs: haversine, and metres from a point to a polyline."""
import math

LatLon = tuple[float, float]


def km(a: LatLon, b: LatLon) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _xy(p: LatLon, lat0: float) -> tuple[float, float]:
    """Local equirectangular metres; accurate to well under 1% across a city."""
    return math.radians(p[1]) * 6371000 * math.cos(math.radians(lat0)), math.radians(p[0]) * 6371000


def metres_to_segment(p: LatLon, a: LatLon, b: LatLon) -> float:
    lat0 = p[0]
    (px, py), (ax, ay), (bx, by) = _xy(p, lat0), _xy(a, lat0), _xy(b, lat0)
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def metres_to_line(p: LatLon, line: list[LatLon]) -> float:
    if not line:
        return math.inf
    if len(line) == 1:
        return km(p, line[0]) * 1000
    return min(metres_to_segment(p, a, b) for a, b in zip(line, line[1:]))


def length_m(line: list[LatLon]) -> float:
    return sum(km(a, b) for a, b in zip(line, line[1:])) * 1000


def segments_near(path: list[LatLon], box: tuple[float, float, float, float]) -> list[tuple[LatLon, LatLon]]:
    """The path's segments whose bounding box meets `box` (south, north, west, east)."""
    s, n, w, e = box
    return [(a, b) for a, b in zip(path, path[1:])
            if min(a[0], b[0]) <= n and max(a[0], b[0]) >= s and min(a[1], b[1]) <= e and max(a[1], b[1]) >= w]


def covered_m(line: list[LatLon], segments: list[tuple[LatLon, LatLon]], metres: float, step: float = 10.0) -> float:
    """How much of `line` (in metres) lies within `metres` of the segments: sampled every `step` metres."""
    if not segments:
        return 0.0
    covered = 0.0
    for a, b in zip(line, line[1:]):
        seg = km(a, b) * 1000
        n = max(1, int(seg // step))
        points = [(a[0] + (b[0] - a[0]) * (k + 0.5) / n, a[1] + (b[1] - a[1]) * (k + 0.5) / n) for k in range(n)]
        hits = sum(min(metres_to_segment(p, u, v) for u, v in segments) <= metres for p in points)
        covered += seg * hits / n
    return covered
