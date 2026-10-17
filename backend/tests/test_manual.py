"""Operator input: issues marked on footage, pins and operator severity. Offline: ffmpeg, GPS, models stubbed."""
from datetime import datetime, timezone
import json

from fastapi.testclient import TestClient
import pytest

from app import config, store
from app.ai import nemotron
from app.models import Issue, IssueRecord, VideoRecord, WorkOrder
from app.pipeline import manual


@pytest.fixture
def fresh(monkeypatch, tmp_path):
    """An empty store writing to tmp_path, no VastDB queue, no report regeneration."""
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    for name in ("_videos", "_issues", "_done_videos", "_saved_issues"):
        monkeypatch.setattr(store, name, {})
    monkeypatch.setattr(store, "_provisional", set())
    monkeypatch.setattr(store, "_cutoff", None)
    queued = []
    monkeypatch.setattr(store, "_enqueue", lambda name, value: queued.append((name, value)))
    from app.planning import report
    monkeypatch.setattr(report, "schedule_regen", lambda: None)
    video = VideoRecord(id="corpus-set04-video_0008", filename="set04/video_0008", source="corpus", status="done",
                        progress=1, drive="set04/video_0008", start_s=300, duration_s=60,
                        created_at=datetime.now(timezone.utc))
    store._videos[video.id] = video
    return tmp_path, queued


def _stub_media(monkeypatch, tmp_path, *, embed_fails=False, nemotron_fails=False):
    seen = {}

    def grab(video, t, issue_id):
        seen["grab"] = (video.id, t)
        path = tmp_path / "frames" / f"{issue_id}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\xff\xd8jpeg")
        return str(path)

    def locate(video, t):
        seen["drive_t"] = video.start_s + t                 # corpus: drive time = start_s + video time
        return 43.65, -79.38

    async def embed(frame, bbox, issue_id):
        return None if embed_fails else [0.1] * 256

    async def orders(video, new, all_):
        if nemotron_fails:
            return nemotron._template([nemotron._compact(i) for i in new], [])[0], "template"
        return {new[0].id: WorkOrder(repair="Saw-cut and patch the pothole.", crew="roads", minutes=45,
                                     equipment=["asphalt"], urgency="urgent")}, "ok"

    monkeypatch.setattr(manual, "_grab_frame", grab)
    monkeypatch.setattr(manual, "_locate", locate)
    monkeypatch.setattr(manual, "_embed", embed)
    monkeypatch.setattr(manual, "_put_frame", lambda id, frame: f"citymaint/frames/{id}.jpg")
    monkeypatch.setattr(nemotron, "work_orders_and_explanation", orders)
    return seen


def test_create_manual_issue(fresh, monkeypatch):
    tmp_path, queued = fresh
    seen = _stub_media(monkeypatch, tmp_path)
    from app.main import app
    client = TestClient(app)
    response = client.post("/api/issues", json={
        "video_id": "corpus-set04-video_0008", "t": 12.5, "category": "pavement", "severity": 5,
        "description": "Deep pothole in the curb lane", "bbox": {"x": 0.4, "y": 0.6, "w": 0.2, "h": 0.15}})
    assert response.status_code == 200, response.text
    issue = response.json()
    assert issue["id"].startswith("m-") and issue["source"] == "manual" and issue["pinned"] is True
    assert (issue["severity"], issue["severity_model"], issue["verdict"]) == (5, "operator", "confirmed")
    assert (issue["lat"], issue["lon"]) == (43.65, -79.38) and seen["drive_t"] == 312.5
    assert issue["work_order"]["repair"].startswith("Saw-cut") and issue["work_order"]["urgency"] == "urgent"
    assert issue["duplicate_of"] is None and issue["frame_url"] == f"/api/frames/{issue['id']}"
    assert "embedding" not in issue and "frame_key" not in issue
    record = store.get_issue(issue["id"])
    assert record.embedding is not None and record.frame_key.endswith(".jpg")
    # Persisted through the store: the issue row, the operator's grade and the pin are all queued for VastDB.
    assert [name for name, _ in queued] == ["insert_issues", "insert_ratings", "insert_pins"]
    assert json.loads((tmp_path / "pins.jsonl").read_text())["pinned"] is True
    assert json.loads((tmp_path / "ratings.jsonl").read_text())["model"] == "operator"
    # Shown with the video and in the issue list, never merged into another issue.
    assert issue["id"] in client.get("/api/videos/corpus-set04-video_0008").json()["video"]["issue_ids"]
    assert [i["id"] for i in client.get("/api/issues").json()] == [issue["id"]]


