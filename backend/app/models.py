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


class Route(BaseModel):
    crew_id: str
    crew: Crew
    stops: list[str]
    eta_min: list[int]
    path: list[tuple[float, float]]


class Plan(BaseModel):
    routes: list[Route]
    unassigned: list[str]
    solver: Literal["cuopt", "fallback"]
    solve_ms: int


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
