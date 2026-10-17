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
You are AGENT 6: corpus pre-compute. Your spec is agents/06_precompute.md; implement it.
You own and may write ONLY: backend/app/pipeline/precompute.py, backend/app/pipeline/vss_client.py.
</task>

<context>
Agents 4 (app.geo.inventory, app.geo.demo, app.geo.gps) and 5 (app.pipeline.piece, app.pipeline.dedupe) are being written IN PARALLEL with you. Code against the README contract plus these details, using guarded imports.
- inventory.load() -> list of Segment with .source_uri, .drive, .t_start, .duration, .moving (True/False/None) and .segment_id (the filename).
- demo.excluded_segments() -> set of segment_ids; demo.forced_segments() -> list of Segment.
- piece.process_piece(piece_path, original_path, piece_index, piece_offset_s, drive, clip_start_s) -> list[Detection].
- dedupe.assign(detections, video, *, use_history=True, time_offset_s=0.0) -> list[IssueRecord] (sync; run it in a thread).
</context>

<details>
- vss_client.py (httpx, config.INGRESS_URL / VSS_USERNAME / VSS_PASSWORD, verify=False): login() caches the JWT; search(query, top_k=100, camera_id="pie_cam-3", hybrid_text_weight=0.2, min_similarity=0.15); stream_url(source) uses /api/v1/videos/stream?source=…&token=….
- Candidates (cap CANDIDATE_CAP=60), saved to config.STATE_DIR/"precompute_candidates.json":
  - Inventory segments with moving is not False, sampled at even gaps across each drive set (sort by drive, t_start; take every k-th so the total ≈ cap).
  - Plus forced, minus excluded; dedupe by segment_id.
  - The optional VSS-search extras sit behind a flag (default off).
- start(): if not running, create an asyncio task and return immediately. stop() lets the current segment finish and then exits. status() -> {running, done, total, errors, segments_per_min, eta_s, current}.
- Loop: skip segment_ids in config.STATE_DIR/"precompute_done.json" (resumable; write after each segment).
  - Await gpu.wait_if_paused().
  - Download the segment READ-ONLY with boto3: parse s3://bucket/key from source_uri; credentials and endpoint from config, verify=False, path-style; get_object only. Fall back to vss_client.stream_url via httpx on AccessDenied.
  - Transcode to 720p with ffmpeg, in a thread.
  - process_piece(piece_720p, original_1080p_segment, 0, 0.0, seg.drive, seg.t_start).
  - Process segments with small concurrency (SEGMENT_CONCURRENCY=3), but run dedupe.assign SERIALLY in segment order (one asyncio.Lock), so re-sightings across segments merge.
- Corpus videos, one VideoRecord per PIE clip (drive):
  - id "corpus-" + drive.replace("/", "-"), filename = drive, source "corpus", status "analysing", created on first use with add_video.
  - Each segment's records go in via store.add_issues (non-provisional) right after dedupe, so the map fills progressively.
  - When all of a drive's candidates are done: work orders via nemotron.work_orders_and_explanation for that drive's new canonical issues. Records already persisted are immutable, so call work orders BEFORE add_issues for each segment's new canonical issues (per segment; that's simpler), and a single explanation call when the drive finishes.
  - Then update_video(explanation, track=gps.track(drive, min t, span), duration_s) and only then set_progress(status="done").
  - Call report.schedule_regen() (guarded import, no-op fallback) after each segment.
- Log throughput, and log every error with config.redact; one bad segment never stops the loop.
</details>

<verification>
Fake the inventory (12 segments over 2 drives), demo (1 excluded, 1 forced), boto3 (it writes a tiny ffmpeg testsrc mp4), piece and dedupe, and use a temp STATE_DIR.
- Show the candidate selection.
- Run start(), let it finish, and show status(); store videos with done status and explanation; that a restart skips done segments; and that pause blocks progress until resume.
</verification>
