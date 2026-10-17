"""Crew plans: triage the backlog, then cuOpt round trips from each site, day by day.

1. Fleet. Each site (facilities.py) sends out a number of trucks per crew type per day: the counts
   stored on the site, or the request's `sites` override. An older request with only `crews`
   (trucks per crew type) shares them over the sites by workload, as before.
2. Each open, located job goes to the nearest site with a truck of its crew type (waste to the nearest
   transfer station or collection yard, potholes to the nearest road yard, ...).
3. Triage (triage.py): Nemotron decides today / later / defer within hard rules in code (severity
   floor, capacity, severity 5 today). Deferred jobs are not routed.
4. One street travel-time matrix per crew type (OSRM; straight-line fallback, reported as matrix_source).
5. Day by day: one cuOpt problem per crew type and group of sites (≤ 100 jobs, the hosted cap). Every
   truck leaves its site at 08:00 and must be back by 16:00; a 30-minute lunch between 11:30 and 13:00
   at a job site is a cuOpt vehicle break. Prizes follow severity, and jobs triaged for today carry a
   bonus. Jobs a day can't fit roll into the next day; after the last day they are unassigned with a
   reason. Nearest neighbour is the fallback (lunch then reserved after the job nearest 11:30).
6. Each truck-day becomes a Route with its full timeline (schedule), totals, a closed street path that
   steers around closures (paths.steer), road alerts, Google Maps links and a plain-text run sheet.
"""
import asyncio
from collections import Counter, defaultdict
from dataclasses import dataclass, field
import logging
import math
import time

from app import config, curation, store
from app.ai.prompts import DEFAULT_MINUTES
from app.geo import roads
from app.geo.distance import LatLon, km
from app.models import (CREW_FOR, Crew, Directions, Facility, IssueRecord, Plan, PlanDay, PlanSite, Route,
                        ScheduleEntry, ShiftTotals)
from app.planning import cuopt, facilities, hazards as hz, paths, triage as triage_mod

log = logging.getLogger(__name__)
DEPOT = (43.6534, -79.3841)          # used only when a crew type has no facility on file
DEPOT_LABEL = "Toronto City Hall (assumed depot)"
SHIFT_MIN = 480
SHIFT_START = (8, 0)                 # 08:00, as the console shows it
LUNCH = (210, 300, 30)               # a 30-minute break starting between 11:30 and 13:00
HAZARD_BY = 240                      # severity 5 jobs start by 12:00 (a time window cuOpt respects or drops)
MAX_JOBS = 100                       # hosted cuOpt needs asset upload above this
MAX_DAYS = 7
PRIZE = {5: 1000, 4: 500, 3: 250, 2: 100, 1: 50}
TODAY_BONUS = 4000                   # jobs triaged for today outrank anything else
DETOUR_CALLS = 6                     # OSRM re-routes around closures per plan (public server: ~1 per second)
PATH_SECONDS = 12                    # rate-limited server: street paths for as many routes as fit, busiest first
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
    # Findings the rating pass judged not to be defects get no crew.
    located = [i for i in curation.visible(store.canonical_issues())
               if i.lat is not None and i.lon is not None and getattr(i, "verdict", None) != "rejected"]
    located.sort(key=lambda i: (-i.severity, -i.confidence))
    return located


# ---- Fleet: trucks per site ----

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
    """Legacy fleet (trucks per crew type): vehicles shared over the crew's sites by workload."""
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
    if not loads:
        loads = {bases[0].id: 0}
    vehicles = []
    for fid, n in _share(count, dict(loads)).items():
        vehicles += [Vehicle(f"{crew}-{len(vehicles) + k + 1}", crew, by_id[fid]) for k in range(n)]
    return vehicles, home


def site_fleet(sites: dict[str, dict[str, int]] | None) -> list[Vehicle]:
    """Vehicles from trucks per site per crew type: the request's override, else what each site stores."""
    known = facilities.load()
    counts = {f.id: dict(f.vehicles) for f in known} if sites is None else sites
    out: list[Vehicle] = []
    numbering: Counter = Counter()
    for f in sorted(known, key=lambda f: f.label):
        for crew, n in sorted((counts.get(f.id) or {}).items()):
            if crew not in f.crews:
                continue
            for _ in range(max(0, min(facilities.MAX_VEHICLES, int(n)))):
                numbering[crew] += 1
                out.append(Vehicle(f"{crew}-{numbering[crew]}", crew, f))
    return out


