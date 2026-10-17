"""Category routing, closures and directions, offline: cuOpt, OSRM and the city feed are stubbed."""
import asyncio
from datetime import datetime, timezone
import json

import pytest

from app import config, store
from app.ai.prompts import normalise_category
from app.geo import roads
from app.models import Hazard, IssueRecord
from app.planning import cuopt, dispatch, hazards, paths

COMMISSIONERS = (43.65198, -79.3393)
INGRAM = (43.70066, -79.47131)


def issue(id, category, lat, lon, severity=3):
    return IssueRecord(id=id, video_id="v", t=0, category=category, severity=severity, confidence=0.9,
                       description=f"{category} {id}", frame_url="", bbox=None, lat=lat, lon=lon,
                       source="corpus", frame_key="", created_at=datetime.now(timezone.utc))


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(config, "ROUTING_URL", "off")
    monkeypatch.setattr(config, "ROAD_RESTRICTIONS_URL", "off")

    async def no_cuopt(payload):
        raise cuopt.CuOptError("offline")
    monkeypatch.setattr(cuopt, "solve", no_cuopt)


@pytest.mark.parametrize("label,description,expected", [
    ("pavement", "", "pavement"), ("pothole", "", "pavement"), ("Potholes", "", "pavement"),
    ("garbage", "", "waste"), ("overflowing trash bin", "", "waste"), ("construction", "", "work_zone"),
    ("road work", "", "work_zone"), ("work-zone", "", "work_zone"), ("graffiti", "", "graffiti"),
    ("vandalism", "spray paint tag on wall", "graffiti"), ("other", "cones around an open trench", "work_zone"),
    ("faded crosswalk", "", "markings"), ("bent stop sign", "", "signage"), ("pedestrian", "", None),
])
def test_normalise_category(label, description, expected):
    assert normalise_category(label, description) == expected


def test_parse_city_repairs_escapes_and_drops_inactive():
    now = 1_800_000_000_000
    rows = [
        {"id": "a", "name": "Shuter St closed", "latitude": "43.65", "longitude": "-79.37", "type": "ROAD_CLOSED",
         "directionsAffected": "BOTH_DIRECTIONS", "startTime": str(now - 1), "endTime": str(now + 1), "expired": 0,
         "geoPolyline": "[-79.371,43.650],[-79.369,43.650]", "description": "C:\\Temp"},
        {"id": "b", "name": "old", "latitude": "43.6", "longitude": "-79.3", "type": "CONSTRUCTION",
         "startTime": "0", "endTime": str(now - 10), "expired": 0},
        {"id": "c", "name": "expired", "latitude": "43.6", "longitude": "-79.3", "type": "CONSTRUCTION",
         "startTime": "0", "endTime": "0", "expired": 1},
    ]
    text = json.dumps({"Closure": rows}).replace("C:\\\\Temp", "C:\\Temp")   # an invalid \T escape, as the feed sends
    parsed = hazards.parse_city(text, now_ms=now)
    assert [h.id for h in parsed] == ["city:a"]
    assert parsed[0].severity == 5 and parsed[0].path == [(43.65, -79.371), (43.65, -79.369)]


def test_waste_clusters_on_nearest_transfer_station():
    near_east = [issue(f"e{n}", "waste", 43.655 + n * 0.001, -79.345) for n in range(3)]
    near_west = [issue(f"w{n}", "waste", 43.698 + n * 0.001, -79.468) for n in range(2)]
    vehicles, home = dispatch.cluster("sanitation", near_east + near_west, 2)
    assert {home[i.id].id for i in near_east} == {"ts-commissioners"}
    assert {home[i.id].id for i in near_west} == {"ts-ingram"}
    assert sorted(v.facility.id for v in vehicles) == ["ts-commissioners", "ts-ingram"]
    # One truck: the busier station stays open and takes everything.
    vehicles, home = dispatch.cluster("sanitation", near_east + near_west, 1)
    assert [v.facility.id for v in vehicles] == ["ts-commissioners"]
    assert {f.id for f in home.values()} == {"ts-commissioners"}


def test_share_respects_count_and_minimum():
    assert dispatch._share(5, {"a": 100, "b": 10}) == {"a": 4, "b": 1}
    assert sum(dispatch._share(3, {"a": 1, "b": 1, "c": 1}).values()) == 3


def test_plan_keeps_each_run_local(monkeypatch):
    jobs = [issue("e1", "waste", 43.655, -79.345, 5), issue("e2", "waste", 43.656, -79.346),
            issue("w1", "waste", 43.699, -79.469), issue("p1", "pavement", 43.662, -79.342, 4),
            issue("z1", "work_zone", 43.661, -79.341), issue("g1", "graffiti", 43.65, -79.38)]
    monkeypatch.setattr(store, "canonical_issues", lambda *a, **k: jobs)
    plan = asyncio.run(dispatch.plan({"sanitation": 2, "roads": 1, "inspection": 1}))
    assert plan.solver == "fallback"
    by_id = {i.id: i for i in jobs}
    for route in plan.routes:
        for stop in route.stops:
            assert dispatch.CREW_FOR[by_id[stop].category] == route.crew
        if route.stops:
            assert route.path[0] == route.depot == route.path[-1]
            assert route.maps_urls and route.brief and route.depot_label in route.brief
    san = {r.facility_id: r.stops for r in plan.routes if r.crew == "sanitation"}
    assert sorted(san["ts-commissioners"]) == ["e1", "e2"] and san["ts-ingram"] == ["w1"]
    assert plan.unassigned == ["g1"] and "No crew" in plan.unassigned_reasons["g1"]
    assert {f.id for f in plan.facilities} >= {"ts-commissioners", "ts-ingram"}
    # The dashcam work zone is a road alert, but the crew sent to inspect it is not warned about it.
    assert any(h.id == "z1" and h.source == "dashcam" for h in plan.hazards)
    assert not any(w.hazard_id == "z1" for r in plan.routes if "z1" in r.stops for w in r.warnings)


