# Agent 5: Live pipeline & dedupe

**Read first:** `agents/README.md` (the `app/pipeline/` contract and everything it calls), `architecture.md` §2 (pipeline diagram), §3.3, §3.5, §7 (live clip rows and replay).

## Mission
Orchestrate a dropped clip from upload to work orders in about 20–40 s, with visible stages, provisional pins as pieces finish, dedupe against the corpus, and a replay fallback. `process_piece` and `dedupe.assign` are also what pre-compute (agent 6) runs, so keep them source-agnostic.

## You own
`backend/app/pipeline/live.py`, `segment.py`, `piece.py`, `dedupe.py`, `replay.py` (+ `__init__.py`)

## Tasks
1. **`segment.py`:** run ffmpeg in a thread:
   `ffmpeg -i in.mp4 -vf scale=-2:720 -an -c:v libx264 -preset veryfast -crf 23 -f segment -segment_time 5 -reset_timestamps 1 seg_%02d.mp4`.
   Also add `extract_frame(original, t) -> jpg` (keyframes come from the **original**), `crop(jpg, bbox, margin) -> jpg` resized to 448×448, and `still_clip(jpg) -> mp4` (`ffmpeg -loop 1 -i crop.jpg -t 1 -r 8 -c:v libx264 -pix_fmt yuv420p crop.mp4`). If ffmpeg is missing, use `imageio-ffmpeg`'s binary.
2. **`piece.py`, `process_piece`:** inside `gpu.slot()` for each model call:
   1. `cosmos.find_issues(piece)`
   2. per issue: extract the frame at `piece_offset + t` → `cosmos.box` → `media.put_frame`
   3. crop (the whole frame if there's no box) → still clip → `embed.embed_clip`
   4. `gps.locate(drive, clip_start_s + piece_offset + t)`

   Return `Detection`s. A failure in one issue must not kill the piece.
3. **`dedupe.py`, `assign(detections, video, use_history)`:** process in time order.
   - Re-sighting of X if: same category, within ~35 m (haversine), and cosine similarity > `DEDUPE_SIM` (calibrate it).
   - Check in-clip in memory first, then history via `vector.nearest(category=…, bbox=±35 m, source="corpus", canonical_only=True)`.
   - **History = corpus issues only**; uploads are never history (§3.5).
   - Output `IssueRecord`s with `duplicate_of` set on re-sightings. Ids are `uuid4().hex[:12]`.
   - If similarity doesn't separate known pairs, fall back to category + distance and keep the vector for ranking. Put the threshold and mode in one constant.
4. **`live.py`, `analyse_video`:**
   - Stages via `store.set_progress`: `segmenting` → `checking i/N` → `checking history` → `planning repairs` → done/failed.
   - Pieces run concurrently (the semaphore caps GPU calls). As each finishes, push provisional issues with `store.add_issues(provisional=True)`.
   - Then dedupe → `nemotron.work_orders_and_explanation` for the new canonical issues → `store.replace_provisional` with the final records → `store.update_video(explanation, issue_ids, track=gps.track(...), duration_s)` → `media.put_original` → `report.schedule_regen()`.
   - For `source="corpus"`, the same flow without the upload-specific steps.
5. **`replay.py`:** after a successful upload run, save `backend/state/replays/{sha256}.json` (stage timings + final records). In `analyse_video`, if any model call fails or the run passes ~60 s, look up the clip hash and replay the saved result through the same stages at a similar pace. Mark the video so the UI can say "replayed" (e.g. stage text). Use it only for uploads.
6. **Calibrate dedupe:** with agent 4's help, find 3 known same-issue pairs (consecutive pieces, or the overlap street) and 3 different-issue pairs; print the similarities; set `DEDUPE_SIM`. If crop embeddings don't separate the pairs, try whole-piece embeddings (§3.3 step 3) and report back.

## Milestones
- **~11:30:** one real PIE segment end to end: find → box → embed → geolocate → insert → visible in `GET /api/issues`.
- **~14:00:** the demo clip end to end with progress stages, dedupe firing against the corpus, and work orders + explanation.

## Gate check
- The ffmpeg part of gate 7: `ffmpeg -version` on the VM.

## Done when
- The demo clip runs in ≤40 s with pre-compute paused; the timing for each stage comes from Weave or logs.
- At least one detection merges into an existing corpus pin ("seen 2 times").
- Killing the Cosmos URL mid-run triggers the replay.

## Out of scope
Model client internals (agent 3), SQL/ADBC (agent 2), candidate selection (agent 6) and the report (agent 7).
