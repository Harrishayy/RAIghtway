# Agent work split

`architecture.md` broken into 8 agent tasks that can run in parallel. Each agent has its own file in this folder. Read this page first: it sets out the shared contracts that let agents build against each other before the other parts exist.

| # | Agent | Owns | Critical path? |
|---|---|---|---|
| 1 | [Backend core & API](01_backend_core.md) | `backend/app/main.py`, `models.py`, `store.py`, `config.py` | Yes (skeleton + contract first) |
| 2 | [VAST data layer](02_vast_data_layer.md) | `backend/app/vast/` | Yes |
| 3 | [Model clients](03_model_clients.md) | `backend/app/ai/` | Yes |
| 4 | [GPS, segment inventory & demo clips](04_gps_and_demo_clips.md) | `backend/app/geo/`, `scripts/`, `data/` | Yes |
| 5 | [Live pipeline & dedupe](05_live_pipeline.md) | `backend/app/pipeline/` (except `precompute.py`, `vss_client.py`) | Yes |
| 6 | [Corpus pre-compute](06_precompute.md) | `backend/app/pipeline/precompute.py`, `vss_client.py` | Yes |
| 7 | [Report & dispatch](07_report_and_dispatch.md) | `backend/app/planning/` | No |
| 8 | [Frontend](08_frontend.md) | `frontend/` | No (but must-have for the demo) |

**Human-owned, not agents:** asking staff about ~6 concurrent Cosmos calls and PIE GPS use (gate check 1), choosing to accept the replay fallback (section 8), rehearsal, recording the backup video, README and submission.

---

## Ground rules for every agent
- **Stay in your files.** Each agent writes only the paths it owns. If you need something from another agent's module and it isn't there yet, write a local stub with the signature below and leave a `# TODO(agentN)` comment; don't edit their file.
- **Hackathon-lean** (architecture §1): no tests, CI, Docker or auth. Check a few real samples by hand instead.
- **Secrets** are env vars on the VM only. Never log, print or commit them.
- **Never** write video to `S3_CHUNKS_BUCKET`, never touch `vss-schema` except to read it, and never name a file `select.py` (§3.1).
- Wrap blocking work (ffmpeg, the `vastdb` SDK, ADBC, boto3) in `asyncio.to_thread` so the API stays responsive.
- Mark anything you couldn't verify with **Verify on the day** in your report back.
- If several agents share one checkout, work in separate git worktrees or branches and merge per milestone.

---

## Repo layout
```
backend/
  requirements.txt            agent 1 (others append their deps)
  app/
    main.py                   agent 1  FastAPI app + routes (§5)
    config.py                 agent 1  env vars
    models.py                 agent 1  data contract (§4) + internal records below
    store.py                  agent 1  in-memory state, local JSON snapshot, progress
    vast/                     agent 2  db.py, media.py, vector.py
    ai/                       agent 3  gpu.py, cosmos.py, embed.py, nemotron.py, prompts.py, weave_setup.py
    geo/                      agent 4  gps.py, inventory.py, demo.py
    pipeline/                 agent 5  live.py, segment.py, piece.py, dedupe.py, replay.py
    pipeline/precompute.py    agent 6
    pipeline/vss_client.py    agent 6
    planning/                 agent 7  report.py, dispatch.py, cuopt.py
scripts/                      agent 4  load_gps.py, build_inventory.py, find_overlaps.py, cut_demo_clip.py
data/                         agent 4  gps.csv, inventory.json, demo_clips.json, clips/
frontend/                     agent 8
```

---

## Shared contracts
These signatures are fixed. Code against them from the start, stubbing whatever isn't ready yet.

### `app/models.py` (agent 1 writes this first; everyone imports it)
It holds everything in architecture §4 verbatim, plus these internal records, which never go to the UI:
```python
class IssueRecord(Issue):
    source: Literal["upload", "corpus"]
    frame_key: str                       # S3 key, or "db:{id}" in the frames-table fallback
    created_at: datetime
    embedding: list[float] | None = None # 256-d; stripped before returning to the UI

class VideoRecord(Video):
    created_at: datetime

class Detection(BaseModel):              # one Cosmos finding before dedupe
    piece_index: int; t_piece: float     # seconds into the 5 s piece
    category: Category; severity: int; confidence: float; description: str
    bbox: BBox | None = None
    frame_path: str | None = None        # local keyframe JPEG
    embedding: list[float] | None = None
    lat: float | None = None; lon: float | None = None; heading: float | None = None

class FindResult(BaseModel):
    issues: list[Detection]; scene: str | None = None
```

### `app/store.py` (agent 1)
```python
store.add_video(v: VideoRecord) -> None
store.set_progress(video_id: str, *, status=None, progress=None, stage=None) -> None   # memory only
store.update_video(video_id: str, **fields) -> None          # e.g. explanation, issue_ids, track
store.add_issues(issues: list[IssueRecord], provisional: bool = False) -> None
store.replace_provisional(video_id: str, issues: list[IssueRecord]) -> None
store.get_issue(id) -> IssueRecord | None
store.canonical_issues(include_uploads_before_reset: bool = False) -> list[IssueRecord]  # sightings + max severity computed here
store.issues_for_video(video_id) -> list[IssueRecord]
store.set_report(r: Report) / store.latest_report() -> Report | None
store.set_plan(p: Plan) / store.latest_plan() -> Plan | None
store.reset_cutoff() -> datetime | None
```
`add_issues(provisional=False)` writes to VastDB (agent 2) and to the local snapshot.

