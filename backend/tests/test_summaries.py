"""Drive summaries: grounded facts, the checks, one retry, the fact-built stand-in, the overlay and the backfill.
Offline: Nemotron, OSRM and the store are stubbed."""
import asyncio
from datetime import datetime, timezone

import pytest

from app import store
from app.ai import nemotron, summaries
from app.models import IssueRecord, TopicHit, VideoRecord


def video(id="corpus-set06-video_0001", drive="set06/video_0001", explanation=None, source=None):
    return VideoRecord(id=id, filename=drive, source="corpus", status="done", progress=1.0, drive=drive,
                       duration_s=600.0, explanation=explanation, explanation_source=source,
                       created_at=datetime.now(timezone.utc))


def issue(id, t, category="work_zone", severity=3, video_id="corpus-set06-video_0001", **kw):
    return IssueRecord(id=id, video_id=video_id, t=t, category=category, severity=severity, confidence=0.9,
                       description=f"{category} at {t}", frame_url="", bbox=None, lat=43.65, lon=-79.40 + t / 1e5,
                       source="corpus", frame_key="", created_at=datetime.now(timezone.utc), **kw)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(summaries.config, "STATE_DIR", str(tmp_path))
    monkeypatch.setattr(summaries, "_overlay", None)
    monkeypatch.setattr(summaries, "_answers", None)
    monkeypatch.setattr(summaries, "_streets", {})

    async def street(lat, lon):
        return "Queen Street West" if lon < -79.35 else None
    monkeypatch.setattr(summaries, "street_at", street)


TEMPLATE = ("This video contains 54 recorded maintenance findings: 5 graffiti. Template work orders were prepared "
            "for 0 new canonical issues; repair times and equipment need crew confirmation.")


def test_template_wording_is_classified_and_overlay_wins():
    v = video(explanation=TEMPLATE)
    assert summaries.effective(v) == (TEMPLATE, "template")
    assert summaries.effective(video(explanation="Cones on Queen St W at 08:50.")) == ("Cones on Queen St W at 08:50.", "nemotron")
    assert summaries.effective(video()) == (None, None)
    summaries.save(v.id, "Thirty work-zone findings on Queen St W, busiest 08:40.", "nemotron")
    summaries._overlay = None                                   # survives a restart: read back from disk
    served = summaries.apply(v)
    assert (served.explanation, served.explanation_source) == ("Thirty work-zone findings on Queen St W, busiest 08:40.", "nemotron")


def facts_for(issues, fleet=None):
    v = video()
    return asyncio.run(summaries.drive_facts(v, issues, fleet or {v.id: issues, "other": [issue("o1", 5, "markings", video_id="other")]}))


def test_facts_skip_rejected_and_find_what_stands_out():
    issues = [issue(f"w{k}", 500 + k * 5) for k in range(6)] + [issue("bad", 10, "pavement", 5, verdict="rejected"),
                                                               issue("sev", 520, "work_zone", 5)]
    facts = facts_for(issues)
    assert facts["findings"] == 7 and "pavement" not in facts["by_category_vs_fleet_avg"]
    assert facts["stands_out"][0]["category"] == "work_zone" and facts["stands_out"][0]["here"] == 7
    assert facts["most_severe"][0]["time"] == "08:40" and facts["most_severe"][0]["severity"] == 5
    assert facts["busiest_stretch"]["from"] == "08:20" and facts["streets"] == ["Queen Street West"]
    text = summaries.fact_summary(facts)
    assert "7 work zone findings" in text and "Queen Street West" in text and "08:40" in text
    assert not summaries.is_template(text)


def test_checks_name_each_problem():
    facts = facts_for([issue(f"w{k}", 500 + k * 5) for k in range(4)])
    good = "Work zones crowd Queen St W between 08:20 and 08:35, well above the fleet average."
    assert summaries.problems(good, facts, {}) == []
    assert any("opens with" in p for p in summaries.problems("This video shows cones on Queen St at 08:20.", facts, {}))
    assert any("template" in p for p in summaries.problems(TEMPLATE, facts, {}))
    assert any("street" in p for p in summaries.problems("Work zones crowd the road at 08:20.", facts, {}))
    assert any("time" in p for p in summaries.problems("Work zones crowd Queen St W.", facts, {}))
    assert any("reads too much like" in p for p in summaries.problems(good, facts, {"v2": good.replace("well", "far")}))


