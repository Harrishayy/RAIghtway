"""Which footage Run picks next. Offline: the inventory, sweep and done lists are stubbed."""
import pytest

from app.geo import inventory
from app.geo.inventory import Segment
from app.pipeline import precompute, run


def seg(drive, t, moving=True):
    return Segment(segment_id=f"{drive.replace('/', '_')}_{int(t):04d}", source_uri=f"s3://b/{drive}/{t}.mp4",
                   drive=drive, t_start=t, moving=moving)


@pytest.fixture(autouse=True)
def idle(monkeypatch):
    monkeypatch.setattr(run, "_active", False)   # a started run that never calls go() would hold the guard


@pytest.fixture
def world(monkeypatch):
    segments = [seg("set01/video_0001", t) for t in range(0, 60, 5)] + [seg("set04/video_0008", t) for t in range(300, 345, 5)]
    state = {"sweep": set(), "pre": set(), "runs": set()}
    monkeypatch.setattr(inventory, "load", lambda: segments)
    monkeypatch.setattr(run, "_sweep_ids", lambda: state["sweep"])
    monkeypatch.setattr(precompute, "_load_done", lambda: state["pre"])
    monkeypatch.setattr(run, "_run_done", lambda: state["runs"])
    return segments, state


def test_picks_footage_no_pass_has_analysed(world):
    segments, state = world
    state["sweep"] = {s.segment_id for s in segments if s.drive == "set01/video_0001"}   # set04 is new
    stretch = run.pick()
    assert [s.t_start for s in stretch] == [300, 305, 310, 315, 320, 325]  # 6 contiguous segments, 30 s
    assert {s.drive for s in stretch} == {"set04/video_0008"}


def test_skips_analysed_and_stopped_footage_and_stops_at_gaps(world):
    segments, state = world
    state["sweep"] = {s.segment_id for s in segments if s.drive == "set04/video_0008"}
    state["runs"] = {"set01_video_0001_0000"}
    segments[2] = seg("set01/video_0001", 10, moving=False)               # parked: never picked
    stretch = run.pick()
    assert [s.t_start for s in stretch] == [5]                           # 10 is stopped, so the stretch ends


def test_nothing_new_raises(world):
    segments, state = world
    state["pre"] = {s.segment_id for s in segments}
    with pytest.raises(run.NothingToRun):
        run.pick()


def _corpus(monkeypatch, issues):
    """Stub the store: issues is {issue_id: (severity, drive, t)}, all open corpus issues."""
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from app import store
    monkeypatch.setattr(store, "canonical_issues", lambda: [
        SimpleNamespace(id=i, source="corpus", verdict="confirmed", severity=sev, confidence=0.9,
                        video_id=f"corpus-{drive}", t=t) for i, (sev, drive, t) in issues.items()])
    monkeypatch.setattr(store, "get_video", lambda v: SimpleNamespace(source="corpus", drive=v.removeprefix("corpus-"),
                                                                       start_s=0.0, created_at=datetime.now(timezone.utc)))


def test_rechecks_follow_the_worst_open_issues_one_per_drive(world, monkeypatch):
    _corpus(monkeypatch, {"c": (3, "set04/video_0008", 330.0), "b": (4, "set01/video_0001", 40.0),
                          "a": (5, "set01/video_0001", 22.0)})
    stretches = run.rechecks(2, set())
    assert [(s[0].drive, s[0].t_start) for s in stretches] == [("set01/video_0001", 10), ("set04/video_0008", 320)]
    assert len(stretches[0]) == 6 and len(stretches[1]) == 5          # set04 runs out at 340
    assert run.rechecks(2, {"set01/video_0001"})[0][0].drive == "set04/video_0008"


def test_start_queues_new_footage_then_rechecks(world, monkeypatch):
    import asyncio
    from app import store
    segments, state = world
    state["sweep"] = {s.segment_id for s in segments if s.drive == "set01/video_0001"}
    _corpus(monkeypatch, {"a": (5, "set04/video_0008", 330.0), "b": (4, "set01/video_0001", 22.0)})
    added = []
    monkeypatch.setattr(store, "add_video", added.append)
    monkeypatch.setattr(run, "refresh_inventory", lambda: True)
    first, _ = asyncio.run(run.start(lambda *a: None, clips=3))
    assert [(v.run_kind, v.source, v.drive) for v in added] == [("new", "corpus", "set04/video_0008"),
                                                                 ("recheck", "upload", "set01/video_0001")]
    assert first is added[0] and all(v.status == "queued" for v in added)


def test_second_run_is_refused_until_the_first_finishes(world, monkeypatch):
    import asyncio
    from app import store
    segments, state = world
    state["sweep"] = {s.segment_id for s in segments if s.drive == "set01/video_0001"}
    _corpus(monkeypatch, {})
    monkeypatch.setattr(store, "add_video", lambda v: None)
    monkeypatch.setattr(store, "set_progress", lambda *a, **k: None)
    monkeypatch.setattr(run, "refresh_inventory", lambda: True)
    monkeypatch.setattr(run, "_fetch", lambda stretch, path: (_ for _ in ()).throw(OSError("S3 down")))

    async def scenario():
        _, go = await run.start(lambda *a: None, clips=1)
        with pytest.raises(RuntimeError, match="still analysing"):   # pick() would choose the same stretch
            await run.start(lambda *a: None, clips=1)
        await go()                                                     # a failed fetch still ends the run
        await run.start(lambda *a: None, clips=1)
    asyncio.run(scenario())
