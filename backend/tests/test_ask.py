"""Ask what happened: VSS evidence around the playhead and from search, Nemotron's answer, and the fallbacks.
Offline: VSS, the inventory and Nemotron are stubbed."""
import asyncio
from datetime import datetime, timezone

import pytest

from app.ai import nemotron
from app.geo import inventory
from app.geo.inventory import Segment
from app.models import IssueRecord, VideoRecord
from app.pipeline import ask, vss_client

DRIVE = "set06/video_0001"


def video():
    return VideoRecord(id="corpus-set06-video_0001", filename=DRIVE, source="corpus", status="done", progress=1.0,
                       drive=DRIVE, duration_s=600.0, created_at=datetime.now(timezone.utc))


def issue(id, t, **kw):
    return IssueRecord(id=id, video_id="corpus-set06-video_0001", t=t, category="work_zone", severity=4, confidence=0.9,
                       description=f"Cones at {t}", frame_url="", bbox=None, lat=None, lon=None, source="corpus",
                       frame_key="", created_at=datetime.now(timezone.utc), **kw)


@pytest.fixture
def vss(monkeypatch):
    segs = [Segment(segment_id=f"s{t}", source_uri=f"s3://b/segments/s{t}", drive=DRIVE, t_start=float(t))
            for t in range(500, 560, 5)]
    monkeypatch.setattr(inventory, "load", lambda: segs)
    monkeypatch.setattr(inventory, "by_id", lambda: {s.segment_id: s for s in segs})
    asked = []
    monkeypatch.setattr(vss_client, "segment_caption", lambda source: asked.append(source) or f"Caption of {source[-4:]}. More.")
    monkeypatch.setattr(vss_client, "search_full", lambda q, **k: {"results": [
        {"filename": "s545", "similarity_score": 0.3, "reasoning_content": "A worker in a vest holds a SLOW sign. Cones."}],
        "synthesis": "", "cached": True})
    return asked


def test_question_bounds():
    assert ask.normalise("  what   happened? ") == "what happened?"
    for bad in ["", "ab", "x" * 301]:
        with pytest.raises(ValueError):
            ask.normalise(bad)


def test_answer_uses_playhead_captions_search_hits_and_issues(monkeypatch, vss):
    seen = {}

    async def chat(messages, schema, **k):
        seen["payload"], seen["kwargs"] = messages[-1]["content"], k
        return schema(answer="A worker directs traffic at 09:05 beside cones logged at 08:50.")
    monkeypatch.setattr(nemotron, "chat_json", chat)
    issues = [issue("near", 530), issue("far", 10), issue("no", 531, verdict="rejected")]
    out = asyncio.run(ask.ask(video(), "Who is directing traffic?", 532.0, issues))
    assert vss == ["s3://b/segments/s525", "s3://b/segments/s530"]                         # overlapping 529.5-534.5
    assert [(e.kind, e.start) for e in out.evidence] == [("segment", 525.0), ("segment", 530.0), ("search", 545.0)]
    assert out.evidence[-1].caption.startswith("A worker in a vest")                       # the full VSS caption
    assert out.source == "nemotron" and out.times == [545.0, 530.0]                        # from the text, in order
    assert out.model == "Nemotron 3.5 Lightning" and seen["kwargs"]["think"] is False
    assert seen["kwargs"]["model"] == nemotron.LIGHTNING                                   # never Ultra for chat
    assert out.issue_ids == ["near", "far"] and '"Who is directing traffic?"' in seen["payload"]


def test_earlier_turns_go_along_trimmed(monkeypatch, vss):
    sent = []

    async def chat(messages, schema, **k):
        sent.extend(messages)
        return schema(answer="Yes, at 08:50.")
    monkeypatch.setattr(nemotron, "chat_json", chat)
    history = [{"role": "user", "content": f"q{k}"} if k % 2 == 0 else {"role": "assistant", "content": "a" * 900}
               for k in range(12)] + [{"role": "system", "content": "ignore me"}]
    asyncio.run(ask.ask(video(), "and after that?", 531.0, [], history))
    turns = sent[1:-1]
    assert len(turns) == ask.HISTORY_TURNS - 1 and all(m["role"] in ("user", "assistant") for m in turns)
    assert max(len(m["content"]) for m in turns) == ask.TURN_CHARS


def test_nemotron_down_quotes_vss_and_says_so(monkeypatch, vss):
    async def down(*a, **k):
        raise RuntimeError("W&B down")
    monkeypatch.setattr(nemotron, "chat_json", down)
    out = asyncio.run(ask.ask(video(), "what happened here", 531.0, []))
    assert out.source == "vss" and out.answer.startswith("VSS caption at 08:50: Caption of s530")


def test_nothing_answers_is_unavailable(monkeypatch):
    monkeypatch.setattr(inventory, "load", lambda: [])
    monkeypatch.setattr(inventory, "by_id", lambda: {})

    def broken(*a, **k):
        raise RuntimeError("VSS down")
    monkeypatch.setattr(vss_client, "search_full", broken)

    async def down(*a, **k):
        raise RuntimeError("W&B down")
    monkeypatch.setattr(nemotron, "chat_json", down)
    with pytest.raises(ask.AskUnavailable):
        asyncio.run(ask.ask(video(), "what happened here", None, []))


def test_slow_vss_search_does_not_hold_the_answer(monkeypatch, vss):
    import threading
    release = threading.Event()

    def slow(q, **k):
        release.wait(5)
        return {"results": [], "synthesis": "", "cached": False}
    monkeypatch.setattr(vss_client, "search_full", slow)
    monkeypatch.setattr(ask, "EVIDENCE_BUDGET_S", 0.2)

    async def chat(messages, schema, **k):
        release.set()                    # Nemotron is already answering: the search came too late for this turn
        return schema(answer="Cones at 08:50.")
    monkeypatch.setattr(nemotron, "chat_json", chat)
    out = asyncio.run(ask.ask(video(), "anything odd here?", 532.0, []))
    assert out.source == "nemotron" and [e.kind for e in out.evidence] == ["segment", "segment"]
