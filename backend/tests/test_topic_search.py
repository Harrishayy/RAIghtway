"""VSS plain-language search: segment hits -> timeline bands, and the no-fallback error path. Offline: VSS is stubbed."""
import asyncio
from datetime import datetime, timezone
import threading

import pytest

from app.geo import inventory
from app.geo.inventory import Segment
from app.models import VideoRecord
from app.pipeline import topic_search, vss_client


def video(drive, start_s=0.0, duration_s=600.0, source="corpus"):
    return VideoRecord(id="corpus-" + drive.replace("/", "-"), filename=drive, source=source, status="done",
                       progress=1.0, drive=drive, start_s=start_s, duration_s=duration_s,
                       created_at=datetime.now(timezone.utc))


def seg(name, drive, t):
    return Segment(segment_id=name, source_uri=f"s3://segments/segments/{name}", drive=drive, t_start=t)


def hit(name, score=0.18, caption="A cracked road. More text follows."):
    return {"filename": name, "source": f"s3://segments/segments/{name}", "similarity_score": str(score),
            "reasoning_content": caption}


@pytest.fixture
def segments(monkeypatch):
    table = {s.segment_id: s for s in [seg("a1", "set01/video_0001", 20.0), seg("a2", "set01/video_0001", 25.0),
                                        seg("a9", "set01/video_0001", 100.0), seg("b1", "set02/video_0002", 40.0),
                                        seg("x1", "set09/video_0009", 0.0)]}
    monkeypatch.setattr(inventory, "by_id", lambda: table)
    return table


def listed(*vs):
    return {v.id: v for v in vs}


def test_hits_map_to_drive_time_and_merge(segments):
    videos = listed(video("set01/video_0001"), video("set02/video_0002", start_s=10.0))
    results = [hit("b1", 0.19), hit("a2", 0.18), hit("a1", 0.17, "Lower rank."), hit("a9", 0.16),
               hit("x1"), hit("unknown"), hit("a9", 0.05)]   # the last is below the floor (0.6 x best)
    hits = topic_search.map_hits(results, videos)
    assert [(h.video_id, h.start, h.end) for h in hits] == [
        ("corpus-set02-video_0002", 30.0, 35.0),         # t_start 40 on a video starting at 10 s
        ("corpus-set01-video_0001", 20.0, 30.0),         # a1 + a2 touch, so one band
        ("corpus-set01-video_0001", 100.0, 105.0)]
    assert [h.score for h in hits] == [1.0, 0.667, 0.333]
    assert hits[1].similarity == 0.18 and hits[1].caption == "A cracked road."   # the band keeps its best segment


def test_hits_off_listed_or_upload_videos_are_dropped(segments):
    assert topic_search.map_hits([hit("a1")], listed(video("set02/video_0002"))) == []
    assert topic_search.map_hits([hit("a1")], listed(video("set01/video_0001", source="upload"))) == []
    # a source URI without a filename still maps; a segment past the video's end is dropped
    assert topic_search.map_hits([{"source": "s3://b/segments/a1", "similarity_score": 0.2}], listed(video("set01/video_0001")))[0].start == 20.0
    assert topic_search.map_hits([hit("a9")], listed(video("set01/video_0001", duration_s=60.0))) == []


def test_weak_hits_fall_below_the_floor(segments):
    hits = topic_search.map_hits([hit("a1", 0.30), hit("b1", 0.10)], listed(video("set01/video_0001"), video("set02/video_0002")))
    assert [h.video_id for h in hits] == ["corpus-set01-video_0001"]
    assert topic_search.map_hits([hit("a1", 0.05), hit("b1", 0.04)], listed(video("set01/video_0001"), video("set02/video_0002"))) == []


def test_caption_picks_the_sentence_matching_the_query():
    text = "The scene is a street. The road is lined with orange traffic cones near a truck. The sky is clear."
    assert topic_search._caption(text, "traffic cones and construction") == "The road is lined with orange traffic cones near a truck."
    assert topic_search._caption(text, "zebra") == "The scene is a street."
    assert topic_search._caption("One.  Two.") == "One."
    long = topic_search._caption("word " * 80)
    assert len(long) == topic_search.CAPTION_CHARS and long.endswith("…")


