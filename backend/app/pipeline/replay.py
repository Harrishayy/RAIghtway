"""Replay fallback for uploads: the saved result of an earlier run of the same file (by sha256).

A run is {"timings": [{"stage", "progress", "t"}], "issues": [IssueRecord json],
"explanation", "track", "duration_s"}; it lives in STATE_DIR/replays/{hash}.json, with the
issues' keyframes copied to STATE_DIR/replays/{hash}/{id}.jpg.
"""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4

from app import config, store
from app.models import IssueRecord

log = logging.getLogger(__name__)
FAST_STEP_S = 0.3          # pace for stages the live run already spent longer than


def _dir() -> Path:
    return Path(config.STATE_DIR) / "replays"


def _valid(clip_hash: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{64}", clip_hash or ""))


def file_hash(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def lookup(clip_hash: str) -> dict | None:
    if not _valid(clip_hash):
        return None
    try:
        run = json.loads((_dir() / f"{clip_hash}.json").read_text())
        return run if isinstance(run, dict) and isinstance(run.get("issues"), list) else None
    except FileNotFoundError:
        return None
    except Exception as exc:
        log.warning("Replay read failed (%s)", config.redact(exc))
        return None


def save(clip_hash: str, run: dict) -> None:
    if not _valid(clip_hash):
        return
    folder = _dir() / clip_hash
    folder.mkdir(parents=True, exist_ok=True)
    for issue in run.get("issues", []):
        frame = Path(config.STATE_DIR) / "frames" / f"{issue['id']}.jpg"
        if frame.is_file():
            shutil.copyfile(frame, folder / frame.name)
    path = _dir() / f"{clip_hash}.json"
    with tempfile.NamedTemporaryFile("w", dir=_dir(), suffix=".tmp", delete=False) as f:
        json.dump({**run, "saved_at": datetime.now(timezone.utc).isoformat()}, f)
        temporary = f.name
    os.replace(temporary, path)
    log.info("Replay saved %s (%d issues)", clip_hash[:12], len(run.get("issues", [])))


def _restore(clip_hash: str, run: dict, video_id: str) -> list[IssueRecord]:
    """Fresh ids (stored records are insert-only), in-clip duplicate_of remapped, frames re-cached."""
    issues = [IssueRecord.model_validate(i) for i in run["issues"]]
    ids = {i.id: uuid4().hex[:12] for i in issues}
    now = datetime.now(timezone.utc)
    frames = Path(config.STATE_DIR) / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    restored = []
    for issue in issues:
        new = ids[issue.id]
        for source in (_dir() / clip_hash / f"{issue.id}.jpg", frames / f"{issue.id}.jpg"):
            if source.is_file():
                shutil.copyfile(source, frames / f"{new}.jpg")
                break
        # frame_key still points at the old S3 object / db row, which stays valid.
        restored.append(issue.model_copy(update={
            "id": new, "video_id": video_id, "frame_url": f"/api/frames/{new}", "created_at": now,
            "duplicate_of": ids.get(issue.duplicate_of, issue.duplicate_of)}))
    return restored


async def play(video_id: str, clip_hash: str, run: dict, *, elapsed_s: float = 0.0) -> list[IssueRecord]:
    """Re-run the saved stages at their recorded pace (stages already overdue go fast),
    then commit the saved result. Ends with stage "done (replayed)"."""
    log.info("Replaying %s for video %s", clip_hash[:12], video_id)
    clock = 0.0
    for step in run.get("timings", []):
        if step.get("stage") == "done":
            continue
        t = float(step.get("t", 0))
        await asyncio.sleep(t - max(clock, elapsed_s) if t > elapsed_s else FAST_STEP_S)
        clock = max(clock, t)
        await asyncio.to_thread(store.set_progress, video_id, status="analysing",
                                progress=float(step.get("progress", 0)), stage=step.get("stage"))
    issues = await asyncio.to_thread(_restore, clip_hash, run, video_id)
    await asyncio.to_thread(store.replace_provisional, video_id, issues)
    await asyncio.to_thread(store.update_video, video_id, explanation=run.get("explanation"),
                            issue_ids=[i.id for i in issues], track=run.get("track") or [],
                            duration_s=float(run.get("duration_s") or 0))
    await asyncio.to_thread(store.set_progress, video_id, status="done", progress=1.0, stage="done (replayed)")
    return issues
