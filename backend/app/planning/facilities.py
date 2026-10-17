"""City operating sites crews leave from and return to, and the console's edits to them.

The bundled list (facilities.json) holds real City of Toronto sites with a source for each: Solid Waste
transfer stations and collection yards for sanitation, Transportation Services road-operations yards for
roads, markings, signage and work-zone inspection, and street-cleaning yards for litter and graffiti. Any
site marked `assumed` is a stand-in and says so. FACILITIES_FILE swaps in a different bundled list.

Edits from the Sites tab live in state/facilities.json, layered over the bundled list:
  {"added": [Facility…], "edited": {id: {field: value}}, "removed": [id…]}
so removing a bundled site is remembered across restarts, and reset() brings the bundled list back.
Writes are atomic (temp file, then rename).
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
from app.geo.distance import km
from app.models import Crew, Facility

log = logging.getLogger(__name__)
DEFAULT_FILE = Path(__file__).with_name("facilities.json")
EDITABLE = {"label", "kind", "crews", "lat", "lon", "address", "source", "source_url", "note", "vehicles", "assumed"}
MAX_VEHICLES = 20                     # per site and crew type, per day
# Greater Toronto: a site outside this box is almost certainly a geocoding mistake.
TORONTO_BOX = (43.55, 43.88, -79.70, -79.08)
_lock = threading.RLock()
_cache: tuple[Facility, ...] | None = None


def overlay_path() -> Path:
    return config.STATE_DIR / "facilities.json"


def bundled() -> tuple[Facility, ...]:
    path = Path(config.FACILITIES_FILE) if config.FACILITIES_FILE else DEFAULT_FILE
    try:
        return tuple(Facility.model_validate(f) for f in json.loads(path.read_text()))
    except (OSError, ValueError) as exc:
        log.warning("Facilities file unreadable (%s); using the bundled list", config.redact(exc))
        return tuple(Facility.model_validate(f) for f in json.loads(DEFAULT_FILE.read_text()))


def _read_overlay() -> dict:
    try:
        data = json.loads(overlay_path().read_text())
        return {"added": list(data.get("added") or []), "edited": dict(data.get("edited") or {}),
                "removed": list(data.get("removed") or [])}
    except FileNotFoundError:
        return {"added": [], "edited": {}, "removed": []}
    except (OSError, ValueError) as exc:
        log.warning("Site edits unreadable (%s); ignoring them", config.redact(exc))
        return {"added": [], "edited": {}, "removed": []}


def _write_overlay(data: dict) -> None:
    path = overlay_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".facilities-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _merge(base: tuple[Facility, ...], overlay: dict) -> tuple[Facility, ...]:
    removed = set(overlay["removed"])
    out = []
    for f in base:
        if f.id in removed:
            continue
        patch = overlay["edited"].get(f.id)
        if patch:
            try:
                f = Facility.model_validate({**f.model_dump(), **{k: v for k, v in patch.items() if k in EDITABLE}})
            except ValueError as exc:
                log.warning("Ignoring a bad edit to %s (%s)", f.id, config.redact(exc))
        out.append(f)
    for raw in overlay["added"]:
        try:
            f = Facility.model_validate(raw)
        except ValueError as exc:
            log.warning("Ignoring a bad added site (%s)", config.redact(exc))
            continue
        if f.id not in removed:
            out.append(f)
    return tuple(out)


def load() -> tuple[Facility, ...]:
    """Every site in use: the bundled list with the console's edits applied."""
    global _cache
    with _lock:
        if _cache is None:
            _cache = _merge(bundled(), _read_overlay())
        return _cache


def _invalidate() -> None:
    global _cache
    _cache = None


load.cache_clear = _invalidate       # the old lru_cache API, kept for callers and tests


def get(facility_id: str) -> Facility | None:
    return next((f for f in load() if f.id == facility_id), None)


