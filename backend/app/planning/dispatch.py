"""Crew routing: one cuOpt problem for all crews, nearest-neighbour fallback.

The depot is an assumed point (Toronto City Hall), not a real yard (architecture §8).
"""
import logging
import math
import time

from app import config, store
from app.ai.prompts import DEFAULT_MINUTES
from app.models import CREW_FOR, Crew, IssueRecord, Plan, Route
from app.planning import cuopt

log = logging.getLogger(__name__)
DEPOT = (43.6534, -79.3841)          # assumed depot: Toronto City Hall
DEPOT_LABEL = "Toronto City Hall (assumed depot)"
SHIFT_MIN = 480
SPEED_KMH = 25.0
DETOUR = 1.3                         # straight line → street distance
MAX_JOBS = 100                       # hosted cuOpt needs asset upload above this
PRIZE = {5: 1000, 4: 500, 3: 250, 2: 100, 1: 50}


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _matrix(points: list[tuple[float, float]]) -> list[list[int]]:
    """Integer travel minutes; index 0 is the depot."""
    return [[round(_km(a, b) * DETOUR / SPEED_KMH * 60) for b in points] for a in points]


def _minutes(issue: IssueRecord) -> int:
    return issue.work_order.minutes if issue.work_order else DEFAULT_MINUTES[issue.category]


def _jobs() -> list[IssueRecord]:
    located = [i for i in store.canonical_issues() if i.lat is not None and i.lon is not None]
    located.sort(key=lambda i: (-i.severity, -i.confidence))
    return located


def _vehicles(crews: dict[Crew, int]) -> list[tuple[str, Crew]]:
    return [(f"{crew}-{n + 1}", crew) for crew, count in crews.items() for n in range(max(0, int(count)))]


def _route(vehicle_id: str, crew: Crew, stops: list[IssueRecord], eta: list[int]) -> Route:
    return Route(crew_id=vehicle_id, crew=crew, stops=[i.id for i in stops], eta_min=eta,
                 path=[DEPOT, *((i.lat, i.lon) for i in stops), DEPOT] if stops else [])


def _payload(jobs: list[IssueRecord], vehicles: list[tuple[str, Crew]], matrix: list[list[int]]) -> dict:
    by_crew: dict[str, list[int]] = {}
    for index, (_, crew) in enumerate(vehicles):
        by_crew.setdefault(crew, []).append(index)
    return {
        "cost_matrix_data": {"data": {"0": matrix}},
        "travel_time_matrix_data": {"data": {"0": matrix}},
        "fleet_data": {"vehicle_locations": [[0, 0] for _ in vehicles],
                       "vehicle_ids": [v for v, _ in vehicles],
                       "vehicle_time_windows": [[0, SHIFT_MIN] for _ in vehicles]},
        "task_data": {"task_locations": list(range(1, len(jobs) + 1)),
                      "task_ids": [i.id for i in jobs],
                      "service_times": [_minutes(i) for i in jobs],
                      "order_vehicle_match": [{"order_id": n, "vehicle_ids": by_crew[CREW_FOR[i.category]]}
                                              for n, i in enumerate(jobs)],
                      "prizes": [PRIZE.get(i.severity, 50) for i in jobs]},
        # Prizes are subtracted from the cost; weight 0 would turn them off.
        "solver_config": {"time_limit": 3, "objectives": {"cost": 1, "prize": 1}},
    }