def homes(jobs: list[IssueRecord], vehicles: list[Vehicle]) -> dict[str, Facility]:
    """Each job's site: the nearest one with a truck of its crew type. Jobs with none are left out."""
    bases: dict[str, dict[str, Facility]] = defaultdict(dict)
    for v in vehicles:
        bases[v.crew][v.facility.id] = v.facility
    out = {}
    for i in jobs:
        options = list(bases.get(CREW_FOR[i.category], {}).values())
        if options:
            out[i.id] = facilities.nearest(CREW_FOR[i.category], (i.lat, i.lon), options)
    return out


# ---- Solving one day ----

@dataclass
class Visit:
    kind: str                                  # "job" or "break"
    issue: IssueRecord | None
    arrive: float
    loc: int                                   # index into the crew's matrix


@dataclass
class TruckDay:
    vehicle: Vehicle
    day: int
    visits: list[Visit]
    start: float                               # leaves the site
    back: float | None                         # back at the site, when the solver says
    solver: str
    lunch: str                                 # "solver" or "reserved"


@dataclass
class CrewContext:
    crew: Crew
    vehicles: list[Vehicle]
    home: dict[str, Facility]
    index: dict[str, int]                      # site id or job id -> matrix row
    matrix: list[list[int]]
    matrix_source: str
    points: list[LatLon]


async def _matrix(points: list[LatLon], groups: list[list[int]]) -> tuple[list[list[int]], str]:
    """Street minutes for the points. Too many for one table: one table per site cluster, since a
    vehicle only ever drives between its base and that base's jobs; other pairs keep straight-line estimates."""
    if len(points) <= roads.MAX_TABLE:
        return await roads.matrix(points)
    matrix, sources = roads.straight_matrix(points), set()
    for group in groups:
        for start in range(0, len(group), roads.MAX_TABLE):
            # A site with more jobs than one table: chunks that each include the site.
            chunk = group[start:start + roads.MAX_TABLE] if start == 0 else [group[0], *group[start:start + roads.MAX_TABLE - 1]]
            sub, source = await roads.matrix([points[k] for k in chunk])
            sources.add(source)
            for a, i in enumerate(chunk):
                for b, j in enumerate(chunk):
                    matrix[i][j] = sub[a][b]
    return matrix, "road" if sources == {"road"} else "straight"


async def _context(crew: Crew, vehicles: list[Vehicle], home: dict[str, Facility],
                   jobs: list[IssueRecord]) -> CrewContext:
    used = list({home[i.id].id: home[i.id] for i in jobs}.values())
    points = [(f.lat, f.lon) for f in used] + [(i.lat, i.lon) for i in jobs]
    index = {f.id: n for n, f in enumerate(used)} | {i.id: len(used) + n for n, i in enumerate(jobs)}
    groups = [[index[f.id], *(index[i.id] for i in jobs if home[i.id].id == f.id)] for f in used]
    matrix, source = await _matrix(points, groups) if points else ([], "road")
    return CrewContext(crew, vehicles, home, index, matrix, source, points)


