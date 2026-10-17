"""Road geometry for the routes a plan drew straight.

The public routing server allows about one request a second, so a plan fetches street paths for its
busiest routes only and returns. This task then fetches the rest one at a time, in the background, and
updates the stored plan as each lands (in memory; persisted once at the end). The console polls
GET /api/plan while `paths_pending` > 0. A newer plan stops it.
"""
import asyncio
import logging

from app import config, store
from app.geo import roads
from app.models import Plan
from app.planning import paths

log = logging.getLogger(__name__)
DETOURS_PER_ROUTE = 1


def pending(plan: Plan) -> int:
    return sum(1 for r in plan.routes if r.stops and r.path_source == "straight")


async def fill(plan: Plan) -> None:
    done = 0
    for n, route in enumerate(plan.routes):
        if not route.stops or route.path_source != "straight" or route.depot is None:
            continue
        jobs = [e for e in route.schedule if e.kind == "job"]
        if not jobs:
            continue
        points = [tuple(route.depot), *((e.lat, e.lon) for e in jobs), tuple(route.depot)]
        try:
            result = await paths.steer(points, plan.hazards, paths.Budget(DETOURS_PER_ROUTE),
                                       skip={e.issue_id for e in jobs if e.issue_id})
        except Exception as exc:
            log.warning("Road path for %s failed (%s)", route.crew_id, config.redact(exc))
            continue
        if result.source != "road":
            continue
        totals = route.totals.model_copy(update={"distance_km": round(result.km, 1)}) if route.totals else None
        plan.routes[n] = route.model_copy(update=dict(path=result.path, path_source="road", warnings=result.warnings,
                                                      distance_km=round(result.km, 1), totals=totals,
                                                      maps_urls=roads.maps_urls(points)))
        plan.paths_pending = pending(plan)
        done += 1
        if not await asyncio.to_thread(store.update_plan, plan, False):
            log.info("Road paths: a newer plan replaced %s; stopped after %d", plan.plan_id, done)
            return
    plan.paths_pending = 0
    for day in plan.days:
        day.distance_km = round(sum(r.distance_km or 0 for r in plan.routes if r.day == day.day and r.stops), 1)
    await asyncio.to_thread(store.update_plan, plan, True)
    log.info("Road paths: %d filled in the background for plan %s; %d still straight", done, plan.plan_id, pending(plan))
