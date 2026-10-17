"""Planning zones, offline: wards, drawn zones, point-in-polygon and zone-focused plans."""
import asyncio
from datetime import datetime, timezone
import json

import pytest

from app import config, main, store
from app.models import Facility, IssueRecord, WorkOrder
from app.planning import cuopt, dispatch, facilities, triage, zones

SQUARE = [(43.64, -79.40), (43.64, -79.37), (43.66, -79.37), (43.66, -79.40)]
YARD = Facility(id="yard", label="Yard", kind="road_yard", crews=["roads"], lat=43.70, lon=-79.45, source="t",
                vehicles={"roads": 2})


def issue(id, lat, lon, severity=3, pinned=False):
    i = IssueRecord(id=id, video_id="v", t=0, category="pavement", severity=severity, confidence=0.9,
                    description=f"pothole {id}", frame_url="", bbox=None, lat=lat, lon=lon,
                    work_order=WorkOrder(repair="fix", crew="roads", minutes=30, equipment=[], urgency="soon"),
                    source="corpus", frame_key="", created_at=datetime.now(timezone.utc))
    i.pinned = pinned
    return i


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    zones._invalidate()
    yield tmp_path
    zones._invalidate()


@pytest.fixture
def offline(monkeypatch, state):
    monkeypatch.setattr(config, "ROUTING_URL", "off")
    monkeypatch.setattr(config, "ROAD_RESTRICTIONS_URL", "off")
    monkeypatch.setattr(facilities, "load", lambda: (YARD,))

    async def no(*a):
        raise RuntimeError("offline")
    monkeypatch.setattr(triage, "triage_with_model", no)
    monkeypatch.setattr(cuopt, "solve", no)


def test_point_in_polygon():
    assert zones.inside((43.65, -79.38), SQUARE)
    assert not zones.inside((43.67, -79.38), SQUARE)
    assert not zones.inside((43.65, -79.41), SQUARE)
    concave = [(0, 0), (0, 4), (4, 4), (4, 0), (2, 2)]            # (lat, lon): a notch cut in from the lon = 0 side
    assert zones.inside((1, 3), concave) and not zones.inside((2, 1), concave)


def test_wards_are_the_citys_25_and_find_real_places():
    wards = zones.wards()
    assert len(wards) == 25 and all(w.kind == "ward" and w.source_url for w in wards)
    assert "Spadina-Fort York" in zones.ward_of((43.6414, -79.40706)).label        # Wellington Yard
    assert zones.ward_of((43.80316, -79.33729)).code in {17, 22}                     # Victoria Park transfer station
    assert zones.ward_of((44.0, -79.0)) is None                                       # outside the city


def test_drawn_zone_crud_persists(state):
    z = zones.add("Queen West blitz", SQUARE + [SQUARE[0]])                          # a closed ring is accepted
    assert z.kind == "custom" and len(z.polygons[0]) == 4
    on_disk = json.loads((state / "zones.json").read_text())
    assert on_disk["added"][0]["id"] == z.id
    zones._invalidate()                                                               # as after a restart
    assert zones.get(z.id).label == "Queen West blitz"
    assert zones.update(z.id, label="Renamed").label == "Renamed"
    with pytest.raises(KeyError):
        zones.remove("ward-10")                                                       # wards are read-only
    with pytest.raises(ValueError):
        zones.add("Ottawa", [(45.4, -75.7), (45.5, -75.7), (45.5, -75.6)])
    zones.remove(z.id)
    assert zones.get(z.id) is None and len(zones.load()) == 25
    # and through the API
    made = main.add_zone(main.ZoneInput(label="API zone", polygon=SQUARE))
    assert main.remove_zone(made.id) == {"removed": made.id}


def test_plan_routes_only_jobs_in_the_focus_and_flags_pinned_outside(offline, monkeypatch):
    jobs = [issue("in1", 43.65, -79.38), issue("in2", 43.655, -79.39, 4), issue("out", 43.70, -79.40, 5),
            issue("pin-out", 43.72, -79.42, 1, pinned=True), issue("pin-in", 43.645, -79.38, 1, pinned=True)]
    monkeypatch.setattr(store, "canonical_issues", lambda *a, **k: jobs)
    plan = asyncio.run(dispatch.plan(days=1, min_severity=3, polygon=SQUARE))
    routed = {s for r in plan.routes for s in r.stops}
    assert routed == {"in1", "in2", "pin-in"}                        # crews come from the yard, outside the zone
    assert plan.zones == ["drawn"] and plan.outside_zone == 2
    flagged = {d.issue_id: d for d in plan.triage.decisions}
    assert flagged["pin-out"].reason == dispatch.OUTSIDE and flagged["pin-out"].decision == "defer"
    assert "out" not in flagged and "pin-out" in plan.deferred
    r = next(r for r in plan.routes if r.stops)
    assert r.depot == (YARD.lat, YARD.lon) and r.path[0] == r.path[-1]
    # a saved zone works the same way, and an unknown id means the whole city
    z = zones.add("Square", SQUARE)
    plan = asyncio.run(dispatch.plan(days=1, min_severity=3, zones=[z.id]))
    assert plan.zones == [z.id] and plan.zone_labels == ["Square"] and plan.outside_zone == 2
    plan = asyncio.run(dispatch.plan(days=1, min_severity=3, zones=["nope"]))
    assert plan.zones == [] and plan.outside_zone == 0
