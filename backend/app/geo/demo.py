"""Demo-clip pre-compute rules from data/demo_clips.json (written by scripts/find_overlaps.py).

Pre-compute drops each clip's own indexed segments and always adds the other drive's
segments on the same street, so on stage some detections merge into existing pins.
"""
import json
import logging

from app import config
from app.geo import inventory
from app.geo.inventory import Segment
from app.geo.gps import DATA_DIR

log = logging.getLogger(__name__)
DEMO_JSON = DATA_DIR / "demo_clips.json"
_warned = False


def clips() -> list[dict]:
    global _warned
    try:
        data = json.loads(DEMO_JSON.read_text())
        return [c for c in data.get("clips", []) if isinstance(c, dict)]
    except FileNotFoundError:
        if not _warned:
            log.warning("No %s yet; demo exclusions are empty", DEMO_JSON.name)
            _warned = True
    except Exception as exc:
        if not _warned:
            log.warning("demo_clips.json unreadable (%s)", config.redact(exc))
            _warned = True
    return []


def excluded_segments() -> set[str]:
    return {str(s) for c in clips() for s in c.get("exclude_segments", [])}


def forced_segments() -> list[Segment]:
    excluded, known = excluded_segments(), inventory.by_id()
    result, seen, missing = [], set(), []
    for clip in clips():
        for segment_id in clip.get("force_segments", []):
            if segment_id in seen or segment_id in excluded:
                continue
            seen.add(segment_id)
            if segment_id in known:
                result.append(known[segment_id])
            else:
                missing.append(segment_id)
    if missing:
        log.warning("%d forced demo segments are not in the inventory", len(missing))
    return result

