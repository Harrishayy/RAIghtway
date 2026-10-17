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
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app import config, curation, store
from app.models import (CREW_FOR, BBox, Category, Crew, Directions, Facility, Hazard, Issue, IssueRecord, Plan, Recommendation, Zone,
                        Report, Route,
                        SimilarIssue, Video, VideoRecord)
from app.models import AskAnswer

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


async def _warm_road_alerts() -> None:
    """Fetch the city's road restrictions once at startup, so the first plan doesn't wait on it."""
    try:
        await importlib.import_module("app.planning.hazards").city()
    except Exception as exc:
        log.warning("Road alerts warm-up failed (%s)", config.redact(exc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    for module, name in (("app.ai.weave_setup", "init"), ("app.vast.db", "ensure_tables"), ("app.store", "load")):
        await asyncio.to_thread(_startup_call, module, name)
    if os.environ.get("DEMO_FIXTURES") == "1":
        await asyncio.to_thread(_seed_fixtures)
    warm = asyncio.create_task(_warm_road_alerts())
    _analysis_tasks.add(warm)
    warm.add_done_callback(_analysis_tasks.discard)
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
    video = Video.model_validate(record.model_dump(include=set(Video.model_fields)))
    try:   # regenerated drive summaries live in an overlay (app/ai/summaries.py); also labels template text
        return importlib.import_module("app.ai.summaries").apply(video)
    except Exception as exc:
        log.debug("Summary overlay skipped (%s)", config.redact(exc))
        return video


def _issue(record: IssueRecord) -> Issue:
    issue = Issue.model_validate(record.model_dump(include=set(Issue.model_fields)))
    issue.featured = curation.featured(record.id)
    return issue


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


class RunRequest(BaseModel):
    clips: Annotated[int, Field(ge=1, le=5)] | None = None   # default RUN_CLIPS (3)


@app.post("/api/run", response_model=Video)
async def run_next(body: RunRequest | None = None):
    """Analyse footage live (app/pipeline/run.py): the next stretch the VAST index has that we haven't seen,
    then re-checks of reviewed stretches on other drives, up to `clips` clips, one after another.
    Returns the first clip; the rest are listed as queued."""
    run = importlib.import_module("app.pipeline.run")
    try:
        video, go = await run.start(_run_analysis, (body or RunRequest()).clips)
    except run.NothingToRun as exc:
        raise HTTPException(409, str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from None
    except Exception as exc:
        log.warning("Run failed to start (%s)", config.redact(exc))
        raise HTTPException(503, "Run unavailable") from None
    task = asyncio.create_task(go())
    _analysis_tasks.add(task)
    task.add_done_callback(_analysis_tasks.discard)
    return _video(video)


@app.get("/api/videos", response_model=list[Video])
def videos():
    listed = store.list_videos()
    if curation.enabled():
        by_video: dict[str, list] = {}
        for i in store.canonical_issues():
            by_video.setdefault(i.video_id, []).append(i)
        listed = [v for v in listed if curation.keep_video(v, by_video)]
    return [_video(v) for v in listed]


class VideoDetail(BaseModel):
    video: Video
    issues: list[Issue]


@app.get("/api/videos/{id}", response_model=VideoDetail)
def video_detail(id: str):
    video = _require_video(id)
    return VideoDetail(video=_video(video), issues=[_issue(i) for i in curation.visible(store.issues_for_video(id))])


@app.get("/api/videos/{id}/file")
def video_file(id: str):
    """Playable footage: the upload itself, or a corpus drive's 480p proxy (scripts/build_video_proxies.py)."""
    video = _require_video(id)
    if not re.fullmatch(r"[\w-]+", id):
        raise HTTPException(404, "Video file not found")
    path = Path(config.STATE_DIR) / ("uploads" if video.source == "upload" else "videos") / f"{id}.mp4"
    if not path.is_file():
        raise HTTPException(404, "Video file not available")
    return FileResponse(path, media_type="video/mp4")  # honours Range, so the player can seek


@app.get("/api/issues", response_model=list[Issue])
def issues():
    return [_issue(i) for i in curation.visible(store.canonical_issues())]


class ManualIssueRequest(BaseModel):
    """An issue an operator marks on footage (Review → Mark issue)."""
    video_id: str
    t: Annotated[float, Field(ge=0)]
    category: Category
    severity: Annotated[int, Field(ge=1, le=5)]
    description: Annotated[str, Field(max_length=500)] = ""
    bbox: BBox | None = None                                    # omitted: the whole frame
    pinned: bool = True                                         # include in the next plan
    name: Annotated[str, Field(max_length=200)] | None = None   # operator's name; trimmed to 80 chars


@app.post("/api/issues", response_model=Issue)
async def create_manual_issue(body: ManualIssueRequest):
    """Operator-reported issue: keyframe, GPS, work order and embedding are best effort (app/pipeline/manual.py)."""
    manual = importlib.import_module("app.pipeline.manual")
    if body.bbox is not None:
        x, y = min(max(body.bbox.x, 0.0), 1.0), min(max(body.bbox.y, 0.0), 1.0)
        body.bbox = BBox(x=x, y=y, w=min(max(body.bbox.w, 0.0), 1.0 - x), h=min(max(body.bbox.h, 0.0), 1.0 - y))
        if body.bbox.w < 0.005 or body.bbox.h < 0.005:
            body.bbox = None
    try:
        record = await manual.create(video_id=body.video_id, t=body.t, category=body.category,
                                     severity=body.severity, description=body.description, bbox=body.bbox,
                                     pinned=body.pinned, name=body.name)
    except manual.VideoNotFound:
        raise HTTPException(404, "Video not found") from None
    except Exception as exc:
        log.warning("Manual issue failed (%s)", config.redact(exc))
        raise HTTPException(503, "Could not save the issue") from None
    return _issue(record)


class IssuePatch(BaseModel):
    pinned: bool | None = None                                  # include in the next plan
    severity: Annotated[int, Field(ge=1, le=5)] | None = None   # operator grade (a rating row, reversible)
    revert_severity: bool = False                               # undo the operator grade
    name: Annotated[str, Field(max_length=200)] | None = None   # operator's name, trimmed to 80; "" clears it


@app.patch("/api/issues/{id}", response_model=Issue)
def update_issue(id: str, body: IssuePatch):
    """Pin/unpin, name or set an operator severity. Overlay rows only; issue rows are never rewritten."""
    _require_issue(id)
    manual = importlib.import_module("app.pipeline.manual")
    try:
        record = manual.update(id, pinned=body.pinned, severity=body.severity, revert_severity=body.revert_severity,
                               name=body.name)
    except Exception as exc:
        log.warning("Issue update failed (%s)", config.redact(exc))
        raise HTTPException(503, "Could not update the issue") from None
    if record is None:
        raise HTTPException(404, "Issue not found")
    return _issue(record)


@app.get("/api/issues/{id}/similar", response_model=list[SimilarIssue])
def similar_issues(id: str):
    issue = _require_issue(id)
    if not issue.embedding:
        return []
    try:
        vector = importlib.import_module("app.vast.vector")
        matches, path = vector.search(issue.embedding, source=None, exclude_id=id, k=5)
    except Exception as exc:
        log.warning("Similar search unavailable (%s)", config.redact(exc))
        return []
    canonical = {i.id: i for i in store.canonical_issues()}
    search = "vastdb" if path == "adbc" else "local"
    return [SimilarIssue(**_issue(canonical[match_id]).model_dump(), distance=round(distance, 4), search=search)
            for match_id, distance in matches if match_id in canonical and match_id != id][:5]


class SearchRequest(BaseModel):
    query: str


@app.post("/api/search")
async def search_footage(body: SearchRequest):
    """Plain-language search over the VSS index, as bands on the drives the console lists. No fallback: 503."""
    try:
        topic_search = importlib.import_module("app.pipeline.topic_search")
    except Exception as exc:
        log.warning("Footage search unavailable (%s)", config.redact(exc))
        raise HTTPException(503, "VSS search is unavailable") from None
    try:
        logged = [i for i in curation.visible(store.all_issues()) if i.verdict != "rejected"]
        return await topic_search.search(body.query, {v.id: v for v in videos()}, logged)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except topic_search.SearchUnavailable as exc:
        raise HTTPException(503, str(exc)) from None


class AskRequest(BaseModel):
    question: str
    t: Annotated[float, Field(ge=0)] | None = None              # the playhead; None asks about the whole drive


@app.post("/api/videos/{id}/ask", response_model=AskAnswer)
async def ask_video(id: str, body: AskRequest):
    """Ask what happened on a drive: VSS captions as evidence, Nemotron answers (VSS quote if it can't). 503 if neither."""
    video = _require_video(id)
    try:
        ask = importlib.import_module("app.pipeline.ask")
    except Exception as exc:
        log.warning("Ask unavailable (%s)", config.redact(exc))
        raise HTTPException(503, "Ask is unavailable") from None
    try:
        return await ask.ask(video, body.question, body.t, curation.visible(store.issues_for_video(id)))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except ask.AskUnavailable as exc:
        raise HTTPException(503, str(exc)) from None


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
    result = store.latest_report()
    if result is None:
        return None
    # Names are an operator overlay that can change after the report was written: show the current ones.
    names = {i.id: i.name for i in store.canonical_issues()}
    for row in [*result.priorities, *(row for section in result.sections for row in section.top)]:
        if row.id in names:
            row.name = names[row.id]
    return result


@app.post("/api/report", response_model=Report)
async def regenerate_report():
    try:
        result = Report.model_validate(await _invoke(report.regenerate))
    except Exception as exc:
        log.warning("Report regeneration failed (%s); using template", config.redact(exc))
        result = await _regenerate()
    await asyncio.to_thread(store.set_report, result)
    return result


class ScenarioRef(BaseModel):
    recommendation_id: str
    scenario_id: str


class DispatchRequest(BaseModel):
    # Older consoles send only `crews` (trucks per crew type, shared over the sites by workload).
    crews: dict[Crew, Annotated[int, Field(ge=0)]] = {}
    # Trucks per site per crew type per day; omitted: what each site stores (Sites tab).
    sites: dict[str, dict[Crew, Annotated[int, Field(ge=0, le=20)]]] | None = None
    days: Annotated[int, Field(ge=1, le=7)] = 1
    min_severity: Annotated[int, Field(ge=1, le=5)] = 1        # the severity floor: plan S{n} and worse
    triage: bool = True                                         # False: rules only, no Nemotron call
    # Apply a recommendation scenario: reuses its solved routes while fresh, else plans its settings.
    scenario: ScenarioRef | None = None
    # Focus: only jobs inside these zones (ids from /api/zones) and/or this drawn ring are planned.
    zones: list[str] | None = None
    polygon: Annotated[list[tuple[Annotated[float, Field(ge=-90, le=90)], Annotated[float, Field(ge=-180, le=180)]]], Field(max_length=200)] | None = None


@app.post("/api/dispatch", response_model=Plan)
async def dispatch_crews(request: DispatchRequest):
    try:
        if isinstance(dispatch, SimpleNamespace):
            raise RuntimeError("dispatch module unavailable")
        result = Plan.model_validate(await _invoke(
            dispatch.plan, request.crews, sites=request.sites, days=request.days,
            min_severity=request.min_severity, triage=request.triage,
            scenario=(request.scenario.recommendation_id, request.scenario.scenario_id) if request.scenario else None,
            zones=request.zones, polygon=request.polygon))
    except Exception as exc:
        log.warning("Dispatch failed (%s); using fallback", config.redact(exc))
        result = await _dispatch_plan(request.crews)
    await asyncio.to_thread(store.set_plan, result)
    try:                                       # the report reads the latest plan's crew facts
        report.schedule_regen()
    except Exception as exc:
        log.warning("schedule_regen failed (%s)", config.redact(exc))
    return result


class RecommendRequest(BaseModel):
    days: Annotated[int, Field(ge=1, le=7)] = 1
    min_severity: Annotated[int, Field(ge=1, le=5)] = 3
    sites: dict[str, dict[Crew, Annotated[int, Field(ge=0, le=20)]]] | None = None
    agent: bool = True                                          # False: rules propose and pick (cuOpt still solves)
    zones: list[str] | None = None
    polygon: Annotated[list[tuple[Annotated[float, Field(ge=-90, le=90)], Annotated[float, Field(ge=-180, le=180)]]], Field(max_length=200)] | None = None


@app.post("/api/dispatch/recommend", response_model=Recommendation)
async def recommend_workforce(request: RecommendRequest):
    """Nemotron proposes workforce scenarios, cuOpt solves each, Nemotron picks one; code validates."""
    try:
        recommend = importlib.import_module("app.planning.recommend")
        return await recommend.recommend(request.days, request.min_severity, request.sites, request.agent,
                                         request.zones, request.polygon)
    except Exception as exc:
        log.warning("Recommendation failed (%s)", config.redact(exc))
        raise HTTPException(503, "Recommendation unavailable") from None


@app.get("/api/dispatch/recommend/progress")
def recommendation_progress():
    """{running, stage, scenarios_done, scenarios_total, elapsed_s} while a recommendation runs."""
    try:
        return importlib.import_module("app.planning.recommend").progress()
    except Exception:
        return {"running": False}


@app.get("/api/dispatch/recommend", response_model=Recommendation | None)
def latest_recommendation():
    try:
        return importlib.import_module("app.planning.recommend").latest()
    except Exception:
        return None


@app.get("/api/plan", response_model=Plan | None)
def latest_plan():
    """The last plan made (persisted), or null."""
    return store.latest_plan()


def _sites():
    return importlib.import_module("app.planning.facilities")


class FacilityInput(BaseModel):
    """A site from the Sites tab. On PUT every field is optional."""
    label: str | None = None
    kind: str | None = None
    crews: list[Crew] | None = None
    lat: Annotated[float, Field(ge=-90, le=90)] | None = None
    lon: Annotated[float, Field(ge=-180, le=180)] | None = None
    address: str | None = None
    source: str | None = None
    source_url: str | None = None
    note: str | None = None
    vehicles: dict[Crew, Annotated[int, Field(ge=0, le=20)]] | None = None


@app.get("/api/facilities", response_model=list[Facility])
def list_facilities():
    """City operating sites: transfer stations, collection, road and street-cleaning yards, with trucks per day."""
    return list(_sites().load())


@app.post("/api/facilities", response_model=Facility)
def add_facility(body: FacilityInput):
    fields = body.model_dump(exclude_none=True)
    if not {"label", "kind", "crews", "lat", "lon"} <= fields.keys():
        raise HTTPException(422, "A site needs a name, kind, crews and a location")
    try:
        return _sites().add(fields)
    except ValueError as exc:
        raise HTTPException(422, str(exc).splitlines()[0][:200]) from None


@app.put("/api/facilities/{facility_id}", response_model=Facility)
def update_facility(facility_id: str, body: FacilityInput):
    try:
        return _sites().update(facility_id, body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(404, "No such site") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc).splitlines()[0][:200]) from None


@app.delete("/api/facilities/{facility_id}")
def remove_facility(facility_id: str):
    try:
        _sites().remove(facility_id)
    except KeyError:
        raise HTTPException(404, "No such site") from None
    return {"removed": facility_id}


@app.post("/api/facilities/reset", response_model=list[Facility])
def reset_facilities():
    """Forget every site edit: the bundled City list again."""
    return list(_sites().reset())


def _zones():
    return importlib.import_module("app.planning.zones")


class ZoneInput(BaseModel):
    label: str | None = None
    polygon: Annotated[list[tuple[Annotated[float, Field(ge=-90, le=90)], Annotated[float, Field(ge=-180, le=180)]]], Field(min_length=3, max_length=200)] | None = None


@app.get("/api/zones", response_model=list[Zone])
def list_zones():
    """Planning zones: the City's 25 wards (Open Data) and areas drawn in the console."""
    return list(_zones().load())


@app.post("/api/zones", response_model=Zone)
def add_zone(body: ZoneInput):
    if not body.polygon:
        raise HTTPException(422, "A zone needs a polygon of at least three points")
    try:
        return _zones().add(body.label or "Drawn area", body.polygon)
    except ValueError as exc:
        raise HTTPException(422, str(exc).splitlines()[0][:200]) from None


@app.put("/api/zones/{zone_id}", response_model=Zone)
def update_zone(zone_id: str, body: ZoneInput):
    try:
        return _zones().update(zone_id, body.label, body.polygon)
    except KeyError:
        raise HTTPException(404, "No such drawn zone (wards are read-only)") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc).splitlines()[0][:200]) from None


