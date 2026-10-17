"""City maintenance API; teammate modules plug into the guarded imports below."""
import asyncio
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import importlib
import inspect
import logging
import os
from pathlib import Path
import re
import shutil
from types import SimpleNamespace
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import config, store
from app.models import CREW_FOR, Crew, Issue, IssueRecord, Plan, Report, Route, Video, VideoRecord

if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

log = logging.getLogger(__name__)
_analysis_tasks: set[asyncio.Task] = set()


def _parse_upload_name(filename: str) -> tuple[str, float] | None:
    # TODO(agent4): replaced by app.geo.gps when available.
    match = re.fullmatch(r"(set\d+)_(video_\d+)_t(\d+(?:\.\d+)?)\.mp4", filename, re.IGNORECASE)
    return (f"{match[1]}/{match[2]}", float(match[3])) if match else None


async def _analyse_video(video_id: str, path: str, *, source: str, drive: str | None,
                         start_s: float, on_progress=None) -> None:
    # TODO(agent5): simulated stages until the live pipeline lands.
    stages = ["segmenting", "checking 1/4", "checking 2/4", "checking 3/4",
              "checking 4/4", "checking history", "planning repairs"]
    for index, stage in enumerate(stages):
        await asyncio.to_thread(store.set_progress, video_id, status="analysing",
                                progress=index / len(stages), stage=stage)
        await asyncio.sleep(5 / len(stages))
    await asyncio.to_thread(store.set_progress, video_id, status="done", progress=1.0, stage="done")


async def _regenerate() -> Report:
    # TODO(agent7): template report until the planning module lands.
    issues = store.canonical_issues()
    counts = dict(Counter(i.category for i in issues))
    return Report(generated_at=datetime.now(timezone.utc),
                  summary=f"{len(issues)} maintenance issues across {len(counts)} categories await review.",
                  counts=counts, crews={CREW_FOR[c]: 1 for c in counts},
                  rationale="One crew per category present; prioritise higher severity issues.")


async def _dispatch_plan(crews: dict[Crew, int]) -> Plan:
    # TODO(agent7): naive routes until the dispatch module lands.
    issues = store.canonical_issues()
    routes, assigned = [], set()
    for crew, count in crews.items():
        eligible = [i for i in issues if CREW_FOR[i.category] == crew and i.lat is not None and i.lon is not None]
        for number in range(min(count, len(eligible))):
            stops = eligible[number::count]
            routes.append(Route(crew_id=f"{crew}-{number + 1}", crew=crew,
                                stops=[i.id for i in stops],
                                eta_min=[15 * (index + 1) for index in range(len(stops))],
                                path=[(i.lat, i.lon) for i in stops]))
            assigned.update(i.id for i in stops)
    return Plan(routes=routes, unassigned=[i.id for i in issues if i.id not in assigned],
                solver="fallback", solve_ms=0)


async def _precompute_noop() -> None:
    # TODO(agent6): replaced by the corpus precompute controller.
    pass


def _precompute_status() -> dict:
    # TODO(agent6): replaced by the corpus precompute controller.
    return {"running": False, "stub": True}


try:
    from app.geo.gps import parse_upload_name
except ImportError:
    parse_upload_name = _parse_upload_name
try:
    from app.pipeline.live import analyse_video
except ImportError:
    analyse_video = _analyse_video
try:
    from app.planning import report
except ImportError:
    report = SimpleNamespace(regenerate=_regenerate)
try:
    from app.planning import dispatch
except ImportError:
    dispatch = SimpleNamespace(plan=_dispatch_plan)
try:
    from app.pipeline import precompute
except ImportError:
    precompute = SimpleNamespace(start=_precompute_noop, stop=_precompute_noop, status=_precompute_status)


async def _invoke(function, *args, **kwargs):
    if inspect.iscoroutinefunction(function):
        return await function(*args, **kwargs)
    result = await asyncio.to_thread(function, *args, **kwargs)
    return await result if inspect.isawaitable(result) else result


def _startup_call(module: str, name: str) -> None:
    try:
        getattr(importlib.import_module(module), name)()
    except Exception as exc:
        log.warning("Startup %s.%s failed (%s)", module, name, config.redact(exc))


