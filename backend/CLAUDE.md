# Backend: notes for agents

FastAPI app plus the video pipeline. It turns dashcam segments into deduplicated issues with work orders, writes a report and plans crew routes. It serves `architecture.md` §5 to the console in `frontend/`. Read the root `CLAUDE.md` first; this file is what you need to change backend code safely.

## Where it runs

- **Production is the workshop VM**: `ssh bc-afthabshiraz`, code in `~/Real_time_VIdeo_Agents`, Python in `backend/.venv/bin/python` (all dependencies installed). The GPU endpoints, VastDB, VAST S3 and the VSS API are reachable only from there.
- **Config is automatic on the VM.** `app/config.py` reads the process env, then `/config/team-*.config`, then the K8s secret `/config/*backend-secret.yaml` (VastDB endpoint, Cosmos and embedder hosts). Locally almost everything is unset, and every integration degrades instead of crashing.
- **Run**: `cd backend && ./run.sh` (uvicorn on 127.0.0.1:8000). From your laptop, `pnpm dev` at the repo root starts it on the VM if needed and tunnels it to :8001. `pnpm backend:status | backend:restart | backend:logs` manage it; the log is `backend/state/uvicorn.log` on the VM.
- **The VM backend is shared by the whole team.** Restart only after pulling backend changes there, and say so.
- `DEMO_FIXTURES=1 ./run.sh` seeds 8 fake issues in memory, for wiring checks only.
- **Demo mode** (`app/curation.py`, off by default) puts the hand-reviewed picks in `app/curation.json` first, lists only their drives and hides reviewed false positives. It is a view filter: stored issues, the pipeline and dedupe never change. Toggle at runtime with `pnpm demo:on` / `pnpm demo:off` from the repo root (`POST /api/admin/demo`), or start with `DEMO_CURATION=1`. `GET /api/health` reports `demo_curation`. Read issues for a console view through `curation.visible()`; pipeline code must not.

## Tests

```bash
cd backend && python3 -m pytest -q      # offline: cuOpt, OSRM, ADBC and the city feed are stubbed
```

Tests must stay offline and fast (no network, no GPU, no VAST). Stub at the module boundary with `monkeypatch` (see `tests/test_dispatch.py`, `tests/test_sponsor_paths.py`). The local machine needs only `fastapi pydantic numpy httpx pytest`; `weave`, `vastdb`, `pyarrow` and `adbc_driver_manager` are optional imports.

## Layout

```
app/main.py            routes (§5); imports teammate modules lazily, so a broken module degrades one endpoint
app/models.py          the contract (§4) + internal *Record types that never reach the UI
app/store.py           thread-safe in-memory state, atomic state/snapshot.json, ordered background VastDB writes
app/config.py          env + /config loading; redact() for every logged error
app/ai/                cosmos.py (find, box) · embed.py (Cosmos-Embed1) · nemotron.py (W&B Inference) ·
                       prompts.py (prompts, crew/urgency rules, JSON extraction) · gpu.py (shared semaphore, pause) ·
                       weave_setup.py (tracing) · gatecheck.py (VM smoke tests)
app/vast/              db.py (VastDB tables, insert-only) · vector.py (ADBC cosine SQL + numpy fallback) ·
                       media.py (frames in VAST S3, or the frames table) · gatecheck.py
app/pipeline/          piece.py (one 5 s piece → Detections) · dedupe.py (in-clip, then history) · live.py (uploads) ·
                       precompute.py (corpus sample) · run.py (Run: unseen VAST footage, live) ·
                       segment.py (ffmpeg) · replay.py (saved runs) · vss_client.py ·
                       manual.py (operator-marked issues, pins, names and operator grades: overlay rows, never deduped)
app/geo/               gps.py (PIE 1 Hz GPS) · inventory.py (segment → drive, t) · demo.py · roads.py (OSRM) · distance.py
app/planning/          dispatch.py (sites → triage → multi-day cuOpt round trips) · triage.py (Nemotron day plan) ·
                       recommend.py (Nemotron + cuOpt workforce scenarios) · zones.py/zones_wards.json (wards, drawn
                       areas) · cuopt.py · report.py · hazards.py (city closures + dashcam work zones) · paths.py
                       (detours) · facilities.py/.json (21 City sites; edits in state/facilities.json)
tests/                 pytest, offline
../scripts/            one-off jobs, run from backend/ with the VM venv (see "Scripts")
```

## Sponsor integrations: what calls what, and how to prove it ran

Each integration has a fallback so the demo never stops. The flip side is that a fallback can quietly stand in for the sponsor tech. When you touch one of these, keep the "which path answered" signal working.