@pytest.mark.parametrize("raw, want", [("  Pot   Hole ", "pot hole"), ("CONES", "cones")])
def test_query_is_normalised(raw, want):
    assert topic_search.normalise(raw) == want


@pytest.mark.parametrize("raw", ["", "  a ", "x" * 201, None])
def test_bad_query_raises(raw):
    with pytest.raises(ValueError):
        topic_search.normalise(raw)


def test_search_returns_vss_answer(monkeypatch, segments):
    calls = []
    monkeypatch.setattr(vss_client, "search_full", lambda q, **k: calls.append((q, k)) or
                        {"results": [hit("a1")], "synthesis": "One pothole on set01.", "cached": True})
    out = asyncio.run(topic_search.search(" Pothole ", listed(video("set01/video_0001"))))
    assert calls == [("pothole", {"top_k": topic_search.TOP_K, "llm_top_n": topic_search.LLM_TOP_N})]
    assert (out.query, out.search, out.synthesis, out.cached, len(out.hits)) == ("pothole", "vss", "One pothole on set01.", True, 1)


def test_vss_failure_is_unavailable_not_a_fallback(monkeypatch, segments):
    def down(q, **k):
        raise RuntimeError("VSS search failed (password=***)")
    monkeypatch.setattr(vss_client, "search_full", down)
    with pytest.raises(topic_search.SearchUnavailable) as err:
        asyncio.run(topic_search.search("pothole", {}))
    assert "password" not in str(err.value)


def test_slow_vss_times_out_and_keeps_running(monkeypatch, segments):
    release, finished = threading.Event(), threading.Event()

    def slow(q, **k):
        release.wait(5)
        finished.set()
        return {"results": [], "synthesis": "", "cached": False}
    monkeypatch.setattr(vss_client, "search_full", slow)
    monkeypatch.setattr(topic_search, "TIMEOUT_S", 0.05)

    async def run():
        with pytest.raises(topic_search.SearchUnavailable, match="busy"):
            await topic_search.search("pothole", {})
        release.set()
        await asyncio.to_thread(finished.wait, 5)
    asyncio.run(run())
    assert finished.is_set()   # the VSS call finished (and would have filled the cache)


def test_search_full_caches_synthesis(monkeypatch, tmp_path):
    monkeypatch.setattr(vss_client.config, "STATE_DIR", str(tmp_path))
    monkeypatch.setattr(vss_client, "_cache", None)
    sent = []

    class Reply:
        def json(self):
            return {"results": [hit("a1"), "junk"],
                    "llm_synthesis": {"response": "**Answer**  \nTwo **deep** potholes.\n\n**Notable moments**\n- 0:25 (Clip 1)"}}
    monkeypatch.setattr(vss_client, "_authed", lambda *a, **k: sent.append(k["json"]) or Reply())
    first = vss_client.search_full("pothole", top_k=50)
    again = vss_client.search_full("pothole", top_k=50)
    assert len(sent) == 1
    assert (first["synthesis"], first["cached"], len(first["results"])) == ("Two deep potholes.", False, 1)
    assert (again["synthesis"], again["cached"]) == ("Two deep potholes.", True)
    assert sent[0]["llm_top_n"] == 1 and vss_client._synthesis(None) == ""
    assert vss_client.search("pothole", top_k=50) == first["results"]


