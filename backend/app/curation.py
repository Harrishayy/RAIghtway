"""Demo mode: show the reviewed picks first, list only the drives that hold them, hide rejected findings.

Off by default, so the API serves exactly what the pipeline stored. DEMO_CURATION=1 turns it on at
start; POST /api/admin/demo {"on": true|false} flips it at runtime and the choice is kept in
state/demo_curation.json, so a restart doesn't silently change the demo. Curation never edits
stored issues, and the pipeline (dedupe against history) always sees everything.

curation.json is edited by hand after reviewing keyframes and reloads when it changes.
CURATION_FILE swaps in another file.
"""
import json
import logging
import os
from pathlib import Path

from app import config

log = logging.getLogger(__name__)
DEFAULT_FILE = Path(__file__).with_name("curation.json")
TOGGLE_FILE = config.STATE_DIR / "demo_curation.json"
_cache: tuple[float, dict, dict] = (-1.0, {}, {})


def _initial() -> bool:
    try:
        return bool(json.loads(TOGGLE_FILE.read_text())["on"])
    except (OSError, ValueError, KeyError, TypeError):
        return (config.DEMO_CURATION or "").strip().lower() in ("1", "true", "on", "yes")


_enabled = _initial()


def enabled() -> bool:
    return _enabled


def set_enabled(on: bool) -> bool:
    global _enabled
    _enabled = bool(on)
    try:
        TOGGLE_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOGGLE_FILE.write_text(json.dumps({"on": _enabled}))
    except OSError as exc:
        log.warning("Demo toggle not saved (%s); it lasts until restart", config.redact(exc))
    log.info("Demo curation %s", "on" if _enabled else "off")
    return _enabled


def _load() -> tuple[dict[str, int], dict[str, str]]:
    global _cache
    path = Path(os.environ.get("CURATION_FILE") or DEFAULT_FILE)
    try:
        mtime = path.stat().st_mtime
        if mtime != _cache[0]:
            data = json.loads(path.read_text())
            _cache = (mtime, {str(k): int(v) for k, v in data.get("featured", {}).items()},
                      {str(k): str(v) for k, v in data.get("rejected", {}).items()})
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        if _cache[0] != -2.0:
            log.warning("Curation file unreadable (%s); no demo picks", config.redact(exc))
        _cache = (-2.0, {}, {})
    return _cache[1], _cache[2]


def featured(issue_id: str) -> int | None:
    """Demo rank (1 first) while demo mode is on, else None."""
    return _load()[0].get(issue_id) if _enabled else None


def rejected(issue_id: str) -> str | None:
    """Why a review judged this finding not to be a defect, while demo mode is on, else None."""
    return _load()[1].get(issue_id) if _enabled else None


def visible(issues: list) -> list:
    """The issues the console, report and dispatch should use: all of them unless demo mode hides rejects."""
    if not _enabled:
        return issues
    rejects = _load()[1]
    return [i for i in issues if i.id not in rejects]


def keep_video(video, issues_by_video: dict[str, list]) -> bool:
    """Demo mode lists uploads and running jobs, plus corpus drives holding a pick; off, it lists everything."""
    if not _enabled or video.source == "upload" or video.status in ("queued", "analysing"):
        return True
    picks = _load()[0]
    return any(i.id in picks for i in issues_by_video.get(video.id, []))
