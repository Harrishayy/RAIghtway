# Agent 4: GPS, segment inventory & demo clips

**Read first:** `agents/README.md` (the `app/geo/` contract), `architecture.md` §3.3 (provenance), §3.4 (all of it), §3.6 (candidate rule 3), §7 (GPS rows).

## Mission
Turn PIE vehicle logs into a queryable GPS track, map every indexed `pie_cam-3` segment to a drive and time, and pick and cut the demo clip plus a backup from streets that another drive also covered. **This is on the critical path:** pre-compute (agent 6) can't start until the inventory, the mapping and both clips exist (target ~12:30).

## You own
- `backend/app/geo/gps.py`, `inventory.py`, `demo.py`
- `scripts/load_gps.py`, `build_inventory.py`, `find_overlaps.py`, `cut_demo_clip.py`
- `data/gps.csv`, `data/inventory.json`, `data/demo_clips.json`, `data/clips/`

## Tasks
1. **GPS load (morning, once):** `scripts/load_gps.py` parses each `video_XXXX_obd.xml` (one row per frame: lat, lon, heading, OBD/GPS speed). Drop rows outside Toronto (~3.5k, mostly set03/video_0004) and zero rows (~100), resample to 1 Hz (~30k rows), write `data/gps.csv` and call `vast.db.insert_gps` (agent 2; skip it if that isn't ready, the CSV is the fallback). Drive ID format: `set04/video_0008`.
2. **`gps.py`:** load the CSV into memory at import.
   - `locate(drive, t, ahead_m=10)` interpolates lat/lon/heading at `t` and optionally projects ~10 m ahead along the heading (the camera looks ahead).
   - `track(drive, start_s, duration_s)` returns the polyline for a video page.
   - `parse_upload_name("set04_video_0008_t0310.mp4") -> ("set04/video_0008", 310.0)`.
3. **Segment inventory (first hour):** `scripts/build_inventory.py` reads `source`, `original_video`, `filename`, `segment_start_sec` and `extra_metadata` for every `pie_cam-3` row of `vss-collection`, **read-only, explicit columns, never the vector column** (as in the vastdb-read `query.py`). Map each to `(drive, t_start)`:
   - Chunk names are `{user}/{ts}_{source-stem}_chunk_{NNNN}.mp4`; `extra_metadata` holds `stream_position_sec`. Segments are `segments/{chunk}_segment_{NNN}_of_{TTT}.mp4`.
   - If the stem is a PIE clip, the position is `t`. If it's a whole set, walk the cumulative clip durations (frames ÷ 30) and check that the set's indexed duration equals the sum.
   - Flag `moving` (median speed ≥ 2 km/h over the segment; 41% of samples are stopped).
   - Write `data/inventory.json`; `inventory.load()` reads it.
4. **Verify the mapping on 2–3 points:** speed ≈0 ↔ the car visibly stopped; heading changes ↔ visible turns. Report what you checked.
5. **Demo clips:** `scripts/find_overlaps.py` bins all tracks into ~30 m cells and finds moving stretches of street that two different drives both cover. Pick a primary and a backup clip, each 20–30 s from consecutive segments of one drive. `scripts/cut_demo_clip.py` cuts it from the PIE source at 720p, ≤5 MB, named `set04_video_0008_t0310.mp4`, into `data/clips/`.
6. **`data/demo_clips.json`** for each clip: the clip's own segment IDs (pre-compute must **exclude** them) and the other drive's segment IDs on the same street (pre-compute must **include** them). `demo.excluded_segments()` and `demo.forced_segments()` read it. Hand it to agent 6 as soon as it exists.

## Gate check (09:30–10:30)
- **Gate 2:** `pie_cam-3` is indexed, the inventory is built, and 2–3 segments are mapped to GPS and sanity-checked.

## Fallback
If the PIE GPS isn't allowed or the mapping stays unclear, say so immediately: issues go without pins and dispatch uses fixed coordinates, stated openly (§7).

## Done when
- `locate()` returns sensible Toronto points for random inventory segments.
- Both demo clips exist in `data/clips/` with `demo_clips.json`, and each overlap is visible when the two tracks are plotted together (a quick screenshot is fine).

## Out of scope
Running models, pre-compute itself and dedupe.
