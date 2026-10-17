"""Demo mode: off serves the pipeline untouched; on ranks picks, hides rejects, lists only curated drives."""
import json
from datetime import datetime, timezone

import pytest

from app import curation, main, store
from app.models import IssueRecord, VideoRecord


def issue(id, video="v"):
    return IssueRecord(id=id, video_id=video, t=0, category="graffiti", severity=3, confidence=0.9,
                       description=f"tag {id}", frame_url="", bbox=None, lat=43.65, lon=-79.38,
                       source="corpus", frame_key="", created_at=datetime.now(timezone.utc))


def video(id, source="corpus"):
    return VideoRecord(id=id, filename=id, source=source, status="done", progress=1.0,
                       created_at=datetime.now(timezone.utc))


@pytest.fixture
def curated(tmp_path, monkeypatch):
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"featured": {"a": 2}, "rejected": {"b": "mural"}}))
    monkeypatch.setenv("CURATION_FILE", str(path))
    monkeypatch.setattr(curation, "TOGGLE_FILE", tmp_path / "toggle.json")
    monkeypatch.setattr(curation, "_cache", (-1.0, {}, {}))
    monkeypatch.setattr(curation, "_enabled", False)
    monkeypatch.setattr(store, "canonical_issues", lambda: [issue("a", "picked"), issue("b", "picked"), issue("c", "plain")])
    monkeypatch.setattr(store, "list_videos", lambda: [video("picked"), video("plain"), video("up", "upload")])
    return path


def test_bundled_file_parses():
    picks, rejected = curation._load()
    assert picks and min(picks.values()) == 1
    assert not set(picks) & set(rejected)


def test_off_by_default_serves_everything(curated):
    assert not curation.enabled()
    assert [i.id for i in main.issues()] == ["a", "b", "c"]
    assert all(i.featured is None for i in main.issues())
    assert [v.id for v in main.videos()] == ["picked", "plain", "up"]
    assert main.health()["demo_curation"] is False


def test_on_ranks_hides_and_filters_then_persists(curated, tmp_path):
    assert main.demo_toggle(main.DemoToggle(on=True)) == {"on": True}
    assert [(i.id, i.featured) for i in main.issues()] == [("a", 2), ("c", None)]
    assert curation.rejected("b") == "mural"
    assert [v.id for v in main.videos()] == ["picked", "up"]
    assert json.loads((tmp_path / "toggle.json").read_text()) == {"on": True}

    main.demo_toggle(main.DemoToggle(on=False))
    assert [i.id for i in main.issues()] == ["a", "b", "c"]


def test_bad_file_means_no_picks(curated):
    curation.set_enabled(True)
    curated.write_text("{not json")
    curation._cache = (-1.0, {}, {})
    assert curation.featured("a") is None and [i.id for i in main.issues()] == ["a", "b", "c"]
