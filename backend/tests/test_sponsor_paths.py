"""Which index answered a vector search, and what reaches the Weave trace. Offline: ADBC is stubbed."""
from datetime import datetime, timezone

import numpy as np

from app import main, store
from app.ai import nemotron
from app.models import IssueRecord
from app.vast import vector


def issue(id, embedding=None):
    return IssueRecord(id=id, video_id="v", t=0, category="graffiti", severity=3, confidence=0.9,
                       description=f"tag {id}", frame_url="", bbox=None, lat=43.65, lon=-79.38,
                       source="corpus", frame_key="", created_at=datetime.now(timezone.utc), embedding=embedding)


def unit(k):
    v = np.zeros(256, dtype=np.float32)
    v[k] = 1
    return v


def test_search_reports_adbc_then_numpy(monkeypatch):
    monkeypatch.setattr(vector, "_index", {"a": (unit(0), {"category": "graffiti", "source": "corpus"})})
    monkeypatch.setattr(vector, "_build_sql", lambda *a, **k: "SQL")
    monkeypatch.setattr(vector, "_adbc_query", lambda sql: [("a", 0.0)])
    assert vector.search(unit(0)) == ([("a", 0.0)], "adbc")

    def down(sql):
        raise RuntimeError("ADBC down")
    monkeypatch.setattr(vector, "_adbc_query", down)
    hits, path = vector.search(unit(0))
    assert path == "numpy" and hits[0][0] == "a"
    assert vector.search(np.zeros(256)) == ([], "empty")
    assert vector.nearest(unit(0)) == hits


def test_similar_endpoint_returns_distance_and_index(monkeypatch):
    me, other = issue("me", unit(0).tolist()), issue("other")
    monkeypatch.setattr(store, "get_issue", lambda id: me if id == "me" else None)
    monkeypatch.setattr(store, "canonical_issues", lambda: [me, other])
    monkeypatch.setattr(vector, "search", lambda *a, **k: ([("other", 0.123456)], "adbc"))
    [hit] = main.similar_issues("me")
    assert (hit.id, hit.distance, hit.search) == ("other", 0.1235, "vastdb")
    monkeypatch.setattr(vector, "search", lambda *a, **k: ([("other", 0.2)], "numpy"))
    assert main.similar_issues("me")[0].search == "local"


def test_trace_keeps_text_and_drops_media():
    messages = [{"role": "system", "content": "Return JSON"},
                {"role": "user", "content": [{"type": "text", "text": "Box the tag"},
                                             {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}}]}]
    traced = nemotron._traceable(messages)
    assert traced[0] == messages[0]
    assert traced[1]["content"] == [{"type": "text", "text": "Box the tag"}, {"type": "image_url", "omitted": "media"}]
    assert "base64" not in str(traced)
    assert messages[1]["content"][1]["image_url"]["url"].startswith("data:")   # the request itself is untouched