def test_steer_takes_the_alternative_around_a_closure(monkeypatch):
    a, b = (43.650, -79.380), (43.650, -79.370)
    blocked = [a, (43.650, -79.375), b]                      # straight along the closed street
    detour = [a, (43.653, -79.380), (43.653, -79.370), b]    # one block north
    closure = Hazard(id="city:x", source="city", kind="ROAD_CLOSED", label="Main St closed", lat=43.650,
                     lon=-79.375, path=[(43.650, -79.376), (43.650, -79.374)], severity=5)
    monkeypatch.setattr(config, "ROUTING_URL", "http://osrm.test")

    async def fake_route(points, alternatives=False):
        fast = roads.Candidate(blocked, 3, 0.8, [blocked])
        return [fast, roads.Candidate(detour, 5, 1.2, [detour])] if alternatives else [fast]
    monkeypatch.setattr(roads, "route", fake_route)
    result = asyncio.run(paths.steer([a, b], [closure], paths.Budget(3)))
    assert result.path == detour and result.source == "road" and result.minutes == 5
    assert [(w.hazard_id, w.avoided) for w in result.warnings] == [("city:x", True)]


def test_maps_urls_chain_long_routes():
    points = [(43.6 + n * 0.001, -79.4) for n in range(15)]
    urls = roads.maps_urls(points)
    assert len(urls) == 2
    assert "origin=43.600000,-79.400000" in urls[0] and "destination=43.609000,-79.400000" in urls[0]
    assert "origin=43.609000,-79.400000" in urls[1] and "destination=43.614000,-79.400000" in urls[1]


def test_crossing_a_closed_street_is_not_using_it():
    closure = Hazard(id="city:y", source="city", kind="ROAD_CLOSED", label="Bay St closed", lat=43.650, lon=-79.380,
                     path=[(43.648, -79.380), (43.652, -79.380)], severity=5)
    along = [(43.647, -79.380), (43.653, -79.380)]
    across = [(43.650, -79.385), (43.650, -79.375)]
    assert hazards.hits(along, [closure]) == [closure]
    assert hazards.hits(across, [closure]) == []


@pytest.mark.parametrize("row,day,expected", [
    ({"scheduleEveryday": "00:00-23:59"}, "Monday", True),
    ({"scheduleEveryday": "21:00-05:00"}, "Monday", False),          # overnight only: off during the day shift
    ({"scheduleEveryday": "07:00-19:00"}, "Sunday", True),
    ({"scheduleMonday": "09:00-15:00", "scheduleTuesday": "09:00-15:00"}, "Saturday", False),
    ({"scheduleMonday": "09:00-15:00"}, "Monday", True),
    ({}, "Monday", True),
])
def test_in_shift(row, day, expected):
    assert hazards.in_shift(row, day) is expected


def test_steer_detours_through_a_parallel_street_when_there_are_no_alternatives(monkeypatch):
    a, b = (43.650, -79.380), (43.650, -79.370)
    blocked = [a, (43.650, -79.375), b]
    closure = Hazard(id="city:x", source="city", kind="ROAD_CLOSED", label="Main St closed", lat=43.650,
                     lon=-79.375, path=[(43.650, -79.376), (43.650, -79.374)], severity=5)
    north, south = paths.vias(closure)
    assert north[0] > 43.651 and south[0] < 43.649 and abs(north[1] + 79.375) < 1e-6   # a block either side
    monkeypatch.setattr(config, "ROUTING_URL", "http://osrm.test")

    async def fake_route(points, alternatives=False):
        if len(points) == 3:                                  # via a detour point: off the closed street
            path = [a, (points[1][0], -79.380), points[1], (points[1][0], -79.370), b]
            return [roads.Candidate(path, 6, 1.4, [path])]
        return [roads.Candidate(blocked, 3, 0.8, [blocked])]    # OSRM offers no alternative
    monkeypatch.setattr(roads, "route", fake_route)
    result = asyncio.run(paths.steer([a, b], [closure], paths.Budget(3)))
    assert result.minutes == 6 and result.alternatives == 2
    assert [(w.hazard_id, w.avoided) for w in result.warnings] == [("city:x", True)]


def test_batches_split_bases_under_the_solver_limit():
    yards = {f.id: f for f in dispatch.facilities.for_crew("markings")}
    jobs = [issue(f"j{n}", "markings", 43.65, -79.38) for n in range(9)]
    home = {i.id: yards[["yard-east", "yard-east", "yard-east", "yard-east", "yard-east",
                         "yard-west", "yard-west", "yard-north", "yard-north"][n]] for n, i in enumerate(jobs)}
    groups, over = dispatch.batches(jobs, home, limit=4)
    assert over == ["j4"]                                   # the east yard keeps its worst 4
    assert sorted(map(sorted, groups)) == [["yard-east"], ["yard-north", "yard-west"]]


def test_a_category_over_the_limit_is_still_routed(monkeypatch):
    jobs = [issue(f"e{n}", "markings", 43.66, -79.34) for n in range(3)] + \
           [issue(f"w{n}", "markings", 43.667, -79.44) for n in range(3)]
    monkeypatch.setattr(store, "canonical_issues", lambda *a, **k: jobs)
    monkeypatch.setattr(dispatch, "MAX_JOBS", 3)
    monkeypatch.setattr(dispatch.batches, "__defaults__", (3,))
    plan = asyncio.run(dispatch.plan({"markings": 2}))
    assert sorted(s for r in plan.routes for s in r.stops) == sorted(i.id for i in jobs)
    assert plan.unassigned == []
