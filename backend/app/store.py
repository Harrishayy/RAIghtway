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
from app.ai.prompts import URGENCY_FOR
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
RATINGS_FILE = "ratings.jsonl"     # append-only log of severity ratings, mirrored to the VastDB `ratings` table
PINS_FILE = "pins.jsonl"           # append-only log of pins ("include in the next plan"), mirrored to VastDB `pins`
NAMES_FILE = "names.jsonl"         # append-only log of operator names for issues, mirrored to VastDB `names`
NAME_MAX = 80
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
    """Called under _lock; live/provisional records are excluded."""
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


# ---- Severity ratings: an overlay on insert-only issue rows ----
# Issue rows in VastDB keep the find pass's severity. A rating (app/ai/rating.py) is a separate row
# {issue_id, severity, find_severity, reason, model, verdict, observed, rated_at}; the newest one per issue wins.
# A row with an empty model clears the rating and restores find_severity, so every re-grade is reversible.

def _rated_at(row: dict) -> datetime | None:
    try:
        value = row.get("rated_at")
        return _utc(value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except (TypeError, ValueError):
        return None


def apply_rating_row(issue: IssueRecord, row: dict) -> bool:
    """Apply one rating row to an issue in place unless the issue already holds a newer one."""
    when = _rated_at(row)
    if when is None or (issue.rated_at is not None and _utc(issue.rated_at) > when):
        return False
    original = issue.find_severity or row.get("find_severity") or issue.severity
    original = max(1, min(5, int(original)))
    if not row.get("model"):
        issue.severity, issue.find_severity = original, None
        issue.severity_reason = issue.severity_model = issue.verdict = None
    else:
        issue.find_severity = original
        issue.severity = max(1, min(5, int(row["severity"])))
        issue.severity_reason = row.get("reason") or None
        issue.severity_model = str(row["model"])
        issue.verdict = row.get("verdict") if row.get("verdict") in ("confirmed", "rejected") else None
    issue.rated_at = when
    if issue.work_order is not None:
        issue.work_order = issue.work_order.model_copy(update={"urgency": URGENCY_FOR(issue.severity)})
    return True


def _latest_ratings(rows: list[dict]) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for row in rows:
        when, id = _rated_at(row), row.get("issue_id")
        if when is None or not id:
            continue
        if id not in latest or _rated_at(latest[id]) <= when:
            latest[id] = row
    return latest


def _read_rating_log(name: str = RATINGS_FILE) -> list[dict]:
    path = Path(config.STATE_DIR) / name
    rows = []
    try:
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    rows.append(row)
            except ValueError:
                continue
    except FileNotFoundError:
        pass
    except Exception as exc:
        log.warning("Rating log unreadable (%s)", config.redact(exc))
    return rows


def append_rating_log(rows: list[dict], name: str = RATINGS_FILE) -> None:
    """Append rating rows to state/ratings.jsonl (sync; safe to call from a script with the API running)."""
    if not rows:
        return
    path = Path(config.STATE_DIR) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        for row in rows:
            f.write(json.dumps(row, default=str) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _load_ratings() -> list[dict]:
    rows = _read_rating_log()
    try:
        rows += importlib.import_module("app.vast.db").load_ratings()
    except Exception as exc:
        log.warning("VastDB ratings unavailable (%s); using the local rating log", config.redact(exc))
    return rows


def apply_ratings(rows: list[dict], persist: bool = True) -> int:
    """Apply rating rows to the live store; persist them to the log, VastDB and the snapshot. Returns how many applied."""
    applied = 0
    with _lock:
        for row in rows:
            for table in (_issues, _saved_issues):
                issue = table.get(row.get("issue_id"))
                if issue is not None and apply_rating_row(issue, row) and table is _issues:
                    applied += 1
        if persist and rows:
            try:
                append_rating_log(rows)
            except Exception as exc:
                log.warning("Rating log write failed (%s)", config.redact(exc))
            _snapshot()
            _enqueue("insert_ratings", [dict(r) for r in rows])
    return applied


# ---- Pins: "include in the next plan", an overlay on insert-only issue rows ----
# A pin row is {issue_id, pinned, by, pinned_at}; the newest one per issue wins, so unpinning is just a newer row.
# Rows go to state/pins.jsonl and the VastDB `pins` table, like ratings; issue rows are never rewritten.

def _pinned_at(row: dict) -> datetime | None:
    return _rated_at({"rated_at": row.get("pinned_at")})


def pin_row(issue_id: str, pinned: bool, by: str = "operator", when: datetime | None = None) -> dict:
    return {"issue_id": issue_id, "pinned": bool(pinned), "by": by,
            "pinned_at": (when or datetime.now(timezone.utc)).isoformat()}


def apply_pin_row(issue: IssueRecord, row: dict) -> bool:
    """Apply one pin row in place unless the issue already holds a newer one."""
    when = _pinned_at(row)
    if when is None or (issue.pinned_at is not None and _utc(issue.pinned_at) > when):
        return False
    issue.pinned, issue.pinned_at = bool(row.get("pinned")), when
    return True


def _latest_pins(rows: list[dict]) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for row in rows:
        when, id = _pinned_at(row), row.get("issue_id")
        if when is None or not id:
            continue
        if id not in latest or _pinned_at(latest[id]) <= when:
            latest[id] = row
    return latest


def _load_pins() -> list[dict]:
    rows = _read_rating_log(PINS_FILE)
    try:
        rows += importlib.import_module("app.vast.db").load_pins()
    except Exception as exc:
        log.warning("VastDB pins unavailable (%s); using the local pin log", config.redact(exc))
    return rows


def apply_pins(rows: list[dict], persist: bool = True) -> int:
    """Apply pin rows to the live store; persist them to the log, VastDB and the snapshot. Returns how many applied."""
    applied = 0
    with _lock:
        for row in rows:
            for table in (_issues, _saved_issues):
                issue = table.get(row.get("issue_id"))
                if issue is not None and apply_pin_row(issue, row) and table is _issues:
                    applied += 1
        if persist and rows:
            try:
                append_rating_log(rows, PINS_FILE)
            except Exception as exc:
                log.warning("Pin log write failed (%s)", config.redact(exc))
            _snapshot()
            _enqueue("insert_pins", [dict(r) for r in rows])
    return applied


# ---- Names: an operator's name for an issue, an overlay like pins ----
# A name row is {issue_id, name, by, named_at}; the newest one per issue wins and an empty name clears it.
# Rows go to state/names.jsonl and the VastDB `names` table; issue rows are never rewritten.

def clean_name(value) -> str | None:
    """Trimmed, whitespace-collapsed, at most NAME_MAX characters; None when empty."""
    text = " ".join(str(value or "").split())[:NAME_MAX].strip()
    return text or None


def _named_at(row: dict) -> datetime | None:
    return _rated_at({"rated_at": row.get("named_at")})


def name_row(issue_id: str, name: str | None, by: str = "operator", when: datetime | None = None) -> dict:
    return {"issue_id": issue_id, "name": clean_name(name) or "", "by": by,
            "named_at": (when or datetime.now(timezone.utc)).isoformat()}


def apply_name_row(issue: IssueRecord, row: dict) -> bool:
    """Apply one name row in place unless the issue already holds a newer one."""
    when = _named_at(row)
    if when is None or (issue.named_at is not None and _utc(issue.named_at) > when):
        return False
    issue.name, issue.named_at = clean_name(row.get("name")), when
    return True


def _latest_names(rows: list[dict]) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for row in rows:
        when, id = _named_at(row), row.get("issue_id")
        if when is None or not id:
            continue
        if id not in latest or _named_at(latest[id]) <= when:
            latest[id] = row
    return latest


def _load_names() -> list[dict]:
    rows = _read_rating_log(NAMES_FILE)
    try:
        rows += importlib.import_module("app.vast.db").load_names()
    except Exception as exc:
        log.warning("VastDB names unavailable (%s); using the local name log", config.redact(exc))
    return rows


def apply_names(rows: list[dict], persist: bool = True) -> int:
    """Apply name rows to the live store; persist them to the log, VastDB and the snapshot. Returns how many applied."""
    applied = 0
    with _lock:
        for row in rows:
            for table in (_issues, _saved_issues):
                issue = table.get(row.get("issue_id"))
                if issue is not None and apply_name_row(issue, row) and table is _issues:
                    applied += 1
        if persist and rows:
            try:
                append_rating_log(rows, NAMES_FILE)
            except Exception as exc:
                log.warning("Name log write failed (%s)", config.redact(exc))
            _snapshot()
            _enqueue("insert_names", [dict(r) for r in rows])
    return applied


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
            # On a tie the snapshot copy wins: VastDB rows keep only the core report columns.
            _report = max(reports, key=lambda r: (_utc(r.generated_at), r is snapshot_report), default=None)
            # The snapshot keeps the whole plan; VastDB plan rows lack paths, triage, sites and plan_id.
            _plan = _snapshot_plan(snapshot) or (plans[-1] if plans else None)
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
        ratings = _latest_ratings(_load_ratings())
        rated = sum(apply_rating_row(issue, ratings[issue.id]) for issue in issues if issue.id in ratings)
        if ratings:
            log.info("Severity ratings: %d rows, %d applied", len(ratings), rated)
        pins = _latest_pins(_load_pins())
        pinned = sum(apply_pin_row(issue, pins[issue.id]) for issue in issues if issue.id in pins)
        if pins:
            log.info("Pins: %d rows, %d applied", len(pins), pinned)
        names = _latest_names(_load_names())
        named = sum(apply_name_row(issue, names[issue.id]) for issue in issues if issue.id in names)
        if names:
            log.info("Names: %d rows, %d applied", len(names), named)
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


def _snapshot_plan(snapshot: dict) -> Plan | None:
    try:
        return Plan.model_validate(snapshot["plan"]) if snapshot.get("plan") else None
    except Exception as exc:
        log.warning("Snapshot plan invalid (%s)", config.redact(exc))
        return None


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


def canonical_issues(include_uploads_before_reset: bool = False, include_rejected: bool = True) -> list[IssueRecord]:
    """One record per real-world issue. Severity is the worst sighting that was not rejected (with that sighting's
    reason and rater); verdict is "rejected" only when every rated sighting was. Work-order urgency follows it."""
    with _lock:
        visible = [i for i in _issues.values() if include_uploads_before_reset or _visible(i)]
        groups: dict[str, list[IssueRecord]] = {i.id: [i] for i in visible if not i.duplicate_of}
        for issue in visible:
            if issue.duplicate_of in groups:
                groups[issue.duplicate_of].append(issue)
        result = []
        for id, sightings in groups.items():
            original = sightings[0].model_copy(deep=True, update={"sightings": len(sightings)})
            kept = [s for s in sightings if s.verdict != "rejected"]
            best = max(kept or sightings, key=lambda s: s.severity)    # max keeps the first on ties: the canonical
            if sightings[0].severity_model == "operator":              # an operator's grade beats every model's
                best = sightings[0]
            original.severity = best.severity
            if best is not sightings[0]:
                original.severity_reason, original.severity_model = best.severity_reason, best.severity_model
            original.pinned = any(s.pinned for s in sightings)    # a pin on any sighting pins the issue
            named = [s for s in sightings if s.named_at is not None]   # the newest name among the sightings
            if named:
                original.name = max(named, key=lambda s: _utc(s.named_at)).name
            if not kept:
                original.verdict = "rejected"
            elif any(s.verdict == "confirmed" for s in kept):
                original.verdict = "confirmed"
            elif original.verdict == "rejected":
                original.verdict = None              # rejected here, but a sighting not yet rated may show it
            if original.work_order is not None:
                original.work_order.urgency = URGENCY_FOR(original.severity)
            if include_rejected or original.verdict != "rejected":
                result.append(original)
        return sorted(result, key=lambda i: _utc(i.created_at))


def all_issues() -> list[IssueRecord]:
    """Every visible sighting, re-sightings included (copies)."""
    with _lock:
        return [i.model_copy(deep=True) for i in _issues.values() if _visible(i)]


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


def update_plan(p: Plan, persist: bool) -> bool:
    """Replace the latest plan if it is still the same plan (same plan_id). persist=False keeps it in memory only
    (progress the console polls); True also snapshots it and queues the VastDB row. False: a newer plan won."""
    global _plan
    with _lock:
        if _plan is None or _plan.plan_id != p.plan_id:
            return False
        _plan = p.model_copy(deep=True)
        if persist:
            _snapshot()
            _enqueue("insert_plan", p.model_copy(deep=True))
        return True


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
