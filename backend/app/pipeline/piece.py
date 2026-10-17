"""One 5 s piece: find -> per issue (frame, box, crop, embed, locate) -> Detections. Source-agnostic."""
import asyncio
import inspect
import logging
from pathlib import Path

from app import config
from app.ai import cosmos, embed
from app.models import Detection
from app.pipeline import segment

log = logging.getLogger(__name__)
try:
    from app.geo import gps
except Exception as exc:  # TODO(agent4): app.geo.gps lands in parallel; until then lat/lon stay None.
    log.warning("app.geo.gps unavailable (%s); detections have no location", config.redact(exc))
    gps = None


class FindFailed(RuntimeError):
    """Cosmos find errored (not merely 'no issues'). Raised only with strict=True."""


async def _maybe(fn, *args):
    """Call a sync teammate function in a thread; await it if it turns out to be async."""
    if inspect.iscoroutinefunction(fn):
        return await fn(*args)
    result = await asyncio.to_thread(fn, *args)
    return await result if inspect.isawaitable(result) else result


async def locate(drive: str | None, t: float) -> tuple[float, float, float] | None:
    if not drive or gps is None:
        return None
    try:
        return await _maybe(gps.locate, drive, t)
    except Exception as exc:
        log.warning("gps.locate failed (%s)", config.redact(exc))
        return None


async def _find(piece_path: str, strict: bool):
    # cosmos.find_issues never raises; its diagnostics say whether an empty result was a failure.
    diagnostics = getattr(cosmos, "_find_diagnostics", None)
    before = diagnostics.get() if diagnostics is not None else None
    result = await cosmos.find_issues(piece_path)
    after = diagnostics.get() if diagnostics is not None else None
    if strict and isinstance(after, dict) and after is not before and not after.get("ok"):
        raise FindFailed(f"Cosmos find failed for {Path(piece_path).name}")
    return result


async def _detail(det: Detection, n: int, piece_path: str, original_path: str, piece_index: int,
                  piece_offset_s: float, drive: str | None, clip_start_s: float) -> Detection:
    det.piece_index = piece_index
    stem = Path(piece_path).parent / f"p{piece_index:03d}_{n:02d}"
    t_original = piece_offset_s + det.t_piece

    async def visual():
        try:
            frame = await asyncio.to_thread(segment.extract_frame, original_path, t_original, f"{stem}_frame.jpg")
        except Exception as exc:
            log.warning("Frame extract failed piece=%d (%s)", piece_index, config.redact(exc))
            return
        det.frame_path = frame
        det.bbox = await cosmos.box(frame, det.category, det.description)
        try:
            crop = await asyncio.to_thread(segment.crop, frame, det.bbox, f"{stem}_crop.jpg")
            clip = await asyncio.to_thread(segment.still_clip, crop, f"{stem}_crop.mp4")
            det.embedding = await embed.embed_clip(clip)
        except Exception as exc:
            log.warning("Embedding failed piece=%d (%s)", piece_index, config.redact(exc))
            det.embedding = None

    async def where():
        position = await locate(drive, clip_start_s + t_original)
        if position:
            det.lat, det.lon, det.heading = position

    await asyncio.gather(visual(), where())
    return det


async def process_piece(piece_path: str, original_path: str, piece_index: int, piece_offset_s: float,
                        drive: str | None, clip_start_s: float, *, strict: bool = False) -> list[Detection]:
    """Detections for one piece. Keyframes come from original_path at piece_offset_s + t_piece
    (corpus segments: original_path is the 1080p segment and piece_offset_s is 0).
    Work files go next to piece_path. strict=True raises FindFailed when Cosmos errors (live replay)."""
    found = await _find(piece_path, strict)
    results = await asyncio.gather(*(
        _detail(det, n, piece_path, original_path, piece_index, piece_offset_s, drive, clip_start_s)
        for n, det in enumerate(found.issues)), return_exceptions=True)
    detections = []
    for det, result in zip(found.issues, results):
        if isinstance(result, BaseException):
            # One issue failing keeps the bare finding rather than killing the piece.
            log.warning("Issue detail failed piece=%d (%s)", piece_index, config.redact(result))
            det.piece_index = piece_index
            detections.append(det)
        else:
            detections.append(result)
    return detections
