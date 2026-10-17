# Architecture

What we're building and how the pieces fit. The work split comes later.

Related docs: `idea.md` (problem and pitch), `ui_spec.md` (frontend), `context.md` (event, rules, stack, APIs).

Environment facts were checked on 16 Oct against the guide repo, the `vss-blueprint` source, NVIDIA/CoreWeave docs and the PIE vehicle logs (sources at the end). **Verify on the day** marks what can only be checked from the VM.

---

## 1. Decisions so far
| Topic | Decision |
|---|---|
| User | A city operations manager planning tomorrow's maintenance work |
| Product | Fleet footage → issues found and graded → per-video explanations → map with evidence frames → situation report with recommended crews → cuOpt-optimised crew routes |
| Demo | About **1 minute**: populated map (from yesterday's fleet footage) → drop in a new clip and watch it analyse live → click an issue to see the frame with a bounding box → report → dispatch, with routes appearing on the map |
| VAST usage | **Level 1:** VAST S3 for all media; VastDB tables as the system of record. **Level 2:** VastDB vector search over issue embeddings (similar issues, deduplication) |
| Live analysis | Our own pipeline calling the models directly; results stored in VAST. The guide limits the challenge path to re-ingesting the already-segmented corpus, and NYC teams saw re-ingest jobs stuck for 40+ min. |
| Hosting | Runs on the workshop VM, opened through Cursor port forwarding. No Kubernetes. |
| Stack | Frontend: React + Vite + Tailwind. Backend: Python + FastAPI. |
| Build style | Hackathon-lean: no tests, CI, Docker or auth. Quick checks on a few samples only. |
| Severity | 1–5 with a written rubric (3.3) |
| Issue panel | Also shows similar issues from VastDB vector search (slightly beyond `ui_spec.md`) |
| Live clip | Taken from a street another drive also covered, so dedupe fires on stage |
| Media fallback | Keyframes stored in VastDB if no safe S3 location exists |

---

## 2. System overview

```
                 ┌──────────── Frontend (React + Vite + Tailwind) ──────────────┐
                 │ drop zone · progress · directory · video page · map ·        │
                 │ frame + box · similar issues · report · crew routes          │
                 └─────────────────────────┬────────────────────────────────────┘
                                           │ REST /api through the Vite proxy (one forwarded port); polling
┌──────────────────────────────────────────▼─────────────────────────────────────────────┐
│ FastAPI backend (workshop VM): reads from memory; writes to VastDB + a local snapshot  │
│                                                                                        │
│ Live pipeline (per dropped clip, background task)                                      │
│   0 drive + start time from the filename → GPS track ─────────── VastDB `gps`          │
│   1 save original ───────────────────────────────────────────────► VAST S3             │
│   2 cut into 5 s pieces at 720p (ffmpeg)                                               │
│   3 per piece, at most ~6 GPU calls at once:                                           │
│       a find + classify + grade + best time ── Cosmos3-Reason (video)                  │
│       b keyframe → bounding box ────────────── Cosmos3-Reason (image) ──► VAST S3      │
│       c embed the issue crop ───────────────── Cosmos-Embed1 (256-d)                   │
│       d geolocate ──────────────────────────── GPS at clip start + offset              │
│   4 dedupe ── in-clip (memory) + corpus history (VastDB vector SQL)                    │
│   5 work orders + video explanation ── Nemotron (one call per video)                   │
│   6 insert video + issues ───────────────────────────────────────► VastDB              │
│   7 regenerate the report in the background                                            │
│                                                                                        │
│ Corpus pre-compute (background, resumable)                                             │
│   candidates: VSS /api/v1/search (visual-weighted, pie_cam-3) + uniform sample         │
│   → segments read from the VSS segments bucket → 720p → steps 3–6                      │
│                                                                                        │
│ Report ── issues → counts + workload → Nemotron → summary + recommended crews          │
│ Dispatch ── canonical issues + work orders → cuOpt (hosted) → route per crew           │
│ Every model call is traced in W&B Weave                                                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **One forwarded port.** Vite's dev server proxies `/api` to FastAPI on `localhost:8000`: no CORS, one port to forward. Map tiles load directly in the laptop's browser.
- **Reads come from memory.** At startup the backend loads our tables (non-vector columns) from VastDB and serves all reads from memory. Writes go to VastDB and to a local JSON snapshot, which is used if VastDB is unreachable at startup. Live progress is memory-only.

**What runs when** (this answers the `ui_spec.md` open point on analysis time)
| Item | When |
|---|---|
| PIE GPS → VastDB `gps` | Once, in the morning |
| Corpus issues ("yesterday's footage") | Background job, running by ~12:30; resumable |
| New clip (20–30 s) | Live in the demo; about 20–40 s |
| Report | Regenerated in the background after each analysis |
| Dispatch (cuOpt) | Live, on click (a few seconds) |

**Where judges see each sponsor**
- **NVIDIA:** Cosmos3-Reason (find, grade, box), Cosmos-Embed1 (VSS candidate search; issue embeddings), Nemotron (work orders, explanations, report), cuOpt (routes).
- **VAST:** S3 for media; VastDB tables for issues, videos, GPS, reports and plans; VastDB vector SQL with category and location filters (dedupe, similar issues); the VSS index for search.
- **W&B:** Inference for Nemotron; Weave traces of every model call.

---

## 3. Components

### 3.1 Data layer (VAST)
**Media (VAST S3)** goes in `S3_SEGMENTS_BUCKET` as `citymaint/frames/{issue_id}.jpg` and `citymaint/uploads/{video_id}.video` (originals, stored with `ContentType: video/mp4`). Per the `vss-blueprint` source, nothing processes these objects:
- This bucket's trigger runs the Detector, which skips keys that aren't `.mp4` with `_segment_`, `-segment-` or `/segments/` in them. The pipeline writes its own `detections/*.json.gz` sidecars here.
- Originals avoid `.mp4` because the VSS dashboard counts every `.mp4` here as awaiting indexing.
- Never write video to `S3_CHUNKS_BUCKET`: the Segmenter ingests any video there into `vss-collection`, which is the re-ingest we ruled out.

**Verify on the day**, since the deployed functions may differ from the repo: write one test object of each kind and confirm that Explore and `dashboard/stats` don't change. **Fallback (agreed):** keyframes go in the VastDB `frames` table and originals stay on the VM disk. Our 5 s pieces stay on disk anyway.

**VastDB.** Team database `VASTDB_BUCKET`, our own schema `citymaint`; never touch `vss-schema`. Writes use the `vastdb` SDK on the data VIP `S3_ENDPOINT` (vastdb-write skill). All tables are insert-only, so there are no updates to get wrong.

| Table | Contents |
|---|---|
| `videos` | id, filename, source (`upload`/`corpus`), drive (e.g. `set04/video_0008`), start_s, duration_s, explanation, track (JSON), created_at |
| `issues` | id, video_id, source, t, category, severity (1–5), confidence, description, frame_key, bbox_x/y/w/h, lat, lon, duplicate_of (empty = canonical), work-order fields (canonical only), created_at, `embedding` (vector), `embedding_bin` (same vector as bytes, for the fallback) |
| `gps` | drive, t (1 Hz), lat, lon, heading, speed: PIE vehicle data, cleaned |
| `reports` | generated_at, summary, counts, crews, rationale |
| `plans` | generated_at, crews, routes (JSON), unassigned, solver, solve_ms |
| `frames` | Fallback only: issue_id, jpeg (binary) |
| `ratings` | issue_id, severity, find_severity, reason, model, verdict, observed, rated_at: severity overlay (model graders and `operator`), newest per issue wins |
| `pins` | issue_id, pinned (0/1), by, pinned_at: "include in the next plan" overlay, newest per issue wins; issue rows are never rewritten |
| `names` | issue_id, name, by, named_at: the operator's name for an issue, newest per issue wins, `""` clears it |

SDK rules (from the skills and the blueprint):
- **Vector column:** `pa.list_(pa.field("item", pa.float32(), nullable=False), 256)`, as in `vss-collection`.
- **Never read vector columns through the SDK:** pass explicit columns, load whole tables and filter in memory. This also avoids predicate selects on tables with vector columns, which need the blueprint's `vastdb_patch.py`.
- **Don't name any file `select.py`.**

**Vector search** uses SQL through VAST's ADBC driver, as the VSS backend does (not the Python SDK).
- **Driver:** `/vss-blueprint/source-code/retrieval/video-backend/libadbc_driver_vastdb.so` (x86-64 Linux) plus `pip install adbc-driver-manager==1.0.0`, the backend's pin.
- **Connect:** `adbc_driver_manager.dbapi.connect(driver=SO, db_kwargs={"vast.db.endpoint": QE, "vast.db.access_key": ..., "vast.db.secret_key": ...})`, where `QE` is `vdb_endpoint` from `/config/backend-secret.yaml` (vastdb-read skill). **Verify on the day** that it's reachable from the VM and shows fresh inserts.
- **Query:** use `OR`, not `IN (...)`, which the backend notes this engine rejects.
  ```sql
  SELECT id, lat, lon,
         array_cosine_distance(embedding::FLOAT[256], ARRAY[<256 floats>]::FLOAT[256]) AS d
  FROM "<VASTDB_BUCKET>/citymaint"."issues"
  WHERE source = 'corpus' AND category = 'pavement' AND duplicate_of = ''
    AND lat BETWEEN <a> AND <b> AND lon BETWEEN <c> AND <d>
  ORDER BY d LIMIT 5
  ```
- **Fallback:** numpy cosine over `embedding_bin`, loaded at startup.

### 3.2 Model calls
| Model | Where | Used for | How (checked) |
|---|---|---|---|
| Cosmos3-Reason | `$COSMOS3_REASON_URL` | Find, classify and grade issues per piece; box on the keyframe | `POST /v1/chat/completions`, content `[{type:text}, {type:video_url, video_url:{url:"data:video/mp4;base64,…"}}]` (the VSS reasoner's pattern); read `choices[0].message.content`. Images go in as `image_url` (**Verify on the day**). Temperature ≤0.2, JSON only, strip any `<think>` block. max_tokens ~1000: the reasoner uses 4000, and a tight cap can cut off the JSON |
| Cosmos-Embed1 | `$COSMOS_EMBED1_URL` | One 256-d vector per issue (dedupe, similar issues) | `POST /v1/embeddings` `{input:"data:video/mp4;base64,…", model:"nvidia/cosmos-embed1", request_type:"query", encoding_format:"float"}` (the VSS embedder's call). It takes text, base64 video or exactly 8 frames (single images aren't documented), so crops go in as 1 s still clips (3.3) |
| Nemotron | W&B Inference: `https://api.inference.wandb.ai/v1`, `project=f"{WANDB_TEAM}/{WANDB_PROJECT}"` | Work orders and explanation (one call per video); report | Catalogue checked 16 Oct: `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B` per video and for the report; `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` for the report only if it answers in under ~10 s; `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B` (vision) as the box fallback. JSON mode isn't documented, so validate with Pydantic and retry once |
| cuOpt | Hosted API; our own key in `NVIDIA_API_KEY` | Crew routing | See 3.8 |

- **GPU endpoints:** read URLs from env (the skills hardcode an old host) and send `Authorization: Bearer $GPU_BEARER_TOKEN` when it's set; the docs disagree on whether it's needed.
- **Shared GPUs:** every team's ingest uses them, and the guide's recap says "you don't call them directly, you query the vectors generated" (though the gpu skills do call them). Ask staff first thing whether ~6 concurrent calls from us are OK.
- **Not used:** YOLO11 (its COCO classes have no road defects) and Canary-1B.
- **Weave:** `weave.init(f"{WANDB_TEAM}/{WANDB_PROJECT}")` and `@weave.op` on model-calling functions that take paths or IDs, not base64 payloads (Weave logs inputs). The W&B judge gets a trace of the agent; we get latency numbers.
- **Secrets:** env vars on the VM only. Never log or commit them.

### 3.3 Live pipeline
- **Start:** `POST /api/videos` starts a background task. Stage (`segmenting`, `checking 3/6`, `checking history`, `planning repairs`) and progress live in memory and are polled. Run blocking work (ffmpeg, SDK, ADBC) via `asyncio.to_thread` so polling stays responsive.
- **Provenance:** the demo clip must come from the corpus (no internet video). Cut it in advance from consecutive PIE segments and name it like `set04_video_0008_t0310.mp4`; the backend parses the drive and start time to look up GPS. In production this comes from the fleet's GPS sidecar. Choose a moving stretch of a street that another drive also covered (compare the drives' GPS tracks to find one), plus a backup chosen the same way. In pre-compute, for both clips, **exclude the clip's own segments and include the other drive's segments for that street**, so on stage some detections merge into existing pins and the rest appear as new ones.
- **Segmenting:** one ffmpeg pass into 5 s pieces at 720p, no audio:
  `ffmpeg -i in.mp4 -vf scale=-2:720 -an -c:v libx264 -preset veryfast -crf 23 -f segment -segment_time 5 -reset_timestamps 1 seg_%02d.mp4`.
  Keyframes come from the original.
- **Per piece** (one global semaphore of ~6 GPU calls, shared with pre-compute; pause pre-compute during demos):
  1. *Find:* one Cosmos video call returning `{"issues":[{category, severity, description (≤20 words), t (s into piece), confidence}], "scene"}`. The prompt lists the 6 categories, asks only for clearly visible issues (ignore vehicles and people), and includes the severity rubric below.
  2. *Box:* per issue, send the frame at `t` to Cosmos for one box, `[x1, y1, x2, y2]`, stored normalised as x, y, w, h. **Verify on the day** whether it returns pixels or 0–1000, using a frame with an obvious object.
  3. *Embed:* crop the box plus a margin (the whole keyframe if there's no box), resize to 448×448 (libx264 needs even sizes), make a 1 s still clip (`ffmpeg -loop 1 -i crop.jpg -t 1 -r 8 -c:v libx264 -pix_fmt yuv420p crop.mp4`) and embed it. A whole-piece embedding would describe the street, not the defect. If stills match poorly on 3 known pairs, embed the piece instead.
  4. *Geolocate:* GPS at clip start + piece start + `t`, interpolated. Optionally move the point ~10 m ahead along the heading, since the camera looks ahead.
- **After all pieces:** dedupe (3.5), then one Nemotron call for the new canonical issues' work orders plus the video explanation (the crew comes from `CREW_FOR` and the urgency from the rubric; Nemotron fills in repair, minutes and equipment). Insert into VastDB, regenerate the report, and save the result as a replay file keyed by the clip's hash (section 7).
- **What the viewer sees:** provisional pins as each piece finishes, re-sightings merging into existing pins after dedupe ("seen 2 times"), and work orders at the end.

**Severity rubric** (used in the Find prompt, the map legend and dispatch prizes; tune the examples on real segments)
| Severity | Meaning | Urgency | Examples |
|---|---|---|---|
| 1 | Cosmetic | routine | light tagging, slightly faded paint |
| 2 | Minor | routine | small crack, worn but visible markings |
| 3 | Repair this month | soon | pothole forming, faded crosswalk, overflowing bin |
| 4 | Repair this week | soon | pothole in a traffic lane, hard-to-read sign |
| 5 | Safety hazard, fix today | urgent | deep pothole, blocked or missing stop sign, unguarded work zone |

**Latency budget for the live clip** (targets; measure with Weave)
| Step | Target |
|---|---|
| Upload (laptop → SSH tunnel → VM) | 2–5 s, so keep the clip to 20–30 s, 720p, ≤5 MB |
| Segment | ≤2 s |
| Find, 4–6 pieces in parallel | 5–15 s |
| Boxes, then crop embeddings | 4–10 s |
| Dedupe SQL | ≤2 s |
| Nemotron work orders and explanation | 3–10 s |
| **Total** | **about 20–40 s** |

If it runs long: use a shorter clip and lower max_tokens, and narrate over the populated map.

### 3.4 Geolocation (PIE GPS)
- **The data (checked locally):** 53 PIE clips in 6 sets, mostly ~10 min at 30 fps (8.4 h, about 117 km). Each `video_XXXX_obd.xml` has a row per frame: lat, lon, heading, OBD and GPS speed, IMU. There are no wall-clock timestamps, so show the drive and clip ID, not dates. Drop about 3.5k rows outside Toronto (almost all in set03/video_0004) and 100 zero rows; load the rest into `gps` at 1 Hz (about 30k rows) and keep the CSV as a fallback.
- **Segment inventory (first hour):** read `source`, `original_video`, `filename`, `segment_start_sec` and `extra_metadata` for every `pie_cam-3` row of `vss-collection`, with explicit columns as in the vastdb-read `query.py`. This list drives pre-compute, the GPS mapping and the demo-clip cut.
- **Mapping a segment to drive and `t` (Verify on the day, first hour):**
  - Batch-sync names chunks `{user}/{ts}_{source-stem}_chunk_{NNNN}.mp4` and records `chunk_start_sec`; the writer keeps it in `extra_metadata` with `stream_position_sec`, the position in the source file. Segments are `segments/{chunk name}_segment_{NNN}_of_{TTT}.mp4`.
  - If the stem is a PIE clip (e.g. `video_0008`), that position is `t`. If it's a whole set, walk the cumulative clip durations (frame count ÷ 30); a set's indexed duration should equal the sum of its clips.
  - Check 2–3 points: the car is stopped when OBD speed is about 0, and turns line up with heading changes.
- **Stopped time:** speed is under 2 km/h in 41% of samples, so sample moving segments only and cut the live clip from a moving stretch.

### 3.5 Dedupe and similar issues (VastDB Level 2)
- **Why:** an issue reappears in consecutive pieces, while the car waits at lights, and on other drives (about 16% of ~30 m street cells are covered by more than one PIE drive set).
- **Rule:** a detection is a re-sighting of canonical issue X if it has the same category, is within about 35 m, and has cosine similarity above a threshold calibrated on a few known pairs. If the pairs don't separate, use category and distance, and keep the vector for ranking. Check within the clip in memory and against history with one VastDB SQL query (3.1), processing detections in time order so parallel pieces can't race.
- **History means corpus issues.** Uploads aren't history for later uploads, so rehearsals and repeat demos of a clip can't become re-sightings of themselves.
- **Storage:** a re-sighting is an `issues` row with `duplicate_of = X`. The map and dispatch use canonical issues only, and the UI can show "seen N times". A canonical issue's severity is the maximum over its sightings, computed in memory because rows are never updated.
- **Similar issues (shown in the issue panel):** `GET /api/issues/{id}/similar` runs the same SQL without the location filter, excluding the issue itself, e.g. to find the same tag on other walls. Show the top 3–5 as thumbnails.

### 3.6 Corpus pre-compute
- **Running:** fills the map with "yesterday's fleet footage". It runs inside the backend (sharing the semaphore and memory), is started and stopped by admin endpoints, and skips segments already done. Start it once the pipeline works on 5 real segments and the GPS mapping checks out: **by ~12:30**.
- **Small sample, not the whole corpus.** We only need enough footage to prove the point, so pre-compute runs on a **small set of segments spread apart** (about 40–60), not all ~8 hours. That keeps it to a few minutes of GPU time.
- **Candidates (cap ~60):**
  1. *Spread-apart sample:* moving segments taken at even gaps across every drive (set01–06), e.g. one every 5–10 minutes of driving, so the pins cover the whole city rather than clustering on one street.
  2. *Demo clips:* never their own segments; always the other drive's segments for the same streets (3.3).
  3. *Optional, only if there's time:* a handful of top hits from VSS search (`POST /api/v1/search`, JWT from `/api/v1/auth/login`, `metadata_filters: {"camera_id": "pie_cam-3"}`, `hybrid_text_weight` about 0.2) to add segments likely to contain issues. Keep it to about 10 extra.
- **Processing:** download each candidate from its `source` URI with read-only boto3 (if access is denied, use `GET /api/v1/videos/stream?source=…&token=…`), scale to 720p, and run the per-piece steps, dedupe and Nemotron. Group results into "videos" by PIE clip, each with its own explanation.
- **Budget:** about 50 segments should take a few minutes on the shared GPUs (an estimate; measure with Weave). Only widen the sample if it finishes quickly and the map looks thin.

### 3.7 Report
- **Severity rating pass first** (`app/ai/rating.py`): Cosmos3-Reason re-grades each sighting from its keyframe (the frame with the box drawn on plus a close-up), against the rubric and per-category anchors in `prompts.py`, and returns a one-sentence reason and a verdict; Nemotron Super-VL answers when Cosmos can't. Ratings are rows on top of the insert-only issue rows (`state/ratings.jsonl` and the VastDB `ratings` table; newest per issue wins), so the find grade is kept and a re-grade can be undone. Live uploads are rated within a 15 s budget; `scripts/rate_severity.py` rates the corpus and `--eval` checks it against hand labels.
- **Inputs:** open canonical issues (rejected ones counted apart), giving counts by category and severity, a top-priority list, and each crew type's workload (the sum of its work-order minutes).
- **Detail, all computed in code:** per-category sections (counts, worst findings with the rater's reason, workload, crews, equipment from work orders), a priority list with deadlines, hotspots (findings within 300 m, weighted by severity, named by the nearest street from OSRM) and provenance (which models answered, coverage, caveats). Nemotron writes the summary, rationale, a repair approach per category and a note per hotspot; the template covers every part when it fails.
- **Crew numbers:** a baseline per type of ceil(workload × 1.3 ÷ 480 min), computed in code so the LLM doesn't do arithmetic. Nemotron writes the summary and recommended crews with reasoning as JSON, which we validate.
- **Freshness:** regenerated in the background after each analysis (at most once a minute during pre-compute); `POST /api/report` forces it. Meanwhile the UI shows the previous report marked "updating".
- **Hand-off:** the recommended crews pre-fill the dispatch form, and the manager can change them.

### 3.8 Dispatch (cuOpt)
- **Hosted API (build.nvidia.com sample):** `POST https://optimize.api.nvidia.com/v1/nvidia/cuopt` with `Authorization: Bearer $NVIDIA_API_KEY` and `Accept: application/json`; body `{"action": "cuOpt_OptimizedRouting", "data": {...}, "client_version": ""}`. A 202 means poll `GET https://optimize.api.nvidia.com/v1/status/{NVCF-REQID}` (from the response header) until it returns 200. Large requests need NVCF's asset upload, so keep to about 100 jobs with integer-minute matrices. The hosted solver is marked non-commercial use only.
- **Categorise, then route each category from its own bases** (`backend/app/planning/`):
  - The pipeline's structured output is normalised onto the six categories (`prompts.normalise_category`: "pothole" → pavement, "garbage"/"trash" → waste, "construction"/"cones" → work_zone, …), so a model or upstream label that isn't an exact category name is kept rather than dropped.
  - **Sites** (`facilities.json`, 21 real City of Toronto sites, each with an address and a source URL): 7 Solid Waste transfer stations, 3 Solid Waste collection yards, 9 Transportation Services road-operations yards (Toryork hosts Signs and Pavement Markings) and 2 street-cleaning yards. Only Morningside is `assumed` (the yard is listed, its address is not). Each site stores **trucks per day per crew type** (`Facility.vehicles`). The Sites tab adds, edits and removes sites: edits live in `state/facilities.json` over the bundled list (atomic writes; `POST /api/facilities/reset` restores it). Set `FACILITIES_FILE` to swap the bundled list.
  - Every job is assigned to the nearest site with a truck of its crew type. (An older request with only `crews` shares those trucks over the sites by workload, as before.)
  - **Triage before routing** (`triage.py`): Nemotron Ultra (W&B Inference, traced in Weave) proposes today / later / defer per job with a reason; code keeps the hard rules: the user's severity floor, crews with no trucks, severity 5 and operator-pinned jobs today, S4 never deferred while there is room, today's minutes within capacity, routine jobs today only next to other work. Rules decide when the model doesn't answer; `Plan.triage.model` says which.
  - **Round trips over days:** every truck leaves its site at 08:00, is back by 16:00, takes a 30-minute lunch (a cuOpt vehicle break between 11:30 and 13:00, at a job site), and severity 5 jobs have a start window before noon. Day by day, (crew type, site group) units are packed into problems of at most 100 jobs; what a day can't fit rolls into the next. Each route carries its day, the full `schedule` (leave, drive / arrive / work / leave per stop, lunch, back) and `totals`. The fallback router reserves lunch after the job nearest 11:30.
  - **Workforce recommendation** (`recommend.py`, `POST /api/dispatch/recommend`): Nemotron proposes 2–4 scenarios (trucks per site per crew, floor), code clamps them and adds the current settings; every scenario is triaged (rules) and solved by cuOpt over one shared set of street matrices within a 30 s budget and scored in code; Nemotron picks one from the scored table (one refinement round allowed) and code validates the pick (pinned and S5 coverage, then S4, then drive hours per job). Rules propose and pick with no model; the fallback router evaluates with no cuOpt. "Apply and plan" reuses the scenario's solved routes while the backlog and sites are unchanged (15 minutes).
- **Multi-depot problems** (crew types packed together; each vehicle only takes its own crew's jobs), solved concurrently (3 at a time), each under the hosted cap of about 100 jobs:
  - `cost_matrix_data` and `travel_time_matrix_data` are `{"data": {"0": M}}`, where M holds integer driving minutes between the bases in use and the jobs. These come from the OSRM table API (`ROUTING_URL`, default the public demo server), one table per base cluster when there are more than 100 points. The haversine estimate (× 1.3 ÷ 25 km/h) fills in when OSRM is off or unreachable. `Plan.matrix_source` says which was used.
  - `fleet_data`: `vehicle_locations` `[[b, b], …]` (each vehicle starts and ends at its base), `vehicle_ids` (`sanitation-1`, …) and `vehicle_time_windows` `[[0,480], …]`.
  - `task_data` has `task_locations`, `task_ids`, `service_times` (work-order minutes), `order_vehicle_match` (each job → **only the vehicles at its nearest base**, so every run stays local) and `prizes` (from severity, so the least important jobs drop first when shifts are full).
  - `solver_config` has `time_limit` about 3 s (the solver uses the whole limit, so this is the demo wait) and `objectives` with a non-zero `prize` weight (prizes are subtracted from the cost; a weight of 0 turns them off).
- **Expect idle crews:** cuOpt minimises the number of vehicles first by default, so a dispatched crew may get no route. Show "3 of 4 crews needed" rather than forcing `min_vehicles`, which can be infeasible with crew-type matching.
- **Response:** `response.solver_response.vehicle_data[vehicle_id]` holds parallel lists `task_id`, `route`, `arrival_stamp` and `type`, each becoming a `Route` (stops and ETAs). `Plan.unassigned_reasons` says why each job wasn't routed: no crew of its type, over the cap, or the shift at its base is full.
- **Road alerts and paths** (`hazards.py`, `paths.py`):
  - Alerts are the City of Toronto road-restrictions feed (RoDARS open data, cached 15 minutes and on disk) plus canonical `work_zone` issues from our own footage. City rows are kept if they're active today and their schedule overlaps the 08:00–16:00 shift. Severity: closed both ways 5, closed one way 4, construction both ways 3, one lane 2.
  - Each route's street path comes from OSRM through base → stops → base. A leg that *runs along* a severity ≥ 4 closure (≥ 60 m of overlap; crossing doesn't count) or a severe dashcam work zone is re-asked for alternatives, then for detours through a point a block either side, and the clearest, fastest candidate wins.
  - `Route.warnings` lists what was avoided and what is still on the way. `Route.maps_urls` holds Google Maps driving links, chained at 10 points. `Route.brief` is a plain-text run sheet to send to the crew.
  - The public OSRM server allows about one request a second, so calls are serialised, cached and budgeted: street paths go to the busiest routes first (`PATH_SECONDS`) and the rest are straight lines. A self-hosted OSRM (`ROUTING_URL`, `ROUTING_MIN_INTERVAL_S=0`) lifts the budget.
  - `POST /api/directions` runs the same steering for any origin → destination (the console's Directions tab: base → selected job).
- **Fallback:** nearest-neighbour routes (highest severity first), labelled in the UI.
- **Before the event:** send a 3-job toy request with our key.

### 3.9 Frontend notes
- **Polling:** `GET /api/videos` and `GET /api/issues` every ~1 s during analysis, otherwise every ~10 s.
- **Map:** for example Leaflet (`react-leaflet`) with a basemap that needs no key; pins coloured by severity, one colour per crew route, and a toggle (`ui_spec.md`).
- **Issue panel:** `<img src="/api/frames/{id}">` with an absolutely positioned box from the normalised bbox (nothing is drawn server-side), the work order, "seen N times" and similar issues.
- Until the backend is ready, build against mock JSON that follows section 4.

---

## 4. Data contract
```python
Category = Literal["pavement", "graffiti", "markings", "work_zone", "signage", "waste"]
Crew     = Literal["roads", "graffiti", "markings", "inspection", "signage", "sanitation"]
CREW_FOR = {"pavement": "roads", "graffiti": "graffiti", "markings": "markings",
            "work_zone": "inspection", "signage": "signage", "waste": "sanitation"}

class BBox(BaseModel):      x: float; y: float; w: float; h: float   # normalised 0..1, top-left origin
class WorkOrder(BaseModel): repair: str; crew: Crew; minutes: int; equipment: list[str]; urgency: Literal["routine","soon","urgent"]
class Issue(BaseModel):
    id: str; video_id: str; t: float                   # seconds from the start of the video
    category: Category; severity: int = Field(ge=1, le=5)   # rubric in 3.3
    confidence: float; description: str
    frame_url: str                                     # /api/frames/{id}
    bbox: BBox | None; lat: float | None; lon: float | None
    duplicate_of: str | None = None                    # set on re-sightings
    sightings: int = 1                                 # canonical: 1 + re-sightings
    work_order: WorkOrder | None = None                # canonical issues only
    featured: int | None = None                        # demo rank from backend/app/curation.json, 1 first
    # severity rating pass (backend/app/ai/rating.py), all optional; absent = the find pass's grade
    severity_reason: str | None = None                 # one sentence: what the rater saw, why this grade
    severity_model: str | None = None                  # "cosmos3-reason" | "nemotron-super-vl" (fallback)
    verdict: Literal["confirmed","rejected"] | None = None   # rejected = not a real defect; kept, never deleted,
                                                       # left out of report counts, dispatch and dashcam hazards
    find_severity: int | None = None                   # the find pass's grade before re-grading
    # operator input, optional:
    source: Literal["upload","corpus","manual"] | None = None   # manual = marked by an operator on footage
                                                       # (POST /api/issues); severity_model "operator"; never deduped
    pinned: bool = False                               # include in the next plan; triage treats it as must-do
    name: str | None = None                            # operator's name for the issue (≤ 80 chars, a `names` overlay row);
                                                       # canonical: the newest name among its sightings. UI label:
                                                       # issueLabel(i) = name ?? description
class Video(BaseModel):
    id: str; filename: str; source: Literal["upload","corpus"]
    status: Literal["queued","analysing","done","failed"]; progress: float; stage: str | None = None
    drive: str | None = None; start_s: float = 0; duration_s: float = 0   # drive e.g. "set04/video_0008"
    explanation: str | None = None; issue_ids: list[str] = []; track: list[tuple[float, float]] = []
class Report(BaseModel):    generated_at: datetime; summary: str; counts: dict[str, int]; crews: dict[Crew, int]; rationale: str
    # optional detail (older reports lack it; figures come from code, Nemotron writes prose only):
    model: str | None                                  # display name of the model that wrote the prose
    stats: ReportStats | None                          # open, today (S5), this_week (S4), this_month (S3), routine,
                                                       # located, drives, crews, crew_hours, rejected
    sections: list[ReportSection] = []                 # per category: open, by_severity {"1".."5"}, severe, rejected,
                                                       # work_minutes, crew_hours, crews, equipment [{label,count}],
                                                       # top: list[ReportIssue], approach (Nemotron, else template)
    priorities: list[ReportIssue] = []                 # every open severity 4-5 issue, worst first
    hotspots: list[ReportHotspot] = []                 # id, label, lat, lon, radius_m, issues, severe, max_severity,
                                                       # score, categories, drives, issue_ids, note
    provenance: ReportProvenance | None                # report_model, find_model, rating_models {model: n}, unrated,
                                                       # rejected, sightings_total, canonical, duplicates_merged,
                                                       # with_embedding/gps/box, work_orders, template_work_orders, caveats
    crew_plan: ReportCrewPlan | None                   # latest stored Plan summarised in code: solver, matrix_source, routes,
                                                       # trucks, jobs, days [{day, jobs, trucks, drive_h, work_h, km,
                                                       # back_first, back_last}], sites [{label, kind, trucks per crew, jobs}],
                                                       # triage_model, today/later/deferred + decisions with reasons,
                                                       # unassigned with reasons, note (Nemotron); None = no plan yet
class ReportIssue:          id, category, severity, severity_reason, description, name (current), video_id, drive, t, lat, lon,
                            place (nearest street), sightings, confidence, deadline ("today"|"this week"|"this month"|
                            "routine"), crew, repair, minutes
class Route(BaseModel):     crew_id: str; crew: Crew; stops: list[str]; eta_min: list[int]; path: list[tuple[float, float]]
    # optional extras: facility_id, depot, depot_label, distance_km, path_source ("road"|"straight"),
    # warnings: list[RouteWarning], maps_urls, brief (plain-text run sheet),
    # day (1-based), vehicle_id (crew_id is unique per day: "roads-2/d2"), schedule: list[ScheduleEntry]
    # (kind depart|job|break|return, issue_id, label, lat, lon, drive_min, arrive_min, work_min, depart_min,
    # idle_min, severity, pinned), totals: ShiftTotals (drive_min, work_min, break_min, idle_min, distance_km,
    # back_min, jobs, lunch "solver"|"reserved"|"none"), solver
class Plan(BaseModel):      routes: list[Route]; unassigned: list[str]; solver: Literal["cuopt","fallback"]; solve_ms: int
    # optional extras: unassigned_reasons, facilities: list[Facility], hazards: list[Hazard], matrix_source,
    # min_severity, horizon_days, sites: list[PlanSite] (trucks per crew per day, jobs), days: list[PlanDay],
    # triage: Triage (model, rationale, by_crew, capacity_min, clamped, decisions[issue_id, decision, reason, by,
    # pinned]), deferred, pinned, recommendation: Recommendation, scenario_id (see the Plan docstring in models.py)
    # solver is "fallback" whenever cuOpt failed; the console shows it, so a fallback is never passed off as cuOpt
class SimilarIssue(Issue):  distance: float | None = None   # cosine distance, 0 = identical
                            search: Literal["vastdb","local"] # VastDB ADBC answered, or the in-memory numpy fallback
# Facility (kind transfer_station|collection_yard|road_yard|cleaning_yard|yard; extras source_url, note, custom,
# vehicles: trucks per day per crew type), Hazard, RouteWarning, Directions, Recommendation, Scenario,
# ScenarioMetrics: see backend/app/models.py (dispatch, sites and road alerts)
```

## 5. API
| Endpoint | Returns |
|---|---|
| `POST /api/videos` (multipart, one file; the UI loops for several) | `Video`; analysis starts |
| `POST /api/run` | `Video`; re-reads the VAST index, picks up to 30 s of footage no pass has analysed (held-back demo segments first) and analyses it live. 409 when there is nothing new |
| `GET /api/videos` | `Video[]`, including live progress and stage (polled) |
| `GET /api/videos/{id}` | `{video: Video, issues: Issue[]}`, including re-sightings |
| `GET /api/issues` | Canonical `Issue[]` for the map, including provisional ones from a running analysis |
| `POST /api/issues` `{video_id, t, category, severity, description, bbox?, pinned, name?}` | `Issue` with `source: "manual"`, `severity_model: "operator"`, `verdict: "confirmed"`. Best effort, never fails on a model: keyframe from the playable file at `t` (ffmpeg → `state/frames`, VAST S3), lat/lon from PIE GPS at `start_s + t`, work order from Nemotron Lightning (template fallback), Cosmos-Embed1 vector for similar issues. No `bbox`: the whole frame. Never deduped. 404 for an unknown video |
| `PATCH /api/issues/{id}` `{pinned?, severity?, revert_severity?, name?}` | `Issue`. Pin or unpin (a `pins` row), name it (a `names` row; trimmed to 80 chars, `""` clears), set an operator severity (a `ratings` row, `model: "operator"`), or undo it (back to the model's grade). Reversible overlays; issue rows are never rewritten |
| `GET /api/issues/{id}/similar` | `SimilarIssue[]` (top 5) for the issue panel: VastDB vector search, with `distance` and which index answered (`search`) |
| `POST /api/search` `{query}` | `{query, hits: [{video_id, start, end, score, similarity, caption}], search: "vss", synthesis, cached}`: plain-language footage search over the VSS index (`pie_cam-3`). Each VSS 5 s segment maps through the inventory to a listed corpus drive; touching segments merge into one band; weak hits (below 0.1, or 0.6 × the best) are dropped. `score` is the rank (1 = best), `similarity` the raw VSS score, `caption` the sentence of VSS's caption closest to the query, `synthesis` VSS's LLM answer over the top 3 clips. 422 on a query outside 3–200 characters; 503 when VSS is down or busy (no fallback). Cached per query in `state/vss_search_cache.json` |
| `GET /api/frames/{issue_id}` | JPEG, from the VM disk cache, else VAST S3 (or the `frames` table in the fallback) |
| `GET /api/report` | Latest `Report` (instant) |
| `POST /api/report` | Regenerates the report → `Report` |
| `POST /api/dispatch` `{crews?, sites?, days?, min_severity?, triage?, scenario?}` | `Plan`. `sites`: site id → crew → trucks per day (default: what the sites store); `days` 1–7; `min_severity` the floor; `triage: false` skips Nemotron; `scenario: {recommendation_id, scenario_id}` applies a recommendation (reusing its solved routes while fresh). Older `{crews}` requests still work. Saved as the latest plan; the report regenerates |
| `GET /api/plan` | The latest `Plan`, or null |
| `POST /api/dispatch/recommend` `{days?, min_severity?, sites?, agent?}` | `Recommendation`: scenarios with settings and cuOpt-scored metrics, the pick, rationale, `agent_model`, timings. `GET` returns the latest; `GET /api/dispatch/recommend/progress` → `{running, stage, scenarios_done, scenarios_total, elapsed_s}` for the button |
| `GET /api/facilities` | `Facility[]`: City sites with crews and trucks per day |
| `POST /api/facilities`, `PUT /api/facilities/{id}`, `DELETE /api/facilities/{id}`, `POST /api/facilities/reset` | Add (`label, kind, crews, lat, lon` required), edit (any field, e.g. `vehicles`), remove (a bundled site is remembered as removed), restore the bundled list. 422 outside Toronto or without crews |
| `GET /api/geocode?q=` | `{lat, lon, label}` for an address in Toronto (OSM Nominatim, 1 request a second, cached); 404 no match |
| `GET /api/hazards` | `Hazard[]`: city road restrictions plus dashcam work zones near bases and open jobs |
| `POST /api/directions` `{origin, destination}` | `Directions`: road path around closures |
| `GET /api/health` | `{ok, store_source}` |
| `POST /api/admin/precompute/start`, `/stop`; `POST /api/admin/reset` | Admin only, not in the UI. Reset hides uploads made before it (the cutoff is kept in the local snapshot) |
| `GET`/`POST /api/admin/demo` `{on: bool}` | Admin only. Demo mode (off by default; `DEMO_CURATION=1` at start): issues carry `featured` ranks from `backend/app/curation.json`, reviewed false positives are hidden from issues, report, dispatch and hazards, and `/api/videos` lists only uploads, running jobs and drives holding a pick. Off, every endpoint serves the pipeline's data untouched. The choice persists in `state/demo_curation.json` |

---

## 6. Build order and critical path
**Gate checks, 09:30–10:30.** They block everything else; run them in parallel.
1. Staff: are ~6 concurrent direct Cosmos calls OK? May we use the PIE GPS metadata?
2. `pie_cam-3` is indexed; segment inventory built; 2–3 segments mapped to GPS (3.4).
3. Cosmos3-Reason on 5 real segments per category (quality, JSON, latency, image input, box coordinates); Cosmos-Embed1 on a still crop.
4. VastDB: `citymaint.issues` created with its vector column; a row inserted and read back through ADBC.
5. Test objects in the segments bucket leave Explore and the dashboard unchanged (3.1).
6. Nemotron through W&B returns valid JSON and appears in Weave.
7. VM tooling: `ffmpeg -version` (otherwise `pip install imageio-ffmpeg`) and `node -v` (otherwise nvm, or run Vite on a laptop with `/api` proxied to the forwarded port).

The cuOpt toy request is done the night before.

| By | Milestone |
|---|---|
| ~11:30 | One real PIE segment end to end: find → box → embed → geolocate → insert → `GET /api/issues`. UI shell on mock data: drop zone, directory, map, frame + box |
| ~12:30 | **Demo clip and backup chosen, then pre-compute running.** Pre-compute needs the 11:30 milestone, the GPS mapping and both clips (to exclude their segments and include the overlapping drive's), then a few minutes of GPU time (small spread-apart sample, 3.6) |
| ~14:00 | Live clip end to end with progress; dedupe and similar issues; work orders, explanations and video pages |
| ~15:00 | Report, dispatch and routes on the map. Feature freeze |
| 15:00–15:45 | Rehearse the demo, keep its replay file, reset, record the backup video |
| 15:45–16:30 | README and description, push to GitHub, submit |

**Critical path:** gate checks → one segment end to end → GPS mapping → demo clips → pre-compute running → rehearsal. The rest can slip without losing the demo.

**If time runs short, cut from the bottom:**
- **Must have:** everything in `ui_spec.md` (live pipeline, corpus on the map, frame + box, progress bars, directory and video pages with explanations, report with recommended crews, dispatch with routes, by cuOpt or the fallback), plus dedupe and Weave.
- **Committed, wired right after:** VastDB vector SQL for dedupe and similar issues (Level 2). The numpy path stands in until then and stays as the fallback.
- **Only if time allows:** playing the original clip, report and plan history.

## 7. Demo reliability: risks and fallbacks
| Demo step | What can fail | Cheap fallback |
|---|---|---|
| Populated map | Pre-compute late or slow | It's resumable, so a partial corpus still fills the map |
| Populated map | PIE GPS not allowed, or the mapping unclear | Issues without pins; dispatch on fixed coordinates, stated openly |
| Live clip | Shared GPUs slow or down | Short 720p clip, pre-compute paused. **Replay:** if a model call fails or the run passes ~60 s, serve the rehearsal result for the same clip (by content hash) with the same stages, and say so |
| Live clip | A rehearsal or earlier demo already "found" its issues | Uploads are never dedupe history (3.5); `POST /api/admin/reset` hides earlier uploads |
| Live clip | Dedupe doesn't fire on stage (the other drive's issue wasn't found) | The rehearsal shows it; switch to the backup clip (3.3) |
| Live clip | Cosmos weak on some categories | Keep only the categories that work; crop to the road for pavement and markings |
| Frame + box | Boxes unreliable | Nemotron Super VL on the same frame; otherwise no box |
| Report | Nemotron slow or invalid JSON | Previous report marked "updating"; one retry, then a template from the counts (work orders: `CREW_FOR` + default minutes) |
| Dispatch | cuOpt down or key rejected | Nearest-neighbour routes, labelled in the UI |
| Dispatch | OSRM or the city feed unreachable | Straight-line minutes and paths (`matrix_source`/`path_source` say so); last cached city feed, else dashcam work zones only |
| Any step | VastDB down at startup; ADBC unavailable; bucket writes trigger ingest | Local snapshot; numpy over `embedding_bin`; keyframes in the VastDB `frames` table and originals on the VM disk |
| Whole demo | VM, tunnel or venue network drops | Backup video recorded by 15:45 (the submission needs one anyway) |

## 8. Open questions and decisions
- Everything marked **Verify on the day** is in the gate checks (section 6).
- Crew bases: real City transfer stations for sanitation. Works yards for the other crews are assumed points, labelled as such (`facilities.json`).
- The final category list, after testing Cosmos on real segments.
- **For the user to decide:** whether the replay fallback (section 7) is acceptable, provided we say when it's used.

---

**Sources checked (16 Oct):** guide repo README, `ARCHITECTURE_REFERENCE.md`, `config.example` and skills; `vss-blueprint` source (ingest triggers and key filters, writer, retrieval backend, reasoner, embedder, batch-sync); the build.nvidia.com cuOpt sample and cuOpt docs; the Cosmos-Embed1 NIM API reference; CoreWeave's serverless model catalogue; our own analysis of the PIE `annotations_vehicle` files.