def payload(jobs: list[IssueRecord], vehicles: list[Vehicle], locs: list[int], ctx: CrewContext,
            today: set[str], lunch: bool = True) -> dict:
    """One cuOpt problem over the locations `locs` (rows of the crew matrix): sites first, then jobs.
    Every vehicle starts and ends at its own site and may only take that site's jobs."""
    local = {g: n for n, g in enumerate(locs)}
    sub = [[ctx.matrix[a][b] for b in locs] for a in locs]
    allowed = {i.id: [n for n, v in enumerate(vehicles) if v.facility.id == ctx.home[i.id].id] for i in jobs}
    fleet = {"vehicle_locations": [[local[ctx.index[v.facility.id]]] * 2 for v in vehicles],
             "vehicle_ids": [v.id for v in vehicles],
             "vehicle_time_windows": [[0, SHIFT_MIN] for _ in vehicles]}
    if lunch:
        start, end, length = LUNCH
        fleet |= {"vehicle_break_time_windows": [[[start, end] for _ in vehicles]],
                  "vehicle_break_durations": [[length for _ in vehicles]],
                  # Lunch at a job site, not by waiting at the yard.
                  "vehicle_break_locations": sorted({local[ctx.index[i.id]] for i in jobs})}
    return {
        "cost_matrix_data": {"data": {"0": sub}},
        "travel_time_matrix_data": {"data": {"0": sub}},
        "fleet_data": fleet,
        "task_data": {"task_locations": [local[ctx.index[i.id]] for i in jobs],
                      "task_ids": [i.id for i in jobs],
                      "service_times": [_minutes(i) for i in jobs],
                      "task_time_windows": [[0, HAZARD_BY if i.severity == 5 else SHIFT_MIN] for i in jobs],
                      "order_vehicle_match": [{"order_id": n, "vehicle_ids": allowed[i.id]} for n, i in enumerate(jobs)],
                      "prizes": [PRIZE.get(i.severity, 50) + (TODAY_BONUS if i.id in today else 0) for i in jobs]},
        # Prizes are subtracted from the cost; weight 0 would turn them off.
        "solver_config": {"time_limit": 3, "objectives": {"cost": 1, "prize": 1}},
    }


def parse(solver: dict, jobs: list[IssueRecord], vehicles: list[Vehicle], locs: list[int],
          day: int) -> list[TruckDay]:
    """cuOpt's answer as truck-days: jobs and breaks in order with arrival minutes, plus leave and back times."""
    by_id = {i.id: i for i in jobs}
    data = solver.get("vehicle_data") or {}
    out, assigned = [], set()
    for v in vehicles:
        entry = data.get(v.id) or {}
        tasks = entry.get("task_id") or []
        stamps = entry.get("arrival_stamp") or [0] * len(tasks)
        types = entry.get("type") or [None] * len(tasks)
        route = entry.get("route") or [None] * len(tasks)
        visits, depots = [], []
        for task, kind, stamp, loc in zip(tasks, types, stamps, route):
            stamp = float(stamp)
            if task in by_id and task not in assigned:
                assigned.add(task)
                visits.append(Visit("job", by_id[task], stamp, -1))
            elif kind == "Break" or task == "Break":
                where = locs[loc] if isinstance(loc, int) and 0 <= loc < len(locs) else None
                visits.append(Visit("break", None, stamp, -1 if where is None else where))
            elif kind == "Depot" or task == "Depot":
                depots.append(stamp)
        if not any(x.kind == "job" for x in visits):
            continue
        out.append(TruckDay(v, day, visits, depots[0] if depots else 0.0,
                            depots[-1] if len(depots) > 1 else None, "cuopt", "solver"))
    return out


def _nearest_neighbour(jobs: list[IssueRecord], vehicles: list[Vehicle], ctx: CrewContext,
                       today: set[str], day: int) -> list[TruckDay]:
    """Each vehicle in turn takes the best job it may serve (today's first, worst, then nearest) that still
    lets it get back by the end of the shift with lunch reserved."""
    limit = SHIFT_MIN - LUNCH[2]
    state = {v.id: {"at": ctx.index[v.facility.id], "clock": 0, "visits": []} for v in vehicles}
    left = list(jobs)
    progress = True
    while progress:
        progress = False
        for v in vehicles:
            s, base = state[v.id], ctx.index[v.facility.id]

            def fits(i: IssueRecord) -> bool:
                at = ctx.index[i.id]
                return s["clock"] + ctx.matrix[s["at"]][at] + _minutes(i) + ctx.matrix[at][base] <= limit

            options = [i for i in left if ctx.home[i.id].id == v.facility.id and fits(i)]
            if not options:
                continue
            pick = min(options, key=lambda i: (i.id not in today, -i.severity, ctx.matrix[s["at"]][ctx.index[i.id]]))
            arrive = s["clock"] + ctx.matrix[s["at"]][ctx.index[pick.id]]
            s["visits"].append(Visit("job", pick, arrive, ctx.index[pick.id]))
            s["clock"], s["at"] = arrive + _minutes(pick), ctx.index[pick.id]
            left.remove(pick)
            progress = True
    return [TruckDay(v, day, state[v.id]["visits"], 0.0, None, "fallback", "reserved")
            for v in vehicles if state[v.id]["visits"]]


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