def _parse(solver: dict, jobs: list[IssueRecord], vehicles: list[tuple[str, Crew]]) -> tuple[list[Route], list[str]]:
    by_id = {i.id: i for i in jobs}
    data = solver.get("vehicle_data") or {}
    routes, assigned = [], set()
    for vehicle_id, crew in vehicles:
        entry = data.get(vehicle_id) or {}
        stops, eta = [], []
        tasks = entry.get("task_id") or []
        stamps = entry.get("arrival_stamp") or [0] * len(tasks)
        # Depot and break entries carry their own task ids, so matching issue ids is enough.
        for task, stamp in zip(tasks, stamps):
            if task in by_id and task not in assigned:
                stops.append(by_id[task])
                eta.append(int(round(float(stamp))))
                assigned.add(task)
        routes.append(_route(vehicle_id, crew, stops, eta))
    dropped = [str(t) for t in (solver.get("dropped_tasks") or {}).get("task_id", [])]
    # Anything neither routed nor reported dropped is still unassigned.
    unassigned = list(dict.fromkeys(dropped + [i.id for i in jobs if i.id not in assigned]))
    return routes, [t for t in unassigned if t not in assigned]


def _nearest_neighbour(jobs: list[IssueRecord], vehicles: list[tuple[str, Crew]],
                       matrix: list[list[int]]) -> tuple[list[Route], list[str]]:
    """Per crew type: each vehicle in turn takes the highest-severity job, nearest first,
    that still lets it finish and return within the shift."""
    index = {i.id: n + 1 for n, i in enumerate(jobs)}
    state = {v: {"at": 0, "clock": 0, "stops": [], "eta": []} for v, _ in vehicles}
    left = {crew: [i for i in jobs if CREW_FOR[i.category] == crew] for crew in {c for _, c in vehicles}}
    progress = True
    while progress:
        progress = False
        for vehicle_id, crew in vehicles:
            s = state[vehicle_id]

            def fits(i: IssueRecord) -> bool:
                return s["clock"] + matrix[s["at"]][index[i.id]] + _minutes(i) + matrix[index[i.id]][0] <= SHIFT_MIN

            options = [i for i in left[crew] if fits(i)]
            if not options:
                continue
            pick = min(options, key=lambda i: (-i.severity, matrix[s["at"]][index[i.id]]))
            arrive = s["clock"] + matrix[s["at"]][index[pick.id]]
            s["stops"].append(pick)
            s["eta"].append(arrive)
            s["clock"], s["at"] = arrive + _minutes(pick), index[pick.id]
            left[crew].remove(pick)
            progress = True
    routes = [_route(v, c, state[v]["stops"], state[v]["eta"]) for v, c in vehicles]
    routed = {i.id for s in state.values() for i in s["stops"]}
    return routes, [i.id for i in jobs if i.id not in routed]


async def plan(crews: dict[Crew, int]) -> Plan:
    """cuOpt routes for the chosen crews; nearest-neighbour fallback on any failure.

    Idle crews come back as routes with no stops; jobs whose crew type has 0 crews,
    or beyond the 100-job cap, are unassigned. Issues without GPS can't be routed and are left out.
    """
    started = time.perf_counter()
    all_jobs = _jobs()
    vehicles = _vehicles(crews)
    staffed = {crew for _, crew in vehicles}
    jobs = [i for i in all_jobs if CREW_FOR[i.category] in staffed][:MAX_JOBS]
    kept = {i.id for i in jobs}
    skipped = [i.id for i in all_jobs if i.id not in kept]
    matrix = _matrix([DEPOT, *((i.lat, i.lon) for i in jobs)])

    solver_name = "fallback"
    if jobs:
        try:
            solver = await cuopt.solve(_payload(jobs, vehicles, matrix))
            routes, unassigned = _parse(solver, jobs, vehicles)
            solver_name = "cuopt"
        except Exception as exc:
            log.warning("cuOpt failed (%s); nearest-neighbour fallback", config.redact(exc))
            routes, unassigned = _nearest_neighbour(jobs, vehicles, matrix)
    else:
        routes, unassigned = [_route(v, c, [], []) for v, c in vehicles], []

    solve_ms = int((time.perf_counter() - started) * 1000)
    log.info("Dispatch: %d jobs, %d vehicles, solver=%s, %d unassigned, %d ms",
             len(jobs), len(vehicles), solver_name, len(unassigned) + len(skipped), solve_ms)
    return Plan(routes=routes, unassigned=unassigned + skipped, solver=solver_name, solve_ms=solve_ms)
