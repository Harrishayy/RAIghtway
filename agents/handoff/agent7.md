<context>
You are building one of agents 4–8 of a hackathon project TODAY (VAST Builders Challenge, London; submission 16:30). Agents 1–3 are finished and verified on the VM. Claude (the orchestrator) reviews and tests your work on the VM.

Work in ~/Real_time_VIdeo_Agents on the workshop VM (ssh bc-afthabshiraz). The real services (VastDB, S3, GPU models, W&B) are reachable there. Python: backend/.venv/bin/python (all deps installed).

Read first:
- agents/README.md (shared contracts + ground rules), your own agents/0N_*.md, and the architecture.md sections it lists.
- The REAL, finished modules from agents 1–3. Read them for exact signatures and behaviour; don't guess:
  backend/app/models.py, config.py, store.py, main.py, vast/{db,media,vector}.py, ai/{gpu,cosmos,embed,nemotron,prompts,weave_setup}.py.
These files and the package __init__.py files (backend/app/geo/, pipeline/, planning/) already exist. DO NOT edit any of them. Run Python from backend/ (with .venv/bin/python); imports look like `from app import config, store`.
</context>

<verified_facts>
Verified on the real VM by the orchestrator. They override older notes in the docs:
- Cosmos model is `nvidia/cosmos3-nano-reasoner` (config.COSMOS3_REASON_MODEL). Find takes ~2.5 s per 5 s piece at 720p and is conservative: empty results are normal. Box takes ~0.6 s (coordinates are 0–1000, handled inside cosmos.box). Embed takes ~0.3 s. Nemotron Ultra answered a report-sized prompt in 5.2 s and Lightning in 9.5 s.
- VastDB tables in schema citymaint exist, and ADBC vector search works (rows are visible in under 0.1 s). Writing frames to the S3 segments bucket doesn't trigger VSS ingest, so MEDIA_MODE=s3.
- The corpus has NO GPS. GPS comes only from PIE's annotations_vehicle files (per-frame XML; see agent 4).
- vss-collection has 1080 `pie_cam-3` rows: 180 per set (set01–set06), covering only the FIRST ~15 min of each set (30 chunks × 30 s × 6 segments of 5 s). Example row:
  source="s3://team-49-vss-chunks-segments/segments/20261001_060645_set01_video_chunk_0003_segment_002_of_006.mp4",
  original_video="s3://team-49-vss-chunks/team-49/20261001_060645_set01_video_chunk_0003.mp4",
  segment_start_sec=5.0 (within the chunk), camera_id="pie_cam-3", location="toronto",
  extra_metadata={"chunk_index":3,"chunk_start_sec":90.0,"stream_position_sec":95.0,"stream_id":"…","ingest_kind":"batch_chunk",…} (a JSON string or dict).
  The source stem is a WHOLE SET ("set01_video"), so stream_position_sec is the position within the set's concatenated clips (video_0001, video_0002, … at 30 fps).
- Segments are 1920x1080, 5.0 s. Transcode to 720p before Cosmos (`ffmpeg -vf scale=-2:720 -an -c:v libx264 -preset veryfast -crf 23`).
- The VM has ffmpeg and Python 3.12 (venv backend/.venv with fastapi, vastdb, pyarrow, boto3, numpy, httpx, openai, weave, ibis, pyyaml, adbc). It has NO node.
</verified_facts>

<integration_rules>
These are decided and binding:
1. GPU: cosmos.find_issues, cosmos.box and embed.embed_clip acquire gpu.slot() INTERNALLY. NEVER wrap them in gpu.slot() yourself, even if your spec says to; it would nest on the same semaphore. Pre-compute awaits gpu.wait_if_paused() between segments; live uploads never do.
2. Failure behaviour: find_issues and box never raise (they return an empty result or None). embed_clip RAISES on failure, so catch it. nemotron.work_orders_and_explanation never raises. vast.* functions are sync and raise; wrap them in asyncio.to_thread. vector.nearest never raises.
3. Store (`from app import store`), all sync:
   - add_video(VideoRecord) → set_progress(id, status=, progress=, stage=) → update_video(id, **fields).
   - A video is persisted ONCE when it first reaches status "done". So call update_video(explanation=…, issue_ids=…, track=…, duration_s=…) BEFORE set_progress(status="done"), and never add_video a record that already has status "done".
   - add_issues(list, provisional=True) for live pins, then replace_provisional(video_id, final_records).
   - store persists to VastDB itself, so NEVER call vast.db.insert_* for videos, issues, reports or plans. Only agent 4's insert_gps is allowed.
   - store.canonical_issues() computes sightings and max severity. store.get_issue(id).
4. Frames: GET /api/frames/{id} serves config.STATE_DIR/"frames"/f"{id}.jpg" first. Whoever creates an IssueRecord id copies its keyframe JPEG there, and also calls media.put_frame(id, jpeg_bytes) in a thread to get frame_key (on failure use "" and keep the local copy).
5. main.py already imports these exact names with guarded fallbacks, so expose them exactly:
   app.geo.gps.parse_upload_name, app.pipeline.live.analyse_video, app.planning.report.regenerate, app.planning.dispatch.plan, app.pipeline.precompute.start/stop/status. Teammate modules that may not exist yet when you run must be imported defensively too (try/except ImportError, with a tiny local fallback and a TODO comment).
