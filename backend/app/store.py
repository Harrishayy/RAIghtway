"""Thread-safe API state, atomic snapshots, and ordered background DB writes."""
from datetime import datetime, timezone
import importlib
import json
import logging
import os
from pathlib import Path
from queue import Queue
import tempfile
from threading import RLock, Thread

from app import config
from app.models import IssueRecord, Plan, Report, VideoRecord

log = logging.getLogger(__name__)
_lock = RLock()
_videos: dict[str, VideoRecord] = {}
_issues: dict[str, IssueRecord] = {}
_done_videos: dict[str, VideoRecord] = {}
_saved_issues: dict[str, IssueRecord] = {}
_provisional: set[str] = set()
_report: Report | None = None
_plan: Plan | None = None
_cutoff: datetime | None = None
_source = "empty"
_writes: Queue = Queue()
_worker: Thread | None = None


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _visible(record) -> bool:
    return not (_cutoff and record.source == "upload" and _utc(record.created_at) < _cutoff)


def _write_worker() -> None:
    while True:
        name, value = _writes.get()
        try:
            getattr(importlib.import_module("app.vast.db"), name)(value)
        except Exception as exc:
            log.warning("VastDB %s failed (%s); snapshot retained", name, config.redact(exc))
        finally:
            _writes.task_done()


def _enqueue(name: str, value) -> None:
    global _worker
    if _worker is None:
        _worker = Thread(target=_write_worker, name="citymaint-db-writes", daemon=True)
        _worker.start()
    _writes.put((name, value))


def _snapshot() -> None:
    """Called under _lock; fixtures and live/provisional records are excluded."""
    path = Path(config.STATE_DIR) / "snapshot.json"
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "videos": [v.model_dump(mode="json") for v in _done_videos.values()],
            "issues": [i.model_dump(mode="json") for i in _saved_issues.values()],
            "report": _report.model_dump(mode="json") if _report else None,
            "plan": _plan.model_dump(mode="json") if _plan else None,
            "reset_cutoff": _cutoff.isoformat() if _cutoff else None,
        }
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, suffix=".tmp", delete=False) as f:
            temporary = f.name
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    except Exception as exc:
        log.warning("Snapshot write failed (%s)", config.redact(exc))
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def _index(issues: list[IssueRecord]) -> None:
    for issue in issues:
        if issue.embedding is None:
            continue
        try:
            vector = importlib.import_module("app.vast.vector")
            vector.add(issue.id, issue.embedding, {
                "category": issue.category, "source": issue.source,
                "lat": issue.lat, "lon": issue.lon, "duplicate_of": issue.duplicate_of,
            })
        except Exception as exc:
            log.warning("Vector add failed (%s)", config.redact(exc))


