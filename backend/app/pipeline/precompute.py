"""Corpus pre-compute: run the per-piece pipeline over a spread-apart sample of PIE segments.

start() launches one background task. Candidates are built once and saved to
STATE_DIR/precompute_candidates.json; finished segment IDs go to
STATE_DIR/precompute_done.json after each segment, so a restart resumes. Segments
are processed a few at a time, but dedupe runs strictly in candidate order so
re-sightings across segments merge. Results are grouped into one corpus
VideoRecord per PIE clip (drive), which reaches status "done" (and is persisted)
once all of that clip's candidates have been tried.
"""
import asyncio
from datetime import datetime, timezone
from functools import lru_cache
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

from app import config, store
from app.ai import gpu, nemotron
from app.models import Detection, IssueRecord, VideoRecord
from app.pipeline import vss_client

log = logging.getLogger(__name__)
CANDIDATE_CAP = 60
SEGMENT_CONCURRENCY = 3
STOP_WAIT_S = 3.0              # stop() waits this long for in-flight segments, then returns
FFMPEG_TIMEOUT_S = 120
VSS_EXTRAS = os.environ.get("PRECOMPUTE_VSS_EXTRAS") == "1"   # optional search-based extras, off by default
VSS_EXTRA_CAP = 10
VSS_QUERIES = {
    "pavement": "pothole or cracked road surface",
    "graffiti": "graffiti tag on a wall",
    "markings": "faded lane markings or crosswalk",
    "work_zone": "road work zone with cones",
    "signage": "damaged or obstructed street sign",
    "waste": "overflowing garbage bin or litter",
}
CANDIDATES_FILE = "precompute_candidates.json"
DONE_FILE = "precompute_done.json"


# ---- Teammate modules (guarded: they may land after this file) ----

def _no_segments() -> list:
    return []


def _assign_fallback(detections: list[Detection], video: VideoRecord, *, use_history: bool = True,
                     time_offset_s: float = 0.0) -> list[IssueRecord]:
    # TODO(agent5): replaced by app.pipeline.dedupe.assign; here every detection is its own canonical issue.
    now = datetime.now(timezone.utc)
    records = []
    for detection in detections:
        id = str(uuid4())
        if detection.frame_path:
            try:
                frames = Path(config.STATE_DIR) / "frames"
                frames.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(detection.frame_path, frames / f"{id}.jpg")
            except OSError:
                pass
        records.append(IssueRecord(
            id=id, video_id=video.id, t=time_offset_s + detection.piece_index * 5.0 + detection.t_piece,
            category=detection.category, severity=detection.severity, confidence=detection.confidence,
            description=detection.description, frame_url=f"/api/frames/{id}", bbox=detection.bbox,
            lat=detection.lat, lon=detection.lon, source=video.source, frame_key="", created_at=now,
            embedding=detection.embedding))
    return records


async def _process_piece_missing(*args, **kwargs) -> list[Detection]:
    # TODO(agent5): replaced by app.pipeline.piece.process_piece.
    raise RuntimeError("app.pipeline.piece is not available yet")


try:
    from app.geo import inventory
except ImportError:
    inventory = SimpleNamespace(load=_no_segments)  # TODO(agent4)
try:
    from app.geo import gps
except ImportError:
    gps = SimpleNamespace(track=lambda drive, start_s, duration_s: [])  # TODO(agent4)
try:
    from app.pipeline import piece
except ImportError:
    piece = SimpleNamespace(process_piece=_process_piece_missing)
try:
    from app.pipeline import dedupe
except ImportError:
    dedupe = SimpleNamespace(assign=_assign_fallback)
try:
    from app.planning import report
except ImportError:
    report = SimpleNamespace(schedule_regen=lambda: None)  # TODO(agent7)


# ---- Candidates ----

def _segment(s) -> dict | None:
    """Inventory Segment (object or dict) -> plain dict; None without a mapped drive/t."""
    get = s.get if isinstance(s, dict) else (lambda key: getattr(s, key, None))
    source, drive, t_start = get("source_uri"), get("drive"), get("t_start")
    if not source or not drive or t_start is None:
        return None
    return {"segment_id": get("segment_id") or source.rsplit("/", 1)[-1], "source_uri": source,
            "drive": drive, "t_start": float(t_start), "duration": float(get("duration") or 5.0),
            "moving": get("moving")}


def _spread(segments: list[dict], n: int) -> list[dict]:
    """n segments at even gaps over an ordered list (the middle of each stride)."""
    if n <= 0:
        return []
    if len(segments) <= n:
        return list(segments)
    step = len(segments) / n
    return [segments[int(i * step + step / 2)] for i in range(n)]


