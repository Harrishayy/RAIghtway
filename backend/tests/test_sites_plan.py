"""Sites, triage and multi-day round trips, offline: cuOpt, OSRM, Nemotron and the city feed are stubbed."""
import asyncio
from datetime import datetime, timezone
import json

import pytest

from app import config, main, store
from app.models import Facility, IssueRecord, WorkOrder
from app.planning import cuopt, dispatch, facilities, triage

YARD = Facility(id="yard", label="Test yard", kind="road_yard", crews=["roads", "inspection"], lat=43.66, lon=-79.34,
                source="test", vehicles={"roads": 1})
STATION = Facility(id="station", label="Test station", kind="transfer_station", crews=["sanitation"], lat=43.70,
                   lon=-79.47, source="test", vehicles={"sanitation": 1})


def issue(id, category="pavement", lat=43.661, lon=-79.341, severity=3, minutes=60):
    crew = {"pavement": "roads", "waste": "sanitation", "work_zone": "inspection", "graffiti": "graffiti"}[category]
    return IssueRecord(id=id, video_id="v", t=0, category=category, severity=severity, confidence=0.9,
                       description=f"{category} {id}", frame_url="", bbox=None, lat=lat, lon=lon,
                       work_order=WorkOrder(repair="fix", crew=crew, minutes=minutes, equipment=[], urgency="soon"),
                       source="corpus", frame_key="", created_at=datetime.now(timezone.utc))


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setattr(config, "FACILITIES_FILE", None)
    facilities.load.cache_clear()
    yield tmp_path
    facilities.load.cache_clear()


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setattr(config, "ROUTING_URL", "off")
    monkeypatch.setattr(config, "ROAD_RESTRICTIONS_URL", "off")
    monkeypatch.setattr(facilities, "load", lambda: (YARD, STATION))

    async def no_model(facts):
        raise RuntimeError("offline")
    monkeypatch.setattr(triage, "triage_with_model", no_model)

    async def no_cuopt(payload):
        raise cuopt.CuOptError("offline")
    monkeypatch.setattr(cuopt, "solve", no_cuopt)


# ---- Sites ----

def test_bundled_sites_are_real_toronto_sites_with_sources(state):
    sites = facilities.load()
    assert len(sites) >= 15
    kinds = {f.kind for f in sites}
    assert {"transfer_station", "collection_yard", "road_yard", "cleaning_yard"} <= kinds
    for f in sites:
        facilities.check(f)                                   # inside Toronto, has crews, sane truck counts
        assert f.source and f.address and (f.source_url or f.assumed)
    crews = {c for f in sites for c in f.crews}
    assert crews == {"roads", "graffiti", "markings", "signage", "inspection", "sanitation"}


def test_site_edits_persist_and_reset(state):
    bundled = facilities.load()
    first = bundled[0]
    added = facilities.add({"label": "Booth yard", "kind": "road_yard", "crews": ["roads"], "lat": 43.66,
                            "lon": -79.34, "vehicles": {"roads": 3, "sanitation": 2}})
    assert added.custom and added.id.startswith("site-booth-yard") and added.vehicles == {"roads": 3}
    facilities.update(first.id, {"vehicles": {first.crews[0]: 4}})
    facilities.remove(bundled[1].id)
    on_disk = json.loads((state / "facilities.json").read_text())
    assert on_disk["removed"] == [bundled[1].id] and on_disk["added"][0]["id"] == added.id

    facilities.load.cache_clear()                             # as after a restart
    ids = [f.id for f in facilities.load()]
    assert added.id in ids and bundled[1].id not in ids
    assert facilities.get(first.id).vehicles == {first.crews[0]: 4}
    facilities.remove(added.id)
    assert facilities.get(added.id) is None

    assert [f.id for f in facilities.reset()] == [f.id for f in bundled]
    assert not (state / "facilities.json").exists()


def test_sites_outside_toronto_or_without_crews_are_refused(state):
    with pytest.raises(ValueError):
        facilities.add({"label": "Ottawa", "kind": "road_yard", "crews": ["roads"], "lat": 45.42, "lon": -75.69})
    with pytest.raises(ValueError):
        facilities.add({"label": "Nobody", "kind": "road_yard", "crews": [], "lat": 43.66, "lon": -79.34})
    with pytest.raises(KeyError):
        facilities.remove("no-such-site")


def test_site_api_crud(state):
    created = main.add_facility(main.FacilityInput(label="Test depot", kind="cleaning_yard", crews=["graffiti"],
                                                   lat=43.65, lon=-79.38, vehicles={"graffiti": 2}))
    assert created.vehicles == {"graffiti": 2}
    changed = main.update_facility(created.id, main.FacilityInput(vehicles={"graffiti": 0}))
    assert changed.vehicles == {"graffiti": 0}
    assert main.remove_facility(created.id) == {"removed": created.id}
    with pytest.raises(main.HTTPException) as err:
        main.remove_facility(created.id)
    assert err.value.status_code == 404
    with pytest.raises(main.HTTPException) as err:
        main.add_facility(main.FacilityInput(label="No place"))
    assert err.value.status_code == 422


# ---- Triage ----