### `app/vast/` (agent 2)
```python
db.ensure_tables() -> None
db.insert_videos(list[VideoRecord]); db.insert_issues(list[IssueRecord])
db.insert_report(Report); db.insert_plan(Plan); db.insert_gps(rows: list[dict])
db.load_all() -> {"videos": [...], "issues": [...], "reports": [...], "plans": [...]}   # no vector columns
db.load_embeddings() -> dict[str, np.ndarray]                                          # from embedding_bin
media.put_frame(issue_id: str, jpeg: bytes) -> str          # returns frame_key
media.get_frame(issue_id: str, frame_key: str) -> bytes
media.put_original(video_id: str, path: str) -> str | None
vector.nearest(embedding: list[float], *, category: str | None = None,
               bbox: tuple[float, float, float, float] | None = None,   # (lat_min, lat_max, lon_min, lon_max)
               source: str | None = "corpus", canonical_only: bool = True,
               exclude_id: str | None = None, k: int = 5) -> list[tuple[str, float]]  # (issue_id, cosine distance); numpy fallback inside
```

### `app/ai/` (agent 3)
```python
gpu.slot()                                  # async context manager: global semaphore (~6), shared by live + pre-compute
gpu.pause() / gpu.resume()                  # pre-compute checks this; live calls ignore it
async cosmos.find_issues(piece_path: str) -> FindResult
async cosmos.box(frame_path: str, category: str, description: str) -> BBox | None   # normalised; Nemotron VL fallback inside
async embed.embed_clip(mp4_path: str) -> list[float]                                # 256-d
async nemotron.chat_json(messages, schema: type[BaseModel], model: str = LIGHTNING) -> BaseModel  # validate + one retry
async nemotron.work_orders_and_explanation(video: VideoRecord, new_canonical: list[IssueRecord],
                                           all_issues: list[IssueRecord]) -> tuple[dict[str, WorkOrder], str]
prompts.SEVERITY_RUBRIC, prompts.CATEGORIES
weave_setup.init()                           # called once from main.py
```

### `app/geo/` (agent 4)
```python
gps.parse_upload_name(filename: str) -> tuple[str, float] | None   # "set04_video_0008_t0310.mp4" -> ("set04/video_0008", 310.0)
gps.locate(drive: str, t: float, ahead_m: float = 10) -> tuple[float, float, float] | None   # lat, lon, heading
gps.track(drive: str, start_s: float, duration_s: float) -> list[tuple[float, float]]
inventory.load() -> list[Segment]   # Segment: source_uri, drive, t_start, duration, moving: bool
demo.excluded_segments() -> set[str]; demo.forced_segments() -> list[Segment]   # from data/demo_clips.json
```

### `app/pipeline/` (agent 5)
```python
async live.analyse_video(video_id: str, path: str, *, source: Literal["upload","corpus"],
                         drive: str | None, start_s: float, on_progress=None) -> None
async piece.process_piece(piece_path: str, original_path: str, piece_index: int, piece_offset_s: float,
                          drive: str | None, clip_start_s: float) -> list[Detection]
dedupe.assign(detections: list[Detection], video: VideoRecord, *, use_history: bool = True) -> list[IssueRecord]
replay.lookup(clip_hash: str) -> dict | None; replay.save(clip_hash: str, run: dict) -> None
```

### `app/planning/` (agent 7)
```python
async report.regenerate() -> Report
report.schedule_regen() -> None                # debounced background regen (≤ once a minute during pre-compute)
async dispatch.plan(crews: dict[Crew, int]) -> Plan   # cuOpt, else nearest-neighbour fallback
```

### `app/pipeline/precompute.py` (agent 6)
```python
async precompute.start() -> None; async precompute.stop() -> None; precompute.status() -> dict
```

---

## Timeline (architecture §6)
| By | Who | Milestone |
|---|---|---|
| Night before | 7 | cuOpt toy request with our key |
| 09:30–10:30 | 1, 2, 3, 4, 8 | Gate checks, in parallel (each agent file lists its own) |
| ~11:30 | 1+2+3+4+5, 8 | One real PIE segment end to end → `GET /api/issues`. UI shell on mock data |
| ~12:30 | 4, 6 | Demo clip + backup chosen; **pre-compute running** |
| ~14:00 | 5, 3, 8 | Live clip end to end with progress; dedupe + similar issues; work orders, explanations, video pages |
| ~15:00 | 7, 8 | Report, dispatch, routes on the map. **Feature freeze** |

**Critical path:** gate checks → one segment end to end → GPS mapping → demo clips → pre-compute running → rehearsal.
