"""Report facts come from code; Nemotron only writes prose, and the template still works. Offline."""
import asyncio
from datetime import datetime, timezone

from app import store
from app.models import BBox, IssueRecord, Report, VideoRecord, WorkOrder
from app.planning import report


def issue(id, category="pavement", severity=3, lat=43.65, lon=-79.38, verdict=None, dup=None, template=False,
          model="cosmos3-reason"):
    repair = "Inspect and repair the reported pavement issue." if template else "Cold-patch the pothole"
    return IssueRecord(id=id, video_id="corpus-set01-video_0001", t=12.0, category=category, severity=severity,
                       confidence=0.8, description=f"{category} {id}", frame_url="", bbox=BBox(x=0, y=0, w=.1, h=.1),
                       lat=lat, lon=lon, duplicate_of=dup, source="corpus", frame_key="",
                       created_at=datetime.now(timezone.utc), severity_model=model, verdict=verdict,
                       severity_reason=f"reason {id}",
                       work_order=None if dup else WorkOrder(repair=repair, crew=report.CREW_FOR[category], minutes=60,
                                                             equipment=["Asphalt", "asphalt ", "cones"],
                                                             urgency="soon"))


def _world(monkeypatch, issues):
    video = VideoRecord(id="corpus-set01-video_0001", filename="set01/video_0001", source="corpus", status="done",
                        progress=1, drive="set01/video_0001", created_at=datetime.now(timezone.utc))
    canonical = [i for i in issues if not i.duplicate_of]
    monkeypatch.setattr(store, "canonical_issues", lambda *a, **k: canonical)
    monkeypatch.setattr(store, "all_issues", lambda: issues)
    monkeypatch.setattr(store, "list_videos", lambda: [video])
    monkeypatch.setattr(report, "_places", _no_places)


async def _no_places(points, budget=0):
    return {}


def test_template_report_has_code_facts(monkeypatch):
    issues = [issue("a", severity=5), issue("b", severity=4, lat=43.6501), issue("c", severity=2, template=True),
              issue("d", category="signage", severity=1, verdict="rejected"),
              issue("e", severity=3, dup="a", model=None)]
    _world(monkeypatch, issues)

    async def no_model(facts):
        return None, ""
    monkeypatch.setattr(report, "_nemotron", no_model)
    r = asyncio.run(report.regenerate())
    assert r.stats.open == 3 and r.stats.today == 1 and r.stats.this_week == 1 and r.stats.rejected == 1
    assert [p.id for p in r.priorities] == ["a", "b"] and r.priorities[0].deadline == "today"
    assert r.priorities[0].drive == "set01/video_0001" and r.priorities[0].severity_reason == "reason a"
    [pave, sign] = r.sections
    assert (pave.category, pave.open, pave.by_severity["5"], pave.severe, sign.open, sign.rejected) == \
        ("pavement", 3, 1, 2, 0, 1)
    assert [(e.label, e.count) for e in pave.equipment] == [("Asphalt", 2), ("cones", 2)]     # rolled up, template orders skipped
    assert pave.approach == report.APPROACH["pavement"]
    assert r.hotspots and r.hotspots[0].issues == 3 and r.hotspots[0].max_severity == 5
    p = r.provenance
    assert (p.report_model, p.sightings_total, p.canonical, p.duplicates_merged, p.unrated, p.template_work_orders) == \
        ("template", 5, 4, 1, 1, 1)
    assert any("not to be a defect" in c for c in p.caveats)
    assert r.counts["pavement"] == 3 and "signage" not in r.counts                  # rejected stay out of counts
    Report.model_validate(r.model_dump(mode="json"))


