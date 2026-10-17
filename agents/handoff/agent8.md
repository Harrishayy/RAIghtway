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
You are AGENT 8: the frontend. Your spec is agents/08_frontend.md; implement it, following ui_spec.md closely (especially its design principles).
You own: frontend/ (React + Vite + TypeScript + Tailwind).
</task>

<setup>
- frontend/package.json already exists with pinned deps: react 18.3.1, react-dom, react-leaflet 4.2.1, leaflet 1.9.4, vite 5.4.10, @vitejs/plugin-react, typescript 5.6.3, tailwindcss 3.4.14, postcss, autoprefixer, @types/*.
- The VM has NO node, so run the frontend on a laptop: `npm install` in frontend/ (the deps are already installed on afthabshiraz's Mac).
- Create vite.config.ts with server.proxy "/api" → "http://localhost:8000". On the laptop, tunnel to the VM backend with `ssh -N -L 8000:localhost:8000 bc-<user>`; the backend runs on the VM via backend/run.sh (port 8000).
- Also write tailwind.config.js, postcss.config.js, tsconfig*.json, index.html and src/.
</setup>

<api>
The real backend is finished. Read backend/app/models.py (mirror it as TS types in src/api/types.ts) and backend/app/main.py (the routes).
- GET /api/videos -> Video[]
- GET /api/videos/{id} -> {video, issues} (re-sightings included)
- GET /api/issues -> canonical Issue[] (provisional pins included during analysis)
- GET /api/issues/{id}/similar -> Issue[]
- GET /api/frames/{id} -> JPEG (may 404: show a neutral placeholder)
- GET /api/report -> Report | null (null before the first report)
- POST /api/report -> Report
- POST /api/dispatch {crews: {crew: n}} -> Plan
- POST /api/videos (multipart field "file", one .mp4 per request) -> Video
- GET /api/health
Severity is 1–5 (rubric in architecture.md §3.3). bbox is normalised x, y, w, h (0–1, top-left origin): draw it as an absolutely positioned box over the <img>, scaled to the rendered image size. Stage strings look like "segmenting", "checking 3/6", "checking history", "planning repairs", "done", "done (replayed)", "Analysis failed: …". Plan.solver "fallback" → show an understated "fallback routing" label. Video.drive looks like "set04/video_0008": show the drive/clip id, not dates (PIE has no wall clock).
</api>

<details>
- Mocks: src/mocks/*.json behind VITE_MOCK=1 (≥30 corpus issues around Toronto lat 43.64–43.70, lon -79.45 to -79.35; 5 videos, one analysing; a report; a plan). Develop against the mocks first. The backend can also serve fixtures with DEMO_FIXTURES=1.
- Polling: GET /api/videos and /api/issues every 1 s while any video is queued or analysing, else every 10 s.
- Map: react-leaflet with a keyless basemap (e.g. CARTO light: https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png, with attribution).
  - Pins coloured by severity, using a colour-blind-safe sequential scale, with a legend giving the rubric meanings.
  - "seen N times" on merged pins.
  - One colour per crew route as polylines, with ETAs.
  - The map is toggleable and is NOT a "map left / panel right" layout.
- Issue panel: frame + box; category, severity and description; the work order (repair, crew, minutes, equipment, urgency); seen N times; 3–5 clickable similar-issue thumbnails.
- Report: summary, counts, recommended crews + rationale, and "updating…" while POST /api/report is in flight.
- Dispatch: a crew form pre-filled from report.crews and editable → routes on the map, "X of Y crews needed" (routes with empty stops are idle), the unassigned list, and the fallback label.
- Look and feel: a professional operations product, restrained palette, clear type hierarchy, no unnecessary controls. It must look right at 1920x1080 (projector) and on a laptop.
</details>

<verification>
`npx tsc -b --noEmit` and `npx vite build` must pass; with node_modules present on the Mac, both work offline. Run `VITE_MOCK=1 npx vite build` too. Don't leave a dev server running.
</verification>