def test_endpoint_answers_on_listed_videos(monkeypatch, segments):
    from fastapi import HTTPException
    from app import main
    monkeypatch.setattr(main, "videos", lambda: [video("set01/video_0001")])
    monkeypatch.setattr(vss_client, "search_full", lambda q, **k: {"results": [hit("a1"), hit("b1")], "synthesis": "", "cached": False})
    out = asyncio.run(main.search_footage(main.SearchRequest(query="cracked road")))
    assert [h.video_id for h in out.hits] == ["corpus-set01-video_0001"] and out.search == "vss"
    with pytest.raises(HTTPException) as err:
        asyncio.run(main.search_footage(main.SearchRequest(query="a")))
    assert err.value.status_code == 422

    def down(q, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(vss_client, "search_full", down)
    with pytest.raises(HTTPException) as err:
        asyncio.run(main.search_footage(main.SearchRequest(query="cracked road")))
    assert (err.value.status_code, err.value.detail) == (503, "VSS search is unavailable")


def test_logged_issues_inside_bands_feed_the_answer(monkeypatch, segments):
    from app.ai import summaries
    from app.models import IssueRecord
    made = []

    async def answer(q, hits, logged, videos):
        made.append(logged)
        return "Cracks on set01 at 00:20; already logged.", False
    monkeypatch.setattr(summaries, "search_answer", answer)
    monkeypatch.setattr(vss_client, "search_full", lambda q, **k: {"results": [hit("a1"), hit("a9")], "synthesis": "", "cached": True})
    logged = [IssueRecord(id="i1", video_id="corpus-set01-video_0001", t=26.0, category="pavement", severity=4, confidence=0.9,
                          description="Deep crack", frame_url="", bbox=None, lat=None, lon=None, source="corpus",
                          frame_key="", created_at=datetime.now(timezone.utc))]
    out = asyncio.run(topic_search.search("cracked road", listed(video("set01/video_0001")), logged))
    assert made == [{0: ["pavement severity 4: Deep crack"]}]        # 26 s is within 2 s of the 20-25 s band
    assert (out.logged, out.answer_source, out.answer) == (1, "nemotron", "Cracks on set01 at 00:20; already logged.")

    async def pending(*a):
        return "", True
    monkeypatch.setattr(summaries, "search_answer", pending)
    out = asyncio.run(topic_search.search("cracked road", listed(video("set01/video_0001"))))
    assert (out.answer, out.answer_source, out.answer_pending, len(out.hits)) == ("", None, True, 2)


def test_ask_route_codes(monkeypatch):
    from fastapi import HTTPException
    from app import main, store
    from app.models import AskAnswer
    from app.pipeline import ask
    monkeypatch.setattr(store, "get_video", lambda id: video("set01/video_0001") if id == "v" else None)
    monkeypatch.setattr(store, "issues_for_video", lambda id: [])

    async def answer(v, q, t, issues):
        if q == "down":
            raise ask.AskUnavailable("Neither VSS nor Nemotron could answer right now")
        return AskAnswer(question=ask.normalise(q), answer="Cones at 08:50.", source="nemotron", times=[530.0])
    monkeypatch.setattr(ask, "ask", answer)
    assert asyncio.run(main.ask_video("v", main.AskRequest(question="what happened", t=530))).times == [530.0]
    for id, q, code in [("missing", "what happened", 404), ("v", "down", 503)]:
        with pytest.raises(HTTPException) as err:
            asyncio.run(main.ask_video(id, main.AskRequest(question=q)))
        assert err.value.status_code == code


def test_videos_serve_the_summary_overlay(monkeypatch, tmp_path):
    from app import main, store
    from app.ai import summaries
    monkeypatch.setattr(summaries.config, "STATE_DIR", str(tmp_path))
    monkeypatch.setattr(summaries, "_overlay", None)
    template = video("set01/video_0001").model_copy(update={"explanation": "This video contains 3 recorded maintenance findings: 3 pavement."})
    monkeypatch.setattr(store, "list_videos", lambda: [template])
    assert main.videos()[0].explanation_source == "template"
    summaries.save(template.id, "Three pavement findings on Bathurst St by 01:53.", "nemotron")
    served = main.videos()[0]
    assert (served.explanation, served.explanation_source) == ("Three pavement findings on Bathurst St by 01:53.", "nemotron")
    started = []
    monkeypatch.setattr(summaries, "start", lambda ids, only: started.append((ids, only)) or {"running": True})
    assert asyncio.run(main.regenerate_explanations(None)) == {"running": True} and started == [(None, True)]