def _vss_extras(pool: dict[str, dict], taken: set[str]) -> list[dict]:
    """A few segments from VSS search hits per category (sequential, cached; see vss_client)."""
    extras: list[dict] = []
    per_query = -(-VSS_EXTRA_CAP // len(VSS_QUERIES))
    for category, query in VSS_QUERIES.items():
        try:
            hits = vss_client.search(query)
        except Exception as exc:
            log.warning("Precompute VSS extras for %s skipped (%s)", category, config.redact(exc))
            continue
        added = 0
        for hit in hits:
            seg = pool.get(str(hit.get("source") or "").rsplit("/", 1)[-1])
            if seg and seg["segment_id"] not in taken and added < per_query and len(extras) < VSS_EXTRA_CAP:
                extras.append(seg)
                taken.add(seg["segment_id"])
                added += 1
    return extras


def build_candidates(rebuild: bool = False) -> list[dict]:
    """The sample to process, built once and saved."""
    path = Path(config.STATE_DIR) / CANDIDATES_FILE
    if path.exists() and not rebuild:
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError, KeyError, TypeError) as exc:
            log.warning("Precompute candidates unreadable (%s); rebuilding", config.redact(exc))
    segments = [s for s in map(_segment, inventory.load()) if s]
    pool = {s["segment_id"]: s for s in segments}
    moving = sorted((s for s in pool.values() if s["moving"] is not False), key=lambda s: (s["drive"], s["t_start"]))
    sample = _spread(moving, CANDIDATE_CAP)
    taken = {s["segment_id"] for s in sample}
    extras = _vss_extras(pool, taken) if VSS_EXTRAS else []
    candidates = sorted(sample + extras, key=lambda s: (s["drive"], s["t_start"]))
    log.info("Precompute candidates: %d (%d sampled from %d moving, %d VSS extras)",
             len(candidates), len(sample), len(moving), len(extras))
    if candidates:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(candidates, indent=1))
    return candidates


def _load_done() -> set[str]:
    try:
        return set(json.loads((Path(config.STATE_DIR) / DONE_FILE).read_text()))
    except (OSError, ValueError, TypeError):
        return set()


def _save_done(done: set[str]) -> None:
    path = Path(config.STATE_DIR) / DONE_FILE
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(sorted(done)))
    temporary.replace(path)


# ---- Media (blocking; run in threads) ----

@lru_cache(maxsize=1)
def _s3():
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=config.S3_ENDPOINT, aws_access_key_id=config.ACCESS_KEY,
                        aws_secret_access_key=config.SECRET_KEY, verify=False,
                        config=Config(s3={"addressing_style": "path"}, connect_timeout=5,
                                      read_timeout=30, retries={"total_max_attempts": 2}))


def _download(source: str, dest: str) -> None:
    """Read-only fetch of s3://bucket/key (get_object only); the VSS stream proxy on AccessDenied."""
    parsed = urlparse(source)
    if parsed.scheme != "s3" or not parsed.netloc:
        raise ValueError("segment source is not an s3:// URI")
    if not all((config.S3_ENDPOINT, config.ACCESS_KEY, config.SECRET_KEY)):
        vss_client.download(source, dest)
        return
    from botocore.exceptions import ClientError
    try:
        body = _s3().get_object(Bucket=parsed.netloc, Key=parsed.path.lstrip("/"))["Body"]
        try:
            with open(dest, "wb") as out:
                shutil.copyfileobj(body, out, 1 << 16)
        finally:
            body.close()
    except ClientError as exc:
        error = exc.response.get("Error", {})
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if error.get("Code") not in ("AccessDenied", "Forbidden", "403") and status != 403:
            raise
        log.info("Precompute S3 access denied; using the VSS stream proxy")
        vss_client.download(source, dest)


def _transcode(src: str, dest: str) -> None:
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", "scale=-2:720", "-an",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", dest],
                       check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except subprocess.CalledProcessError as exc:
        tail = exc.stderr.decode(errors="replace")[-200:] if exc.stderr else ""
        raise RuntimeError(f"ffmpeg 720p failed: {tail}") from None


# ---- Controller ----

_task: asyncio.Task | None = None
_stop: asyncio.Event | None = None
_dedupe_lock: asyncio.Lock | None = None   # made per run, on the running loop
_finished: set[str] = set()                # clips already finalised this run
_state = {"done": 0, "total": 0, "errors": 0, "processed": 0, "started": None,
          "current": [], "last_error": None}


def _video_id(drive: str) -> str:
    return "corpus-" + drive.replace("/", "-")