def check(f: Facility) -> None:
    """Raises ValueError when a site can't be used: outside Toronto, no crews, bad truck counts."""
    lat0, lat1, lon0, lon1 = TORONTO_BOX
    if not (lat0 <= f.lat <= lat1 and lon0 <= f.lon <= lon1):
        raise ValueError("The site is outside the City of Toronto")
    if not f.crews:
        raise ValueError("Pick at least one crew type for the site")
    if not f.label.strip():
        raise ValueError("The site needs a name")
    for crew, n in f.vehicles.items():
        if crew not in f.crews:
            raise ValueError(f"The site has trucks for {crew} but does not host that crew")
        if not 0 <= n <= MAX_VEHICLES:
            raise ValueError(f"Trucks per day must be between 0 and {MAX_VEHICLES}")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:32] or "site"


def add(data: dict) -> Facility:
    """A new site from the console. Its id is generated; it is marked custom."""
    fields = {k: v for k, v in data.items() if k in EDITABLE}
    fields.setdefault("source", "Added in the console")
    fields.setdefault("assumed", False)
    with _lock:
        existing = {f.id for f in load()}
        fid = f"site-{_slug(str(fields.get('label', '')))}"
        while fid in existing:
            fid = f"site-{_slug(str(fields.get('label', '')))}-{uuid.uuid4().hex[:4]}"
        site = Facility.model_validate({**fields, "id": fid, "custom": True})
        site = site.model_copy(update={"vehicles": {c: n for c, n in site.vehicles.items() if c in site.crews}})
        check(site)
        overlay = _read_overlay()
        overlay["added"].append(site.model_dump())
        _write_overlay(overlay)
        _invalidate()
        return site


def update(facility_id: str, patch: dict) -> Facility:
    """Change a site's fields (e.g. trucks per day). Raises KeyError for an unknown site."""
    patch = {k: v for k, v in patch.items() if k in EDITABLE}
    with _lock:
        current = get(facility_id)
        if current is None:
            raise KeyError(facility_id)
        site = Facility.model_validate({**current.model_dump(), **patch})
        # Trucks for a crew type the site no longer hosts are dropped rather than refused.
        site = site.model_copy(update={"vehicles": {c: n for c, n in site.vehicles.items() if c in site.crews}})
        check(site)
        overlay = _read_overlay()
        if site.custom:
            overlay["added"] = [site.model_dump() if a.get("id") == facility_id else a for a in overlay["added"]]
        else:
            edited = overlay["edited"].get(facility_id, {})
            edited.update({k: getattr(site, k) for k in patch})
            overlay["edited"][facility_id] = edited
        _write_overlay(overlay)
        _invalidate()
        return site


def remove(facility_id: str) -> None:
    """Remove a site. A bundled site is remembered as removed; reset() brings it back."""
    with _lock:
        if get(facility_id) is None:
            raise KeyError(facility_id)
        overlay = _read_overlay()
        before = len(overlay["added"])
        overlay["added"] = [a for a in overlay["added"] if a.get("id") != facility_id]
        if len(overlay["added"]) == before and facility_id not in overlay["removed"]:
            overlay["removed"].append(facility_id)
        overlay["edited"].pop(facility_id, None)
        _write_overlay(overlay)
        _invalidate()


def reset() -> tuple[Facility, ...]:
    """Forget every console edit: the bundled list again."""
    with _lock:
        overlay_path().unlink(missing_ok=True)
        _invalidate()
        return load()


def for_crew(crew: Crew) -> list[Facility]:
    return [f for f in load() if crew in f.crews]


def staffed(crew: Crew) -> list[Facility]:
    """Sites that send out at least one truck of this crew type per day."""
    return [f for f in for_crew(crew) if f.vehicles.get(crew, 0) > 0]


def nearest(crew: Crew, point: tuple[float, float], among: list[Facility] | None = None) -> Facility | None:
    options = among if among is not None else for_crew(crew)
    return min(options, key=lambda f: km((f.lat, f.lon), point), default=None)
