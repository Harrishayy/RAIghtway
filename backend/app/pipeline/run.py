"""Run: analyse footage the VAST index has that Raightway hasn't looked at yet, live.

POST /api/run re-reads the segment inventory from vss-collection (VastDB), picks up to MAX_SEGMENTS
contiguous segments of one drive that no earlier pass analysed, downloads them from VAST S3, joins them
into one clip and hands it to the live pipeline, the same path an upload takes. The console shows the
stages and provisional pins as they land.

"Analysed" means: in the imported Cosmos sweep (minus the demo segments held back from it), done by
precompute, or done by an earlier Run. Held-back demo segments are picked first, so the first Run on
stage is the demo street, whose findings merge into pins another drive already found.
"""
import asyncio
import json
import logging
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from uuid import uuid4

from app import config, store
from app.geo import demo, gps, inventory
from app.models import VideoRecord
from app.pipeline import precompute

log = logging.getLogger(__name__)
MAX_SEGMENTS = 6                      # 30 s of footage: enough to see pins land, short enough for a demo
REFRESH_TIMEOUT_S = 45.0
FFMPEG_TIMEOUT_S = 120
SWEEP_FILE = gps.DATA_DIR / "sweep" / "results.jsonl"
DONE_FILE = "run_done.json"
BUILD_INVENTORY = config.BACKEND_DIR.parent / "scripts" / "build_inventory.py"
_lock = asyncio.Lock()


class NothingToRun(Exception):
    """Every segment in the VAST index has been analysed already."""


def refresh_inventory() -> bool:
    """Rebuild data/inventory.json from vss-collection (one read-only query). False keeps the cached file."""
    try:
        subprocess.run([sys.executable, str(BUILD_INVENTORY), "--check", "0"], cwd=config.BACKEND_DIR,
                       check=True, capture_output=True, timeout=REFRESH_TIMEOUT_S)
        return True
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("Run: inventory refresh failed, using the cached inventory (%s)", config.redact(str(exc)))
        return False


def _sweep_ids() -> set[str]:
    try:
        return {json.loads(line)["filename"] for line in SWEEP_FILE.read_text().splitlines() if line.strip()}
    except (OSError, ValueError, KeyError, TypeError):
        return set()


def _done_path() -> Path:
    return Path(config.STATE_DIR) / DONE_FILE


def _run_done() -> set[str]:
    try:
        return set(json.loads(_done_path().read_text()))
    except (OSError, ValueError, TypeError):
        return set()


def _mark_done(segment_ids: list[str]) -> None:
    path = _done_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(sorted(_run_done() | set(segment_ids))))
    temporary.replace(path)


def analysed() -> set[str]:
    held_back = demo.excluded_segments()
    return (_sweep_ids() - held_back) | precompute._load_done() | _run_done()


def pick(max_segments: int = MAX_SEGMENTS) -> list[inventory.Segment]:
    """The next unanalysed stretch: held-back demo segments first, then any new ones, contiguous on one drive."""
    seen, held_back = analysed(), demo.excluded_segments()
    segments = inventory.load()
    pending = [s for s in segments if s.segment_id not in seen and s.moving is not False]
    if not pending:
        raise NothingToRun("Nothing new in the VAST index: every segment has been analysed")
    first = min(pending, key=lambda s: (s.segment_id not in held_back, s.drive, s.t_start))
    stretch, end = [first], first.t_start + first.duration
    for s in sorted((s for s in pending if s.drive == first.drive and s.t_start > first.t_start),
                    key=lambda s: s.t_start):
        if len(stretch) >= max_segments or abs(s.t_start - end) > 0.5:
            break
        stretch.append(s)
        end = s.t_start + s.duration
    return stretch


def _join(parts: list[str], out: str) -> None:
    """Concatenate the segments and re-encode to 720p, like the demo clips."""
    listing = Path(out).with_suffix(".txt")
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-vf", "scale=-2:720", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
                       check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except subprocess.CalledProcessError as exc:
        tail = exc.stderr.decode(errors="replace")[-200:] if exc.stderr else ""
        raise RuntimeError(f"ffmpeg join failed: {tail}") from None
    finally:
        listing.unlink(missing_ok=True)


def _fetch(stretch: list[inventory.Segment], out: str) -> None:
    work = Path(out).parent / "parts"
    work.mkdir(parents=True, exist_ok=True)
    try:
        parts = []
        for n, s in enumerate(stretch):
            part = work / f"{n:02d}.mp4"
            precompute._download(s.source_uri, str(part))     # VAST S3, read-only; VSS proxy on AccessDenied
            parts.append(str(part))
        _join(parts, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def start(analyse):
    """Pick and register one run. Returns (video, go): the caller schedules `go()`, which fetches the clip
    and calls `analyse(video, path)` (main's live-analysis runner). Raises NothingToRun."""
    if _lock.locked():
        raise RuntimeError("A run is already starting")
    async with _lock:
        await asyncio.to_thread(refresh_inventory)
        stretch = await asyncio.to_thread(pick)
        drive, start_s = stretch[0].drive, stretch[0].t_start
        duration = round(stretch[-1].t_start + stretch[-1].duration - start_s, 3)
        id = str(uuid4())
        filename = f"{drive.replace('/', '_')}_t{int(start_s):04d}.mp4"
        video = VideoRecord(id=id, filename=filename, source="corpus", status="queued", progress=0,
                            stage="fetching from VAST", drive=drive, start_s=start_s, duration_s=duration,
                            created_at=datetime.now(timezone.utc))
        await asyncio.to_thread(store.add_video, video)
        log.info("Run %s: %s from %.0f s, %d segments", id, drive, start_s, len(stretch))

    async def go() -> None:
        path = Path(config.STATE_DIR) / "runs" / id / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(_fetch, stretch, str(path))
        except Exception as exc:
            await asyncio.to_thread(store.set_progress, id, status="failed",
                                    stage=f"Fetching from VAST failed: {config.redact(exc)}")
            return
        await analyse(video, str(path))
        finished = await asyncio.to_thread(store.get_video, id)
        if finished and finished.status == "done":
            await asyncio.to_thread(_mark_done, [s.segment_id for s in stretch])

    return video, go
