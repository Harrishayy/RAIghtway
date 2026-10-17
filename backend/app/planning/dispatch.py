"""Crew routing by category: each job goes to the nearest base of its crew type, then one cuOpt solve.

1. Jobs are grouped by crew (sanitation for waste, roads for potholes, graffiti, inspection for
   work zones, …) and each job is assigned to the nearest facility for that crew: waste goes to
   the nearest City transfer station, the rest to the nearest works yard (facilities.json).
2. Each crew type's vehicles are shared out across its facilities by workload. With fewer
   vehicles than facilities in use, the busiest facilities stay open and the rest fold into them.
3. One multi-depot cuOpt problem per crew type, split into groups of bases when it has more than
   the hosted 100-job cap (all solved concurrently): every vehicle starts and ends at its facility and may only take jobs clustered on that
   facility, so each run stays local. Travel minutes come from OSRM where reachable.
   Nearest-neighbour per vehicle is the fallback.
4. Each route gets a street path that steers around closures (paths.steer), its road alerts,
   Google Maps links and a plain-text brief to send to the crew.
"""
import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
import logging
import math
import time

from app import config, store
from app.ai.prompts import DEFAULT_MINUTES
from app.geo import roads
from app.geo.distance import LatLon, km
from app.models import CREW_FOR, Crew, Directions, Facility, IssueRecord, Plan, Route
from app.planning import cuopt, facilities, hazards as hz, paths

log = logging.getLogger(__name__)
DEPOT = (43.6534, -79.3841)          # used only when a crew type has no facility on file
DEPOT_LABEL = "Toronto City Hall (assumed depot)"
SHIFT_MIN = 480
SHIFT_START = (8, 0)                 # 08:00, as the console shows it
MAX_JOBS = 100                       # hosted cuOpt needs asset upload above this
PRIZE = {5: 1000, 4: 500, 3: 250, 2: 100, 1: 50}
DETOUR_CALLS = 6                     # OSRM re-routes around closures per plan (public server: ~1 per second)
PATH_SECONDS = 8                     # rate-limited server: street paths for as many routes as fit, busiest first
CREW_LABEL = {"roads": "Roads (potholes)", "graffiti": "Graffiti", "markings": "Markings", "inspection":
              "Work-zone inspection", "signage": "Signage", "sanitation": "Sanitation (waste)"}
_FALLBACK = Facility(id="depot-city-hall", label=DEPOT_LABEL, kind="yard", crews=list(CREW_LABEL),
                     lat=DEPOT[0], lon=DEPOT[1], source="Assumed location", assumed=True)


@dataclass
class Vehicle:
    id: str
    crew: Crew
    facility: Facility


def _minutes(issue: IssueRecord) -> int:
    return issue.work_order.minutes if issue.work_order else DEFAULT_MINUTES[issue.category]


def _jobs() -> list[IssueRecord]:
    located = [i for i in store.canonical_issues() if i.lat is not None and i.lon is not None]
    located.sort(key=lambda i: (-i.severity, -i.confidence))
    return located


def _share(count: int, loads: dict[str, int]) -> dict[str, int]:
    """Largest-remainder split of `count` vehicles over facilities by workload, at least one each."""
    total = sum(loads.values()) or 1
    raw = {f: count * w / total for f, w in loads.items()}
    shares = {f: max(1, math.floor(r)) for f, r in raw.items()}
    while sum(shares.values()) > count:      # the minimum of one overshot: take back from the lightest
        f = min((f for f in shares if shares[f] > 1), key=lambda f: raw[f] - shares[f], default=None)
        if f is None:
            break
        shares[f] -= 1
    for f in sorted(raw, key=lambda f: raw[f] - math.floor(raw[f]), reverse=True):
        if sum(shares.values()) >= count:
            break
        shares[f] += 1
    return shares


