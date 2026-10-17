"""Hosted cuOpt client (build.nvidia.com). Raises on any failure; dispatch falls back.

CLI for the VM: `python -m app.planning.cuopt --toy` sends a 3-job request and prints
the status, solve time and a compact summary (the key is never printed).
"""
import asyncio
import json
import logging
from pathlib import Path
import sys
import time

import httpx

from app import config

log = logging.getLogger(__name__)
INVOKE_URL = "https://optimize.api.nvidia.com/v1/nvidia/cuopt"
STATUS_URL = "https://optimize.api.nvidia.com/v1/status/{}"
TIMEOUT_S = 20.0
POLL_S = 0.5
SAMPLE_PATH = Path(__file__).with_name("cuopt_sample.json")


class CuOptError(RuntimeError):
    pass


def _solver_response(body: dict) -> dict:
    """Unwrap {"response": {"solver_response": …}}; infeasible answers count as failures."""
    response = body.get("response", body) if isinstance(body, dict) else {}
    solver = response.get("solver_response")
    if not isinstance(solver, dict):
        infeasible = response.get("solver_infeasible_response")
        raise CuOptError("cuOpt returned no solution" + (" (infeasible)" if infeasible is not None else ""))
    if solver.get("status", 0) != 0:
        raise CuOptError(f"cuOpt status {solver.get('status')}: {str(solver.get('msg', ''))[:200]}")
    return solver


async def _solve(payload: dict) -> dict:
    if not config.NVIDIA_API_KEY:
        raise CuOptError("NVIDIA_API_KEY is not set")
    headers = {"Authorization": f"Bearer {config.NVIDIA_API_KEY}", "Accept": "application/json"}
    body = {"action": "cuOpt_OptimizedRouting", "data": payload, "client_version": ""}
    async with httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_S)) as client:
        response = await client.post(INVOKE_URL, headers=headers, json=body)
        # 202: NVCF queued the request; poll its status until the result is ready.
        while response.status_code == 202:
            request_id = response.headers.get("NVCF-REQID")
            if not request_id:
                raise CuOptError("cuOpt 202 without NVCF-REQID")
            await asyncio.sleep(POLL_S)
            response = await client.get(STATUS_URL.format(request_id), headers=headers)
        if response.status_code != 200:
            raise CuOptError(f"cuOpt HTTP {response.status_code}: {response.text[:200]}")
        return response.json()


async def solve(payload: dict) -> dict:
    """POST one routing problem; returns the solver_response dict. Raises on failure or after 20 s."""
    try:
        body = await asyncio.wait_for(_solve(payload), timeout=TIMEOUT_S)
    except asyncio.TimeoutError:
        raise CuOptError(f"cuOpt timed out after {TIMEOUT_S:.0f} s") from None
    except httpx.HTTPError as exc:
        raise CuOptError(config.redact(exc)) from None
    return _solver_response(body)


# ---- Toy request (run on the VM) ----

def toy_payload() -> dict:
    """Depot + 3 jobs, 2 vehicles; job 2 only on vehicle 1, low prize so it can drop."""
    matrix = [[0, 5, 8, 12],
              [5, 0, 4, 9],
              [8, 4, 0, 6],
              [12, 9, 6, 0]]
    return {
        "cost_matrix_data": {"data": {"0": matrix}},
        "travel_time_matrix_data": {"data": {"0": matrix}},
        "fleet_data": {"vehicle_locations": [[0, 0], [0, 0]],
                       "vehicle_ids": ["roads-1", "graffiti-1"],
                       "vehicle_time_windows": [[0, 480], [0, 480]]},
        "task_data": {"task_locations": [1, 2, 3],
                      "task_ids": ["toy-pothole", "toy-crack", "toy-tag"],
                      "service_times": [60, 60, 30],
                      "order_vehicle_match": [{"order_id": 0, "vehicle_ids": [0]},
                                              {"order_id": 1, "vehicle_ids": [0]},
                                              {"order_id": 2, "vehicle_ids": [1]}],
                      "prizes": [1000, 250, 500]},
        "solver_config": {"time_limit": 3, "objectives": {"cost": 1, "prize": 1}},
    }


def summarise(solver: dict) -> dict:
    vehicles = solver.get("vehicle_data") or {}
    return {"status": solver.get("status"), "num_vehicles": solver.get("num_vehicles"),
            "solution_cost": solver.get("solution_cost"),
            "routes": {v: list(zip(d.get("task_id", []), d.get("arrival_stamp", [])))
                       for v, d in vehicles.items()},
            "dropped": (solver.get("dropped_tasks") or {}).get("task_id", [])}


async def _toy() -> int:
    payload = toy_payload()
    SAMPLE_PATH.write_text(json.dumps(
        {"action": "cuOpt_OptimizedRouting", "data": payload, "client_version": ""}, indent=2) + "\n")
    print(f"request shape saved to {SAMPLE_PATH.name}; key set: {bool(config.NVIDIA_API_KEY)}")
    started = time.perf_counter()
    try:
        solver = await solve(payload)
    except Exception as exc:
        print(f"FAILED after {time.perf_counter() - started:.1f} s: {config.redact(exc)}")
        return 1
    print(f"OK in {time.perf_counter() - started:.1f} s")
    print(json.dumps(summarise(solver), indent=2, default=str))
    return 0


if __name__ == "__main__":
    if "--toy" not in sys.argv:
        print("usage: python -m app.planning.cuopt --toy")
        sys.exit(2)
    sys.exit(asyncio.run(_toy()))