def test_manual_issue_survives_model_failures(fresh, monkeypatch):
    tmp_path, _ = fresh
    _stub_media(monkeypatch, tmp_path, embed_fails=True, nemotron_fails=True)
    record = __import__("asyncio").run(manual.create(video_id="corpus-set04-video_0008", t=3, category="waste",
                                                     severity=2, description="", bbox=None, pinned=False))
    assert record.embedding is None and record.pinned is False
    assert manual.work_order_model(record) == "template"
    assert record.description == "Operator-reported waste issue"


def test_create_unknown_video_is_404(fresh):
    from app.main import app
    response = TestClient(app).post("/api/issues", json={"video_id": "nope", "t": 0, "category": "pavement",
                                                          "severity": 3})
    assert response.status_code == 404


def _model_issue(id="c1", severity=2):
    return IssueRecord(id=id, video_id="corpus-set04-video_0008", t=0, category="pavement", severity=severity,
                       confidence=0.8, description="pothole", frame_url="", bbox=None, lat=43.65, lon=-79.38,
                       source="corpus", frame_key="", created_at=datetime.now(timezone.utc))


def test_pin_unpin_persist_and_reload(fresh):
    tmp_path, queued = fresh
    store.add_issues([_model_issue()])
    from app.main import app
    client = TestClient(app)
    assert client.patch("/api/issues/c1", json={"pinned": True}).json()["pinned"] is True
    assert [i["pinned"] for i in client.get("/api/issues").json()] == [True]
    assert client.patch("/api/issues/c1", json={"pinned": False}).json()["pinned"] is False
    rows = [json.loads(line) for line in (tmp_path / "pins.jsonl").read_text().splitlines()]
    assert [r["pinned"] for r in rows] == [True, False]
    assert sum(name == "insert_pins" for name, _ in queued) == 2
    # A reload from insert-only issue rows applies the newest pin row: unpinned wins.
    reloaded = _model_issue()
    latest = store._latest_pins(store._read_rating_log(store.PINS_FILE))
    assert store.apply_pin_row(reloaded, latest["c1"]) and reloaded.pinned is False
    assert client.patch("/api/issues/missing", json={"pinned": True}).status_code == 404


def test_operator_severity_override_and_revert(fresh):
    from app.ai import cosmos, rating
    store.add_issues([_model_issue(severity=2)])
    graded = rating.row(store.get_issue("c1"), cosmos._parse_rating(
        {"reason": "Pothole forming.", "real": True, "severity": 3}, "cosmos3-reason"))
    store.apply_ratings([graded])
    from app.main import app
    client = TestClient(app)
    over = client.patch("/api/issues/c1", json={"severity": 5}).json()
    assert (over["severity"], over["severity_model"], over["find_severity"]) == (5, "operator", 2)
    back = client.patch("/api/issues/c1", json={"revert_severity": True}).json()
    assert (back["severity"], back["severity_model"]) == (3, "cosmos3-reason")    # the model's grade returns


def test_schema_accepts_manual_and_defaults_pinned():
    issue = Issue.model_validate({"id": "a", "video_id": "v", "t": 0, "category": "pavement", "severity": 3,
                                  "confidence": 1, "description": "x", "frame_url": "", "bbox": None,
                                  "lat": None, "lon": None})
    assert issue.pinned is False and issue.source is None
    assert Issue.model_validate({**issue.model_dump(), "source": "manual"}).source == "manual"
    assert _model_issue().model_copy(update={"source": "manual"}).source == "manual"


def test_name_set_clear_persist_and_reload(fresh):
    tmp_path, queued = fresh
    store.add_issues([_model_issue()])
    from app.main import app
    client = TestClient(app)
    named = client.patch("/api/issues/c1", json={"name": "   King St   pothole \n by the TTC stop  "}).json()
    assert named["name"] == "King St pothole by the TTC stop"
    assert [i["name"] for i in client.get("/api/issues").json()] == ["King St pothole by the TTC stop"]
    assert client.patch("/api/issues/c1", json={"name": "x" * 120}).json()["name"] == "x" * 80   # trimmed to 80
    cleared = client.patch("/api/issues/c1", json={"name": "  "}).json()
    assert cleared["name"] is None and cleared["description"] == "pothole"
    rows = [json.loads(line) for line in (tmp_path / "names.jsonl").read_text().splitlines()]
    assert [r["name"] for r in rows] == ["King St pothole by the TTC stop", "x" * 80, ""]
    assert sum(name == "insert_names" for name, _ in queued) == 3
    # Untouched fields don't write rows: a pin-only patch leaves the names log alone.
    client.patch("/api/issues/c1", json={"pinned": True})
    assert len((tmp_path / "names.jsonl").read_text().splitlines()) == 3