@app.delete("/api/zones/{zone_id}")
def remove_zone(zone_id: str):
    try:
        _zones().remove(zone_id)
    except KeyError:
        raise HTTPException(404, "No such drawn zone (wards are read-only)") from None
    return {"removed": zone_id}


@app.get("/api/geocode")
async def geocode(q: str):
    """An address in Toronto -> {lat, lon, label} (OSM Nominatim, one request a second, cached)."""
    try:
        hit = await importlib.import_module("app.geo.geocode").search(q)
    except Exception as exc:
        log.warning("Geocode failed (%s)", config.redact(exc))
        raise HTTPException(503, "Address lookup unavailable") from None
    if hit is None:
        raise HTTPException(404, "No match in Toronto for that address")
    return hit


@app.get("/api/hazards", response_model=list[Hazard])
async def road_alerts():
    """City road closures and dashcam work zones near the bases and the open jobs, worst first."""
    try:
        facilities = importlib.import_module("app.planning.facilities")
        hazards = importlib.import_module("app.planning.hazards")
        points = [(f.lat, f.lon) for f in facilities.load()]
        points += [(i.lat, i.lon) for i in store.canonical_issues() if i.lat is not None and i.lon is not None]
        return (await hazards.near(points, radius_km=1.0))[:200]
    except Exception as exc:
        log.warning("Road alerts unavailable (%s)", config.redact(exc))
        return []


