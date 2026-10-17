"""Live analysis of one video: segment -> pieces (provisional pins) -> dedupe -> work orders -> store.

Uploads fall back to a saved replay of the same file when the run fails or passes REPLAY_AFTER_S.
"""
import asyncio
import inspect
import logging
import shutil
import time
from uuid import uuid4

from app import config, store
from app.ai import nemotron, rating
from app.models import Detection, IssueRecord, VideoRecord
from app.pipeline import dedupe, piece, replay, segment

log = logging.getLogger(__name__)
try:
    from app.planning import report
except Exception as exc:  # TODO(agent7): app.planning.report lands in parallel; regen is a no-op until then.
    log.warning("app.planning.report unavailable (%s)", config.redact(exc))
    report = None

REPLAY_AFTER_S = 60.0


class _Run:
    """Stage bookkeeping: store progress, the optional callback, and timings for logs and replay."""

    def __init__(self, video_id: str, on_progress):
        self.video_id, self.on_progress = video_id, on_progress
        self.started = time.monotonic()
        self.timings: list[dict] = []
        self.committed = False       # past replace_provisional: too late to swap in a replay

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    async def stage(self, stage: str, progress: float) -> None:
        self.timings.append({"stage": stage, "progress": round(progress, 3), "t": round(self.elapsed(), 2)})
        await asyncio.to_thread(store.set_progress, self.video_id, status="analysing", progress=progress, stage=stage)
        if self.on_progress:
            try:
                result = self.on_progress(stage, progress)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                log.warning("on_progress failed (%s)", config.redact(exc))


def _provisional(dets: list[Detection], video: VideoRecord) -> list[IssueRecord]:
    records = []
    for det in dets:
        id = "p-" + uuid4().hex[:10]
        dedupe.cache_frame(id, det.frame_path)
        records.append(dedupe.record(det, video, id, det.piece_index * segment.PIECE_S + det.t_piece))
    return records


def _track(drive: str | None, start_s: float, duration_s: float) -> list[tuple[float, float]]:
    if not drive or piece.gps is None:
        return []
    try:
        return [tuple(p) for p in piece.gps.track(drive, start_s, duration_s)]
    except Exception as exc:
        log.warning("gps.track failed (%s)", config.redact(exc))
        return []


async def _pieces(run: _Run, video: VideoRecord, path: str, work, drive, start_s, strict: bool) -> list[Detection]:
    paths = await asyncio.to_thread(segment.split, path, str(work))
    if not paths:
        raise RuntimeError("Segmenting produced no pieces")
    total = len(paths)
    await run.stage(f"checking 0/{total}", 0.1)
    tasks = [asyncio.create_task(piece.process_piece(p, path, i, i * segment.PIECE_S, drive, start_s, strict=strict))
             for i, p in enumerate(paths)]
    detections: list[Detection] = []
    try:
        for done, next_piece in enumerate(asyncio.as_completed(tasks), 1):
            found = await next_piece
            detections += found
            if found:
                await asyncio.to_thread(store.add_issues, _provisional(found, video), provisional=True)
            await run.stage(f"checking {done}/{total}", 0.1 + 0.6 * done / total)
    finally:
        for task in tasks:
            task.cancel()
    return detections


async def _analyse(run: _Run, video_id: str, path: str, source: str, drive, start_s: float) -> dict:
    video = store.get_video(video_id)
    if video is None:
        raise RuntimeError("Video not in store")
    work = await asyncio.to_thread(segment.work_dir, f"{video_id[:8]}-")
    try:
        duration = await asyncio.to_thread(segment.probe_duration, path)
        detections = await _pieces(run, video, path, work, drive, start_s, strict=source == "upload")
        await run.stage("checking history", 0.75)
        records = await asyncio.to_thread(dedupe.assign, detections, video, use_history=True)
    finally:
        await asyncio.to_thread(shutil.rmtree, work, True)

    # The console maps this onto the "Repairs" stage; work-order urgency then follows the new grades.
    await run.stage("planning repairs: grading severity", 0.8)
    rating_rows = await _rate(records)
    await run.stage("planning repairs", 0.85)
    canonical = [r for r in records if not r.duplicate_of]
    orders, explanation = await nemotron.work_orders_and_explanation(video, canonical, records)
    for r in canonical:
        r.work_order = orders.get(r.id)

    track = await asyncio.to_thread(_track, drive, start_s, duration)
    run.committed = True
    await asyncio.to_thread(store.replace_provisional, video_id, records)
    if rating_rows:
        try:
            await asyncio.to_thread(store.apply_ratings, rating_rows)    # log + VastDB `ratings` row
        except Exception as exc:
            log.warning("Saving ratings failed (%s)", config.redact(exc))
    await asyncio.to_thread(store.update_video, video_id, explanation=explanation,
                            issue_ids=[r.id for r in records], track=track, duration_s=duration)
    run.timings.append({"stage": "done", "progress": 1.0, "t": round(run.elapsed(), 2)})
    await asyncio.to_thread(store.set_progress, video_id, status="done", progress=1.0, stage="done")
    return {"timings": run.timings, "issues": [r.model_dump(mode="json") for r in records],
            "explanation": explanation, "track": track, "duration_s": duration}