def _corpus_video(drive: str, segments: list[dict]) -> VideoRecord:
    """The clip's VideoRecord, created ("analysing", memory-only) on first use. Call under _dedupe_lock."""
    video = store.get_video(_video_id(drive))
    if video is None:
        start = min(s["t_start"] for s in segments)
        end = max(s["t_start"] + s["duration"] for s in segments)
        video = VideoRecord(id=_video_id(drive), filename=drive, source="corpus", status="analysing",
                            progress=0.0, stage="queued", drive=drive, start_s=start,
                            duration_s=round(end - start, 3), created_at=datetime.now(timezone.utc))
        store.add_video(video)
    return video


async def _with_work_orders(video: VideoRecord, records: list[IssueRecord]) -> list[IssueRecord]:
    """Work orders go on before add_issues: persisted records are immutable."""
    new = [r for r in records if not r.duplicate_of]
    if not new:
        return records
    try:
        orders, _ = await nemotron.work_orders_and_explanation(video, new, records)
    except Exception as exc:
        log.warning("Precompute work orders failed (%s)", config.redact(exc))
        return records
    return [r.model_copy(update={"work_order": orders[r.id]}) if r.id in orders else r for r in records]


async def _wait_unpaused(stop: asyncio.Event) -> bool:
    """Block while gpu.pause() is on (live analysis wins). False only if stop() came during the pause."""
    if not gpu.is_paused():
        return True
    if not stop.is_set():
        log.info("Precompute paused")
        waiters = [asyncio.ensure_future(gpu.wait_if_paused()), asyncio.ensure_future(stop.wait())]
        try:
            await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in waiters:
                waiter.cancel()
        log.info("Precompute %s", "stopping" if stop.is_set() else "resumed")
    return not stop.is_set()


async def _finish_drive(drive: str, segments: list[dict], done: set[str], failed: set[str],
                        finished: set[str]) -> None:
    """Explanation + track, then status "done" (persisting the video), once every segment was tried."""
    ids = {s["segment_id"] for s in segments}
    if drive in finished or not ids <= done | failed or not ids & done:
        return
    finished.add(drive)
    try:
        existing = store.get_video(_video_id(drive))
        if existing and existing.status == "done":
            return
        async with _dedupe_lock:
            video = _corpus_video(drive, segments)
        issues = await asyncio.to_thread(store.issues_for_video, video.id)
        _, explanation = await nemotron.work_orders_and_explanation(video, [], issues)
        try:
            track = await asyncio.to_thread(gps.track, drive, video.start_s, video.duration_s)
        except Exception as exc:
            log.warning("Precompute track for %s failed (%s)", drive, config.redact(exc))
            track = []
        await asyncio.to_thread(store.update_video, video.id, explanation=explanation,
                                issue_ids=[i.id for i in issues], track=[tuple(p) for p in track or []],
                                duration_s=video.duration_s, progress=1.0, stage="done")
        await asyncio.to_thread(store.set_progress, video.id, status="done")
        log.info("Precompute clip %s done: %d issues", drive, len(issues))
    except Exception as exc:
        _state["errors"] += 1
        _state["last_error"] = config.redact(exc)
        log.warning("Precompute finishing %s failed (%s)", drive, config.redact(exc))


async def _process(index: int, seg: dict, turns: list[asyncio.Event], stop: asyncio.Event,
                   by_drive: dict[str, list[dict]], done: set[str], failed: set[str], tmp_root: Path) -> None:
    sid, drive = seg["segment_id"], seg["drive"]
    _state["current"].append(sid)
    workdir = Path(tempfile.mkdtemp(prefix="seg-", dir=tmp_root))
    try:
        original, small = workdir / "original.mp4", workdir / "piece_720p.mp4"
        await asyncio.to_thread(_download, seg["source_uri"], str(original))
        await asyncio.to_thread(_transcode, str(original), str(small))
        if not await _wait_unpaused(stop):
            return  # stopped while paused: not marked done, so it reruns next time
        detections = await piece.process_piece(str(small), str(original), 0, 0.0, drive, seg["t_start"])
        if index:
            await turns[index - 1].wait()  # dedupe strictly in candidate order
        async with _dedupe_lock:
            video = _corpus_video(drive, by_drive[drive])
            records = await asyncio.to_thread(dedupe.assign, detections, video, use_history=True,
                                              time_offset_s=max(0.0, seg["t_start"] - video.start_s))
            records = await _with_work_orders(video, records)
            await asyncio.to_thread(store.add_issues, records)
            done.add(sid)
            await asyncio.to_thread(_save_done, done)
        _state["processed"] += 1
        _state["done"] = len(done & {s["segment_id"] for segs in by_drive.values() for s in segs})
        elapsed = time.monotonic() - _state["started"]
        log.info("Precompute %s: %d detections -> %d issues (%d/%d, %.1f segments/min)", sid,
                 len(detections), len(records), _state["done"], _state["total"],
                 _state["processed"] / max(elapsed / 60, 1e-6))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        failed.add(sid)
        _state["errors"] += 1
        _state["last_error"] = f"{sid}: {config.redact(exc)}"
        log.warning("Precompute segment %s failed (%s)", sid, config.redact(exc))
    finally:
        turns[index].set()
        _state["current"].remove(sid)
        shutil.rmtree(workdir, ignore_errors=True)
    segments = by_drive[drive]
    video = store.get_video(_video_id(drive))
    if video and video.status != "done":
        count = sum(s["segment_id"] in done for s in segments)
        store.set_progress(video.id, progress=round(count / len(segments), 3),
                           stage=f"checking {count}/{len(segments)}")
    await _finish_drive(drive, segments, done, failed, _finished)
    try:
        report.schedule_regen()
    except Exception as exc:
        log.warning("Report regen scheduling failed (%s)", config.redact(exc))