def test_rules_triage_floor_capacity_and_bundling():
    cap = {"roads": 120}
    jobs = [issue("s5", severity=5, minutes=90), issue("s4", severity=4, minutes=60, lat=43.70),
            issue("s3", severity=3, minutes=60, lat=43.71), issue("s1", severity=1, minutes=15, lat=43.6611),
            issue("s1far", severity=1, minutes=15, lat=43.75), issue("w", "waste", severity=5)]
    out = triage.rules(jobs, 1, cap, days=1)
    assert out["s5"].decision == "today"                      # hazards go today, even past the estimate
    assert out["s4"].decision == "defer"                      # 90 + 60 > 120 and one day only
    assert out["s1"].decision == "today" and "Bundled" in out["s1"].reason   # next to the S5 job
    assert out["s1far"].decision == "defer"                   # routine, alone, and one day only
    assert out["w"].decision == "defer" and "No sanitation trucks" in out["w"].reason
    two = triage.rules(jobs, 3, cap, days=2)
    assert two["s4"].decision == "later" and two["s1"].decision == "defer"   # below the S3+ floor
    assert "floor" in two["s1"].reason


def test_clamp_keeps_the_model_inside_the_rules():
    cap = {"roads": 120}
    jobs = [issue("s5", severity=5), issue("s4", severity=4, lat=43.70), issue("s3a", lat=43.71),
            issue("s3b", lat=43.72), issue("low", severity=1, lat=43.75, minutes=10), issue("floor", severity=2)]
    base = triage.rules(jobs, 3, cap, days=2)
    proposed = {"s5": ("defer", "x"), "s4": ("defer", "not needed"), "s3a": ("today", "busy road"),
                "s3b": ("today", "school"), "floor": ("today", "x"), "ghost": ("today", "x")}
    out, clamped = triage.clamp(proposed, jobs, base, 3, cap, days=2)
    assert out["s5"].decision == "today" and out["s5"].by == "rule"
    assert out["s4"].decision == "later" and out["s4"].by == "rule"
    assert out["floor"].decision == "defer"
    assert "ghost" not in out
    today = [k for k, d in out.items() if d.decision == "today"]
    assert sum(60 for k in today if k != "s5") <= cap["roads"] * triage.TODAY_SLACK
    assert out["s3a"].by == "model" and out["s3a"].reason == "busy road"
    assert clamped >= 3
    # A routine job the model sends today on its own is moved back.
    out2, _ = triage.clamp({"low": ("today", "quick")}, jobs, triage.rules(jobs, 1, cap, 2), 1, cap, days=2)
    assert out2["low"].decision == "later" and out2["low"].by == "rule"


def test_decide_names_the_model_or_the_rules(monkeypatch):
    jobs = [issue("a", severity=4), issue("b", severity=2, lat=43.7)]

    async def reply(facts):
        assert facts["severity_floor"] == 1 and facts["crews"]["roads"]["trucks_per_day"] == 1
        return {"rationale": "Potholes first.", "by_crew": {"roads": "One truck."},
                "decisions": [{"issue_id": "a", "decision": "today", "reason": "Lane hazard"},
                              {"issue_id": "b", "decision": "defer", "reason": "Cosmetic"}]}
    monkeypatch.setattr(triage, "triage_with_model", reply)
    t = asyncio.run(triage.decide(jobs, 1, {"roads": 1}, 2))
    assert t.model == "nemotron-lightning" and t.rationale == "Potholes first." and t.by_crew == {"roads": "One truck."}
    assert {d.issue_id: (d.decision, d.by) for d in t.decisions} == {"a": ("today", "model"), "b": ("defer", "model")}

    async def broken(facts):
        raise RuntimeError("no key")
    monkeypatch.setattr(triage, "triage_with_model", broken)
    t = asyncio.run(triage.decide(jobs, 1, {"roads": 1}, 2))
    assert t.model == "rules" and t.model_name is None and len(t.decisions) == 2
    assert asyncio.run(triage.decide(jobs, 1, {"roads": 1}, 1, use_model=False)).model == "rules"


# ---- Round trips ----

def _ctx(jobs):
    vehicles = [dispatch.Vehicle("roads-1", "roads", YARD), dispatch.Vehicle("roads-2", "roads", YARD)]
    home = {i.id: YARD for i in jobs}
    return asyncio.run(dispatch._context("roads", vehicles, home, jobs)), vehicles


def test_payload_starts_and_ends_each_truck_at_its_site(offline):
    jobs = [issue("a", severity=5), issue("b", lat=43.67)]
    ctx, vehicles = _ctx(jobs)
    locs = [ctx.index["yard"], ctx.index["a"], ctx.index["b"]]
    p = dispatch.payload(jobs, vehicles, locs, ctx, today={"a"})
    fleet, tasks = p["fleet_data"], p["task_data"]
    assert fleet["vehicle_locations"] == [[0, 0], [0, 0]]
    assert fleet["vehicle_time_windows"] == [[0, 480], [0, 480]]
    assert fleet["vehicle_break_time_windows"] == [[[210, 300], [210, 300]]]
    assert fleet["vehicle_break_durations"] == [[30, 30]] and fleet["vehicle_break_locations"] == [1, 2]
    assert tasks["task_locations"] == [1, 2] and tasks["service_times"] == [60, 60]
    assert tasks["prizes"] == [1000 + dispatch.TODAY_BONUS, 250]
    assert tasks["order_vehicle_match"] == [{"order_id": 0, "vehicle_ids": [0, 1]}, {"order_id": 1, "vehicle_ids": [0, 1]}]
    assert len(p["cost_matrix_data"]["data"]["0"]) == 3


