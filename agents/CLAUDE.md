# agents/: notes for agents

These are the build-day work briefs: `architecture.md` split into 8 parallel workstreams (`0N_*.md`), plus `handoff/agentN.md` for agents 4–8, written once agents 1–3 were verified on the VM. They record **intent and reasoning**. They are not the current state of the code.

## Which source wins

When two sources disagree, use the first one in this list:

1. **The code**, and `backend/CLAUDE.md` / `frontend/CLAUDE.md`, which describe it as it is now.
2. **`architecture.md` §4 (data contract) and §5 (API)**, kept in step with `backend/app/models.py` and `frontend/packages/core/src/{types,schema}.ts`.
3. **`handoff/agentN.md`**: facts verified on the VM (model names, bucket layout, what ADBC can do, the integration traps).
4. **`0N_*.md` and `README.md`**: the original plan.

## What has changed since the briefs

- **Tests exist now.** The "no tests" ground rule in `README.md` is superseded. The backend has offline pytest (`backend/tests/`) and the frontend has vitest in `packages/core/test/`. Both must pass before you finish.
- **Dispatch grew** beyond the brief in `07_report_and_dispatch.md`: per-category bases (`facilities.json`), OSRM road travel times, City of Toronto road closures, detours, and crew run sheets. See `backend/app/planning/` and the optional `Route`/`Plan` fields in §4.
- **Corpus issues came from a standalone Cosmos sweep** (`scripts/import_sweep.py`), not only the precompute loop in `06_precompute.md`.
- **Similar issues return `SimilarIssue`** (`distance`, and `search`: `vastdb` or `local`), not plain `Issue[]`.
- **Model names**: the Cosmos model is the one in the VM's backend secret (`nvidia/cosmos3-nano-reasoner` on the day), not the `nvidia/cosmos3-reason` default in the briefs. The report uses Nemotron Ultra first, then Lightning.
- **The console** is a movable-panel desk with three looks; `08_frontend.md` predates it. Follow `frontend/CLAUDE.md`.

## Using these files

- Read a brief for why a module is shaped the way it is: the fallbacks, the never-raise contracts, the gate checks.
- Don't rewrite the briefs to match the code; they're a record of the plan. Put current facts in `architecture.md` and the `CLAUDE.md` files instead.
- If you start a new parallel workstream, copy the brief format: owned paths, the contract you build against, stubs with `# TODO(agentN)`, and "Verify on the day" for anything you couldn't check.
