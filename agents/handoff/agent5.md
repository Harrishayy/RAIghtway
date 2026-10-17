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
You are AGENT 5: live pipeline and dedupe, the critical path. Your spec is agents/05_live_pipeline.md; implement it, with the corrections below.
You own and may write ONLY: backend/app/pipeline/live.py, segment.py, piece.py, dedupe.py, replay.py.
</task>

<corrections>
These override the spec:
- Do NOT wrap model calls in gpu.slot() (integration rule 1).
- Frames and ids: Detections have no id, so process_piece only keeps the local keyframe in Detection.frame_path. Issue ids, the frame copy to STATE_DIR/frames/{id}.jpg and media.put_frame happen where IssueRecords are created (dedupe.assign, and the provisional records below).
- Provisional pins: as each piece finishes, convert its detections to provisional IssueRecords with id "p-" + uuid4().hex[:10], duplicate_of None and the frame copied to the frames cache. Call store.add_issues(..., provisional=True). The final records from dedupe replace them via store.replace_provisional.
- report.schedule_regen() comes from agent 7, who is being written in parallel, so use a guarded import with a no-op fallback. Do the same for app.geo.gps (agent 4): without it, lat/lon stay None and the track is [].
</corrections>

<details>
- segment.py: functions run through asyncio.to_thread.
  - split(in_path, out_dir) -> list[str] uses the spec's ffmpeg command.
  - probe_duration(path).
  - extract_frame(original, t, out) writes a JPEG from the ORIGINAL video (full resolution).
  - crop(jpg, bbox|None, margin=0.15, out) -> 448x448 JPEG, using an ffmpeg crop+scale filter (no Pillow).
  - still_clip(jpg, out) uses the spec's command.
  - Use a per-run temp dir under config.STATE_DIR/"work".
- piece.process_piece(piece_path, original_path, piece_index, piece_offset_s, drive, clip_start_s) -> list[Detection]:
  - find_issues on the 720p piece.
  - Per issue, concurrently: extract the frame from original_path at piece_offset_s + t_piece, then box, then crop, still_clip and embed_clip (catch failures: embedding None), then gps.locate(drive, clip_start_s + piece_offset_s + t_piece) when drive is set.
  - Set piece_index, frame_path, bbox, embedding, lat/lon/heading. One issue failing must not kill the piece.
  - IMPORTANT for corpus segments: original_path is the 1080p segment and piece_offset_s is 0.
- dedupe.assign(detections, video: VideoRecord, *, use_history=True) -> list[IssueRecord]:
  - Sort by (piece_index, t_piece). Video time t = piece_index*5 + t_piece for uploads. For corpus segments the caller passes the right offset: accept an optional kwarg time_offset_s=0.0 and add it.
  - Re-sighting rule: same category, haversine ≤ 35 m (needs lat/lon on both sides) and cosine similarity ≥ DEDUPE_SIM.
  - Check in-clip matches first (memory), then history via vector.nearest(embedding, category=…, bbox=±35 m box, source="corpus", canonical_only=True, k=5), with distance confirmed from store.get_issue(id) lat/lon.
  - Module constants: DEDUPE_MODE = "vector" | "distance" (distance = category + 35 m only) and DEDUPE_SIM = 0.80, a placeholder that gets calibrated on the VM.
  - With no embedding or no location, the detection becomes a new canonical issue.
  - Create IssueRecords with id uuid4().hex[:12], source=video.source, frame_url=f"/api/frames/{id}", frame_key from media.put_frame (in-thread, "" on failure) and the frame copied to the cache. This function is sync and is called through asyncio.to_thread.
  - History = corpus only: uploads never become history.
- live.analyse_video(video_id, path, *, source, drive, start_s, on_progress=None):
  - Stages as in the spec, via store.set_progress, starting with status "analysing".
  - Pieces run concurrently; each one's provisional pins go in as it finishes. The stage is "checking i/N" with i = pieces finished.
  - Then run dedupe in a thread.
  - Then work orders: nemotron.work_orders_and_explanation(video, new_canonical, all) and attach work_order to the canonical records.
  - Then store.replace_provisional, then store.update_video(explanation, issue_ids, track=gps.track(drive, start_s, duration), duration_s), then set_progress(status="done", progress=1.0, stage="done").
  - Then media.put_original (in a thread, upload source only, failure logged) and report.schedule_regen().
  - Log per-stage timings.
- replay.py: lookup and save by the sha256 of the upload file, stored in config.STATE_DIR/"replays"/{hash}.json (stage timings + final IssueRecords + explanation + track).
  - For uploads, live checks for a replay after the run fails, or when the total passes REPLAY_AFTER_S = 60. In that case it cancels the work and replays the saved stages at their recorded pace, ending with stage "done (replayed)".
  - Save after every successful upload run.
  - Also expose a small CLI so dedupe can be calibrated on the VM: `python -m app.pipeline.dedupe --pairs a.jpg:b.jpg ...` prints the cosine similarity of the still-clip embeddings of image pairs.
</details>

<verification>
Use fakes for cosmos, embed, nemotron, media, vector and gps, a temp STATE_DIR, and a real tiny ffmpeg testsrc video (ffmpeg is on this Mac): `ffmpeg -f lavfi -i testsrc=d=12:s=1280x720 -pix_fmt yuv420p in.mp4`.
- Run analyse_video end to end. Show the stage sequence, the provisional→final replacement, one in-clip re-sighting (duplicate_of set) and one history re-sighting, update_video called before done, and frame files in the cache.
- Show the replay path: save, then a run where find raises/times out, with the replay used.
</verification>
