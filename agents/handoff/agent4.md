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
You are AGENT 4: GPS, segment inventory and demo clips. Your spec is agents/04_gps_and_demo_clips.md; implement its code.
You own and may write ONLY: backend/app/geo/gps.py, inventory.py, demo.py; scripts/load_gps.py, build_inventory.py, find_overlaps.py, cut_demo_clip.py. The data/ outputs (gps.csv, inventory.json, demo_clips.json, clips/) are produced later by running your scripts on the VM. Don't fabricate them.
</task>

<details>
GPS source: PIE's annotations_vehicle is ALREADY ON THE VM at ~/Real_time_VIdeo_Agents/data/pie/annotations_vehicle/setXX/video_XXXX_obd.xml (53 files, 237 MB; the default --src should be data/pie/annotations_vehicle).
- The exact format, verified: `<vehicle_info><frame GPS_speed="0.048" OBD_speed="0.0" accX=… heading_angle="132.44" id="0" latitude="43.682966333" longitude="-79.420487" pitch=… roll=… yaw=… />…</vehicle_info>`, one <frame> per video frame at 30 fps.
- Each file is a single line, so use xml.etree.ElementTree.iterparse. Speeds are km/h.
- Discover files by glob (any depth). Derive set and video ids from the path or filename.
- scripts/load_gps.py --src <dir> writes data/gps.csv (drive,t,lat,lon,heading,speed) at 1 Hz, where t is seconds from the clip start (frame/30). Drop rows outside a Toronto bounding box (~43.5–43.9, -79.7 to -79.1) and zero rows. Use `--db` to also call vast.db.insert_gps(rows) in batches.
- Also write data/clip_durations.json ({drive: seconds}, from the frame count / 30). The inventory mapping needs it, and it doesn't depend on lat/lon validity.

gps.py: lazy-load data/gps.csv once (missing file → locate/track return None/[] and log once).
- parse_upload_name: the README regex; also accept an optional `.mp4` case-insensitively.
- locate(drive, t, ahead_m=10): linear interpolation between 1 Hz rows, heading-aware projection of ahead_m metres; None outside the track.
- track(drive, start_s, duration_s): the [(lat, lon)] polyline, about 1 point per second.

inventory: scripts/build_inventory.py reads vss-collection READ-ONLY with explicit columns only (source, original_video, filename, segment_start_sec, camera_id, extra_metadata), using vastdb: tx.bucket(config.VASTDB_BUCKET).schema("vss-schema").table("vss-collection").select(columns=[...]).read_all(). NEVER select vector columns.
- Keep camera_id == "pie_cam-3".
- Map stream_position_sec, the position within the set-level concatenation, to (drive "setXX/video_YYYY", t_start) by walking the set's clips in order with data/clip_durations.json. Log a check of the set's indexed span against the clip durations.
- Flag `moving` from gps.csv (median speed ≥ 2 km/h over [t, t+5]). Unknown when there's no GPS: keep the segment but set moving=None.
- Write data/inventory.json. inventory.load() -> list[Segment] (a small pydantic model or dataclass with source_uri, drive, t_start, duration, moving, segment_id = filename).

find_overlaps.py:
- Bin all GPS tracks into ~30 m cells.
- Find moving stretches of ≥20 s on drive A whose cells are also covered by a DIFFERENT drive B, where B's covering segments are in the inventory (indexed), so pre-compute can include them.
- Print the top candidates (A drive, t range, B drive, B segment ids, distance stats).
- --write <n> writes data/demo_clips.json for a chosen primary and backup: {"clips":[{"name","drive","start_s","duration_s","source":…,"exclude_segments":[…A's indexed segment ids in range…],"force_segments":[…B's segment ids…]}]}.

cut_demo_clip.py: cut a 20–30 s clip at 720p, ≤5 MB, no audio, named like set04_video_0008_t0310.mp4, into data/clips/.
- The source can be a local PIE clip file (--src path; some full clips exist on the laptop, e.g. ~/Desktop/PIE_clips/set04_video_0008.mp4) or, when the range is inside the indexed first ~15 min of a set, the 30 s chunks in S3_CHUNKS_BUCKET downloaded READ-ONLY and concatenated.
- Name the clip with the PIE CLIP time t (seconds from that clip's start), so parse_upload_name + gps.locate line up.

demo.py: excluded_segments() -> set[str] and forced_segments() -> list[Segment] from data/demo_clips.json; a missing file → empty, logged once.
</details>

<verification>
Use SYNTHETIC data:
- a tiny fake obd XML for two drives with crossing tracks;
- a fake inventory, faking the vastdb read with a monkeypatch.
Show load_gps output rows, locate/track values, parse_upload_name cases, the set-position→clip mapping, and find_overlaps detecting the synthetic overlap. Clean up the temp files.
</verification>
