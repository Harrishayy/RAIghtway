# Raightway: notes for agents

Raightway turns fleet dashcam footage into city maintenance work. The pipeline:

1. Find issues (Cosmos3-Reason).
2. Box them and embed them (Cosmos-Embed1).
3. Dedupe against history (VastDB vector search).
4. Write work orders and a report (Nemotron via W&B).
5. Route crews (cuOpt).

The data is Toronto PIE dashcam drives (`pie_cam-3`, sets `set01`–`set06`) with GPS. It was built for the VAST Builders Challenge, so the one-minute demo matters (`hack.md`).

## Read first, in this order

| File | What it settles |
|---|---|
| `idea.md` | The product and the demo story |
| `architecture.md` | The system. **§4 is the data contract, §5 the API.** Both the frontend and the backend build to these |
| `agents/README.md` | The work split into 8 workstreams, plus the shared contracts that let them build in parallel |
| `agents/0N_*.md` | One brief per workstream (backend core, VAST, models, GPS, live pipeline, precompute, report and dispatch, frontend) |
| `ui_spec.md` | UI principles (it should look professional, not AI-made). The movable-panel desk supersedes its layout rule |
| `frontend/README.md`, `frontend/CLAUDE.md` | How to run and change the console |
| `docs/design/directions/index.html` | The design system: 3 looks over one component set, the component catalogue and the build spec. Open it in a browser |

## Repo map

```
architecture.md, idea.md, ui_spec.md, hack.md, context.md   specs
agents/            workstream briefs
frontend/          pnpm workspace: apps/web (Next.js 16 console) + packages/core (contracts, adapters, sample data)
docs/design/       design-directions page and its source
backend/           FastAPI + pipeline (per architecture.md; may live on the VM)
```

## Contract discipline

- The frontend parses every response against `frontend/packages/core/src/schema.ts`, which mirrors `architecture.md` §4.
- If you change a model on the backend, change §4, `types.ts` and `schema.ts` together.
- New optional fields are safe; renames are not. Prefer a `transform` in `frontend/apps/web/src/config/backend.ts` over editing components.
- The console runs on sample data with no backend (`cd frontend && pnpm dev`). Use that to work on the UI in parallel.

## Ground rules

- Never print or commit secrets. Credentials live in env vars on the VM. `.env*.local` is git-ignored.
- Before you finish frontend work, run `cd frontend && pnpm check` and click through every screen.
