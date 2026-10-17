# Agent 1: Backend core & API

**Read first:** `agents/README.md` (shared contracts), `architecture.md` §2, §4, §5, §7 (snapshot and reset rows).

## Mission
Stand up the FastAPI app that everything else plugs into: the data contract, the in-memory store, the local JSON snapshot, and every route in §5. Other agents depend on `models.py` and `store.py`, so **ship those two first (within ~20 min)**, even if the routes are stubs at that point.

## You own
- `backend/app/main.py`, `config.py`, `models.py`, `store.py`
- `backend/requirements.txt` (others append their deps)
- `backend/run.sh` (e.g. `uvicorn app.main:app --host 127.0.0.1 --port 8000`)

## Tasks
1. **`models.py`:** copy §4 verbatim, then add `IssueRecord`, `VideoRecord`, `Detection` and `FindResult` exactly as in `agents/README.md`. Commit this first.
2. **`config.py`:** read every env var used in the architecture (`S3_ENDPOINT`, `S3_SEGMENTS_BUCKET`, `S3_CHUNKS_BUCKET`, `VASTDB_BUCKET`, `COSMOS3_REASON_URL`, `COSMOS_EMBED1_URL`, `GPU_BEARER_TOKEN`, `WANDB_TEAM`, `WANDB_PROJECT`, `WANDB_API_KEY`, `NVIDIA_API_KEY`, the VSS URL and credentials, plus AWS-style access keys). Optional values default to `None`. Never print them.
3. **`store.py`:** the API's only read path.
   - In memory: videos, issues (canonical + re-sightings + provisional), latest report and plan, and live progress (memory only).
   - At startup: `vast.db.load_all()` → populate; on failure, load `backend/state/snapshot.json`. Log which source was used.
   - On every write: call the matching `vast.db.insert_*` (in a thread; log and continue on failure) **and** append to the snapshot.
   - `canonical_issues()` computes `sightings = 1 + re-sightings` and severity = the max over sightings (rows are never updated, §3.5).
   - Provisional issues from a running analysis show in `GET /api/issues` and are replaced when that video finishes.
   - Reset cutoff: `POST /api/admin/reset` stores `now()` in the snapshot. Uploads created before it are hidden from every read.
4. **`main.py`, routes from §5:**
   - `POST /api/videos` (multipart, one file): save to `backend/state/uploads/{video_id}.mp4`, create a `VideoRecord` (`status="queued"`, drive and start time from `geo.gps.parse_upload_name`), start `pipeline.live.analyse_video` as a background task, and return the `Video`.
   - `GET /api/videos`, `GET /api/videos/{id}` (video + all its issues, re-sightings included), `GET /api/issues` (canonical, provisional included).
   - `GET /api/issues/{id}/similar` → `vast.vector.nearest(embedding, source=None, exclude_id=id, k=5)` → the matching `Issue`s.
   - `GET /api/frames/{issue_id}`: serve from the disk cache `backend/state/frames/{id}.jpg`, else `vast.media.get_frame`, caching the result. `Content-Type: image/jpeg`.
   - `GET /api/report` (instant, from the store), `POST /api/report` → `planning.report.regenerate()`.
   - `POST /api/dispatch {crews}` → `planning.dispatch.plan(crews)`.
   - `POST /api/admin/precompute/start|stop`, `POST /api/admin/reset`.
   - Strip `embedding`, `frame_key` and `source` when serialising to the UI: return plain `Issue`/`Video` models.
   - At startup: `weave_setup.init()`, `vast.db.ensure_tables()`, `store.load()`.
5. Until the other modules land, use stubs that return fixtures shaped like §4, so agent 8 can point at a real backend early.

## Gate check (09:30–10:30)
- Gate 7, VM tooling: `python3 --version`, and confirm `pip install fastapi uvicorn pydantic python-multipart` works on the VM. Report back.

## Done when
- `uvicorn` starts with VastDB unreachable (snapshot path) and with it reachable.
- Every §5 route returns contract-shaped JSON (stubbed or real), and `curl` of each is pasted in your report.
- Uploading a file returns a `Video` and `GET /api/videos` shows its stage changing (stubbed pipeline is fine).

## Out of scope
Model calls, VastDB internals, GPS, dedupe logic, the report, dispatch and the UI. Just call the interfaces.