| Service | Module | Used for | Fallback | Proof it really ran |
|---|---|---|---|---|
| **Cosmos3-Reason** (NVIDIA, CoreWeave GPU) | `ai/cosmos.py` | `find_issues` on 5 s pieces; `box` on keyframes (0–1000 coords) | empty result; box falls back to Nemotron Super-VL, then none | Weave traces of `find_issues` / `box` |
| **Cosmos3-Reason severity rating** | `ai/cosmos.py` `rate`, `ai/rating.py` | re-grade each finding from its boxed keyframe + close-up: severity, one-sentence reason, verdict (rejected = not a defect) | Nemotron Super-VL (one image), then the find grade | `Issue.severity_model`; log `Rate: N/M rated cosmos3-reason=…`; Weave `rate` traces; the report's provenance |
| **Cosmos-Embed1** | `ai/embed.py` | one 256-d vector per issue crop (1 s still clip) | raises; the pipeline keeps the issue without a vector | `has_embedding = 1` rows |
| **VastDB** | `vast/db.py` | system of record in schema `citymaint` (videos, issues, gps, reports, plans, frames) | `state/snapshot.json` | `GET /api/health` → `store_source` |
| **VastDB vector search** | `vast/vector.py` | dedupe (category + 35 m box) and similar issues | in-memory numpy cosine for 60 s after any ADBC error | log `vector.nearest path=adbc`; the similar-issues API returns `search: "vastdb"` and the issue card shows it |
| **VAST S3** | `vast/media.py`, `pipeline/run.py` | keyframes (`citymaint/frames/`), uploaded originals; Run downloads its segments from here | `MEDIA_MODE=vastdb` (frames table) | frame served when the disk cache is empty |
| **VSS API** (VAST DataEngine index) | `pipeline/vss_client.py`, `pipeline/topic_search.py` | `POST /api/search` (the console's footage search, mapped onto drives via the inventory); semantic search hits that widen the precompute sample; clip download; `scripts/build_inventory.py` reads `vss-collection` | none for `/api/search` (503); precompute extras skipped | `/api/search` returns `search: "vss"`; log `VSS topic search '…': N segments -> M bands`. Warm demo queries with `scripts/warm_vss.py` |
| **Nemotron on W&B Inference** | `ai/nemotron.py`, `ai/summaries.py`, `pipeline/ask.py` | work orders (Lightning), report (Ultra, then Lightning), box fallback (Super-VL); grounded, checked drive summaries; the answer to a footage search; "Ask about this drive" over VSS captions | template work orders / report; a fact-built summary marked `explanation_source: "template"`; no search answer (VSS synthesis shown); Ask quotes the nearest VSS caption (`source: "vss"`) | Weave trace `nemotron_json` with the text prompt and parsed reply (schema `DriveSummary`, `SearchAnswer`, `AskReply`); `/api/videos` `explanation_source`; logs `Drive summary for …: nemotron`, `Ask … -> nemotron`. Lightning reasons for 750–4000+ tokens before answering: summaries keep reasoning with an 8192-token budget; chat (Ask) and search answers pass `think=False` (`chat_template_kwargs.enable_thinking=false`, about 1 s, verified on W&B Inference). Chat never uses Ultra |
| **W&B Weave** | `ai/weave_setup.py`, `scripts/weave_eval.py` | tracing every model op; Evaluations of work orders and Cosmos find | tracing off | the W&B project `$WANDB_TEAM/$WANDB_PROJECT` |
| **cuOpt** (hosted, build.nvidia.com) | `planning/cuopt.py`, `dispatch.py`, `recommend.py` | round trips from each site per day (vehicle breaks = lunch, S5 time windows), and every recommendation scenario | nearest-neighbour per site (lunch reserved) | `Plan.solver == "cuopt"`, `Route.solver`, `ScenarioMetrics.solver`; log `Dispatch: … solver=cuopt`; Dispatch shows it |
| **Nemotron triage / recommendation** | `planning/triage.py`, `recommend.py` | today / later / defer per job; propose and pick workforce scenarios | rules (`Triage.model == "rules"` with `note`; `Recommendation.proposer/picker == "rules"`) | log `Triage: nemotron-ultra decided N of M`; `Triage.model_decisions`; Weave ops `triage_with_model`, `recommend_propose`, `scenario_solved`, `recommend_pick` |

Gate checks on the VM exercise each of these: `python -m app.ai.gatecheck --help`, `python -m app.vast.gatecheck --help`, `python -m app.planning.cuopt --toy`.

## Rules

- **Contract**: change `app/models.py`, `architecture.md` §4/§5, `frontend/packages/core/src/types.ts` and `schema.ts` together. Add optional fields; don't rename them. Response models must stay valid for older consoles.
- **Secrets**: never log or print `config.*` values. Wrap every logged exception in `config.redact(exc)`. Add any new secret to `_SECRETS` in `config.py`.
- **Never fail a request because a dependency failed.** Endpoints return the fallback or a 503 with a short message, never a traceback. `find_issues`, `box` and `work_orders_and_explanation` never raise; `embed_clip` and `cuopt.solve` do, and their callers catch.
- **Store owns persistence.** Never call `vast.db.insert_*` for videos, issues, reports or plans; the store queues those writes (`insert_gps` is fine). Call `store.update_video(explanation=…, issue_ids=…, track=…)` *before* `store.set_progress(status="done")`, because the video row is saved once, at "done".
- **Frames**: whoever creates an issue id writes `state/frames/{id}.jpg` and calls `media.put_frame(id, bytes)`.
- **GPU slots**: `cosmos.*` and `embed.*` take `gpu.slot()` themselves; never wrap them in another slot (same semaphore, it deadlocks). `GPU_CONCURRENCY` defaults to 6. Precompute waits while `gpu.pause()` is on, but nothing calls `pause()` yet, so a live upload shares the slots with a running precompute. Stop precompute (`POST /api/admin/precompute/stop`) before a live demo.
- **Weave traces carry text, never media.** Ops take file paths, not bytes; `nemotron._traceable` strips base64 image and video parts. Keep autopatching off (`weave_setup.init`).
- **Sync I/O goes through `asyncio.to_thread`** (`vast/*`, `segment.py`, VSS client).
- `main.py` finds teammate modules by name: `app.geo.gps.parse_upload_name`, `app.pipeline.live.analyse_video`, `app.planning.report.regenerate`, `app.planning.dispatch.plan`, `app.pipeline.precompute.start/stop/status`. Keep those names. `precompute.start()` must return immediately (it launches a task).

## Shared infrastructure etiquette

- **VSS API**: one request at a time, at least 2 s apart, results cached in `state/vss_search_cache.json` (`vss_client.py` enforces this). No parallel bursts; the team shares one backend.
- **Never write to `S3_CHUNKS_BUCKET`** (it feeds VSS ingest; `media.py` refuses). Frames go to `S3_SEGMENTS_BUCKET` under `citymaint/`.
- **Don't redeploy the DataEngine pipeline or the VSS stack.** Re-ingest (`POST /api/v1/dashboard/reingest`) is limited to 1–2 designated people per team. It can hang for 40+ minutes, so never make the demo depend on it.
- **Never `select()` all columns of `vss-collection`** (the vector columns crash the SDK), and never read our own `embedding` column through the SDK; use `embedding_bin` or ADBC.
- The public OSRM server and the City of Toronto feed are rate-limited; `roads.py` and `hazards.py` cache and throttle. Set `ROUTING_URL=off` / `ROAD_RESTRICTIONS_URL=off` to work offline.

## Scripts (`../scripts/`, run from `backend/` with `.venv/bin/python`)

| Script | Does |
|---|---|
| `build_inventory.py` | reads `pie_cam-3` rows from `vss-collection` → `data/inventory.json` (segment → drive, t) |
| `load_gps.py` | PIE OBD XML → `data/gps.csv` (1 Hz) + `data/clip_durations.json` |
| `find_overlaps.py`, `cut_demo_clip.py` | pick and cut the demo upload clip (overlaps an indexed drive, so dedupe has history) |
| `import_sweep.py` | loads the standalone Cosmos sweep (`data/sweep/results.jsonl`) as corpus issues; stop the API first |
| `warm_vss.py` | runs the demo footage queries through VSS one at a time, so `/api/search` answers them from the cache; prints what each finds |
| `rate_severity.py` | re-grades every stored issue's severity from its keyframe (Cosmos3-Reason, Nemotron Super-VL fallback) into `state/ratings.jsonl` + the VastDB `ratings` table; the API can stay up, restart it after to load them. `--eval ../scripts/severity_labels.json` checks the rater against hand labels; `--revert` undoes |
| `weave_eval.py` | Weave Evaluations: `orders --limit 20` (no labels needed), `find --labels <jsonl>` |

## Before you finish

1. `python3 -m pytest -q` passes.
2. On the VM, after `pnpm backend:restart`: `curl localhost:8000/api/health`, then check that the logs show the real paths (`path=adbc`, `solver=cuopt`) rather than fallbacks.
3. If you changed a response, run `cd frontend && pnpm check` and look at the screen that uses it.
