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


class Report(BaseModel):
    generated_at: datetime
    summary: str
    counts: dict[str, int]
    crews: dict[Crew, int]
    rationale: str


class Facility(BaseModel):
    """Where a crew type starts and ends its shift (a transfer station, a works yard)."""
    id: str
    label: str
    kind: Literal["transfer_station", "yard"]
    crews: list[Crew]
    lat: float
    lon: float
    address: str | None = None
    source: str                                       # where the location came from
    assumed: bool = False                             # true: a stand-in, not a confirmed site


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


class Plan(BaseModel):
    routes: list[Route]
    unassigned: list[str]
    solver: Literal["cuopt", "fallback"]
    solve_ms: int
    unassigned_reasons: dict[str, str] = {}
    facilities: list[Facility] = []
    hazards: list[Hazard] = []
    matrix_source: Literal["road", "straight"] = "straight"


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


class FindResult(BaseModel):
    issues: list[Detection]
    scene: str | None = None
