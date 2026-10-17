"""Street travel times and paths from OSRM, with straight-line fallbacks everywhere.

The default host is OSRM's public demo server, which asks for at most one request a second, so
calls here are serialised and spaced, results are cached, and each plan has a call budget. Point
ROUTING_URL at a self-hosted OSRM to lift that; set it to "off" to use straight lines only.
"""
import asyncio
from collections import OrderedDict
import logging
import time
from urllib.parse import quote

import httpx

from app import config
from app.geo.distance import LatLon, km

log = logging.getLogger(__name__)
PUBLIC_HOST = "router.project-osrm.org"
TIMEOUT_S = 8.0
MAX_TABLE = 100                # coordinates per table request on the public server
SPEED_KMH = 25.0               # straight-line fallback: haversine × DETOUR at city speed
DETOUR = 1.3
_lock: asyncio.Lock | None = None
_last = 0.0
_cache: OrderedDict[str, object] = OrderedDict()
CACHE_MAX = 512


def enabled() -> bool:
    return bool(config.ROUTING_URL) and config.ROUTING_URL.lower() != "off"


def interval() -> float:
    if config.ROUTING_MIN_INTERVAL_S is not None:
        return float(config.ROUTING_MIN_INTERVAL_S)
    return 1.0 if PUBLIC_HOST in (config.ROUTING_URL or "") else 0.0


def straight_minutes(a: LatLon, b: LatLon) -> int:
    return round(km(a, b) * DETOUR / SPEED_KMH * 60)


def straight_matrix(points: list[LatLon]) -> list[list[int]]:
    return [[straight_minutes(a, b) for b in points] for a in points]


def _coords(points: list[LatLon]) -> str:
    return ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in points)


async def _get(path: str, params: dict) -> dict:
    """One OSRM GET, cached, serialised and spaced for the public server. Raises on failure."""
    global _lock, _last
    key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    _lock = _lock or asyncio.Lock()
    async with _lock:
        if key in _cache:
            return _cache[key]
        wait = _last + interval() - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": "raightway-dispatch"}) as client:
                response = await client.get(config.ROUTING_URL.rstrip("/") + path, params=params)
        finally:
            _last = time.monotonic()
        response.raise_for_status()
        body = response.json()
        if body.get("code") != "Ok":
            raise RuntimeError(f"OSRM {body.get('code')}: {str(body.get('message', ''))[:120]}")
        _cache[key] = body
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
        return body


async def matrix(points: list[LatLon]) -> tuple[list[list[int]], str]:
    """Integer driving minutes between every pair, and "road" or "straight" for where they came from."""
    if enabled() and 1 < len(points) <= MAX_TABLE:
        try:
            body = await _get(f"/table/v1/driving/{quote(_coords(points), safe=',;.-')}", {"annotations": "duration"})
            durations = body["durations"]
            fallback = straight_matrix(points)
            # Unroutable pairs come back null: keep the straight-line estimate for those.
            return [[round(d / 60) if d is not None else fallback[i][j] for j, d in enumerate(row)]
                    for i, row in enumerate(durations)], "road"
        except Exception as exc:
            log.warning("OSRM table failed (%s); straight-line minutes", config.redact(exc))
    return straight_matrix(points), "straight"


class Candidate:
    def __init__(self, path: list[LatLon], minutes: float, km_: float, legs: list[list[LatLon]]):
        self.path, self.minutes, self.km, self.legs = path, minutes, km_, legs


def straight_path(points: list[LatLon]) -> Candidate:
    legs = [[a, b] for a, b in zip(points, points[1:])]
    return Candidate(list(points), sum(straight_minutes(a, b) for a, b in zip(points, points[1:])),
                     sum(km(a, b) * DETOUR for a, b in zip(points, points[1:])), legs)


def _split_legs(path: list[LatLon], waypoints: list[LatLon]) -> list[list[LatLon]]:
    """Cut a full route line into legs at the vertices nearest each snapped waypoint, in order."""
    cuts, start = [0], 0
    for wp in waypoints[1:-1]:
        best = min(range(start, len(path)), key=lambda i: km(path[i], wp), default=start)
        cuts.append(best)
        start = best
    cuts.append(len(path) - 1)
    return [path[a:b + 1] for a, b in zip(cuts, cuts[1:])]


async def route(points: list[LatLon], alternatives: bool = False) -> list[Candidate]:
    """Road candidates through the points in order (fastest first). Raises when routing is off or fails."""
    if not enabled():
        raise RuntimeError("routing is off")
    params = {"overview": "full", "geometries": "geojson"}
    if alternatives and len(points) == 2:
        params["alternatives"] = "3"
    body = await _get(f"/route/v1/driving/{quote(_coords(points), safe=',;.-')}", params)
    snapped = [(w["location"][1], w["location"][0]) for w in body.get("waypoints", [])]
    out = []
    for r in body["routes"]:
        path = [(lat, lon) for lon, lat in r["geometry"]["coordinates"]]
        out.append(Candidate(path, r["duration"] / 60, r["distance"] / 1000,
                             _split_legs(path, snapped) if len(snapped) == len(points) else [path]))
    if not out:
        raise RuntimeError("OSRM returned no route")
    return out


async def route_or_straight(points: list[LatLon]) -> tuple[Candidate, str]:
    try:
        return (await route(points))[0], "road"
    except Exception as exc:
        if enabled():
            log.warning("OSRM route failed (%s); straight line", config.redact(exc))
        return straight_path(points), "straight"


def maps_urls(points: list[LatLon], per_link: int = 10) -> list[str]:
    """Google Maps driving directions; consumer links take an origin, a destination and ≤8 waypoints."""
    if len(points) < 2:
        return []
    links, start = [], 0
    while start < len(points) - 1:
        chunk = points[start:start + per_link]
        fmt = [f"{lat:.6f},{lon:.6f}" for lat, lon in chunk]
        url = f"https://www.google.com/maps/dir/?api=1&travelmode=driving&origin={fmt[0]}&destination={fmt[-1]}"
        if len(fmt) > 2:
            url += "&waypoints=" + quote("|".join(fmt[1:-1]), safe=",")
        links.append(url)
        start += per_link - 1          # the next link starts where this one ended
    return links