def cluster(crew: Crew, jobs: list[IssueRecord], count: int) -> tuple[list[Vehicle], dict[str, Facility]]:
    """Vehicles for one crew type, each based at a facility, and each job's facility."""
    bases = facilities.for_crew(crew) or [_FALLBACK]
    home = {i.id: facilities.nearest(crew, (i.lat, i.lon), bases) for i in jobs}
    loads: dict[str, int] = defaultdict(int)
    for i in jobs:
        loads[home[i.id].id] += _minutes(i)
    by_id = {f.id: f for f in bases}
    if len(loads) > count:                   # too few vehicles: keep the busiest bases open
        kept = [by_id[f] for f in sorted(loads, key=loads.get, reverse=True)[:count]]
        home = {i.id: facilities.nearest(crew, (i.lat, i.lon), kept) for i in jobs}
        loads = defaultdict(int)
        for i in jobs:
            loads[home[i.id].id] += _minutes(i)
    vehicles = []
    for fid, n in _share(count, dict(loads)).items():
        vehicles += [Vehicle(f"{crew}-{len(vehicles) + k + 1}", crew, by_id[fid]) for k in range(n)]
    return vehicles, home


def _payload(jobs: list[IssueRecord], vehicles: list[Vehicle], allowed: dict[str, list[int]],
             index: dict[str, int], matrix: list[list[int]]) -> dict:
    return {
        "cost_matrix_data": {"data": {"0": matrix}},
        "travel_time_matrix_data": {"data": {"0": matrix}},
        "fleet_data": {"vehicle_locations": [[index[v.facility.id]] * 2 for v in vehicles],
                       "vehicle_ids": [v.id for v in vehicles],
                       "vehicle_time_windows": [[0, SHIFT_MIN] for _ in vehicles]},
        "task_data": {"task_locations": [index[i.id] for i in jobs],
                      "task_ids": [i.id for i in jobs],
                      "service_times": [_minutes(i) for i in jobs],
                      "order_vehicle_match": [{"order_id": n, "vehicle_ids": allowed[i.id]} for n, i in enumerate(jobs)],
                      "prizes": [PRIZE.get(i.severity, 50) for i in jobs]},
        # Prizes are subtracted from the cost; weight 0 would turn them off.
        "solver_config": {"time_limit": 3, "objectives": {"cost": 1, "prize": 1}},
    }


def _parse(solver: dict, jobs: list[IssueRecord], vehicles: list[Vehicle]) -> dict[str, tuple[list, list]]:
    by_id = {i.id: i for i in jobs}
    data = solver.get("vehicle_data") or {}
    out, assigned = {}, set()
    for v in vehicles:
        entry = data.get(v.id) or {}
        tasks = entry.get("task_id") or []
        stamps = entry.get("arrival_stamp") or [0] * len(tasks)
        stops, eta = [], []
        # Depot and break entries carry their own task ids, so matching issue ids is enough.
        for task, stamp in zip(tasks, stamps):
            if task in by_id and task not in assigned:
                stops.append(by_id[task])
                eta.append(int(round(float(stamp))))
                assigned.add(task)
        out[v.id] = (stops, eta)
    return out


def _nearest_neighbour(jobs: list[IssueRecord], vehicles: list[Vehicle], allowed: dict[str, list[int]],
                       index: dict[str, int], matrix: list[list[int]]) -> dict[str, tuple[list, list]]:
    """Each vehicle in turn takes the highest-severity job it may serve, nearest first,
    that still lets it finish and return to its base within the shift."""
    state = {v.id: {"at": index[v.facility.id], "clock": 0, "stops": [], "eta": []} for v in vehicles}
    left = list(jobs)
    progress = True
    while progress:
        progress = False
        for n, v in enumerate(vehicles):
            s, home = state[v.id], index[v.facility.id]

            def fits(i: IssueRecord) -> bool:
                at = index[i.id]
                return s["clock"] + matrix[s["at"]][at] + _minutes(i) + matrix[at][home] <= SHIFT_MIN

            options = [i for i in left if n in allowed[i.id] and fits(i)]
            if not options:
                continue
            pick = min(options, key=lambda i: (-i.severity, matrix[s["at"]][index[i.id]]))
            arrive = s["clock"] + matrix[s["at"]][index[pick.id]]
            s["stops"].append(pick)
            s["eta"].append(arrive)
            s["clock"], s["at"] = arrive + _minutes(pick), index[pick.id]
            left.remove(pick)
            progress = True
    return {v: (s["stops"], s["eta"]) for v, s in state.items()}