async def _solve_group(ctx: CrewContext, jobs: list[IssueRecord], vehicles: list[Vehicle], today: set[str],
                       day: int) -> list[TruckDay]:
    sites = list({v.facility.id: v.facility for v in vehicles}.values())
    locs = [ctx.index[f.id] for f in sites if f.id in ctx.index] + [ctx.index[i.id] for i in jobs]
    try:
        return parse(await cuopt.solve(payload(jobs, vehicles, locs, ctx, today)), jobs, vehicles, locs, day)
    except Exception as exc:
        log.warning("cuOpt failed for %s day %d (%s); nearest-neighbour fallback", ctx.crew, day, config.redact(exc))
        return _nearest_neighbour(jobs, vehicles, ctx, today, day)


async def solve_day(ctx: CrewContext, jobs: list[IssueRecord], today: set[str], day: int) -> tuple[list[TruckDay], list[str], set[str]]:
    """One crew type, one day: problems per group of sites under the solver cap.
    Returns the truck-days, the jobs over the cap, and which solvers answered."""
    if not jobs:
        return [], [], set()
    groups, over = batches(jobs, ctx.home)
    skipped = set(over)
    parts = await asyncio.gather(*(
        _solve_group(ctx, [i for i in jobs if ctx.home[i.id].id in g and i.id not in skipped],
                     [v for v in ctx.vehicles if v.facility.id in g], today, day)
        for g in groups))
    days = [t for p in parts for t in p]
    solvers = {t.solver for t in days} or {"cuopt"}
    # A problem with no truck-days still answered; record a fallback only when one happened.
    return days, over, solvers


# ---- Schedules ----

def _clock(minute: float) -> str:
    total = SHIFT_START[0] * 60 + SHIFT_START[1] + int(round(minute))
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def schedule(td: TruckDay, ctx: CrewContext) -> tuple[list[ScheduleEntry], ShiftTotals]:
    """A truck's full shift: leave the site, drive / arrive / work / leave per stop, lunch, back at the site."""
    site = td.vehicle.facility
    base = ctx.index[site.id]
    visits = list(td.visits)
    lunch_mode = td.lunch
    if lunch_mode == "reserved":               # fallback: lunch after the job that ends nearest 11:30
        jobs = [n for n, x in enumerate(visits) if x.kind == "job"]
        ends = [(n, visits[n].arrive + _minutes(visits[n].issue)) for n in jobs]
        after = next((n for n, end in ends if end >= LUNCH[0]), None)
        if after is None and ends and ends[-1][1] + ctx.matrix[ctx.index[visits[ends[-1][0]].issue.id]][base] <= LUNCH[0]:
            lunch_mode = "none"                # back before lunch: no break on the road
        else:
            n = ends[-1][0] if after is None else after
            at = visits[n].arrive + _minutes(visits[n].issue)
            shifted = [Visit(x.kind, x.issue, x.arrive + LUNCH[2], x.loc) for x in visits[n + 1:]]
            visits = visits[:n + 1] + [Visit("break", None, max(at, LUNCH[0]), ctx.index[visits[n].issue.id])] + shifted
    elif not any(x.kind == "break" for x in visits):
        lunch_mode = "none"

    entries = [ScheduleEntry(kind="depart", label=f"Leave {site.label}", lat=site.lat, lon=site.lon,
                             arrive_min=round(td.start), depart_min=round(td.start))]
    at, clock = base, td.start
    drive = work = rest = 0
    for x in visits:
        if x.kind == "job":
            loc = ctx.index[x.issue.id]
            length, point = _minutes(x.issue), (x.issue.lat, x.issue.lon)
        else:
            loc = at if x.loc < 0 else x.loc
            length, point = LUNCH[2], ctx.points[loc]
        leg = ctx.matrix[at][loc]
        arrive = max(x.arrive, clock + leg)
        entries.append(ScheduleEntry(
            kind=x.kind, issue_id=x.issue.id if x.issue else None,
            label=x.issue.description if x.issue else "Lunch break", lat=point[0], lon=point[1],
            drive_min=leg, arrive_min=round(arrive), work_min=length, depart_min=round(arrive + length),
            idle_min=max(0, round(arrive - clock - leg)), severity=x.issue.severity if x.issue else None))
        drive += leg
        if x.kind == "job":
            work += length
        else:
            rest += length
        clock, at = arrive + length, loc
    leg = ctx.matrix[at][base]
    back = max(td.back or 0, clock + leg)
    entries.append(ScheduleEntry(kind="return", label=f"Back at {site.label}", lat=site.lat, lon=site.lon,
                                 drive_min=leg, arrive_min=round(back), depart_min=round(back),
                                 idle_min=max(0, round(back - clock - leg))))
    drive += leg
    totals = ShiftTotals(drive_min=drive, work_min=work, break_min=rest,
                         idle_min=max(0, round(back - td.start) - drive - work - rest),
                         back_min=round(back), jobs=sum(x.kind == "job" for x in visits), lunch=lunch_mode)
    return entries, totals