async def _run(stop: asyncio.Event) -> None:
    started = time.monotonic()
    try:
        candidates = await asyncio.to_thread(build_candidates)
        done = await asyncio.to_thread(_load_done)
        by_drive: dict[str, list[dict]] = {}
        for seg in candidates:
            by_drive.setdefault(seg["drive"], []).append(seg)
        pending = [s for s in candidates if s["segment_id"] not in done]
        _state.update(total=len(candidates), done=len(candidates) - len(pending), errors=0, processed=0,
                      started=started, current=[], last_error=None)
        _finished.clear()
        failed: set[str] = set()
        log.info("Precompute starting: %d candidates, %d already done, %d to go",
                 len(candidates), len(candidates) - len(pending), len(pending))
        # Clips finished in an earlier run that crashed before reaching "done".
        for drive, segments in by_drive.items():
            await _finish_drive(drive, segments, done, failed, _finished)
        tmp_root = Path(config.STATE_DIR) / "precompute_tmp"
        tmp_root.mkdir(parents=True, exist_ok=True)
        turns = [asyncio.Event() for _ in pending]
        work = iter(enumerate(pending))

        async def worker() -> None:
            for index, seg in work:          # shared iterator: workers take segments in order
                if stop.is_set():
                    turns[index].set()
                    continue
                await _process(index, seg, turns, stop, by_drive, done, failed, tmp_root)

        await asyncio.gather(*(worker() for _ in range(min(SEGMENT_CONCURRENCY, len(pending)))))
    except asyncio.CancelledError:
        log.info("Precompute cancelled")
        raise
    except Exception as exc:
        _state["errors"] += 1
        _state["last_error"] = config.redact(exc)
        log.error("Precompute stopped (%s)", config.redact(exc))
    finally:
        minutes = (time.monotonic() - started) / 60
        log.info("Precompute %s: %d segments in %.1f min (%.1f segments/min), %d errors",
                 "stopped" if stop.is_set() else "finished", _state["processed"], minutes,
                 _state["processed"] / max(minutes, 1e-6), _state["errors"])


async def start() -> None:
    """Launch the background run and return at once; a no-op while one is running."""
    global _task, _stop, _dedupe_lock
    if _task and not _task.done():
        return
    _stop = asyncio.Event()
    _dedupe_lock = asyncio.Lock()
    _task = asyncio.create_task(_run(_stop), name="precompute")


async def stop() -> None:
    """In-flight segments finish (or are dropped if paused); no new ones start."""
    if _stop:
        _stop.set()
    task = _task
    if task and not task.done():
        await asyncio.wait({task}, timeout=STOP_WAIT_S)  # never cancels the task itself


def status() -> dict:
    running = bool(_task and not _task.done())
    started = _state["started"]
    elapsed = time.monotonic() - started if started else 0.0
    rate = _state["processed"] / (elapsed / 60) if elapsed > 0 and _state["processed"] else 0.0
    remaining = _state["total"] - _state["done"]
    return {"running": running, "stopping": running and bool(_stop and _stop.is_set()),
            "paused": gpu.is_paused(), "done": _state["done"], "total": _state["total"],
            "errors": _state["errors"], "segments_per_min": round(rate, 2),
            "eta_s": round(remaining / rate * 60) if running and rate else None,
            "current": list(_state["current"]), "last_error": _state["last_error"]}
