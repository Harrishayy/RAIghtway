"""Background road paths: straight routes get street geometry one at a time; a newer plan stops it. Offline."""
import asyncio

from app import store
from app.models import Plan, Route, ScheduleEntry
from app.planning import fill_paths, paths


def route(id, source="straight"):
    jobs = [ScheduleEntry(kind="job", issue_id=f"{id}-j", label="job", lat=43.65, lon=-79.40, arrive_min=10, depart_min=40)]
    return Route(crew_id=id, crew="roads", stops=[f"{id}-j"], eta_min=[10], path=[(43.64, -79.41), (43.65, -79.40)],
                 depot=(43.64, -79.41), path_source=source, schedule=jobs)


def test_fills_straight_routes_and_persists_once(monkeypatch):
    plan = Plan(routes=[route("a"), route("b", "road")], unassigned=[], solver="cuopt", solve_ms=1, plan_id="p1")
    plan.paths_pending = fill_paths.pending(plan)
    assert plan.paths_pending == 1
    calls, writes = [], []

    async def steer(points, hazards, budget, skip=frozenset(), road=True):
        calls.append(points)
        return paths.PathResult([(43.64, -79.41), (43.645, -79.405), (43.65, -79.40)], 4.0, 2.5, "road")
    monkeypatch.setattr(paths, "steer", steer)
    monkeypatch.setattr(store, "update_plan", lambda p, persist: writes.append((p.paths_pending, persist)) or True)
    asyncio.run(fill_paths.fill(plan))
    assert len(calls) == 1 and calls[0][0] == calls[0][-1]            # a round trip from the depot
    assert plan.routes[0].path_source == "road" and plan.routes[0].distance_km == 2.5
    assert writes == [(0, False), (0, True)]


def test_stops_when_a_newer_plan_exists(monkeypatch):
    plan = Plan(routes=[route("a"), route("b")], unassigned=[], solver="cuopt", solve_ms=1, plan_id="old")

    async def steer(*a, **k):
        return paths.PathResult([(43.64, -79.41), (43.65, -79.40)], 4.0, 2.5, "road")
    monkeypatch.setattr(paths, "steer", steer)
    writes = []
    monkeypatch.setattr(store, "update_plan", lambda p, persist: writes.append(persist) and False)
    asyncio.run(fill_paths.fill(plan))
    assert writes == [False]                                            # gave up after the first write was refused
