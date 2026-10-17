"""Data contract (architecture.md §4) plus internal records (agents/README.md).

Everything above "Internal records" goes to the UI. Internal records never do:
strip `source`, `frame_key`, `created_at` and `embedding` before returning them.
"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["pavement", "graffiti", "markings", "work_zone", "signage", "waste"]
Crew = Literal["roads", "graffiti", "markings", "inspection", "signage", "sanitation"]
CREW_FOR: dict[str, str] = {"pavement": "roads", "graffiti": "graffiti", "markings": "markings",
                            "work_zone": "inspection", "signage": "signage", "waste": "sanitation"}


class BBox(BaseModel):
    x: float                  # normalised 0..1, top-left origin
    y: float
    w: float
    h: float


class WorkOrder(BaseModel):
    repair: str
    crew: Crew
    minutes: int
    equipment: list[str]
    urgency: Literal["routine", "soon", "urgent"]


class Issue(BaseModel):
    id: str
    video_id: str
    t: float                                          # seconds from the start of the video
    category: Category
    severity: int = Field(ge=1, le=5)                 # rubric in architecture.md §3.3
    confidence: float
    description: str
    frame_url: str                                    # /api/frames/{id}
    bbox: BBox | None
    lat: float | None
    lon: float | None
    duplicate_of: str | None = None                   # set on re-sightings
    sightings: int = 1                                # canonical: 1 + re-sightings
    work_order: WorkOrder | None = None               # canonical issues only
    featured: int | None = None                       # demo rank from app/curation.json, 1 shows first
    # Severity rating pass (app/ai/rating.py): a model re-grades the keyframe against the rubric.
    severity_reason: str | None = None                # one sentence: what the rater saw and why this grade
    severity_model: str | None = None                 # who graded: "cosmos3-reason", "nemotron-super-vl", "review";
                                                      # None = the find pass's severity, never re-graded
    verdict: Literal["confirmed", "rejected"] | None = None   # rejected = not a real defect (kept, not deleted)
    find_severity: int | None = None                  # the find pass's original severity, when re-graded


class SimilarIssue(Issue):                            # GET /api/issues/{id}/similar
    distance: float | None = None                     # cosine distance, 0 = identical
    search: Literal["vastdb", "local"]                # which index answered: VastDB ADBC or the numpy fallback


class Video(BaseModel):
    id: str
    filename: str
    source: Literal["upload", "corpus"]
    status: Literal["queued", "analysing", "done", "failed"]
    progress: float
    stage: str | None = None
    drive: str | None = None                          # e.g. "set04/video_0008"
    start_s: float = 0
    duration_s: float = 0
    explanation: str | None = None
    issue_ids: list[str] = []
    track: list[tuple[float, float]] = []


class ReportIssue(BaseModel):
    """One finding as the report lists it: what, how bad and why, where, and what to do."""
    id: str
    category: Category
    severity: int
    severity_reason: str | None = None
    description: str
    video_id: str
    drive: str | None = None
    t: float = 0                                      # seconds from the start of the video
    lat: float | None = None
    lon: float | None = None
    place: str | None = None                          # nearest named street (OSRM), when known
    sightings: int = 1
    confidence: float = 0
    deadline: Literal["today", "this week", "this month", "routine"]
    crew: Crew
    repair: str | None = None
    minutes: int = 0


class ReportCount(BaseModel):
    label: str
    count: int


class ReportSection(BaseModel):
    """One category: counts from code, the worst findings, workload and crews, and how to fix them."""
    category: Category
    crew: Crew
    open: int
    by_severity: dict[str, int]                       # "1".."5" -> open issues
    severe: int                                       # severity 4-5
    rejected: int = 0                                 # flagged as not a defect, left out of the counts
    work_minutes: int
    crew_hours: float                                 # work minutes plus 30% travel and setup
    crews: int
    equipment: list[ReportCount] = []                 # rolled up from work orders
    top: list[ReportIssue] = []
    approach: str | None = None                       # recommended repair approach (Nemotron, else template)


class ReportHotspot(BaseModel):
    """A cluster of open findings within a few hundred metres."""
    id: str
    label: str
    lat: float
    lon: float
    radius_m: int
    issues: int
    severe: int
    max_severity: int
    score: float                                      # sum of severity weights (1, 2, 4, 8, 16)
    categories: dict[str, int]
    drives: list[str] = []
    issue_ids: list[str] = []
    note: str | None = None


class ReportStats(BaseModel):
    open: int
    today: int                                        # severity 5
    this_week: int                                    # severity 4
    this_month: int                                   # severity 3
    routine: int                                      # severity 1-2
    located: int
    drives: int
    crews: int
    crew_hours: float
    rejected: int = 0


class ReportProvenance(BaseModel):
    """Which models answered and how complete the data is, so the report never overstates itself."""
    report_model: str                                 # "nemotron-ultra", "nemotron-lightning" or "template"
    find_model: str = "cosmos3-reason"
    rating_models: dict[str, int] = {}                # who graded severity -> sightings graded
    unrated: int = 0                                  # sightings still on the find pass's severity
    rejected: int = 0                                 # canonical issues flagged as not a defect
    sightings_total: int = 0                          # every recorded sighting, re-sightings included
    canonical: int = 0
    duplicates_merged: int = 0
    with_embedding: int = 0
    with_gps: int = 0
    with_box: int = 0
    work_orders: int = 0
    template_work_orders: int = 0
    caveats: list[str] = []


class Report(BaseModel):
    generated_at: datetime
    summary: str
    counts: dict[str, int]
    crews: dict[Crew, int]
    rationale: str
    # Optional detail (older reports lack it): figures and lists come from code; Nemotron writes the prose.
    model: str | None = None                          # display name of the model that wrote the prose
    stats: ReportStats | None = None
    sections: list[ReportSection] = []
    priorities: list[ReportIssue] = []                # every open severity 4-5 issue, worst first
    hotspots: list[ReportHotspot] = []
    provenance: ReportProvenance | None = None


FacilityKind = Literal["transfer_station", "collection_yard", "road_yard", "cleaning_yard", "yard"]


class Facility(BaseModel):
    """A City operating site crews leave from and return to: a transfer station, a collection,
    road-operations or street-cleaning yard. "yard" is the older catch-all kind."""
    id: str
    label: str
    kind: FacilityKind
    crews: list[Crew]
    lat: float
    lon: float
    address: str | None = None
    source: str                                       # where the location came from
    assumed: bool = False                             # true: a stand-in, not a confirmed site
    # Optional extras (Sites tab): the public page naming the site, a note, who added it, and the
    # trucks/crews it sends out each day per crew type (dispatch uses these per site).
    source_url: str | None = None
    note: str | None = None
    custom: bool = False                              # added in the console, not in the bundled list
    vehicles: dict[Crew, int] = {}


class Hazard(BaseModel):
    """A road that is closed, restricted or busy: a city closure or a work zone seen on camera."""
    id: str
    source: Literal["city", "dashcam"]
    kind: str                                         # e.g. CONSTRUCTION, work_zone
    label: str
    lat: float
    lon: float
    path: list[tuple[float, float]] = []              # closed stretch, when known
    severity: int = 3
    detail: str | None = None
    until: datetime | None = None


class RouteWarning(BaseModel):
    hazard_id: str
    label: str
    source: Literal["city", "dashcam"]
    avoided: bool                                     # true: the path was re-routed around it


class Route(BaseModel):
    crew_id: str
    crew: Crew
    stops: list[str]
    eta_min: list[int]
    path: list[tuple[float, float]]
    # Optional extras: where the route starts and ends, street geometry, and what to send the crew.
    facility_id: str | None = None
    depot: tuple[float, float] | None = None
    depot_label: str | None = None
    distance_km: float | None = None
    path_source: Literal["road", "straight"] = "straight"
    warnings: list[RouteWarning] = []
    maps_urls: list[str] = []                         # Google Maps directions, ≤10 points per link
    brief: str | None = None                          # plain-text run sheet for the crew
    # Round-trip schedule (multi-day plans): which day and truck, the full shift timeline and its totals.
    day: int = 1                                      # 1 = the first day of the plan
    vehicle_id: str | None = None                     # the truck; crew_id is unique per day (e.g. "roads-2/d2")
    schedule: list["ScheduleEntry"] = []
    totals: "ShiftTotals | None" = None
    solver: Literal["cuopt", "fallback"] | None = None   # who ordered this route's stops


class ScheduleEntry(BaseModel):
    """One line of a truck's shift, in minutes from the shift start (08:00)."""
    kind: Literal["depart", "job", "break", "return"]
    issue_id: str | None = None
    label: str
    lat: float
    lon: float
    drive_min: int = 0                                # driving to reach this point from the previous one
    arrive_min: int
    work_min: int = 0                                 # on site (job) or the break length
    depart_min: int
    idle_min: int = 0                                 # waiting before this point (early arrival)
    severity: int | None = None


