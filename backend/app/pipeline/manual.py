"""Operator input: issues marked by hand on footage, pins, and operator severity overrides.

A manual issue is canonical (never deduped away) and its severity is the operator's. Everything a model or VAST
adds is best effort: the keyframe (ffmpeg on the playable file), the pin location (PIE GPS), the work order
(Nemotron Lightning, template fallback) and the Cosmos-Embed1 vector (for similar issues). A failure in any of
them leaves that part empty; the issue is still created.

Severity, pins and names are overlay rows (state/ratings.jsonl + VastDB `ratings`, state/pins.jsonl + VastDB `pins`,
state/names.jsonl + VastDB `names`),
so issue rows stay insert-only and every change can be undone.
"""
import asyncio
from datetime import datetime, timezone
import logging
from pathlib import Path
import shutil
from uuid import uuid4

from app import config, store
from app.models import BBox, IssueRecord

log = logging.getLogger(__name__)
OPERATOR = "operator"                 # severity_model for grades an operator set
TEMPLATE_REPAIR = "Inspect and repair the reported"   # nemotron._template's repair text starts with this


class VideoNotFound(LookupError):
    pass


def video_path(video) -> Path:
    """The playable file the console shows: the upload itself, or the corpus drive's proxy."""
    folder = "uploads" if video.source == "upload" else "videos"
    return Path(config.STATE_DIR) / folder / f"{video.id}.mp4"


def _grab_frame(video, t: float, issue_id: str) -> str | None:
    """Sync: write state/frames/{id}.jpg from the video at t. Returns the path, or None."""
    from app.pipeline import segment
    source = video_path(video)
    if not source.is_file():
        log.warning("Manual issue %s: no playable file for video %s; no keyframe", issue_id, video.id)
        return None
    target = Path(config.STATE_DIR) / "frames" / f"{issue_id}.jpg"
    target.parent.mkdir(parents=True, exist_ok=True)
    work = segment.work_dir("manual-")
    try:
        frame = segment.extract_frame(str(source), t, str(work / "frame.jpg"))
        shutil.copyfile(frame, target)
        return str(target)
    except Exception as exc:
        log.warning("Manual issue %s: frame grab failed (%s)", issue_id, config.redact(exc))
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _put_frame(issue_id: str, frame: str) -> str:
    """Sync: the keyframe to VAST S3 (or the frames table). Returns the frame key, or ""."""
    try:
        from app.vast import media
        return media.put_frame(issue_id, Path(frame).read_bytes())
    except Exception as exc:
        log.warning("Manual issue %s: put_frame failed (%s); local copy kept", issue_id, config.redact(exc))
        return ""


def _locate(video, t: float) -> tuple[float, float] | None:
    """Sync: lat/lon at the drive time of video time t (corpus and named uploads carry drive + start_s)."""
    if not video.drive:
        return None
    try:
        from app.geo import gps
        point = gps.locate(video.drive, video.start_s + t)
        return (point[0], point[1]) if point else None
    except Exception as exc:
        log.warning("Manual issue: GPS lookup failed (%s)", config.redact(exc))
        return None


async def _embed(frame: str, bbox: BBox | None, issue_id: str) -> list[float] | None:
    """Cosmos-Embed1 vector of the boxed crop, like the pipeline's. None on any failure."""
    from app.ai import embed
    from app.pipeline import segment
    work = await asyncio.to_thread(segment.work_dir, "manual-embed-")
    try:
        crop = await asyncio.to_thread(segment.crop, frame, bbox, str(work / "crop.jpg"))
        clip = await asyncio.to_thread(segment.still_clip, crop, str(work / "crop.mp4"))
        return await embed.embed_clip(clip)
    except Exception as exc:
        log.warning("Manual issue %s: embedding skipped (%s)", issue_id, config.redact(exc))
        return None
    finally:
        await asyncio.to_thread(shutil.rmtree, work, True)


async def _work_order(video, record: IssueRecord):
    try:
        from app.ai import nemotron
        orders, _ = await nemotron.work_orders_and_explanation(video, [record], [record])
        return orders.get(record.id)
    except Exception as exc:                  # work_orders_and_explanation never raises; belt and braces
        log.warning("Manual issue %s: work order skipped (%s)", record.id, config.redact(exc))
        return None


def operator_rating(issue: IssueRecord, severity: int, reason: str, when: datetime | None = None) -> dict:
    """A ratings row for a grade the operator set (reversible like any rating)."""
    return {"issue_id": issue.id, "severity": severity, "find_severity": issue.find_severity or issue.severity,
            "reason": reason, "model": OPERATOR, "verdict": "confirmed", "observed": "",
            "rated_at": (when or datetime.now(timezone.utc)).isoformat()}


def _whole_frame(bbox: BBox | None) -> bool:
    return bbox is None or (bbox.w >= 0.98 and bbox.h >= 0.98)


