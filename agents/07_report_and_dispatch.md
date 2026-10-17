# Agent 7: Report & dispatch (Nemotron + cuOpt)

**Read first:** `agents/README.md` (the `app/planning/` contract), `architecture.md` §3.7, §3.8, §4 (`Report`, `Route`, `Plan`), §7 (report and dispatch rows).

## Mission
Turn the canonical issues into a situation report with recommended crews, then turn the manager's chosen crews into cuOpt-optimised routes, with deterministic fallbacks for both.

## You own
`backend/app/planning/report.py`, `dispatch.py`, `cuopt.py` (+ `__init__.py`)

## Tasks
1. **Do first (ideally the night before):** a 3-job toy cuOpt request with `NVIDIA_API_KEY`, copying the exact shape from the build.nvidia.com sample. Save the working request/response as `backend/app/planning/cuopt_sample.json` for reference.
2. **`report.py`:**
   - Inputs from `store.canonical_issues()`: counts by category and severity, the top-priority list (severity desc, then confidence), and workload per crew type = the sum of work-order minutes.
   - Baseline crews per type = `ceil(workload × 1.3 ÷ 480)`, **computed in code**.
   - `nemotron.chat_json` → `{summary, crews: {Crew: int}, rationale}` (Lightning; use Ultra only if agent 3 measured it under ~10 s). Validate it and fill in `generated_at` and `counts`.
   - Fallback: a template summary from the counts, with the baseline crews.
   - `schedule_regen()` is debounced: at most once a minute while pre-compute runs, and right away after a live upload finishes. Keep the previous report visible while it runs (expose `report.is_updating()` so agent 1 can add it to the `GET /api/report` response, e.g. an `updating` field, if agent 8 wants it). `store.set_report` + `vast.db.insert_report`.
3. **`cuopt.py`:**
   - `POST https://optimize.api.nvidia.com/v1/nvidia/cuopt` with `{"action":"cuOpt_OptimizedRouting","data":…,"client_version":""}`. On 202, poll `GET /v1/status/{NVCF-REQID}` until 200. Timeout ~20 s.
4. **`dispatch.py`, `plan(crews)`:**
   - Jobs = canonical issues with a work order and lat/lon, at most ~100 (keep the highest severity).
   - Depot = an assumed fixed Toronto point, labelled as such (§8). Matrix: haversine × 1.3 ÷ 25 km/h in integer minutes, depot at index 0, as `{"data":{"0": M}}` for both cost and travel time.
   - `fleet_data`: one vehicle per crew (`roads-1`, …), at `[0,0]`, time window `[0,480]`.
   - `task_data`: `service_times` from the work orders, `order_vehicle_match` (each job → the vehicle indices of its crew type), `prizes` from severity (e.g. 5→1000 … 1→50).
   - `solver_config`: `time_limit≈3`, objectives with a non-zero prize weight. Don't force `min_vehicles`.
   - Parse `vehicle_data[...]` → `Route(stops, eta_min, path=depot→stops→depot)` and `dropped_tasks` → `unassigned`.
   - **Fallback:** nearest-neighbour per crew type, highest severity first, respecting the 480-min shift; `solver="fallback"`.
   - `store.set_plan` + `vast.db.insert_plan`. Return a `Plan` with `solve_ms`.
   - Expect idle crews: report "3 of 4 crews needed" via routes with empty stops.

## Done when
- `POST /api/report` returns a sensible report on the current corpus in a few seconds.
- `POST /api/dispatch` with the report's crews returns a cuOpt `Plan` in ~3–5 s. With a bad key, it returns a fallback `Plan`.
- Prizes visibly drop low-severity jobs when crews are under-provisioned.

## Out of scope
Per-issue work orders (agent 3/5 produce them), the UI (agent 8) and the routes (agent 1 wires them).