class DirectionsRequest(BaseModel):
    origin: tuple[Annotated[float, Field(ge=-90, le=90)], Annotated[float, Field(ge=-180, le=180)]]
    destination: tuple[Annotated[float, Field(ge=-90, le=90)], Annotated[float, Field(ge=-180, le=180)]]


@app.post("/api/directions", response_model=Directions)
async def directions(request: DirectionsRequest):
    """Best road path between two points around current closures, plus what is still in the way."""
    try:
        return await dispatch.directions(request.origin, request.destination)
    except Exception as exc:
        log.warning("Directions failed (%s)", config.redact(exc))
        raise HTTPException(503, "Directions unavailable") from None


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


class RegenerateRequest(BaseModel):
    video_ids: list[str] | None = None        # default: every corpus drive
    only_template: bool = True                # skip drives that already have a Nemotron summary


@app.post("/api/admin/explanations/regenerate")
async def regenerate_explanations(body: RegenerateRequest | None = None):
    """Admin only. Rewrite drive summaries with grounded Nemotron, one drive at a time (Weave-traced); returns at once."""
    body = body or RegenerateRequest()
    try:
        summaries = importlib.import_module("app.ai.summaries")
    except Exception as exc:
        log.warning("Summaries unavailable (%s)", config.redact(exc))
        raise HTTPException(503, "Summaries unavailable") from None
    return summaries.start(body.video_ids, body.only_template)


@app.get("/api/admin/explanations/status")
async def explanations_status():
    try:
        return importlib.import_module("app.ai.summaries").status()
    except Exception as exc:
        log.warning("Summaries unavailable (%s)", config.redact(exc))
        raise HTTPException(503, "Summaries unavailable") from None


@app.post("/api/admin/reset")
def reset():
    return {"reset_cutoff": store.reset()}


class DemoToggle(BaseModel):
    on: bool


@app.get("/api/admin/demo")
def demo_status():
    return {"on": curation.enabled()}


@app.post("/api/admin/demo")
def demo_toggle(request: DemoToggle):
    """Demo mode: reviewed picks first, only their drives, rejected findings hidden. Off = the raw pipeline."""
    return {"on": curation.set_enabled(request.on)}


@app.get("/api/health")
def health():
    return {"ok": True, "store_source": store.source(), "demo_curation": curation.enabled()}