def _clock(minute: float) -> str:
    total = SHIFT_START[0] * 60 + SHIFT_START[1] + int(round(minute))
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def brief(route: Route, stops: list[IssueRecord], facility: Facility, back_min: float) -> str:
    """The run sheet a supervisor can paste into a text or a chat to the crew."""
    lines = [f"{route.crew_id.upper()} · {CREW_LABEL.get(route.crew, route.crew)} · from {facility.label}",
             f"Leave {_clock(0)}. {len(stops)} stop{'s' if len(stops) != 1 else ''}"
             + (f", {route.distance_km:.1f} km" if route.distance_km else "") + f", back about {_clock(back_min)}."]
    for n, (issue, eta) in enumerate(zip(stops, route.eta_min), 1):
        lines.append(f"{n}. {_clock(eta)}  S{issue.severity}  {issue.description} ({_minutes(issue)} min)"
                     f"  [{issue.lat:.5f}, {issue.lon:.5f}]")
    if route.warnings:
        lines.append("Road alerts:")
        lines += [f"- {w.label}{' (route avoids it)' if w.avoided else ''}" for w in route.warnings[:6]]
    if route.maps_urls:
        lines.append("Directions" + (" (Google Maps does not know these alerts; follow the stop order)"
                                     if route.warnings else "") + ":")
        lines += route.maps_urls
    return "\n".join(lines)


async def _finish(v: Vehicle, stops: list[IssueRecord], eta: list[int], back: float, alerts,
                  budget: paths.Budget, road: bool = True) -> Route:
    base: LatLon = (v.facility.lat, v.facility.lon)
    route = Route(crew_id=v.id, crew=v.crew, stops=[i.id for i in stops], eta_min=eta, path=[],
                  facility_id=v.facility.id, depot=base, depot_label=v.facility.label)
    if not stops:
        return route
    points = [base, *((i.lat, i.lon) for i in stops), base]
    # A route doesn't warn about the work zones it was sent to inspect.
    result = await paths.steer(points, alerts, budget, skip={i.id for i in stops}, road=road)
    route = route.model_copy(update=dict(path=result.path, distance_km=round(result.km, 1),
                                         path_source=result.source, warnings=result.warnings,
                                         maps_urls=roads.maps_urls(points)))
    return route.model_copy(update={"brief": brief(route, stops, v.facility, back)})


@dataclass
class CrewSolve:
    vehicles: list[Vehicle]
    assignment: dict[str, tuple[list, list]]
    home: dict[str, Facility]
    back: dict[str, int]                       # vehicle id → minutes from its last stop back to base
    points: list[LatLon]
    solver: str
    matrix_source: str
    over: list[str] = field(default_factory=list)   # jobs beyond a base's solver limit


async def _matrix(points: list[LatLon], groups: list[list[int]]) -> tuple[list[list[int]], str]:
    """Street minutes for the points. Too many for one table: one table per facility cluster, since a
    vehicle only ever drives between its base and that base's jobs; other pairs keep straight-line estimates."""
    if len(points) <= roads.MAX_TABLE:
        return await roads.matrix(points)
    matrix, sources = roads.straight_matrix(points), set()
    for group in groups:
        sub, source = await roads.matrix([points[k] for k in group])
        sources.add(source)
        for a, i in enumerate(group):
            for b, j in enumerate(group):
                matrix[i][j] = sub[a][b]
    return matrix, "road" if sources == {"road"} else "straight"


