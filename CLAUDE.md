# Raightway: notes for agents

Raightway turns fleet dashcam footage into city maintenance work. The pipeline:

1. Find issues in 5 s pieces (NVIDIA Cosmos3-Reason on CoreWeave GPUs).
2. Box each one (Cosmos3-Reason) and embed its crop (Cosmos-Embed1).
3. Place it on the map (PIE GPS) and dedupe against history (same category within 35 m; records in VastDB, frames in VAST S3). The crop vectors power similar issues (VastDB vector search), not the merge: `DEDUPE_MODE = "distance"` in `backend/app/pipeline/dedupe.py`.
4. Write work orders and a report (Nemotron on W&B Inference, traced and evaluated in W&B Weave).
5. Route crews from their bases around road closures (NVIDIA cuOpt, OSRM road times).

The data is Toronto PIE dashcam drives (`pie_cam-3`, sets `set01`–`set06`) with GPS. It was built for the VAST Builders Challenge, so the one-minute demo matters (`hack.md`).

## Read first, in this order

| File | What it settles |
|---|---|
| `idea.md` | The product and its story |
| `architecture.md` | The system. **§4 is the data contract, §5 the API.** Both the frontend and the backend build to these |
| `agents/README.md` | The work split into 8 workstreams, plus the shared contracts that let them build in parallel |
| `agents/0N_*.md` | One brief per workstream (backend core, VAST, models, GPS, live pipeline, precompute, report and dispatch, frontend) |
| `ui_spec.md` | UI principles (it should look professional, not AI-made). The movable-panel desk supersedes its layout rule |
| `backend/CLAUDE.md` | How to run, test and change the API and pipeline; **the sponsor-integration map** (what calls what, its fallback, how to prove the real path ran) |
| `frontend/README.md`, `frontend/CLAUDE.md` | How to run and change the console |
| `agents/CLAUDE.md` | How far to trust the build-day briefs, and what changed since |
| `docs/design/directions/index.html` | The design system: 3 looks over one component set, the component catalogue and the build spec. Open it in a browser |

## Repo map

```
architecture.md, idea.md, ui_spec.md, hack.md, context.md   specs
agents/            build-day workstream briefs (historical; see agents/CLAUDE.md)
frontend/          pnpm workspace: apps/web (Next.js 16 console) + packages/core (contracts, adapters, sample data)
docs/design/       design-directions page and its source
backend/           FastAPI + pipeline; runs on the workshop VM (ssh bc-afthabshiraz, ~/Real_time_VIdeo_Agents)
scripts/           one-off jobs run on the VM from backend/: inventory, GPS, sweep import, severity rating, Weave evals
data/              VM-side inputs (gps.csv, inventory.json, sweep/); PIE and clips are git-ignored
package.json       root shortcuts: pnpm dev | dev:mock | check | backend:status|restart|logs
```

## Sponsor stack at a glance

| Sponsor | Where we use it |
|---|---|
| NVIDIA | Cosmos3-Reason (find, box), Cosmos-Embed1 (vectors), Nemotron Lightning / Ultra / Super-VL, cuOpt (routing) |
| CoreWeave | The shared GPU endpoints serving the Cosmos models (provided; we don't deploy them) |
| W&B | W&B Inference for Nemotron; Weave traces on every model op; Weave Evaluations (`scripts/weave_eval.py`) |
| VAST | VastDB tables (schema `citymaint`), VastDB vector SQL over ADBC (similar issues), VAST S3 frames and Run footage, the VSS index (inventory from `vss-collection`, footage search, Ask captions, clip download) |

Every one of these has a fallback, so the UI and the logs must say which path answered (`backend/CLAUDE.md`, "Sponsor integrations"). Never present a fallback as the sponsor service.

## Contract discipline

- The frontend parses every response against `frontend/packages/core/src/schema.ts`, which mirrors `architecture.md` §4.
- If you change a model on the backend, change §4, `types.ts` and `schema.ts` together.
- New optional fields are safe; renames are not. Prefer a `transform` in `frontend/apps/web/src/config/backend.ts` over editing components.
- `pnpm dev` from the repo root runs everything: the VM backend, an SSH tunnel and the console, with a reconnect watchdog (`frontend/tooling/dev-live.mjs`). `pnpm backend:status | backend:restart | backend:logs` manage the VM's uvicorn.
- The console runs on sample data with no backend (`pnpm dev:mock`). Use that to work on the UI in parallel.

## Ground rules

- Never print or commit secrets. Credentials live in env vars on the VM. `.env*.local` is git-ignored.
- The team shares one VSS backend, one GPU pool and one VM uvicorn. Query VSS one request at a time, never write to the chunks bucket, and don't redeploy the DataEngine pipeline (`backend/CLAUDE.md`, "Shared infrastructure etiquette").
- Before you finish backend work, run `cd backend && python3 -m pytest -q`.
- Before you finish frontend work, run `pnpm check` and click through every screen.