def test_rejected_summary_is_retried_with_reasons(monkeypatch):
    sent = []
    replies = iter(["This video shows work zones on Queen St at 08:20.", "Queen St W carries most work zones, 08:20–08:35."])

    async def chat(messages, schema, **k):
        sent.append([m["content"] for m in messages])
        return schema(summary=next(replies))
    monkeypatch.setattr(nemotron, "chat_json", chat)
    issues = [issue(f"w{k}", 500 + k * 5) for k in range(4)]
    text, source = asyncio.run(summaries.summarise_drive(video(), issues, {"a": issues}, {"v2": "Graffiti on Bloor St at 01:00."}))
    assert (text, source) == ("Queen St W carries most work zones, 08:20–08:35.", "nemotron")
    assert len(sent) == 2 and "Rejected" in sent[1][-1] and "Graffiti on Bloor St" in sent[1][-1]


def test_two_bad_replies_or_a_failure_give_the_fact_summary(monkeypatch):
    async def generic(messages, schema, **k):
        return schema(summary="The video shows faded markings, potholes and cones.")
    monkeypatch.setattr(nemotron, "chat_json", generic)
    issues = [issue(f"w{k}", 500 + k * 5) for k in range(4)]
    text, source = asyncio.run(summaries.summarise_drive(video(), issues, {"a": issues}, {}))
    assert source == "template" and "Queen Street West" in text

    async def down(*a, **k):
        raise RuntimeError("W&B down")
    monkeypatch.setattr(nemotron, "chat_json", down)
    assert asyncio.run(summaries.summarise_drive(video(), issues, {"a": issues}, {}))[1] == "template"


def test_backfill_regenerates_only_template_drives(monkeypatch):
    drives = [video("corpus-a", "set01/video_0001", TEMPLATE), video("corpus-b", "set01/video_0002", "Fine summary on King St at 01:00.")]
    monkeypatch.setattr(store, "list_videos", lambda: drives)
    monkeypatch.setattr(store, "get_video", lambda id: next(v for v in drives if v.id == id))
    monkeypatch.setattr(store, "issues_for_video", lambda id: [issue(f"{id}-{k}", 100 + k * 5, video_id=id) for k in range(4)])
    seen = []

    async def summarise(v, issues, fleet, others):
        seen.append((v.id, sorted(others)))
        return "Queen St W work zones at 01:40.", "nemotron"
    monkeypatch.setattr(summaries, "summarise_drive", summarise)

    async def run():
        first = summaries.start()
        assert first["total"] == 1 and first["running"]
        await summaries._task
    asyncio.run(run())
    assert seen == [("corpus-a", ["corpus-b"])]                 # the other drive's Nemotron summary must be avoided
    assert summaries.status()["results"] == [{"video_id": "corpus-a", "source": "nemotron"}]
    assert summaries.effective(drives[0]) == ("Queen St W work zones at 01:40.", "nemotron")


def test_search_answer_is_cached_and_never_raises(monkeypatch):
    calls = []

    async def chat(messages, schema, **k):
        calls.append(messages)
        return schema(answer="Cones on 2 drives. 1 is **logged**, 1 is not.")
    monkeypatch.setattr(nemotron, "chat_json", chat)
    hits = [TopicHit(video_id="v", start=530, end=540, score=1, similarity=0.34, caption="Orange cones narrow the lane.")]
    v = {"v": video("v")}
    assert asyncio.run(summaries.search_answer("cones", hits, {0: ["Work zone on Queen"]}, v)) == "Cones on 2 drives. 1 is logged, 1 is not."
    assert asyncio.run(summaries.search_answer("cones", hits, {0: ["Work zone on Queen"]}, v)).startswith("Cones")
    assert len(calls) == 1 and "Work zone on Queen" in calls[0][1]["content"]

    async def down(*a, **k):
        raise TimeoutError()
    monkeypatch.setattr(nemotron, "chat_json", down)
    assert asyncio.run(summaries.search_answer("debris", hits, {}, v)) == ""
    assert asyncio.run(summaries.search_answer("debris", [], {}, v)) == ""
