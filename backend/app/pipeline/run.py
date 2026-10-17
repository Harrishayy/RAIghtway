"""Run: analyse footage the VAST index has that Raightway hasn't looked at yet, live.

POST /api/run re-reads the segment inventory from vss-collection (VastDB), picks up to MAX_SEGMENTS
contiguous segments of one drive that no earlier pass analysed, downloads them from VAST S3, joins them
into one clip and hands it to the live pipeline, the same path an upload takes. The console shows the
stages and provisional pins as they land.

"Analysed" means: in the imported Cosmos sweep, done by precompute, or done by an earlier Run. When nothing
is new, Run re-checks the stretches around the worst open issues instead.
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
from app.geo import gps, inventory
from app.models import VideoRecord
from app.pipeline import precompute

log = logging.getLogger(__name__)
MAX_SEGMENTS = 6                      # 30 s of footage: enough to see pins land, short enough to watch
RECHECK_LEAD_S = 10.0                 # a re-check starts this far before the reviewed finding
REFRESH_TIMEOUT_S = 45.0
FFMPEG_TIMEOUT_S = 120
SWEEP_FILE = gps.DATA_DIR / "sweep" / "results.jsonl"
DONE_FILE = "run_done.json"
BUILD_INVENTORY = config.BACKEND_DIR.parent / "scripts" / "build_inventory.py"
_lock = asyncio.Lock()
_active = False                       # a run's clips are still being fetched or analysed


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
    return _sweep_ids() | precompute._load_done() | _run_done()


def pick(max_segments: int = MAX_SEGMENTS) -> list[inventory.Segment]:
    """The next unanalysed stretch, contiguous on one drive."""
    seen = analysed()
    segments = inventory.load()
    pending = [s for s in segments if s.segment_id not in seen and s.moving is not False]
    if not pending:
        raise NothingToRun("Nothing new in the VAST index: every segment has been analysed")
    first = min(pending, key=lambda s: (s.drive, s.t_start))
    stretch, end = [first], first.t_start + first.duration
    for s in sorted((s for s in pending if s.drive == first.drive and s.t_start > first.t_start),
                    key=lambda s: s.t_start):
        if len(stretch) >= max_segments or abs(s.t_start - end) > 0.5:
            break
        stretch.append(s)
        end = s.t_start + s.duration
    return stretch


def _join(parts: list[str], out: str) -> None:
    """Concatenate the segments and re-encode to 720p."""
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
    work = Path(out).parent / f"{Path(out).stem}.parts"      # per clip: `out` may sit in the shared uploads folder
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


def rechecks(count: int, skip_drives: set[str], max_segments: int = MAX_SEGMENTS) -> list[list[inventory.Segment]]:
    """Stretches of already-analysed footage to look at again: around the worst open corpus issues (severity,
    then confidence), one per drive, skipping `skip_drives`."""
    if count <= 0:
        return []
    by_drive: dict[str, list[inventory.Segment]] = {}
    for s in inventory.load():
        by_drive.setdefault(s.drive, []).append(s)
    out: list[list[inventory.Segment]] = []
    worst = sorted((i for i in store.canonical_issues() if i.source == "corpus" and i.verdict != "rejected"),
                   key=lambda i: (-i.severity, -i.confidence))
    for issue in worst:
        video = store.get_video(issue.video_id)
        if not video or video.source != "corpus" or not video.drive or video.drive in skip_drives:
            continue
        at = video.start_s + issue.t - RECHECK_LEAD_S       # start a little before the finding
        segments = sorted((s for s in by_drive.get(video.drive, []) if s.t_start + s.duration > at),
                          key=lambda s: s.t_start)
        stretch: list[inventory.Segment] = []
        for s in segments:
            if len(stretch) >= max_segments or (stretch and abs(s.t_start - stretch[-1].t_start - stretch[-1].duration) > 0.5):
                break
            stretch.append(s)
        if stretch:
            out.append(stretch)
            skip_drives = skip_drives | {video.drive}
        if len(out) >= count:
            break
    return out


async def start(analyse, clips: int | None = None):
    """Pick and register one Run of up to `clips` clips (default RUN_CLIPS): the next unanalysed stretch if
    there is one, then re-checks of the worst open issues' stretches on other drives. All are registered at once
    (queued), then `go()` fetches and analyses them one after another, so each runs at full speed.

    Re-checks are registered as uploads: they dedupe against corpus history (their findings land as
    re-sightings) but never become history themselves, and an admin reset hides them.
    Returns (first video, go). Raises NothingToRun only when there is nothing at all to look at."""
    global _active
    if _lock.locked():
        raise RuntimeError("A run is already starting")
    if _active:
        # pick() skips only finished stretches, so a second run now would analyse the same footage again
        raise RuntimeError("A run is still analysing; wait for it to finish")
    clips = max(1, min(int(clips or config.RUN_CLIPS), 5))
    async with _lock:
        await asyncio.to_thread(refresh_inventory)
        try:
            fresh = [await asyncio.to_thread(pick)]
        except NothingToRun:
            fresh = []
        again = await asyncio.to_thread(rechecks, clips - len(fresh), {s[0].drive for s in fresh})
        if not fresh and not again:
            raise NothingToRun("Nothing new in the VAST index, and no reviewed stretches to re-check")
        jobs = []
        for stretch, kind in [(s, "new") for s in fresh] + [(s, "recheck") for s in again]:
            drive, start_s = stretch[0].drive, stretch[0].t_start
            duration = round(stretch[-1].t_start + stretch[-1].duration - start_s, 3)
            video = VideoRecord(
                id=str(uuid4()), filename=f"{drive.replace('/', '_')}_t{int(start_s):04d}.mp4",
                source="corpus" if kind == "new" else "upload", run_kind=kind, status="queued", progress=0,
                stage="fetching from VAST", drive=drive, start_s=start_s, duration_s=duration,
                created_at=datetime.now(timezone.utc))
            await asyncio.to_thread(store.add_video, video)
            jobs.append((video, stretch))
            log.info("Run %s (%s): %s from %.0f s, %d segments", video.id, kind, drive, start_s, len(stretch))
        _active = True

    async def one(video: VideoRecord, stretch: list[inventory.Segment]) -> None:
        # Written where GET /api/videos/{id}/file looks, so the console can play the clip.
        path = Path(config.STATE_DIR) / ("uploads" if video.source == "upload" else "videos") / f"{video.id}.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(_fetch, stretch, str(path))
        except Exception as exc:
            await asyncio.to_thread(store.set_progress, video.id, status="failed",
                                    stage=f"Fetching from VAST failed: {config.redact(exc)}")
            return
        await analyse(video, str(path))
        finished = await asyncio.to_thread(store.get_video, video.id)
        if video.run_kind == "new" and finished and finished.status == "done":
            await asyncio.to_thread(_mark_done, [s.segment_id for s in stretch])

    async def go() -> None:
        global _active
        try:
            for video, stretch in jobs:
                try:
                    await one(video, stretch)
                except Exception as exc:   # one clip failing must not strand the rest at "queued"
                    log.warning("Run clip %s failed (%s)", video.id, config.redact(exc))
                    await asyncio.to_thread(store.set_progress, video.id, status="failed",
                                            stage=f"Run failed: {config.redact(exc)}")
        finally:
            _active = False

    return jobs[0][0], go
