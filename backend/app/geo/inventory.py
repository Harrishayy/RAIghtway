"""Indexed pie_cam-3 segments mapped to (drive, t_start); data/inventory.json from scripts/build_inventory.py."""
import json
import logging
from threading import Lock

from pydantic import BaseModel

from app import config
from app.geo.gps import DATA_DIR

log = logging.getLogger(__name__)
INVENTORY_JSON = DATA_DIR / "inventory.json"
_lock = Lock()
_cache: tuple[float | None, list] = (None, [])
_warned = False


class Segment(BaseModel):
    segment_id: str                  # vss-collection `filename` (segment file name)
    source_uri: str                  # s3://…segments bucket…/segments/…mp4 (read-only)
    drive: str                       # "set04/video_0008"
    t_start: float                   # seconds from the PIE clip's start
    duration: float = 5.0
    moving: bool | None = None       # median speed >= 2 km/h; None without GPS
    original_video: str = ""         # the 30 s chunk in S3_CHUNKS_BUCKET (read-only)
    chunk_start_sec: float | None = None
    stream_position_sec: float | None = None   # position within the set-level concatenation


def load() -> list[Segment]:
    """All mapped segments, ordered by drive and time. Missing file -> [] (logged once)."""
    global _cache, _warned
    try:
        mtime = INVENTORY_JSON.stat().st_mtime
    except OSError:
        if not _warned:
            log.warning("No %s yet; run scripts/build_inventory.py", INVENTORY_JSON.name)
            _warned = True
        return []
    with _lock:
        if _cache[0] != mtime:
            try:
                data = json.loads(INVENTORY_JSON.read_text())
                rows = data["segments"] if isinstance(data, dict) else data
                _cache = (mtime, [Segment(**row) for row in rows])
            except Exception as exc:
                log.warning("Inventory unreadable (%s)", config.redact(exc))
                _cache = (mtime, [])
        return list(_cache[1])


def by_id() -> dict[str, Segment]:
    return {s.segment_id: s for s in load()}