async def create(*, video_id: str, t: float, category: str, severity: int, description: str,
                 bbox: BBox | None = None, pinned: bool = True, name: str | None = None) -> IssueRecord:
    """Create one operator-reported issue. Raises VideoNotFound; nothing else fails the request."""
    video = await asyncio.to_thread(store.get_video, video_id)
    if video is None:
        raise VideoNotFound(video_id)
    t = max(0.0, float(t))
    if video.duration_s:
        t = min(t, float(video.duration_s))
    severity = max(1, min(5, int(severity)))
    box = None if _whole_frame(bbox) else bbox
    id = "m-" + uuid4().hex[:12]
    description = (description or "").strip() or f"Operator-reported {category.replace('_', ' ')} issue"
    record = IssueRecord(id=id, video_id=video.id, t=round(t, 2), category=category, severity=severity,
                         confidence=1.0, description=description[:500], frame_url=f"/api/frames/{id}", bbox=box,
                         lat=None, lon=None, source="manual", frame_key="", created_at=datetime.now(timezone.utc))

    frame, position = await asyncio.gather(asyncio.to_thread(_grab_frame, video, t, id),
                                           asyncio.to_thread(_locate, video, t))
    if position:
        record.lat, record.lon = position

    async def no_vector():
        return None

    order, embedding, frame_key = await asyncio.gather(
        _work_order(video, record),
        _embed(frame, box, id) if frame else no_vector(),
        asyncio.to_thread(_put_frame, id, frame) if frame else asyncio.sleep(0, ""))
    record.work_order, record.embedding, record.frame_key = order, embedding, frame_key or ""

    # The operator's grade is a rating row and the pin a pin row, so both survive a reload from VastDB
    # (issue rows carry neither) and both can be changed later without rewriting the issue.
    grade = operator_rating(record, severity, "Graded by the operator who marked it on the footage.")
    store.apply_rating_row(record, grade)
    pin = store.pin_row(id, pinned) if pinned else None
    if pin:
        store.apply_pin_row(record, pin)
    label = store.name_row(id, name) if store.clean_name(name) else None
    if label:
        store.apply_name_row(record, label)
    await asyncio.to_thread(store.add_issues, [record])
    try:
        await asyncio.to_thread(store.apply_ratings, [grade])
        if pin:
            await asyncio.to_thread(store.apply_pins, [pin])
        if label:
            await asyncio.to_thread(store.apply_names, [label])
    except Exception as exc:
        log.warning("Manual issue %s: saving grade, pin or name failed (%s)", id, config.redact(exc))
    log.info("Manual issue %s video=%s t=%.1f %s S%d frame=%s gps=%s work_order=%s embedding=%s pinned=%s",
             id, video.id, t, category, severity, "yes" if frame else "no", "yes" if position else "no",
             work_order_model(record), "cosmos-embed1" if embedding else "none", pinned)
    try:
        from app.planning import report
        report.schedule_regen()
    except Exception as exc:
        log.warning("schedule_regen failed (%s)", config.redact(exc))
    return store.get_issue(id) or record


def work_order_model(issue: IssueRecord) -> str:
    """Which path wrote the work order: "nemotron-lightning", "template" or "none"."""
    if issue.work_order is None:
        return "none"
    return "template" if issue.work_order.repair.startswith(TEMPLATE_REPAIR) else "nemotron-lightning"


def _previous_rating(issue_id: str) -> dict | None:
    """The newest rating row for this issue that an operator did not set (a model's grade), from the local log."""
    rows = [r for r in store._read_rating_log() if r.get("issue_id") == issue_id and r.get("model")
            and r.get("model") != OPERATOR]
    return max(rows, key=lambda r: store._rated_at(r) or datetime.min.replace(tzinfo=timezone.utc), default=None)


def update(issue_id: str, *, pinned: bool | None = None, severity: int | None = None,
           revert_severity: bool = False, name: str | None = None) -> IssueRecord | None:
    """Sync: pin/unpin, name or rename ("" clears), set an operator severity, or undo it.
    Returns the updated issue, None if unknown."""
    issue = store.get_issue(issue_id)
    if issue is None:
        return None
    if pinned is not None and bool(pinned) != issue.pinned:
        store.apply_pins([store.pin_row(issue_id, bool(pinned))])
    if name is not None and store.clean_name(name) != issue.name:
        store.apply_names([store.name_row(issue_id, name)])
    now = datetime.now(timezone.utc)
    if severity is not None:
        store.apply_ratings([operator_rating(issue, max(1, min(5, int(severity))), "Set by an operator.", now)])
    elif revert_severity and issue.severity_model == OPERATOR:
        if issue.source == "manual":
            original = issue.find_severity or issue.severity     # back to the grade given when it was marked
            row = operator_rating(issue, original, "Graded by the operator who marked it on the footage.", now)
        else:
            previous = _previous_rating(issue_id)
            if previous:                              # back to the model's grade, re-stamped so it is newest
                row = {**previous, "rated_at": now.isoformat()}
            else:
                from app.ai import rating
                row = rating.cleared_row(issue, now)
        store.apply_ratings([row])
    return store.get_issue(issue_id)