def load() -> None:
    """Merge VastDB with the local snapshot, retaining locally persisted records."""
    global _report, _plan, _cutoff, _source
    with _lock:
        snapshot = {}
        try:
            snapshot = json.loads((Path(config.STATE_DIR) / "snapshot.json").read_text())
            if not isinstance(snapshot, dict):
                raise ValueError("Invalid snapshot")
        except FileNotFoundError:
            pass
        except Exception as exc:
            snapshot = {}
            log.warning("Snapshot read failed (%s)", config.redact(exc))
        try:
            _cutoff = _utc(datetime.fromisoformat(snapshot["reset_cutoff"])) if snapshot.get("reset_cutoff") else None
        except (ValueError, TypeError):
            _cutoff = None
        try:
            db = importlib.import_module("app.vast.db")
            data = db.load_all()
            embeddings = db.load_embeddings()
            videos = [VideoRecord.model_validate(v).model_copy(deep=True) for v in data["videos"]]
            issues = [IssueRecord.model_validate(i).model_copy(deep=True) for i in data["issues"]]
            for issue in issues:
                embedding = embeddings.get(issue.id)
                if embedding is not None:
                    issue.embedding = [float(x) for x in embedding]
            reports = [Report.model_validate(r) for r in data["reports"]]
            plans = [Plan.model_validate(p) for p in data["plans"]]
            try:
                snapshot_videos = {v["id"]: VideoRecord.model_validate(v) for v in snapshot.get("videos", [])}
                snapshot_issues = {i["id"]: IssueRecord.model_validate(i) for i in snapshot.get("issues", [])}
                snapshot_report = Report.model_validate(snapshot["report"]) if snapshot.get("report") else None
            except Exception as snapshot_exc:
                log.warning("Snapshot validation failed (%s)", config.redact(snapshot_exc))
                snapshot_videos, snapshot_issues, snapshot_report = {}, {}, None
            snapshot_only_videos = snapshot_videos.keys() - {v.id for v in videos}
            snapshot_only_issues = snapshot_issues.keys() - {i.id for i in issues}
            snapshot_contributed = bool(snapshot_only_videos or snapshot_only_issues)
            for issue in issues:
                saved = snapshot_issues.get(issue.id)
                if issue.embedding is None and saved and saved.embedding is not None:
                    issue.embedding = saved.embedding.copy()
                    snapshot_contributed = True
            log.info("Store loaded: vastdb videos=%d issues=%d, snapshot-only videos=%d issues=%d",
                     len(videos), len(issues), len(snapshot_only_videos), len(snapshot_only_issues))
            videos = list((snapshot_videos | {v.id: v for v in videos}).values())
            issues = list((snapshot_issues | {i.id: i for i in issues}).values())
            if snapshot_report:
                reports.append(snapshot_report)
            _report = max(reports, key=lambda r: _utc(r.generated_at), default=None)
            _plan = plans[-1] if plans else None
            if _cutoff:
                if _report and _utc(_report.generated_at) < _cutoff:
                    _report = None
                # Plans have no timestamp; only the local snapshot knows reset order.
                _plan = Plan.model_validate(snapshot["plan"]) if snapshot.get("plan") else None
            if _report is not None and _report is snapshot_report:
                snapshot_contributed = True
            _source = "vastdb+snapshot" if snapshot_contributed else "vastdb"
        except Exception as exc:
            log.warning("VastDB load failed (%s); trying snapshot", config.redact(exc))
            try:
                videos = [VideoRecord.model_validate(v) for v in snapshot.get("videos", [])]
                issues = [IssueRecord.model_validate(i) for i in snapshot.get("issues", [])]
                _report = Report.model_validate(snapshot["report"]) if snapshot.get("report") else None
                _plan = Plan.model_validate(snapshot["plan"]) if snapshot.get("plan") else None
                _source = "snapshot" if snapshot else "empty"
            except Exception as snapshot_exc:
                log.warning("Snapshot validation failed (%s)", config.redact(snapshot_exc))
                videos, issues, _report, _plan = [], [], None, None
                _source = "empty"
        if _cutoff and _report and _utc(_report.generated_at) < _cutoff:
            _report = None
        _videos.clear()
        _issues.clear()
        _done_videos.clear()
        _saved_issues.clear()
        _provisional.clear()
        for video in videos:
            if video.status == "done":
                _videos[video.id] = video
                _done_videos[video.id] = video.model_copy(deep=True)
        for issue in issues:
            _issues[issue.id] = issue
            _saved_issues[issue.id] = issue.model_copy(deep=True)
        _index(list(_issues.values()))
        if _source in ("vastdb", "vastdb+snapshot"):
            _snapshot()
        log.info("Store loaded from %s", _source)


def source() -> str:
    with _lock:
        return _source


def _persist_done(video: VideoRecord) -> None:
    if video.status == "done" and video.id not in _done_videos:
        saved = video.model_copy(deep=True)
        _done_videos[video.id] = saved
        _snapshot()
        _enqueue("insert_videos", [saved.model_copy(deep=True)])


def add_video(v: VideoRecord) -> None:
    with _lock:
        _videos[v.id] = v.model_copy(deep=True)
        _persist_done(_videos[v.id])


def set_progress(video_id: str, *, status=None, progress=None, stage=None) -> None:
    fields = {k: v for k, v in {"status": status, "progress": progress, "stage": stage}.items() if v is not None}
    update_video(video_id, **fields)