async def _solve_part(crew: Crew, vehicles: list[Vehicle], home: dict[str, Facility],
                      jobs: list[IssueRecord]) -> CrewSolve:
    """One cuOpt problem: these vehicles at their bases, these jobs (at most MAX_JOBS), street times."""
    used = list({v.facility.id: v.facility for v in vehicles}.values())
    points = [(f.lat, f.lon) for f in used] + [(i.lat, i.lon) for i in jobs]
    index = {f.id: n for n, f in enumerate(used)} | {i.id: len(used) + n for n, i in enumerate(jobs)}
    allowed = {i.id: [n for n, v in enumerate(vehicles) if v.facility.id == home[i.id].id] for i in jobs}
    groups = [[index[f.id], *(index[i.id] for i in jobs if home[i.id].id == f.id)] for f in used]
    matrix, matrix_source = await _matrix(points, groups)
    try:
        assignment = _parse(await cuopt.solve(_payload(jobs, vehicles, allowed, index, matrix)), jobs, vehicles)
        solver = "cuopt"
    except Exception as exc:
        log.warning("cuOpt failed for %s (%s); nearest-neighbour fallback", crew, config.redact(exc))
        assignment, solver = _nearest_neighbour(jobs, vehicles, allowed, index, matrix), "fallback"
    back = {v.id: matrix[index[stops[-1].id]][index[v.facility.id]]
            for v in vehicles for stops, _ in [assignment.get(v.id, ([], []))] if stops}
    return CrewSolve(vehicles, assignment, {i.id: home[i.id] for i in jobs}, back, points, solver, matrix_source)


def batches(jobs: list[IssueRecord], home: dict[str, Facility], limit: int = MAX_JOBS) -> tuple[list[list[str]], list[str]]:
    """Bases grouped so each group has at most `limit` jobs (one cuOpt problem each), and the jobs that
    don't fit: a single base over the limit keeps its worst `limit` (jobs arrive worst first)."""
    by_base: dict[str, list[str]] = defaultdict(list)
    for i in jobs:
        by_base[home[i.id].id].append(i.id)
    over = [j for ids in by_base.values() for j in ids[limit:]]
    sizes = {b: min(len(ids), limit) for b, ids in by_base.items()}
    groups: list[list[str]] = []
    for b in sorted(sizes, key=sizes.get, reverse=True):     # first fit, largest first
        fit = next((g for g in groups if sum(sizes[x] for x in g) + sizes[b] <= limit), None)
        if fit is None:
            groups.append([b])
        else:
            fit.append(b)
    return groups, over


async def _solve_crew(crew: Crew, count: int, jobs: list[IssueRecord]) -> CrewSolve:
    """One crew type: cluster on bases, then one cuOpt problem per group of bases under the solver limit."""
    if not jobs:                               # idle: park at the first base on file
        base = (facilities.for_crew(crew) or [_FALLBACK])[0]
        return CrewSolve([Vehicle(f"{crew}-{k + 1}", crew, base) for k in range(count)], {}, {}, {}, [],
                         "cuopt", "road")
    vehicles, home = cluster(crew, jobs, count)
    groups, over = batches(jobs, home)
    skipped = set(over)
    parts = await asyncio.gather(*(_solve_part(crew, [v for v in vehicles if v.facility.id in g], home,
                                               [i for i in jobs if home[i.id].id in g and i.id not in skipped])
                                   for g in groups))
    return CrewSolve(vehicles, {k: v for p in parts for k, v in p.assignment.items()},
                     {k: v for p in parts for k, v in p.home.items()}, {k: v for p in parts for k, v in p.back.items()},
                     [x for p in parts for x in p.points],
                     "cuopt" if all(p.solver == "cuopt" for p in parts) else "fallback",
                     "road" if all(p.matrix_source == "road" for p in parts) else "straight", over)