def _seed_fixtures() -> None:
    now = datetime.now(timezone.utc)
    videos = [VideoRecord(id=f"demo-video-{n}", filename=f"toronto_corpus_{n}.mp4", source="corpus",
                          status="done", progress=1, stage="done", created_at=now, duration_s=30,
                          track=[(43.650, -79.385), (43.654, -79.377)]) for n in (1, 2)]
    categories = ["pavement", "graffiti", "markings", "work_zone", "signage", "waste", "pavement", "pavement"]
    issues = []
    for index, category in enumerate(categories):
        id = f"demo-issue-{index + 1}"
        video = videos[index // 4]
        issue = IssueRecord(id=id, video_id=video.id, t=float(index % 4 * 5), category=category,
                            severity=1 + index % 5, confidence=0.9,
                            description=f"Demo {category.replace('_', ' ')} maintenance finding",
                            frame_url=f"/api/frames/{id}", frame_key="", bbox=None,
                            lat=43.650 + index * 0.0005, lon=-79.385 + index * 0.001,
                            duplicate_of="demo-issue-1" if index == 7 else None,
                            source="corpus", created_at=now)
        issues.append(issue)
        video.issue_ids.append(id)
    store.seed_memory(videos, issues)


@asynccontextmanager
async def lifespan(app: FastAPI):
    for module, name in (("app.ai.weave_setup", "init"), ("app.vast.db", "ensure_tables"), ("app.store", "load")):
        await asyncio.to_thread(_startup_call, module, name)
    if os.environ.get("DEMO_FIXTURES") == "1":
        await asyncio.to_thread(_seed_fixtures)
    yield
    tasks = list(_analysis_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    try:
        await asyncio.wait_for(_invoke(precompute.stop), timeout=5)
    except Exception as exc:
        log.warning("Precompute shutdown failed (%s)", config.redact(exc))


app = FastAPI(title="City Maintenance", lifespan=lifespan)


def _video(record: VideoRecord) -> Video:
    return Video.model_validate(record.model_dump(include=set(Video.model_fields)))


def _issue(record: IssueRecord) -> Issue:
    return Issue.model_validate(record.model_dump(include=set(Issue.model_fields)))


def _require_video(id: str) -> VideoRecord:
    video = store.get_video(id)
    if video is None:
        raise HTTPException(404, "Video not found")
    return video


def _require_issue(id: str) -> IssueRecord:
    issue = store.get_issue(id)
    if issue is None:
        raise HTTPException(404, "Issue not found")
    return issue


async def _run_analysis(video: VideoRecord, path: str) -> None:
    try:
        await _invoke(analyse_video, video.id, path, source=video.source,
                      drive=video.drive, start_s=video.start_s)
    except asyncio.CancelledError:
        await asyncio.to_thread(store.set_progress, video.id, status="failed", stage="Analysis interrupted by shutdown")
        raise
    except Exception as exc:
        log.warning("Video analysis failed (%s)", config.redact(exc))
        await asyncio.to_thread(store.set_progress, video.id, status="failed",
                                stage=f"Analysis failed: {config.redact(exc)}")


@app.post("/api/videos", response_model=Video)
async def upload_video(file: UploadFile = File(...)):
    filename = Path((file.filename or "upload.mp4").replace("\\", "/")).name
    if not filename.lower().endswith(".mp4"):
        await file.close()
        raise HTTPException(400, "Upload an MP4 file")
    id = str(uuid4())
    path = Path(config.STATE_DIR) / "uploads" / f"{id}.mp4"

    def save():
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as target:
            shutil.copyfileobj(file.file, target)

    try:
        await asyncio.to_thread(save)
    except OSError:
        raise HTTPException(503, "Upload storage unavailable") from None
    finally:
        await file.close()
    try:
        parsed = await _invoke(parse_upload_name, filename)
    except Exception as exc:
        log.warning("Upload GPS parsing failed (%s)", config.redact(exc))
        parsed = _parse_upload_name(filename)
    drive, start_s = parsed if parsed else (None, 0.0)
    video = VideoRecord(id=id, filename=filename, source="upload", status="queued", progress=0,
                        stage="queued", drive=drive, start_s=start_s, created_at=datetime.now(timezone.utc))
    await asyncio.to_thread(store.add_video, video)
    task = asyncio.create_task(_run_analysis(video, str(path)))
    _analysis_tasks.add(task)
    task.add_done_callback(_analysis_tasks.discard)
    return _video(video)


@app.get("/api/videos", response_model=list[Video])
def videos():
    return [_video(v) for v in store.list_videos()]


class VideoDetail(BaseModel):
    video: Video
    issues: list[Issue]


@app.get("/api/videos/{id}", response_model=VideoDetail)
def video_detail(id: str):
    video = _require_video(id)
    return VideoDetail(video=_video(video), issues=[_issue(i) for i in store.issues_for_video(id)])


@app.get("/api/issues", response_model=list[Issue])
def issues():
    return [_issue(i) for i in store.canonical_issues()]


@app.get("/api/issues/{id}/similar", response_model=list[Issue])
def similar_issues(id: str):
    issue = _require_issue(id)
    if not issue.embedding:
        return []
    try:
        vector = importlib.import_module("app.vast.vector")
        matches = vector.nearest(issue.embedding, source=None, exclude_id=id, k=5)
    except Exception as exc:
        log.warning("Similar search unavailable (%s)", config.redact(exc))
        return []
    canonical = {i.id: i for i in store.canonical_issues()}
    return [_issue(canonical[match_id]) for match_id, _ in matches if match_id in canonical and match_id != id][:5]


@app.get("/api/frames/{issue_id}")
def frame(issue_id: str):
    issue = _require_issue(issue_id)
    # IDs generated by us are UUIDs; reject unsafe imported IDs before using a disk path.
    if not re.fullmatch(r"[\w-]+", issue_id):
        raise HTTPException(404, "Frame not found")
    path = Path(config.STATE_DIR) / "frames" / f"{issue_id}.jpg"
    try:
        return Response(path.read_bytes(), media_type="image/jpeg")
    except OSError:
        pass
    try:
        media = importlib.import_module("app.vast.media")
        jpeg = media.get_frame(issue_id, issue.frame_key)
        if not jpeg:
            raise ValueError("Empty frame")
    except Exception as exc:
        log.warning("Frame unavailable (%s)", config.redact(exc))
        raise HTTPException(404, "Frame not available") from None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid4().hex}.tmp")
        temporary.write_bytes(jpeg)
        temporary.replace(path)
    except OSError:
        log.warning("Frame cache write unavailable")
    return Response(jpeg, media_type="image/jpeg")


@app.get("/api/report", response_model=Report | None)
def latest_report():
    return store.latest_report()


@app.post("/api/report", response_model=Report)
async def regenerate_report():
    try:
        result = Report.model_validate(await _invoke(report.regenerate))
    except Exception as exc:
        log.warning("Report regeneration failed (%s); using template", config.redact(exc))
        result = await _regenerate()
    await asyncio.to_thread(store.set_report, result)
    return result


class DispatchRequest(BaseModel):
    crews: dict[Crew, Annotated[int, Field(ge=0)]]


@app.post("/api/dispatch", response_model=Plan)
async def dispatch_crews(request: DispatchRequest):
    try:
        result = Plan.model_validate(await _invoke(dispatch.plan, request.crews))
    except Exception as exc:
        log.warning("Dispatch failed (%s); using fallback", config.redact(exc))
        result = await _dispatch_plan(request.crews)
    await asyncio.to_thread(store.set_plan, result)
    return result


async def _precompute_action(action: str) -> dict:
    try:
        await _invoke(getattr(precompute, action))
        return await _invoke(precompute.status)
    except Exception as exc:
        log.warning("Precompute %s failed (%s)", action, config.redact(exc))
        raise HTTPException(503, "Precompute unavailable") from None


@app.post("/api/admin/precompute/start")
async def start_precompute():
    return await _precompute_action("start")


@app.post("/api/admin/precompute/stop")
async def stop_precompute():
    return await _precompute_action("stop")


@app.get("/api/admin/precompute/status")
async def precompute_status():
    try:
        return await _invoke(precompute.status)
    except Exception as exc:
        log.warning("Precompute status failed (%s)", config.redact(exc))
        raise HTTPException(503, "Precompute unavailable") from None


@app.post("/api/admin/reset")
def reset():
    return {"reset_cutoff": store.reset()}


@app.get("/api/health")
def health():
    return {"ok": True, "store_source": store.source()}
