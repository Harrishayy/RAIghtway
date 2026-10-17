"""vss-collection pie_cam-3 rows -> data/inventory.json, each segment mapped to (drive, t_start).

Run from backend/ after load_gps.py:  .venv/bin/python ../scripts/build_inventory.py [--check 3]
Reads vss-schema READ-ONLY with explicit columns (never the vector column), one query.
--dump saves the raw rows (data/vss_rows.json) and --rows re-maps from that file without querying.
"""
import argparse
import json
from pathlib import Path
import random
import re
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import config  # noqa: E402
from app.geo import gps  # noqa: E402
from app.geo.inventory import INVENTORY_JSON, Segment  # noqa: E402

COLUMNS = ["source", "original_video", "filename", "segment_start_sec", "camera_id", "extra_metadata"]
CAMERA = "pie_cam-3"
SEGMENT_S = 5.0
CHUNK_S = 30.0
MOVING_KMH = 2.0
_CHUNK = re.compile(r"^(?:\d{8}_\d{6}_)?(?P<stem>.+?)_chunk_(?P<n>\d+)(?:_segment_\d+_of_\d+)?\.mp4$", re.IGNORECASE)


def read_vss_rows(bucket: str | None = None) -> list[dict]:
    """Every vss-collection row, explicit non-vector columns only. Read-only."""
    import vastdb
    session = vastdb.connect(endpoint=config.S3_ENDPOINT, access=config.ACCESS_KEY,
                             secret=config.SECRET_KEY, ssl_verify=False)
    with session.transaction() as tx:
        table = tx.bucket(bucket or config.VASTDB_BUCKET).schema("vss-schema").table("vss-collection")
        return table.select(columns=COLUMNS).read_all().to_pylist()


def _meta(value) -> dict:
    if isinstance(value, dict):
        return value
    try:
        data = json.loads(value.decode() if isinstance(value, bytes) else value or "{}")
        return data if isinstance(data, dict) else {}
    except (TypeError, ValueError):
        return {}


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _name(uri: str) -> str:
    return (uri or "").rstrip("/").rsplit("/", 1)[-1]


def stem_of(row: dict) -> tuple[str | None, str | None, int | None]:
    """(set, clip or None for a whole-set stream, chunk index) from the chunk or segment name."""
    for uri in (row.get("original_video"), row.get("source")):
        match = _CHUNK.match(_name(uri))
        if not match:
            continue
        stem, index = match["stem"].lower(), int(match["n"])
        clip = re.search(r"(set\d+)_(video_\d+)$", stem)
        if clip:
            return clip[1], clip[2], index
        whole = re.search(r"(set\d+)(?:_video)?$", stem)
        if whole:
            return whole[1], None, index
    return None, None, None


def position(row: dict, meta: dict, chunk_index: int | None) -> tuple[float | None, float | None]:
    """(stream_position_sec, chunk_start_sec) of the segment start within its source stream."""
    seg = _num(row.get("segment_start_sec")) or 0.0
    chunk = _num(meta.get("chunk_start_sec"))
    if chunk is None and chunk_index is not None:
        chunk = chunk_index * CHUNK_S
    pos = _num(meta.get("stream_position_sec"))
    if pos is None and chunk is not None:
        pos = chunk + seg
    return pos, chunk


def set_clips(durations: dict[str, float], set_id: str) -> list[tuple[str, float, float]]:
    """[(drive, offset in the set stream, duration)] in clip order."""
    clips, offset = [], 0.0
    for drive in sorted(d for d in durations if d.startswith(set_id + "/")):
        clips.append((drive, offset, durations[drive]))
        offset += durations[drive]
    return clips


def map_position(clips: list[tuple[str, float, float]], pos: float) -> tuple[str, float] | None:
    for drive, offset, duration in clips:
        if offset <= pos < offset + duration:
            return drive, round(pos - offset, 3)
    return None


def moving(drive: str, t: float, duration: float) -> bool | None:
    speeds = [s[4] for s in gps.samples(drive, t, t + duration)]
    return statistics.median(speeds) >= MOVING_KMH if speeds else None