def brief(route: Route, facility: Facility, horizon: int = 1) -> str:
    """The run sheet a supervisor can paste into a text or a chat to the crew."""
    t = route.totals
    day = f"Day {route.day} · " if horizon > 1 else ""
    lines = [f"{day}{(route.vehicle_id or route.crew_id).upper()} · {CREW_LABEL.get(route.crew, route.crew)} · from {facility.label}"]
    if t:
        lines.append(f"{t.jobs} stop{'s' if t.jobs != 1 else ''}"
                     + (f", {route.distance_km:.1f} km" if route.distance_km else "")
                     + f". Driving {t.drive_min} min, on site {t.work_min} min, back {_clock(t.back_min)}.")
    n = 0
    for e in route.schedule:
        if e.kind == "depart":
            lines.append(f"{_clock(e.depart_min)}  Leave {facility.label}")
        elif e.kind == "job":
            n += 1
            lines.append(f"{n}. {_clock(e.arrive_min)}-{_clock(e.depart_min)}  S{e.severity}  {e.label}"
                         f"  ({e.drive_min} min drive)  [{e.lat:.5f}, {e.lon:.5f}]")
        elif e.kind == "break":
            lines.append(f"   {_clock(e.arrive_min)}-{_clock(e.depart_min)}  Lunch")
        else:
            lines.append(f"{_clock(e.arrive_min)}  Back at {facility.label} ({e.drive_min} min drive)")
    if route.warnings:
        lines.append("Road alerts:")
        lines += [f"- {w.label}{' (route avoids it)' if w.avoided else ''}" for w in route.warnings[:6]]
    if route.maps_urls:
        lines.append("Directions" + (" (Google Maps does not know these alerts; follow the stop order)"
                                     if route.warnings else "") + ":")
        lines += route.maps_urls
    return "\n".join(lines)


async def _finish(td: TruckDay, ctx: CrewContext, alerts, budget: paths.Budget, road: bool, horizon: int) -> Route:
    v = td.vehicle
    base: LatLon = (v.facility.lat, v.facility.lon)
    entries, totals = schedule(td, ctx)
    stops = [e for e in entries if e.kind == "job"]
    crew_id = v.id if td.day == 1 else f"{v.id}/d{td.day}"
    route = Route(crew_id=crew_id, crew=v.crew, stops=[e.issue_id for e in stops], eta_min=[e.arrive_min for e in stops],
                  path=[], facility_id=v.facility.id, depot=base, depot_label=v.facility.label, day=td.day,
                  vehicle_id=v.id, schedule=entries, totals=totals, solver=td.solver)
    points = [base, *((e.lat, e.lon) for e in stops), base]
    # A route doesn't warn about the work zones it was sent to inspect.
    result = await paths.steer(points, alerts, budget, skip={e.issue_id for e in stops}, road=road)
    totals = totals.model_copy(update={"distance_km": round(result.km, 1)})
    route = route.model_copy(update=dict(path=result.path, distance_km=round(result.km, 1), totals=totals,
                                         path_source=result.source, warnings=result.warnings,
                                         maps_urls=roads.maps_urls(points)))
    return route.model_copy(update={"brief": brief(route, v.facility, horizon)})


def _idle_route(v: Vehicle) -> Route:
    base = (v.facility.lat, v.facility.lon)
    return Route(crew_id=v.id, crew=v.crew, stops=[], eta_min=[], path=[], facility_id=v.facility.id, depot=base,
                 depot_label=v.facility.label, day=1, vehicle_id=v.id)