def test_nemotron_writes_prose_only(monkeypatch):
    from app.models import Plan, Route
    _world(monkeypatch, [issue("a", severity=5), issue("b", severity=4, lat=43.6501)])
    monkeypatch.setattr(store, "latest_plan", lambda: Plan(
        routes=[Route(crew_id="roads-1", crew="roads", stops=["a"], eta_min=[5], path=[])], unassigned=["b"],
        solver="cuopt", solve_ms=10))

    async def model(facts):
        assert facts["open_issues"] == 2 and "pavement" in facts["categories"]
        return report._ReportReply(summary="Two hazards.", crews={"roads": 99}, rationale="Fix a first.",
                                   sections={"pavement": "Patch a today."}, hotspots={"H1": "Two potholes."},
                                   crew_plan="One truck today."), \
            report.nemotron.ULTRA
    monkeypatch.setattr(report, "_nemotron", model)
    r = asyncio.run(report.regenerate())
    assert (r.summary, r.model, r.provenance.report_model) == ("Two hazards.", "Nemotron 3 Ultra", "nemotron-ultra")
    assert r.crews["roads"] <= 1 + 2                                               # clamped to baseline + 2
    assert r.sections[0].approach == "Patch a today." and r.hotspots[0].note == "Two potholes."
    assert r.stats.open == 2                                                       # numbers are not the model's
    assert (r.crew_plan.note, r.crew_plan.jobs, r.crew_plan.unassigned_total) == ("One truck today.", 1, 1)


def test_old_report_without_detail_still_validates():
    old = {"generated_at": "2026-10-17T11:15:59Z", "summary": "s", "counts": {"pavement": 1},
           "crews": {"roads": 1}, "rationale": "r"}
    r = Report.model_validate(old)
    assert r.sections == [] and r.stats is None and r.provenance is None


def test_crew_plan_summary_reads_new_and_old_plans():
    from app.models import Facility, Plan, Route
    assert report._crew_plan(None, {}) is None
    yard = Facility(id="y1", label="Yard", kind="yard", crews=["roads"], lat=43.6, lon=-79.4, source="test")
    old = Plan(routes=[Route(crew_id="roads-1", crew="roads", stops=["a", "b"], eta_min=[10, 40], path=[],
                             facility_id="y1", distance_km=12.5)],
               unassigned=["c"], unassigned_reasons={"c": "Shift full"}, solver="cuopt", solve_ms=3000,
               facilities=[yard], matrix_source="road")
    cp = report._crew_plan(old, {"c": 4}, {"a": 30, "b": 60})
    assert (cp.solver, cp.matrix_source, cp.jobs, cp.trucks, cp.unassigned_total) == ("cuopt", "road", 2, 1, 1)
    assert cp.days[0].jobs == 2 and cp.days[0].km == 12.5 and cp.triage_model is None
    assert (cp.days[0].work_h, cp.days[0].drive_h) == (1.5, 0.2)              # drive = 40 - 30 min of work before
    assert cp.sites[0].trucks == {"roads": 1} and cp.unassigned[0].reason == "Shift full"
    assert cp.unassigned[0].severity == 4
    # A newer plan, as a dict with the multi-day and triage fields.
    new = {"routes": [{"crew_id": "roads-1/d1", "crew": "roads", "stops": ["a"], "day": 1, "vehicle_id": "roads-1",
                       "facility_id": "y1", "totals": {"drive_min": 30, "work_min": 60, "back_min": 400,
                                                       "distance_km": 9.0}},
                      {"crew_id": "roads-1/d2", "crew": "roads", "stops": ["b"], "day": 2, "vehicle_id": "roads-1",
                       "facility_id": "y1", "totals": {"drive_min": 20, "work_min": 45, "back_min": 300}}],
           "unassigned": [], "solver": "fallback", "solve_ms": 5,
           "facilities": [{"id": "y1", "label": "Yard", "kind": "road_yard", "crews": ["roads"], "vehicles": {"roads": 2}}],
           "triage": {"model": "rules", "rationale": "r", "decisions": [
               {"issue_id": "z", "crew": "roads", "severity": 2, "decision": "defer", "reason": "low", "by": "rule"},
               {"issue_id": "a", "crew": "roads", "severity": 5, "decision": "today", "reason": "S5", "by": "rule"}]}}
    cp = report._crew_plan(new, {})
    assert [d.day for d in cp.days] == [1, 2] and cp.days[0].back_last == "14:40" and cp.days[0].drive_h == 0.5
    assert (cp.today, cp.deferred, cp.triage[0].issue_id, cp.triage_model) == (1, 1, "a", "rules")
    assert cp.sites[0].trucks == {"roads": 2} and cp.trucks == 1