6. Don't edit backend/requirements.txt (shared). List any new dependency in your report and the orchestrator adds it. Prefer the stdlib (xml.etree, json, math).
7. Use config.redact(exc) in logs, never raw exception text containing secrets.
</integration_rules>

<hard_rules>
- Write ONLY the files you own (listed below); other agents' files are shared and finished.
- Coordinate commits with the team; nothing is committed yet.
- Never print secrets (they come from /config via app/config.py; never hardcode hosts or keys).
- Never write to S3_CHUNKS_BUCKET or vss-schema (read-only is fine). Never name a file select.py.
- Hackathon-lean: small readable modules, fallbacks over polish. The live demo must never block on a failing dependency.
- Use the venv: backend/.venv/bin/python. If you need a new pip package, tell Claude (requirements.txt is shared).
</hard_rules>

<final_report>
Finish with:
1. Files written.
2. Public functions and signatures, flagging any deviation from agents/README.md.
3. Smoke checks with actual output.
4. "Verify on the day" items plus the exact VM commands (run from ~/Real_time_VIdeo_Agents/backend with .venv/bin/python).
5. New dependencies, if any.
</final_report>

<task>
You are AGENT 7: report and dispatch (Nemotron + cuOpt). Your spec is agents/07_report_and_dispatch.md; implement it, with the corrections below.
You own and may write ONLY: backend/app/planning/report.py, dispatch.py, cuopt.py.
</task>

<corrections>
- Never call vast.db.insert_*; store.set_report / store.set_plan persist (integration rule 3). main.py already calls store.set_report / store.set_plan after POST /api/report and /api/dispatch, so regenerate() and plan() just return the result. regenerate() may also call store.set_report: it's idempotent.
- Report model: Ultra measured 5.2 s, so use nemotron.chat_json(..., model=nemotron.ULTRA, timeout=10.0), then LIGHTNING (timeout=15.0), then the template.
- There's no network here, so the cuOpt toy request can't run now. Provide a CLI for the VM: `python -m app.planning.cuopt --toy` sends a 3-job request and prints the status and solve time, plus a compact response summary, with the key never printed. Save the request you send as backend/app/planning/cuopt_sample.json (the request shape only).
</corrections>

<details>
- report.py:
  - Inputs: store.canonical_issues(). Counts are keyed by category, plus "severity_N" keys (Report.counts is dict[str, int]).
  - Workload per crew = the sum of work_order.minutes, or prompts.DEFAULT_MINUTES[category] when there's no work order.
  - Baseline crews = ceil(workload*1.3/480) in code, 0 for crews with no work.
  - The prompt gives the counts, the top 10 priority issues (severity desc, confidence desc; id, category, severity, description) and the baseline, and asks for {summary, crews, rationale}. Clamp the LLM crews to [baseline-1, baseline+2], ≥0.
  - Fallback: a template.
  - schedule_regen(): sync and non-blocking. It schedules one background regeneration on the running loop and debounces to ≤1 per 60 s (a call within the window marks it pending and it runs when the window ends); call store.set_report when done.
  - is_updating() -> bool.
- cuopt.py:
  - async solve(payload) -> dict, using httpx with config.NVIDIA_API_KEY (the backend secret provides it; whether it's valid for the hosted cuOpt API is "Verify on the day").
  - POST, handle 202 + poll the NVCF-REQID status, overall timeout 20 s. Raise on failure.
- dispatch.py, async plan(crews: dict[Crew, int]) -> Plan:
  - Jobs = canonical issues with lat/lon (cap 100 by severity).
  - Depot = DEPOT = (43.6534, -79.3841) (Toronto City Hall, an assumed depot, labelled).
  - Integer-minute haversine matrix ×1.3 at 25 km/h.
  - Vehicles = one per crew unit (ids like "roads-1").
  - order_vehicle_match maps each job to the vehicle indices of its crew type (models.CREW_FOR).
  - Prizes by severity {5:1000, 4:500, 3:250, 2:100, 1:50}; time_limit 3; objectives with a non-zero prize weight.
  - Parse vehicle_data / dropped_tasks into Routes (path = depot → stops → depot) and unassigned ids.
  - On any cuOpt failure, nearest-neighbour per crew type, highest severity first, within 480 min: solver="fallback".
  - Idle crews appear as routes with empty stops.
  - The jobs where crews == 0 for their type are unassigned.
</details>

<verification>
- Monkeypatch nemotron.chat_json (success, then failure → template) and cuopt.solve (a fake cuOpt response, then raise → fallback).
- Use fake canonical issues around Toronto.
- Show the Report, both Plans, the debounce behaviour of schedule_regen, and prizes dropping low-severity jobs when crews are short.
</verification>
