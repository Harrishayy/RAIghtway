"""Detections -> IssueRecords, marking re-sightings in-clip first, then against corpus history.

Sync: call assign() through asyncio.to_thread. Calibrate on the VM with
`python -m app.pipeline.dedupe --pairs a.jpg:b.jpg ...`.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import logging
import math
from pathlib import Path
import shutil
from uuid import uuid4

from app import config, store
from app.models import Detection, IssueRecord, VideoRecord
from app.pipeline.segment import PIECE_S

log = logging.getLogger(__name__)
try:
    from app.vast import media, vector
except Exception as exc:
    log.warning("app.vast media/vector unavailable (%s)", config.redact(exc))
    media = vector = None

DEDUPE_MODE = "vector"     # "vector": category + 35 m + cosine >= DEDUPE_SIM; "distance": category + 35 m only
DEDUPE_SIM = 0.80          # placeholder until calibrated on the VM
RADIUS_M = 35.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(min(1.0, a)))


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def _box(lat: float, lon: float, metres: float = RADIUS_M) -> tuple[float, float, float, float]:
    dlat = metres / 111_320
    dlon = metres / (111_320 * max(0.01, math.cos(math.radians(lat))))
    return lat - dlat, lat + dlat, lon - dlon, lon + dlon


def _near(det: Detection, other: IssueRecord) -> float | None:
    """Distance in metres if the pair can be a re-sighting by place and category, else None."""
    if det.category != other.category or None in (det.lat, det.lon, other.lat, other.lon):
        return None
    distance = haversine_m(det.lat, det.lon, other.lat, other.lon)
    return distance if distance <= RADIUS_M else None


def _match_in_clip(det: Detection, earlier: list[IssueRecord]) -> str | None:
    best, best_score = None, None
    for other in earlier:
        distance = _near(det, other)
        if distance is None:
            continue
        if DEDUPE_MODE == "distance":
            score = -distance
        else:
            if det.embedding is None or other.embedding is None:
                continue
            score = cosine(det.embedding, other.embedding)
            if score < DEDUPE_SIM:
                continue
        if best_score is None or score > best_score:
            best, best_score = other, score
    return (best.duplicate_of or best.id) if best else None


def _history(issue: IssueRecord | None, video_id: str) -> bool:
    """Saved corpus canonical issues from other videos; uploads and provisional pins never count."""
    return bool(issue and issue.source == "corpus" and not issue.duplicate_of
                and not issue.id.startswith("p-") and issue.video_id != video_id)


def _match_history(det: Detection, video_id: str) -> str | None:
    if DEDUPE_MODE == "distance":
        candidates = [(i, _near(det, i)) for i in store.canonical_issues() if _history(i, video_id)]
        candidates = [(i, d) for i, d in candidates if d is not None]
        return min(candidates, key=lambda c: c[1])[0].id if candidates else None
    if det.embedding is None or vector is None:
        return None
    hits = vector.nearest(det.embedding, category=det.category, bbox=_box(det.lat, det.lon),
                          source="corpus", canonical_only=True, k=5)
    for issue_id, distance in hits:  # nearest first
        if 1 - distance < DEDUPE_SIM:
            break
        other = store.get_issue(issue_id)
        if _history(other, video_id) and _near(det, other) is not None:
            return other.id
    return None


def cache_frame(issue_id: str, frame_path: str | None) -> bool:
    """Copy a keyframe into STATE_DIR/frames/{id}.jpg, which GET /api/frames serves first."""
    if not frame_path:
        return False
    try:
        target = Path(config.STATE_DIR) / "frames" / f"{issue_id}.jpg"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(frame_path, target)
        return True
    except OSError as exc:
        log.warning("Frame cache copy failed (%s)", config.redact(exc))
        return False


def _put_frame(issue_id: str, frame_path: str | None) -> str:
    if not frame_path or media is None:
        return ""
    try:
        return media.put_frame(issue_id, Path(frame_path).read_bytes())
    except Exception as exc:
        log.warning("put_frame failed for %s (%s); local copy kept", issue_id, config.redact(exc))
        return ""


def record(det: Detection, video: VideoRecord, id: str, t: float, duplicate_of: str | None = None,
           frame_key: str = "") -> IssueRecord:
    return IssueRecord(id=id, video_id=video.id, t=round(t, 2), category=det.category,
                       severity=max(1, min(5, det.severity)), confidence=det.confidence,
                       description=det.description, frame_url=f"/api/frames/{id}", bbox=det.bbox,
                       lat=det.lat, lon=det.lon, duplicate_of=duplicate_of, source=video.source,
                       frame_key=frame_key, created_at=datetime.now(timezone.utc), embedding=det.embedding)


def assign(detections: list[Detection], video: VideoRecord, *, use_history: bool = True,
           time_offset_s: float = 0.0) -> list[IssueRecord]:
    """Video time t = time_offset_s + piece_index * 5 + t_piece."""
    ordered = sorted(detections, key=lambda d: (d.piece_index, d.t_piece))
    records: list[IssueRecord] = []
    in_clip = history = 0
    for det in ordered:
        duplicate_of = None
        if det.lat is not None and det.lon is not None:
            duplicate_of = _match_in_clip(det, records)
            if duplicate_of:
                in_clip += 1
            elif use_history:
                try:
                    duplicate_of = _match_history(det, video.id)
                except Exception as exc:
                    log.warning("History match failed (%s)", config.redact(exc))
                history += bool(duplicate_of)
        t = time_offset_s + det.piece_index * PIECE_S + det.t_piece
        records.append(record(det, video, uuid4().hex[:12], t, duplicate_of))
    frames = [det.frame_path for det in ordered]
    for issue, frame in zip(records, frames):
        cache_frame(issue.id, frame)
    if records:
        with ThreadPoolExecutor(max_workers=6) as pool:
            keys = list(pool.map(_put_frame, [r.id for r in records], frames))
        for issue, key in zip(records, keys):
            issue.frame_key = key
    log.info("dedupe video=%s mode=%s detections=%d in-clip=%d history=%d",
             video.id, DEDUPE_MODE, len(records), in_clip, history)
    return records


async def _pair_similarity(a: str, b: str) -> float:
    from app.ai import embed
    from app.pipeline import segment
    work = segment.work_dir("calib-")
    try:
        vectors = []
        for n, jpg in enumerate((a, b)):
            crop = segment.crop(jpg, None, str(work / f"{n}.jpg"))
            vectors.append(await embed.embed_clip(segment.still_clip(crop, str(work / f"{n}.mp4"))))
        return cosine(*vectors)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _main() -> None:
    import argparse
    import asyncio
    parser = argparse.ArgumentParser(description="Cosine similarity of still-clip embeddings, to calibrate DEDUPE_SIM")
    parser.add_argument("--pairs", nargs="+", required=True, metavar="A.jpg:B.jpg",
                        help="pass crops (or whole frames) of the same/different issues")
    args = parser.parse_args()

    async def run():
        for pair in args.pairs:
            a, _, b = pair.partition(":")
            try:
                print(f"{await _pair_similarity(a, b):.4f}  {a}  {b}")
            except Exception as exc:
                print(f"error   {a}  {b}  ({config.redact(exc)})")
    asyncio.run(run())
    print(f"current DEDUPE_SIM={DEDUPE_SIM} mode={DEDUPE_MODE}")


if __name__ == "__main__":
    _main()
