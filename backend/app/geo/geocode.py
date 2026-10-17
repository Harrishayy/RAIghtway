"""Address -> point inside Toronto, for placing a new site (OSM Nominatim).

Nominatim's usage policy: at most one request a second, a real User-Agent, cache results. Calls here
are serialised and spaced, results are cached in memory, and the search is bounded to Toronto.
"""
import asyncio
import time

import httpx

URL = "https://nominatim.openstreetmap.org/search"
VIEWBOX = "-79.64,43.86,-79.11,43.58"        # west, north, east, south: the City of Toronto
_lock: asyncio.Lock | None = None
_last = 0.0
_cache: dict[str, dict | None] = {}


async def search(query: str) -> dict | None:
    """{lat, lon, label} for the best match in Toronto, or None. Raises when the service fails."""
    global _lock, _last
    q = " ".join(query.split())[:200]
    if not q:
        return None
    if q.lower() in _cache:
        return _cache[q.lower()]
    _lock = _lock or asyncio.Lock()
    async with _lock:
        wait = _last + 1.1 - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": "raightway-dispatch (sites tab)"}) as c:
                response = await c.get(URL, params={"q": q if "toronto" in q.lower() else f"{q}, Toronto",
                                                    "format": "json", "limit": 1, "countrycodes": "ca",
                                                    "viewbox": VIEWBOX, "bounded": 1})
        finally:
            _last = time.monotonic()
        response.raise_for_status()
        rows = response.json()
    hit = ({"lat": round(float(rows[0]["lat"]), 5), "lon": round(float(rows[0]["lon"]), 5),
            "label": str(rows[0].get("display_name", q))[:200]} if rows else None)
    _cache[q.lower()] = hit
    return hit