def update_video(video_id: str, **fields) -> None:
    with _lock:
        video = VideoRecord.model_validate({**_videos[video_id].model_dump(), **fields})
        _videos[video_id] = video
        _persist_done(video)


def get_video(id: str) -> VideoRecord | None:
    with _lock:
        video = _videos.get(id)
        if video is None or not _visible(video):
            return None
        result = video.model_copy(deep=True)
        # VastDB video rows do not store issue_ids; rebuild them from the read model.
        result.issue_ids = [i.id for i in _issues.values() if i.video_id == id and _visible(i)]
        return result


def list_videos() -> list[VideoRecord]:
    with _lock:
        return [get_video(v.id) for v in sorted(_videos.values(), key=lambda v: _utc(v.created_at)) if _visible(v)]


def add_issues(issues: list[IssueRecord], provisional: bool = False) -> None:
    with _lock:
        saved = []
        for issue in issues:
            if issue.id in _saved_issues:
                continue  # Insert-only records are immutable once persisted.
            record = issue.model_copy(deep=True)
            _issues[record.id] = record
            if provisional:
                _provisional.add(record.id)
            else:
                _provisional.discard(record.id)
                _saved_issues[record.id] = record.model_copy(deep=True)
                saved.append(record.model_copy(deep=True))
        if not provisional:
            _snapshot()
            if saved:
                _enqueue("insert_issues", saved)
                _index(saved)


def replace_provisional(video_id: str, issues: list[IssueRecord]) -> None:
    with _lock:
        for id in list(_provisional):
            if _issues[id].video_id == video_id:
                del _issues[id]
                _provisional.remove(id)
        add_issues(issues)


def get_issue(id: str) -> IssueRecord | None:
    with _lock:
        issue = _issues.get(id)
        return issue.model_copy(deep=True) if issue and _visible(issue) else None


def canonical_issues(include_uploads_before_reset: bool = False) -> list[IssueRecord]:
    with _lock:
        visible = [i for i in _issues.values() if include_uploads_before_reset or _visible(i)]
        canonical = {i.id: i.model_copy(deep=True, update={"sightings": 1}) for i in visible if not i.duplicate_of}
        for issue in visible:
            original = canonical.get(issue.duplicate_of)
            if original:
                original.sightings += 1
                original.severity = max(original.severity, issue.severity)
        return sorted(canonical.values(), key=lambda i: _utc(i.created_at))


def issues_for_video(video_id: str) -> list[IssueRecord]:
    with _lock:
        video = _videos.get(video_id)
        if video and not _visible(video):
            return []
        return [i.model_copy(deep=True) for i in _issues.values() if i.video_id == video_id and _visible(i)]


def set_report(r: Report) -> None:
    global _report
    with _lock:
        if _report == r:
            return
        _report = r.model_copy(deep=True)
        _snapshot()
        _enqueue("insert_report", r.model_copy(deep=True))


def latest_report() -> Report | None:
    with _lock:
        return _report.model_copy(deep=True) if _report else None


def set_plan(p: Plan) -> None:
    global _plan
    with _lock:
        if _plan == p:
            return
        _plan = p.model_copy(deep=True)
        _snapshot()
        _enqueue("insert_plan", p.model_copy(deep=True))


def latest_plan() -> Plan | None:
    with _lock:
        return _plan.model_copy(deep=True) if _plan else None


def reset_cutoff() -> datetime | None:
    with _lock:
        return _cutoff


def reset() -> datetime:
    global _cutoff, _report, _plan
    with _lock:
        _cutoff = datetime.now(timezone.utc)
        _report, _plan = None, None
        _snapshot()
        return _cutoff


def seed_memory(videos: list[VideoRecord], issues: list[IssueRecord]) -> None:
    """Development fixtures only: never snapshot, enqueue, or index these records."""
    with _lock:
        if _videos or _issues:
            return
        _videos.update((v.id, v.model_copy(deep=True)) for v in videos)
        _issues.update((i.id, i.model_copy(deep=True)) for i in issues)