async def plan(crews: dict[Crew, int]) -> Plan:
    """cuOpt routes for the chosen crews: problems per crew type (split by base under the solver limit),
    each run kept to its base's jobs.

    Idle crews come back as routes with no stops. Jobs whose crew type has 0 crews, or beyond one base's
    100-job cap, are unassigned with a reason. Issues without GPS can't be routed and are left out.
    """
    started = time.perf_counter()
    all_jobs = _jobs()
    reasons: dict[str, str] = {}
    by_crew: dict[str, list[IssueRecord]] = defaultdict(list)
    for i in all_jobs:                         # already worst first, so each cap keeps the worst
        crew = CREW_FOR[i.category]
        if crews.get(crew, 0) <= 0:
            reasons[i.id] = "No crew of this type dispatched"
        else:
            by_crew[crew].append(i)

    staffed = [(crew, int(n)) for crew, n in crews.items() if n > 0]
    solves = await asyncio.gather(*(_solve_crew(crew, n, by_crew.get(crew, [])) for crew, n in staffed))
    for solve in solves:
        for job_id in solve.over:
            reasons[job_id] = f"Over the {MAX_JOBS}-job solver limit at one base"
        routed = {i.id for stops, _ in solve.assignment.values() for i in stops}
        for job_id, base in solve.home.items():
            if job_id not in routed:
                reasons[job_id] = f"Shift full at {base.label}"

    used = list({v.facility.id: v.facility for s in solves for v in s.vehicles}.values())
    alerts = await hz.near([p for s in solves for p in s.points] or [(f.lat, f.lon) for f in used])
    # Detours are shared out so the first routes can't use them all. Paths run one after another:
    # the routing server is rate-limited, and the cache dedupes repeats.
    work = [(s, v, *s.assignment.get(v.id, ([], []))) for s in solves for v in s.vehicles]
    busiest = sorted((w for w in work if w[2]), key=lambda w: -sum(PRIZE.get(i.severity, 50) for i in w[2]))
    gap = roads.interval()
    on_road = {w[1].id for w in (busiest if not gap else busiest[:max(1, int(PATH_SECONDS / gap))])}
    per_route = max(1, DETOUR_CALLS // max(1, len(on_road)))
    routes = []
    for s, v, stops, eta in work:
        back = eta[-1] + _minutes(stops[-1]) + s.back[v.id] if stops else 0
        routes.append(await _finish(v, stops, eta, back, alerts, paths.Budget(per_route), road=v.id in on_road))
    relevant = {w.hazard_id for r in routes for w in r.warnings}
    shown = [h for h in alerts if h.id in relevant or h.source == "dashcam" or h.severity >= hz.AVOID_AT][:80]

    unassigned = [i.id for i in all_jobs if i.id in reasons]
    solver = "cuopt" if solves and all(s.solver == "cuopt" for s in solves) else "fallback"
    matrix_source = "road" if solves and all(s.matrix_source == "road" for s in solves) else "straight"
    solve_ms = int((time.perf_counter() - started) * 1000)
    log.info("Dispatch: %d jobs in %d crew problems, %d vehicles at %d bases, solver=%s, matrix=%s, %d unassigned, %d ms",
             sum(len(v) for v in by_crew.values()), len(solves), len(routes), len(used), solver, matrix_source,
             len(unassigned), solve_ms)
    return Plan(routes=routes, unassigned=unassigned, solver=solver, solve_ms=solve_ms,
                unassigned_reasons={k: reasons[k] for k in unassigned}, facilities=used, hazards=shown,
                matrix_source=matrix_source)


async def directions(origin: LatLon, destination: LatLon) -> Directions:
    """Best road path between two points around current closures, with what is still in the way."""
    alerts = await hz.near([origin, destination], radius_km=max(1.5, km(origin, destination) / 2 + 0.5))
    result = await paths.steer([origin, destination], alerts, paths.Budget(4))
    return Directions(path=result.path, minutes=round(result.minutes), distance_km=round(result.km, 1),
                      path_source=result.source, warnings=result.warnings, alternatives=result.alternatives,
                      maps_url=roads.maps_urls([origin, destination])[0])
