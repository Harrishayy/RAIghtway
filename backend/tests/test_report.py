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
    _world(monkeypatch, [issue("a", severity=5), issue("b", severity=4, lat=43.6501)])

    async def model(facts):
        assert facts["open_issues"] == 2 and "pavement" in facts["categories"]
        return report._ReportReply(summary="Two hazards.", crews={"roads": 99}, rationale="Fix a first.",
                                   sections={"pavement": "Patch a today."}, hotspots={"H1": "Two potholes."}), \
            report.nemotron.ULTRA
    monkeypatch.setattr(report, "_nemotron", model)
    r = asyncio.run(report.regenerate())
    assert (r.summary, r.model, r.provenance.report_model) == ("Two hazards.", "Nemotron 3 Ultra", "nemotron-ultra")
    assert r.crews["roads"] <= 1 + 2                                               # clamped to baseline + 2
    assert r.sections[0].approach == "Patch a today." and r.hotspots[0].note == "Two potholes."
    assert r.stats.open == 2                                                       # numbers are not the model's


def test_old_report_without_detail_still_validates():
    old = {"generated_at": "2026-10-17T11:15:59Z", "summary": "s", "counts": {"pavement": 1},
           "crews": {"roads": 1}, "rationale": "r"}
    r = Report.model_validate(old)
    assert r.sections == [] and r.stats is None and r.provenance is None