class ShiftTotals(BaseModel):
    drive_min: int
    work_min: int
    break_min: int
    idle_min: int                                     # shift minutes not driving, working or on break
    distance_km: float | None = None
    back_min: int                                     # back at base, minutes from the shift start
    jobs: int
    lunch: Literal["solver", "reserved", "none"]     # solver: cuOpt placed the break; reserved: added after


Route.model_rebuild()


class TriageDecision(BaseModel):
    issue_id: str
    crew: Crew
    severity: int
    decision: Literal["today", "later", "defer"]      # today: day 1; later: within the plan's days; defer: not planned
    reason: str
    by: Literal["rule", "model"]                      # rule: a hard rule in code decided (or overrode the model)


class Triage(BaseModel):
    """The day plan before routing: what goes today, later in the horizon, or waits, and why."""
    model: str                                        # "nemotron-lightning", ... or "rules" when no model answered
    model_name: str | None = None                     # display name of the model
    min_severity: int                                 # the severity floor the user chose
    days: int
    rationale: str
    by_crew: dict[Crew, str] = {}
    capacity_min: dict[Crew, int] = {}                # work minutes the crew type's trucks can do per day
    clamped: int = 0                                  # model decisions code overrode
    decisions: list[TriageDecision] = []


class PlanDay(BaseModel):
    day: int
    jobs: int
    trucks: int                                       # trucks with at least one stop
    by_severity: dict[str, int] = {}
    drive_min: int = 0
    work_min: int = 0
    solver: Literal["cuopt", "fallback"] = "fallback"