def test_name_newest_row_wins_on_reload(fresh):
    early, late = datetime(2026, 10, 1, tzinfo=timezone.utc), datetime(2026, 10, 2, tzinfo=timezone.utc)
    rows = [store.name_row("c1", "Second", when=late), store.name_row("c1", "First", when=early)]
    latest = store._latest_names(rows)
    issue = _model_issue()
    assert store.apply_name_row(issue, latest["c1"]) and issue.name == "Second"
    assert not store.apply_name_row(issue, rows[1]) and issue.name == "Second"     # an older row never wins
    assert store.apply_name_row(issue, store.name_row("c1", "")) and issue.name is None   # a newer "" clears


def test_canonical_takes_newest_name_among_sightings(fresh):
    original, again = _model_issue("c1"), _model_issue("c2")
    again.duplicate_of = "c1"
    store.add_issues([original, again])
    early, late = datetime(2026, 10, 1, tzinfo=timezone.utc), datetime(2026, 10, 2, tzinfo=timezone.utc)
    store.apply_names([store.name_row("c1", "Own name", when=early), store.name_row("c2", "Seen again", when=late)])
    [canonical] = store.canonical_issues()
    assert canonical.id == "c1" and canonical.name == "Seen again"
    store.apply_names([store.name_row("c1", "Renamed", when=datetime.now(timezone.utc))])
    assert store.canonical_issues()[0].name == "Renamed"


def test_create_manual_issue_with_name(fresh, monkeypatch):
    tmp_path, _ = fresh
    _stub_media(monkeypatch, tmp_path)
    from app.main import app
    client = TestClient(app)
    issue = client.post("/api/issues", json={"video_id": "corpus-set04-video_0008", "t": 3, "category": "pavement",
                                            "severity": 4, "name": "  Queen & Spadina sinkhole "}).json()
    assert issue["name"] == "Queen & Spadina sinkhole" and issue["source"] == "manual"
    unnamed = client.post("/api/issues", json={"video_id": "corpus-set04-video_0008", "t": 4,
                                              "category": "pavement", "severity": 4, "name": ""}).json()
    assert unnamed["name"] is None


def test_patch_validation(fresh):
    store.add_issues([_model_issue()])
    from app.main import app
    client = TestClient(app)
    assert client.patch("/api/issues/c1", json={"name": "y" * 201}).status_code == 422
    assert client.patch("/api/issues/c1", json={"name": 5}).status_code == 422
    assert client.patch("/api/issues/c1", json={"severity": 6}).status_code == 422
    assert client.patch("/api/issues/missing", json={"name": "x"}).status_code == 404
    assert client.patch("/api/issues/c1", json={}).json()["name"] is None


def test_report_shows_current_names(fresh, monkeypatch):
    from app.models import Report, ReportIssue
    store.add_issues([_model_issue()])
    row = ReportIssue(id="c1", category="pavement", severity=5, description="pothole", video_id="v",
                      deadline="today", crew="roads")
    monkeypatch.setattr(store, "_report", Report(generated_at=datetime.now(timezone.utc), summary="", counts={},
                                                 crews={}, rationale="", priorities=[row]))
    store.apply_names([store.name_row("c1", "Bathurst crater")])
    from app.main import app
    assert TestClient(app).get("/api/report").json()["priorities"][0]["name"] == "Bathurst crater"


def test_failed_analysis_drops_its_provisional_pins(fresh, monkeypatch):
    import asyncio
    import app.main as main
    video = store._videos["corpus-set04-video_0008"]
    store.add_issues([_model_issue("p-1")], provisional=True)

    async def boom(*a, **k):
        raise RuntimeError("Cosmos down")
    monkeypatch.setattr(main, "analyse_video", boom)
    asyncio.run(main._run_analysis(video, "/nowhere.mp4"))
    assert store.get_issue("p-1") is None and store._videos[video.id].status == "failed"


def test_report_says_when_a_newer_one_is_coming(fresh, monkeypatch):
    from app.main import app
    from app.models import Report
    from app.planning import report
    monkeypatch.setattr(store, "_report", Report(generated_at=datetime.now(timezone.utc), summary="s", counts={},
                                                 crews={}, rationale="r"))
    monkeypatch.setattr(report, "is_updating", lambda: True)
    assert TestClient(app).get("/api/report").json()["updating"] is True
    assert store.latest_report().updating is False                     # the stored report is never marked