def build(rows: list[dict], durations: dict[str, float]) -> tuple[list[Segment], dict]:
    segments, seen, notes = [], set(), {"rows": len(rows), "camera": 0, "unparsed": 0, "unmapped": 0,
                                        "duplicates": 0, "straddle": 0, "filename_is_source_name": 0}
    spans: dict[str, list[float]] = {}
    for row in rows:
        if row.get("camera_id") != CAMERA:
            continue
        notes["camera"] += 1
        meta = _meta(row.get("extra_metadata"))
        set_id, clip, index = stem_of(row)
        pos, chunk = position(row, meta, index)
        if set_id is None or pos is None:
            notes["unparsed"] += 1
            continue
        if clip:
            mapped = (f"{set_id}/{clip}", pos)
        else:
            spans.setdefault(set_id, []).append(pos)
            mapped = map_position(set_clips(durations, set_id), pos)
        if not mapped:
            notes["unmapped"] += 1
            continue
        drive, t = mapped
        segment_id = _name(row.get("source")) or str(row.get("filename"))
        notes["filename_is_source_name"] += row.get("filename") == segment_id
        if segment_id in seen:
            notes["duplicates"] += 1
            continue
        seen.add(segment_id)
        if drive in durations and t + SEGMENT_S > durations[drive] + 0.05:
            notes["straddle"] += 1
        segments.append(Segment(segment_id=segment_id, source_uri=row.get("source") or "", drive=drive,
                                t_start=t, duration=SEGMENT_S, moving=moving(drive, t, SEGMENT_S),
                                original_video=row.get("original_video") or "", chunk_start_sec=chunk,
                                stream_position_sec=pos))
    segments.sort(key=lambda s: (s.drive, s.t_start))
    return segments, {"notes": notes, "spans": spans}


def report_spans(spans: dict[str, list[float]], durations: dict[str, float]) -> None:
    for set_id, positions in sorted(spans.items()):
        positions = sorted(set(positions))
        indexed = positions[-1] + SEGMENT_S
        total = sum(d for _, _, d in set_clips(durations, set_id))
        gaps = [(a + SEGMENT_S, b) for a, b in zip(positions, positions[1:]) if b - a > SEGMENT_S + 0.01]
        clips = [d for d, o, _ in set_clips(durations, set_id) if o < indexed]
        state = "OK" if indexed <= total + 0.5 else "MISMATCH: indexed span exceeds the clips' total"
        print(f"{set_id}: {len(positions)} segments, indexed {positions[0]:.0f}-{indexed:.0f} s of {total:.0f} s "
              f"({len(clips)} clips: {clips[0] if clips else '-'} .. {clips[-1] if clips else '-'}), "
              f"gaps {gaps[:3]}{'…' if len(gaps) > 3 else ''}  {state}")


def check(segments: list[Segment], n: int) -> None:
    """Prints segments to eyeball: stopped ones, moving ones and ones with a turn (heading change)."""
    rng = random.Random(7)
    with_gps = [s for s in segments if s.moving is not None]
    stopped = [s for s in with_gps if not s.moving]
    turning = []
    for s in with_gps:
        rows = gps.samples(s.drive, s.t_start, s.t_start + s.duration)
        if len(rows) >= 2 and s.moving:
            turn = abs((rows[-1][3] - rows[0][3] + 180) % 360 - 180)
            if turn >= 45:
                turning.append((s, turn))
    picks = [("stopped", s, None) for s in rng.sample(stopped, min(n, len(stopped)))]
    picks += [("turning", s, turn) for s, turn in rng.sample(turning, min(n, len(turning)))]
    print("\nCheck these by eye (stopped = car still; turning = visible turn):")
    for kind, s, turn in picks:
        rows = gps.samples(s.drive, s.t_start, s.t_start + s.duration)
        speeds = ", ".join(f"{r[4]:.0f}" for r in rows)
        extra = f", heading change {turn:.0f} deg" if turn else ""
        print(f"  {kind}: {s.drive} t={s.t_start:.0f}-{s.t_start + s.duration:.0f} s, km/h [{speeds}]{extra}\n"
              f"    {s.source_uri}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--durations", type=Path, default=gps.DATA_DIR / "clip_durations.json")
    parser.add_argument("--out", type=Path, default=INVENTORY_JSON)
    parser.add_argument("--rows", type=Path, help="map from a saved row dump instead of querying VastDB")
    parser.add_argument("--dump", action="store_true", help="save the raw rows to data/vss_rows.json")
    parser.add_argument("--check", type=int, default=3, help="print N stopped + N turning segments to verify")
    args = parser.parse_args()

    try:
        durations = json.loads(args.durations.read_text())
    except OSError:
        sys.exit(f"{args.durations} missing: run load_gps.py first")
    if args.rows:
        rows = json.loads(args.rows.read_text())
    else:
        try:
            rows = read_vss_rows()
        except Exception as exc:
            sys.exit(f"vss-collection read failed ({config.redact(exc)})")
        if args.dump:
            dump = gps.DATA_DIR / "vss_rows.json"
            dump.write_text(json.dumps(rows, default=str))
            print(f"raw rows -> {dump}")

    segments, info = build(rows, durations)
    report_spans(info["spans"], durations)
    notes = info["notes"]
    known = [s for s in segments if s.moving is not None]
    print(f"\n{notes}")
    print(f"{len(segments)} segments over {len({s.drive for s in segments})} drives; "
          f"{sum(bool(s.moving) for s in known)} moving, {sum(not s.moving for s in known)} stopped, "
          f"{len(segments) - len(known)} without GPS")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"camera_id": CAMERA, "segments": [s.model_dump() for s in segments]}, indent=1))
    print(f"-> {args.out}")
    if args.check:
        check(segments, args.check)


if __name__ == "__main__":
    main()
