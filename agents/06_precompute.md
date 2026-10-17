# Agent 6: Corpus pre-compute

**Read first:** `agents/README.md`, `architecture.md` §3.6, §3.3 (provenance: exclude/include rule), §7 (populated-map rows). Use the guide repo's VSS API docs for `/api/v1/auth/login`, `/api/v1/search`, `/metadata/values` and `/api/v1/videos/stream`.

## Mission
Fill the map with "yesterday's fleet footage" by running the per-piece pipeline over a **small sample (~40–60) of corpus segments spread apart across all drives**. We don't need the whole corpus to prove the point; keep it fast. It runs in the background, resumable, pausable, and **running by ~12:30**.

## You own
`backend/app/pipeline/precompute.py`, `backend/app/pipeline/vss_client.py`

## Tasks
1. **`vss_client.py`** (needed for the stream fallback; search is optional): log in for a JWT. Then `search(query, top_k=100)` with `metadata_filters={"camera_id":"pie_cam-3"}` (check the value via `/metadata/values` first), `hybrid_text_weight≈0.2`, `min_similarity≈0.1–0.2`, and `stream_url(source)`.
2. **Candidate list (cap ~60)**, built once and saved to `backend/state/precompute_candidates.json`:
   1. Spread-apart sample: moving segments from `inventory.load()` at even gaps across every drive (set01–06), about one every 5–10 minutes of driving, so pins cover the whole city.
   2. **Always add** `demo.forced_segments()` and **always drop** `demo.excluded_segments()` (from agent 4's `data/demo_clips.json`).
   3. Optional, only if there's time: about 10 extra segments from the top VSS search hits per category.
   4. Dedupe by segment ID; keep only segments with a mapped drive/`t`.
3. **Processing loop** (`start()` launches it as an asyncio task inside the backend):
   - Skip segments already recorded in `backend/state/precompute_done.json` (resumable).
   - Download with read-only boto3 from the segment's `source` URI; on AccessDenied, use the stream endpoint. Scale to 720p.
   - Await `gpu` not paused, then `piece.process_piece(...)` with the segment's drive and `t_start`.
   - Group results by PIE clip into one corpus `VideoRecord` per clip (`source="corpus"`, `drive`, `track`). Run `dedupe.assign(use_history=True)` per batch so re-sightings across segments merge.
   - When a clip's segments are all done (or every N segments), call `nemotron.work_orders_and_explanation` for that clip's new canonical issues and write via `store`.
   - Call `report.schedule_regen()` (agent 7 debounces it to ≤1/min).
   - `stop()` cancels cleanly after the current segment. `status()` returns done/total/errors/ETA for `/api/admin/...` logs.
4. **Pause during demos:** respect `gpu.pause()`; live uploads must never wait behind pre-compute.

## Dependencies and timing
Needs agent 5's `process_piece` working on 5 real segments (~11:30), plus agent 4's inventory, GPS mapping and `demo_clips.json`. Build the candidate list and the loop against stubs before then, so you can press start the moment those land.

## Done when
- Pre-compute finishes the small sample in a few minutes, survives a restart without redoing work, and its throughput (segments/min) is logged.
- The map shows corpus pins across the city, including issues on the demo clip's street from the *other* drive.

## Out of scope
The per-piece logic, dedupe rules and model clients. Reuse them; don't fork them.
