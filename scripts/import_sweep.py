"""Load the standalone Cosmos sweep (data/sweep/results.jsonl) into the store as corpus issues.

The sweep already did the find step for all 1080 segments, so this skips Cosmos find and box and runs
the rest of pre-compute per finding: clean keyframe from the 1080p segment, crop + embedding, GPS,
then dedupe one drive at a time (earlier drives are history for later ones), batched work orders,
explanation, track, and the video marked "done".

Stop the API first (it holds its own store and snapshot), run this, then start the API again.

    .venv/bin/python ../scripts/import_sweep.py --dry-run --limit 8     # no store writes
    .venv/bin/python ../scripts/import_sweep.py                          # resumable per drive
"""
import argparse
import asyncio
import json
import logging
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import config, store  # noqa: E402
from app.ai import embed, nemotron  # noqa: E402
from app.geo import demo, gps, inventory  # noqa: E402
from app.models import BBox, Detection, VideoRecord  # noqa: E402
from app.pipeline import dedupe, piece, precompute, segment  # noqa: E402

log = logging.getLogger("import_sweep")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEGMENT_CONCURRENCY = 6
WORK_ORDER_CHUNK = 12
WORK_ORDER_CONCURRENCY = 3


def load_sweep(path: Path) -> dict[str, dict]:
    rows = {}
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["filename"]] = row
    return rows


async def detections_for(row: dict, seg, start_s: float, work: Path, gate: asyncio.Semaphore) -> list[Detection]:
    """One sweep segment -> Detections with keyframe, sweep box, embedding and GPS (piece_index 0)."""
    async with gate:
        original = work / row["filename"]
        await asyncio.to_thread(precompute._download, seg.source_uri, str(original))
        try:
            found = []
            for issue in row["issues"]:
                t = min(max(float(issue.get("t") or 0.0), 0.0), seg.duration - 0.05)
                stem = work / f"{Path(row['filename']).stem}_{int(issue['n']):04d}"
                box = BBox(**issue["box"]) if issue.get("box") else None
                det = Detection(piece_index=0, t_piece=round(seg.t_start - start_s + t, 3),
                                category=issue["category"], severity=int(issue["severity"]),
                                confidence=float(issue.get("confidence") or 0.0),
                                description=issue.get("description") or "", bbox=box)
                try:
                    det.frame_path = await asyncio.to_thread(segment.extract_frame, str(original), t,
                                                             f"{stem}_frame.jpg")
                    crop = await asyncio.to_thread(segment.crop, det.frame_path, box, f"{stem}_crop.jpg")
                    clip = await asyncio.to_thread(segment.still_clip, crop, f"{stem}_crop.mp4")
                    det.embedding = await embed.embed_clip(clip)
                except Exception as exc:
                    log.warning("%s #%s: frame/embedding failed (%s)", row["filename"], issue["n"],
                                config.redact(exc))
                position = await piece.locate(seg.drive, seg.t_start + t)
                if position:
                    det.lat, det.lon, det.heading = position
                found.append(det)
            return found
        finally:
            original.unlink(missing_ok=True)


async def work_orders(video: VideoRecord, records: list) -> list:
    """Batched work orders for the new canonical issues; records are immutable once added."""
    new = [r for r in records if not r.duplicate_of]
    chunks = [new[i:i + WORK_ORDER_CHUNK] for i in range(0, len(new), WORK_ORDER_CHUNK)]
    gate = asyncio.Semaphore(WORK_ORDER_CONCURRENCY)

    async def one(chunk):
        async with gate:
            orders, _ = await nemotron.work_orders_and_explanation(video, chunk, records)
            return orders

    orders = {}
    for result in await asyncio.gather(*(one(c) for c in chunks)):
        orders.update(result)
    return [r.model_copy(update={"work_order": orders[r.id]}) if r.id in orders else r for r in records]