async def _rate(records: list[IssueRecord]) -> list[dict]:
    """Re-grade every new sighting from its keyframe, within a time budget. Never raises: on any failure the
    findings keep the find pass's severity."""
    try:
        ratings = await rating.rate_issues(records, budget_s=rating.LIVE_BUDGET_S)
        rows = []
        for record in records:
            if record.id in ratings:
                row = rating.row(record, ratings[record.id])
                store.apply_rating_row(record, row)
                rows.append(row)
        return rows
    except Exception as exc:
        log.warning("Severity rating skipped (%s)", config.redact(exc))
        return []


def _log_timings(video_id: str, timings: list[dict], how: str) -> None:
    marks = {}
    for step in timings:
        marks.setdefault(step["stage"].split(" ")[0], step["t"])
    parts, previous = [], 0.0
    for name, t in marks.items():
        parts.append(f"{name}@{t:.1f}s")
        previous = t
    log.info("live %s video=%s %s total=%.1fs", how, video_id, " ".join(parts), previous)


async def _after(video_id: str, path: str, source: str) -> None:
    if source == "upload":
        try:
            await asyncio.to_thread(_put_original, video_id, path)
        except Exception as exc:
            log.warning("put_original failed (%s)", config.redact(exc))
    if report is not None:
        try:
            report.schedule_regen()
        except Exception as exc:
            log.warning("schedule_regen failed (%s)", config.redact(exc))


def _put_original(video_id: str, path: str) -> None:
    from app.vast import media
    media.put_original(video_id, path)


async def analyse_video(video_id: str, path: str, *, source: str, drive: str | None, start_s: float,
                        on_progress=None) -> None:
    run = _Run(video_id, on_progress)
    await run.stage("segmenting", 0.05)
    if source != "upload":
        await _analyse(run, video_id, path, source, drive, start_s)
        _log_timings(video_id, run.timings, "run")
        await _after(video_id, path, source)
        return

    clip_hash = await asyncio.to_thread(replay.file_hash, path)
    task = asyncio.create_task(_analyse(run, video_id, path, source, drive, start_s))
    try:
        done, _ = await asyncio.wait({task}, timeout=REPLAY_AFTER_S)
        if not done and not run.committed:
            saved = await asyncio.to_thread(replay.lookup, clip_hash)
            if saved:
                log.warning("live video=%s passed %.0fs; switching to replay", video_id, REPLAY_AFTER_S)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await _replay(run, video_id, path, clip_hash, saved)
                return
        result = await task
    except asyncio.CancelledError:
        task.cancel()
        raise
    except Exception as exc:
        saved = None if run.committed else await asyncio.to_thread(replay.lookup, clip_hash)
        if not saved:
            raise
        log.warning("live video=%s failed (%s); switching to replay", video_id, config.redact(exc))
        await _replay(run, video_id, path, clip_hash, saved)
        return
    _log_timings(video_id, run.timings, "run")
    try:
        await asyncio.to_thread(replay.save, clip_hash, result)
    except Exception as exc:
        log.warning("Replay save failed (%s)", config.redact(exc))
    await _after(video_id, path, source)


async def _replay(run: _Run, video_id: str, path: str, clip_hash: str, saved: dict) -> None:
    await replay.play(video_id, clip_hash, saved, elapsed_s=run.elapsed())
    log.info("live replayed video=%s total=%.1fs", video_id, run.elapsed())
    await _after(video_id, path, "upload")