def test_parse_and_schedule_a_cuopt_answer(offline):
    jobs = [issue("a", severity=5), issue("b", lat=43.67)]
    ctx, vehicles = _ctx(jobs)
    locs = [ctx.index["yard"], ctx.index["a"], ctx.index["b"]]
    leg = ctx.matrix[ctx.index["a"]][ctx.index["b"]]
    answer = {"vehicle_data": {"roads-1": {
        "task_id": ["Depot", "a", "Break", "b", "Depot"],
        "type": ["Depot", "Delivery", "Break", "Delivery", "Depot"],
        "arrival_stamp": [0.0, 2.0, 210.0, 240.0 + leg, 300.0 + leg + 20],
        "route": [0, 1, 1, 2, 0]}}}
    [td] = dispatch.parse(answer, jobs, vehicles, locs, day=1)
    assert [x.kind for x in td.visits] == ["job", "break", "job"] and td.solver == "cuopt" and td.lunch == "solver"
    entries, totals = dispatch.schedule(td, ctx)
    assert [e.kind for e in entries] == ["depart", "job", "break", "job", "return"]
    assert (entries[0].lat, entries[0].lon) == (entries[-1].lat, entries[-1].lon) == (YARD.lat, YARD.lon)
    assert entries[1].arrive_min == 2 and entries[1].depart_min == 62
    assert entries[2].arrive_min == 210 and entries[2].idle_min == 148 and entries[2].depart_min == 240
    assert totals.jobs == 2 and totals.work_min == 120 and totals.break_min == 30 and totals.lunch == "solver"
    assert totals.back_min == entries[-1].arrive_min >= 300
    assert totals.idle_min == totals.back_min - totals.drive_min - totals.work_min - totals.break_min


def test_days_roll_over_with_the_worst_first(offline, monkeypatch):
    # One truck, 3 h jobs: two fit a day. Five jobs over two days leave the routine one unassigned.
    jobs = [issue("s5", severity=5, minutes=180), issue("s4", severity=4, minutes=180, lat=43.662),
            issue("s3", severity=3, minutes=180, lat=43.663), issue("s2", severity=2, minutes=180, lat=43.664),
            issue("s1", severity=1, minutes=180, lat=43.665)]
    monkeypatch.setattr(store, "canonical_issues", lambda *a, **k: jobs)
    plan = asyncio.run(dispatch.plan(days=2, triage=False))
    assert plan.solver == "fallback" and plan.triage.model == "rules" and plan.horizon_days == 2
    by_day = {r.day: r for r in plan.routes if r.stops}
    assert set(by_day) == {1, 2}
    assert set(by_day[1].stops) == {"s5", "s4"}               # severity 5 and 4 land on day 1
    assert by_day[2].crew_id == "roads-1/d2" and by_day[2].vehicle_id == "roads-1"
    for r in by_day.values():
        assert r.schedule[0].kind == "depart" and r.schedule[-1].kind == "return"
        assert r.path[0] == r.path[-1] == r.depot
        assert (r.totals.lunch == "reserved") == any(e.kind == "break" for e in r.schedule)
        assert r.totals.back_min <= dispatch.SHIFT_MIN and f"Day {r.day}" in r.brief
    assert by_day[1].totals.lunch == "reserved" and "Lunch" in by_day[1].brief   # the fallback reserves lunch
    assert by_day[2].totals.lunch == "none" and by_day[2].totals.back_min < 210   # back before lunch
    planned = {s for r in plan.routes for s in r.stops}
    left = {"s3", "s2", "s1"} - planned
    assert set(plan.unassigned) | set(plan.deferred) >= left
    assert [d.day for d in plan.days] == [1, 2] and plan.days[0].jobs == 2
    sites = {s.facility_id: s for s in plan.sites}
    assert sites["yard"].trucks == {"roads": 1} and sites["yard"].jobs == 3 and sites["station"].jobs == 0


def test_site_override_and_severity_floor(offline, monkeypatch):
    jobs = [issue("hi", severity=4), issue("lo", severity=2, lat=43.67), issue("w", "waste", lat=43.701, lon=-79.47)]
    monkeypatch.setattr(store, "canonical_issues", lambda *a, **k: jobs)
    plan = asyncio.run(dispatch.plan(sites={"yard": {"roads": 2}, "station": {"sanitation": 0}}, min_severity=3))
    assert plan.min_severity == 3
    assert sorted(plan.deferred) == ["lo", "w"]
    assert [s for r in plan.routes for s in r.stops] == ["hi"]
    assert {r.vehicle_id for r in plan.routes} == {"roads-1", "roads-2"}      # day 1 keeps idle trucks
