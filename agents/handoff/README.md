# Handoff: agents 4–8

Agents 1–3 are built and verified on the VM. Each `agentN.md` here is a self-contained brief. You can implement from it by hand, or paste it into Cursor's agent. Each brief includes the facts verified on the VM and the integration rules, and those override older notes in `architecture.md` and `agents/0N_*.md`.

## Where things are (VM: `ssh bc-afthabshiraz`)
- Code: `~/Real_time_VIdeo_Agents`. Python: `backend/.venv/bin/python` (all deps installed). Config and secrets are read automatically from `/config` by `backend/app/config.py`.
- PIE GPS: `data/pie/annotations_vehicle/setXX/video_XXXX_obd.xml` (53 files).
- Corpus: 1080 `pie_cam-3` segments in `team-49-vss-chunks-segments/segments/` (180 per set, the first ~15 min of each set).
- Gate-check scripts: `python -m app.vast.gatecheck --help`, `python -m app.ai.gatecheck --help`.
- Run the API: `cd backend && ./run.sh` (port 8000). Add `DEMO_FIXTURES=1` for fake data.

## The traps (read these even if you skip the briefs)
1. **Don't wrap `cosmos.*` or `embed.*` in `gpu.slot()`.** They take the slot themselves, so wrapping would nest on the same semaphore.
2. **Call `store.update_video(explanation=…, issue_ids=…, track=…)` before `store.set_progress(status="done")`.** The video row is saved once, at "done".
3. **Never call `vast.db.insert_*`** for videos, issues, reports or plans. The store does it. (`insert_gps` is fine.)
4. **Frames:** whoever creates an issue id copies the JPEG to `backend/state/frames/{id}.jpg` and calls `media.put_frame(id, bytes)`.
5. `embed_clip` raises on failure. `find_issues`, `box` and `work_orders_and_explanation` never raise.
6. The Cosmos model is `nvidia/cosmos3-nano-reasoner`. It's conservative: empty results are normal. Use Ultra for the report; it took 5.2 s, faster than Lightning.
7. `main.py` picks your modules up automatically by these exact names: `app.geo.gps.parse_upload_name`, `app.pipeline.live.analyse_video`, `app.planning.report.regenerate`, `app.planning.dispatch.plan`, `app.pipeline.precompute.start/stop/status`.
8. `precompute.start()` must return immediately (launch a task).

## Order (critical path)
4 (GPS load → inventory → demo clips) and 5 (pipeline) first → 6 (pre-compute, by ~12:30) → 7 (report and dispatch) → 8 (the frontend can start on mocks now).

Tell Claude when a module lands, and it will review it and test it on the VM.
