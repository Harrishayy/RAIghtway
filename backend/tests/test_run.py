"""Which footage Run picks next. Offline: the inventory, sweep and done lists are stubbed."""
import pytest

from app.geo import demo, inventory
from app.geo.inventory import Segment
from app.pipeline import precompute, run


def seg(drive, t, moving=True):
    return Segment(segment_id=f"{drive.replace('/', '_')}_{int(t):04d}", source_uri=f"s3://b/{drive}/{t}.mp4",
                   drive=drive, t_start=t, moving=moving)


@pytest.fixture
def world(monkeypatch):
    segments = [seg("set01/video_0001", t) for t in range(0, 60, 5)] + [seg("set04/video_0008", t) for t in range(300, 345, 5)]
    state = {"sweep": set(), "held": set(), "pre": set(), "runs": set()}
    monkeypatch.setattr(inventory, "load", lambda: segments)
    monkeypatch.setattr(run, "_sweep_ids", lambda: state["sweep"])
    monkeypatch.setattr(demo, "excluded_segments", lambda: state["held"])
    monkeypatch.setattr(precompute, "_load_done", lambda: state["pre"])
    monkeypatch.setattr(run, "_run_done", lambda: state["runs"])
    return segments, state


def test_held_back_demo_segments_come_first(world):
    segments, state = world
    state["sweep"] = {s.segment_id for s in segments}                     # the sweep saw everything
    state["held"] = {s.segment_id for s in segments if s.drive == "set04/video_0008"}
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