class Plan(BaseModel):
    routes: list[Route]
    unassigned: list[str]
    solver: Literal["cuopt", "fallback"]
    solve_ms: int
    unassigned_reasons: dict[str, str] = {}
    facilities: list[Facility] = []
    hazards: list[Hazard] = []
    matrix_source: Literal["road", "straight"] = "straight"
    # Multi-day round trips and triage (optional; older plans lack them).
    days: list[PlanDay] = []
    triage: Triage | None = None
    deferred: list[str] = []                          # triaged out: not planned in this horizon (reasons in triage)


class Directions(BaseModel):
    """Best road path between two points, steering around known hazards."""
    path: list[tuple[float, float]]
    minutes: int
    distance_km: float
    path_source: Literal["road", "straight"]
    warnings: list[RouteWarning]
    alternatives: int                                 # how many candidate paths were compared
    maps_url: str


# ---- Internal records (never sent to the UI) ----

class IssueRecord(Issue):
    source: Literal["upload", "corpus"]
    frame_key: str                                    # S3 key, or "db:{id}" in the frames-table fallback
    created_at: datetime
    embedding: list[float] | None = None              # 256-d; stripped before returning to the UI
    rated_at: datetime | None = None                  # when the severity rating last changed


class VideoRecord(Video):
    created_at: datetime


class Detection(BaseModel):                           # one Cosmos finding before dedupe
    piece_index: int
    t_piece: float                                    # seconds into the 5 s piece
    category: Category
    severity: int
    confidence: float
    description: str
    bbox: BBox | None = None
    frame_path: str | None = None                     # local keyframe JPEG
    embedding: list[float] | None = None
    lat: float | None = None
    lon: float | None = None
    heading: float | None = None


class SeverityRating(BaseModel):                     # one rating-pass answer, before it is applied
    severity: int = Field(ge=1, le=5)
    reason: str
    verdict: Literal["confirmed", "rejected"]
    model: str                                        # "cosmos3-reason" or "nemotron-super-vl"
    observed: str | None = None                       # what the rater says is actually there


class FindResult(BaseModel):
    issues: list[Detection]
    scene: str | None = None