# ---- The plan ----

async def plan(crews: dict[Crew, int] | None = None, *, sites: dict[str, dict[str, int]] | None = None,
               days: int = 1, min_severity: int = 1, triage: bool = True) -> Plan:
    """Triage, then cuOpt round trips from each site for `days` days.

    `sites` (site id -> crew type -> trucks per day) overrides what the sites store. With only `crews`
    (an older console: trucks per crew type), the trucks are shared over the sites by workload.
    Issues without GPS can't be routed and are left out.
    """
    started = time.perf_counter()
    days = max(1, min(MAX_DAYS, int(days)))
    min_severity = max(1, min(5, int(min_severity)))
    all_jobs = _jobs()
    if sites is None and crews:
        vehicles = []
        for crew, n in crews.items():
            if n > 0:
                vehicles += cluster(crew, [i for i in all_jobs if CREW_FOR[i.category] == crew], int(n))[0]
    else:
        vehicles = site_fleet(sites)
    home = homes(all_jobs, vehicles)
    trucks = Counter(v.crew for v in vehicles)
    located = [i for i in all_jobs if i.id in home or trucks[CREW_FOR[i.category]] == 0]
    phase = {}
    mark = time.perf_counter()
    tri = await triage_mod.decide(located, min_severity, dict(trucks), days, use_model=triage)
    phase["triage"], mark = time.perf_counter() - mark, time.perf_counter()
    decision = {d.issue_id: d for d in tri.decisions}
    today = {k for k, d in decision.items() if d.decision == "today"}
    selected = [i for i in all_jobs if i.id in home and decision.get(i.id) and decision[i.id].decision != "defer"]
    deferred = [d.issue_id for d in tri.decisions if d.decision == "defer"]

    by_crew: dict[str, list[IssueRecord]] = defaultdict(list)
    for i in selected:                          # worst first, today's first: each cap keeps the most urgent
        by_crew[CREW_FOR[i.category]].append(i)
    for jobs in by_crew.values():
        jobs.sort(key=lambda i: (i.id not in today, -i.severity, -i.confidence))
    contexts = {}
    for crew, jobs in by_crew.items():         # one after another: the routing server is rate-limited
        contexts[crew] = await _context(crew, [v for v in vehicles if v.crew == crew], home, jobs)

    phase["matrix"], mark = time.perf_counter() - mark, time.perf_counter()
    remaining = {crew: list(jobs) for crew, jobs in by_crew.items()}
    truck_days: list[tuple[TruckDay, CrewContext]] = []
    solvers: set[str] = set()
    plan_days: list[PlanDay] = []
    last_over: dict[str, list[str]] = {}
    for day in range(1, days + 1):
        crews_today = [c for c in remaining if remaining[c]]
        results = await asyncio.gather(*(solve_day(contexts[c], remaining[c], today, day) for c in crews_today))
        day_solvers: set[str] = set()
        done_today: list[TruckDay] = []
        for crew, (tds, over, used) in zip(crews_today, results):
            day_solvers |= used
            done = {x.issue.id for td in tds for x in td.visits if x.kind == "job"}
            remaining[crew] = [i for i in remaining[crew] if i.id not in done]
            last_over[crew] = over
            done_today += tds
            truck_days += [(td, contexts[crew]) for td in tds]
        solvers |= day_solvers
        jobs_done = [x.issue for td in done_today for x in td.visits if x.kind == "job"]
        plan_days.append(PlanDay(day=day, jobs=len(jobs_done), trucks=len(done_today),
                                 by_severity=dict(Counter(str(i.severity) for i in jobs_done)),
                                 solver="fallback" if "fallback" in day_solvers else "cuopt"))
        if not any(remaining.values()):
            break

    reasons: dict[str, str] = {}
    for crew, left in remaining.items():
        over = set(last_over.get(crew, []))
        for i in left:
            site = contexts[crew].home[i.id].label
            reasons[i.id] = (f"Over the {MAX_JOBS}-job solver limit at {site}" if i.id in over else
                             f"Not reached in {days} day{'s' if days > 1 else ''}: shifts full at {site}")

    phase["cuopt"], mark = time.perf_counter() - mark, time.perf_counter()
    # Street paths: the busiest truck-days first (day 1 first) while the rate-limited server allows.
    points = [p for ctx in contexts.values() for p in ctx.points]
    used_sites = list({v.facility.id: v.facility for v in vehicles}.values())
    alerts = await hz.near(points or [(f.lat, f.lon) for f in used_sites])
    busiest = sorted(truck_days, key=lambda w: (w[0].day, -sum(PRIZE.get(x.issue.severity, 50)
                                                               for x in w[0].visits if x.kind == "job")))
    gap = roads.interval()
    on_road = {id(w[0]) for w in (busiest if not gap else busiest[:max(1, int(PATH_SECONDS / gap))])}
    per_route = max(1, DETOUR_CALLS // max(1, len(on_road)))
    routes = []
    for td, ctx in busiest:
        routes.append(await _finish(td, ctx, alerts, paths.Budget(per_route), id(td) in on_road, days))
    out = {r.vehicle_id for r in routes if r.day == 1}
    routes += [_idle_route(v) for v in vehicles if v.id not in out]
    for pd in plan_days:
        rs = [r for r in routes if r.day == pd.day and r.totals]
        pd.drive_min = sum(r.totals.drive_min for r in rs)
        pd.work_min = sum(r.totals.work_min for r in rs)
        pd.distance_km = round(sum(r.distance_km or 0 for r in rs), 1)
        pd.last_back_min = max((r.totals.back_min for r in rs), default=0)
    phase["paths"] = time.perf_counter() - mark
    relevant = {w.hazard_id for r in routes for w in r.warnings}
    shown = [h for h in alerts if h.id in relevant or h.source == "dashcam" or h.severity >= hz.AVOID_AT][:80]

    routed = Counter(r.facility_id for r in routes for _ in r.stops)
    trucks_at: dict[str, Counter] = defaultdict(Counter)
    for v in vehicles:
        trucks_at[v.facility.id][v.crew] += 1
    site_rows = [PlanSite(facility_id=f.id, label=f.label, kind=f.kind, trucks=dict(trucks_at[f.id]), jobs=routed[f.id])
                 for f in used_sites]
    unassigned = [i.id for i in all_jobs if i.id in reasons]
    no_truck = [i for i in all_jobs if i.id not in home and decision.get(i.id) is None]
    for i in no_truck:                           # unreachable: no site has a truck of this crew type
        deferred.append(i.id)
    solver = "cuopt" if solvers and solvers == {"cuopt"} else ("cuopt" if not truck_days and not solvers else "fallback")
    matrix_source = "road" if all(c.matrix_source == "road" for c in contexts.values()) else "straight"
    solve_ms = int((time.perf_counter() - started) * 1000)
    log.info("Dispatch: %d selected of %d jobs (triage=%s, floor S%d), %d days, %d truck-days from %d sites, "
             "solver=%s, matrix=%s, %d unassigned, %d deferred, %d ms (%s)",
             len(selected), len(all_jobs), tri.model, min_severity, len(plan_days), len(truck_days), len(used_sites),
             solver, matrix_source, len(unassigned), len(deferred), solve_ms,
             ", ".join(f"{k} {v:.1f} s" for k, v in phase.items()))
    return Plan(routes=routes, unassigned=unassigned, solver=solver, solve_ms=solve_ms,
                unassigned_reasons={k: reasons[k] for k in unassigned}, facilities=used_sites, hazards=shown,
                matrix_source=matrix_source, min_severity=min_severity, horizon_days=days, sites=site_rows,
                days=plan_days, triage=tri, deferred=deferred)


async def directions(origin: LatLon, destination: LatLon) -> Directions:
    """Best road path between two points around current closures, with what is still in the way."""
    alerts = await hz.near([origin, destination], radius_km=max(1.5, km(origin, destination) / 2 + 0.5))
    result = await paths.steer([origin, destination], alerts, paths.Budget(4))
    return Directions(path=result.path, minutes=round(result.minutes), distance_km=round(result.km, 1),
                      path_source=result.source, warnings=result.warnings, alternatives=result.alternatives,
                      maps_url=roads.maps_urls([origin, destination])[0])
