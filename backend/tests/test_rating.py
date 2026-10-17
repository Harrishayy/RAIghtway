"""Severity rating pass: reply parsing, Cosmos -> Nemotron fallback, rating rows on the store. Offline."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app import store
from app.ai import cosmos, nemotron, rating
from app.models import IssueRecord, WorkOrder


def issue(id, severity=2, duplicate_of=None, category="pavement", work_order=True):
    return IssueRecord(id=id, video_id="v", t=0, category=category, severity=severity, confidence=0.8,
                       description="pothole", frame_url="", bbox=None, lat=43.65, lon=-79.38,
                       duplicate_of=duplicate_of, source="corpus", frame_key="", created_at=datetime.now(timezone.utc),
                       work_order=WorkOrder(repair="Patch", crew="roads", minutes=60, equipment=[], urgency="routine")
                       if work_order else None)


def test_parse_rating_is_lenient_on_spelling_and_strict_on_meaning():
    r = cosmos._parse_rating({"observed": "Pothole in lane", "reason": "Deep pothole in the wheel path.",
                              "real": "yes", "severity": "4"}, "cosmos3-reason")
    assert (r.severity, r.verdict, r.model, r.reason) == (4, "confirmed", "cosmos3-reason", "Deep pothole in the wheel path.")
    r = cosmos._parse_rating({"observed": "Crisp crosswalk", "real": False, "severity": 1}, "cosmos3-reason")
    assert r.verdict == "rejected" and r.reason == "Crisp crosswalk"      # no reason: what it saw stands in
    for bad in ({"real": True, "reason": "x"}, {"real": True, "severity": 7, "reason": "x"},
                {"real": "maybe", "severity": 2, "reason": "x"}, {"real": True, "severity": 2}, ["not", "a", "dict"]):
        with pytest.raises((ValueError, TypeError)):
            cosmos._parse_rating(bad, "cosmos3-reason")


def _stub_views(monkeypatch, tmp_path):
    from app.pipeline import segment
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"\xff\xd8jpeg")
    monkeypatch.setattr(segment, "work_dir", lambda prefix="": tmp_path / "w")
    (tmp_path / "w").mkdir()
    monkeypatch.setattr(segment, "rating_views", lambda jpg, bbox, a, b: (str(frame), str(frame)))
    return str(frame)


def test_rate_prefers_cosmos(monkeypatch, tmp_path):
    frame = _stub_views(monkeypatch, tmp_path)
    sent = []

    async def cosmos_ok(content):
        sent.append(content)
        return '{"observed":"pothole","reason":"Pothole in lane.","real":true,"severity":4}'
    monkeypatch.setattr(cosmos, "_request", cosmos_ok)
    r = asyncio.run(cosmos.rate(frame, "pavement", "pothole"))
    assert (r.model, r.severity) == ("cosmos3-reason", 4)
    assert [p["type"] for p in sent[0]] == ["text", "image_url", "image_url"]   # boxed frame + close-up


def test_rate_falls_back_to_nemotron_then_none(monkeypatch, tmp_path):
    frame = _stub_views(monkeypatch, tmp_path)

    async def cosmos_down(content):
        raise RuntimeError("GPU endpoint down")

    async def nemo(messages, schema, model=None, timeout=None):
        assert model == nemotron.SUPER_VL
        assert sum(p["type"] == "image_url" for p in messages[0]["content"]) == 1   # Super-VL: one image
        return schema.model_validate({"observed": "crack", "reason": "Isolated crack.", "real": True, "severity": 2})
    monkeypatch.setattr(cosmos, "_request", cosmos_down)
    monkeypatch.setattr(nemotron, "chat_json", nemo)
    r = asyncio.run(cosmos.rate(frame, "pavement", "pothole"))
    assert (r.model, r.severity, r.verdict) == ("nemotron-super-vl", 2, "confirmed")

    async def nemo_down(*a, **k):
        raise RuntimeError("W&B down")
    monkeypatch.setattr(nemotron, "chat_json", nemo_down)
    assert asyncio.run(cosmos.rate(frame, "pavement", "pothole")) is None


def test_rate_issues_respects_budget_and_skips_missing_frames(monkeypatch, tmp_path):
    monkeypatch.setattr(rating, "frame_path", lambda id: None if id == "noframe" else "x.jpg")

    async def slow_or_fast(path, category, description, bbox=None):
        if description == "slow":
            await asyncio.sleep(5)
        return cosmos._parse_rating({"reason": "ok", "real": True, "severity": 3}, "cosmos3-reason")
    monkeypatch.setattr(cosmos, "rate", slow_or_fast)
    fast, slow, noframe = issue("fast"), issue("slow"), issue("noframe")
    slow.description = "slow"
    got = asyncio.run(rating.rate_issues([fast, slow, noframe], budget_s=0.2))
    assert set(got) == {"fast"}


def test_rating_rows_apply_revert_and_order():
    i = issue("a", severity=2)
    t0 = datetime.now(timezone.utc)
    r = cosmos._parse_rating({"reason": "Deep pothole.", "real": True, "severity": 5}, "cosmos3-reason")
    assert store.apply_rating_row(i, rating.row(i, r, t0))
    assert (i.severity, i.find_severity, i.verdict, i.severity_model) == (5, 2, "confirmed", "cosmos3-reason")
    assert i.work_order.urgency == "urgent"                                   # urgency follows the new grade
    older = rating.row(i, cosmos._parse_rating({"reason": "x", "real": True, "severity": 1}, "m"), t0 - timedelta(1))
    assert not store.apply_rating_row(i, older) and i.severity == 5           # a stale row never wins
    assert store.apply_rating_row(i, rating.cleared_row(i, t0 + timedelta(seconds=1)))
    assert (i.severity, i.find_severity, i.verdict, i.severity_model) == (2, None, None, None)
    assert i.work_order.urgency == "routine"
    latest = store._latest_ratings([{"issue_id": "a", "rated_at": t0.isoformat(), "model": "x"},
                                    {"issue_id": "a", "rated_at": (t0 + timedelta(1)).isoformat(), "model": "y"}])
    assert latest["a"]["model"] == "y"


def test_canonical_severity_skips_rejected_sightings(monkeypatch):
    t = datetime.now(timezone.utc)
    canon, seen_again = issue("c", severity=2), issue("d", severity=4, duplicate_of="c")
    store.apply_rating_row(canon, rating.row(canon, cosmos._parse_rating(
        {"reason": "Failed patch.", "real": True, "severity": 3}, "cosmos3-reason"), t))
    store.apply_rating_row(seen_again, rating.row(seen_again, cosmos._parse_rating(
        {"reason": "Just a shadow.", "real": False, "severity": 1}, "cosmos3-reason"), t))
    lonely = issue("e", severity=4)
    store.apply_rating_row(lonely, rating.row(lonely, cosmos._parse_rating(
        {"reason": "Intact sign.", "real": False, "severity": 1}, "cosmos3-reason"), t))
    monkeypatch.setattr(store, "_issues", {i.id: i for i in (canon, seen_again, lonely)})
    monkeypatch.setattr(store, "_cutoff", None)
    by_id = {i.id: i for i in store.canonical_issues()}
    assert (by_id["c"].severity, by_id["c"].sightings, by_id["c"].verdict) == (3, 2, "confirmed")
    assert by_id["c"].work_order.urgency == "soon"
    assert by_id["e"].verdict == "rejected"
    assert [i.id for i in store.canonical_issues(include_rejected=False)] == ["c"]