async def import_drive(drive: str, segs: list, sweep: dict[str, dict], work: Path, dry_run: bool,
                       limit: int | None, excluded: set[str]) -> None:
    video_id = precompute._video_id(drive)
    existing = store.get_video(video_id)
    if existing and existing.status == "done":
        log.info("%s already done (%d issues); skipping", drive, len(existing.issue_ids))
        return
    start = min(s.t_start for s in segs)
    end = max(s.t_start + s.duration for s in segs)
    video = existing or VideoRecord(id=video_id, filename=drive, source="corpus", status="analysing",
                                    progress=0.0, stage="importing sweep", drive=drive, start_s=start,
                                    duration_s=round(end - start, 3), created_at=datetime.now(timezone.utc))
    if not dry_run and not existing:
        store.add_video(video)

    if store.issues_for_video(video_id):
        log.warning("%s has issues from an earlier partial run; finishing the video only", drive)
    else:
        # Demo-clip segments stay out, so the live upload is matched by another drive, not itself.
        rows = [(sweep[s.segment_id], s) for s in segs
                if s.segment_id in sweep and sweep[s.segment_id].get("issues") and s.segment_id not in excluded]
        rows = rows[:limit] if limit else rows
        gate = asyncio.Semaphore(SEGMENT_CONCURRENCY)
        batches = await asyncio.gather(*(detections_for(r, s, start, work, gate) for r, s in rows),
                                       return_exceptions=True)
        detections = []
        for (row, _), batch in zip(rows, batches):
            if isinstance(batch, BaseException):
                log.warning("%s failed (%s)", row["filename"], config.redact(batch))
            else:
                detections.extend(batch)
        records = await asyncio.to_thread(dedupe.assign, detections, video, use_history=True)
        records = await work_orders(video, records)
        canonical = sum(not r.duplicate_of for r in records)
        located = sum(r.lat is not None for r in records)
        log.info("%s: %d segments -> %d detections -> %d issues (%d canonical, %d with GPS, %d work orders)",
                 drive, len(rows), len(detections), len(records), canonical, located,
                 sum(r.work_order is not None for r in records))
        if dry_run:
            for r in records[:5]:
                print(json.dumps(r.model_dump(mode="json", exclude={"embedding"}), default=str)[:400])
            return
        store.add_issues(records)

    issues = store.issues_for_video(video_id)
    _, explanation = await nemotron.work_orders_and_explanation(video, [], issues)
    try:
        track = gps.track(drive, start, end - start)
    except Exception as exc:
        log.warning("%s track failed (%s)", drive, config.redact(exc))
        track = []
    store.update_video(video_id, explanation=explanation, issue_ids=[i.id for i in issues],
                       track=[tuple(p) for p in track or []], duration_s=round(end - start, 3),
                       progress=1.0, stage="done")
    store.set_progress(video_id, status="done")
    log.info("%s done: %d issues", drive, len(issues))


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sweep", default=str(DATA_DIR / "sweep" / "results.jsonl"))
    parser.add_argument("--drive", help="only this drive, e.g. set04/video_0002")
    parser.add_argument("--limit", type=int, help="at most N segments with findings per drive")
    parser.add_argument("--dry-run", action="store_true", help="no store, VastDB or frame-cache writes")
    parser.add_argument("--no-report", action="store_true", help="skip the report regen at the end")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "weave", "urllib3", "botocore", "vastdb"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    try:
        from app.ai import weave_setup
        weave_setup.init()
    except Exception as exc:
        log.warning("Weave off (%s)", config.redact(exc))
    store.load()
    if args.dry_run:
        dedupe.cache_frame = lambda *a, **k: False   # keep the frame cache and S3 untouched
        dedupe._put_frame = lambda *a, **k: ""

    sweep = load_sweep(Path(args.sweep))
    by_drive: dict[str, list] = {}
    for seg in inventory.load():
        by_drive.setdefault(seg.drive, []).append(seg)
    drives = [args.drive] if args.drive else sorted(by_drive)
    found = sum(len(r.get("issues") or []) for r in sweep.values())
    excluded = set(demo.excluded_segments())
    log.info("Sweep: %d segments, %d findings; %d drives to import; %d demo segments excluded",
             len(sweep), found, len(drives), len(excluded))

    work = Path(config.STATE_DIR) / "sweep_import"
    work.mkdir(parents=True, exist_ok=True)
    try:
        for drive in drives:     # in order: earlier drives are dedupe history for later ones
            await import_drive(drive, sorted(by_drive[drive], key=lambda s: s.t_start), sweep, work,
                               args.dry_run, args.limit, excluded)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if not args.dry_run:
        if not args.no_report:
            from app.planning import report
            store.set_report(await report.regenerate())
            log.info("Report regenerated")
        log.info("Waiting for VastDB writes to finish")
        await asyncio.to_thread(store._writes.join)
        canonical = store.canonical_issues()
        log.info("Store now: %d videos, %d canonical issues", len(store.list_videos()), len(canonical))


if __name__ == "__main__":
    asyncio.run(main())
