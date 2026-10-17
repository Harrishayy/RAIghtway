"""Find demo-clip candidates: moving stretches of drive A on streets an indexed drive B also covered.

Run from backend/ after build_inventory.py:
  .venv/bin/python ../scripts/find_overlaps.py              # print the top candidates
  .venv/bin/python ../scripts/find_overlaps.py --write 1 2  # primary + backup -> data/demo_clips.json
"""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.geo import gps, inventory  # noqa: E402

CELL_M = 30.0
MATCH_M = 35.0          # same street: B passes within this distance (the dedupe radius)
MOVING_KMH = 2.0
MAX_GAP_S = 2.0         # tolerated missing seconds inside a run
_LON_M = 111320.0 * math.cos(math.radians(43.7))


def cell(lat: float, lon: float) -> tuple[int, int]:
    return math.floor(lat * 111320.0 / CELL_M), math.floor(lon * _LON_M / CELL_M)


def _segment_index(segments) -> dict[str, list]:
    by_drive = defaultdict(list)
    for s in segments:
        by_drive[s.drive].append(s)
    for items in by_drive.values():
        items.sort(key=lambda s: s.t_start)
    return by_drive


def _segment_at(by_drive, drive: str, t: float):
    for s in by_drive.get(drive, []):
        if s.t_start <= t < s.t_start + s.duration:
            return s
    return None


def candidates(min_s: float = 20, max_s: float = 30) -> list[dict]:
    segments = inventory.load()
    by_drive = _segment_index(segments)
    tracks = {d: gps.samples(d, -1e9, 1e9) for d in gps.drives()}
    cells: dict[tuple, list] = defaultdict(list)          # cell -> [(drive, t, lat, lon)] indexed rows only
    for drive, rows in tracks.items():
        for t, lat, lon, _, _ in rows:
            if _segment_at(by_drive, drive, t):
                cells[cell(lat, lon)].append((drive, t, lat, lon))

    found = []
    for a, rows in tracks.items():
        matches = defaultdict(list)                       # B drive -> [(t_a, t_b, distance)]
        for t, lat, lon, _, speed in rows:
            if speed < MOVING_KMH:
                continue
            ci, cj = cell(lat, lon)
            best: dict[str, tuple[float, float]] = {}
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for b, tb, lat_b, lon_b in cells.get((ci + di, cj + dj), ()):
                        if b == a:
                            continue
                        d = gps.distance_m(lat, lon, lat_b, lon_b)
                        if d <= MATCH_M and (b not in best or d < best[b][1]):
                            best[b] = (tb, d)
            for b, (tb, d) in best.items():
                matches[b].append((t, tb, d))
        for b, hits in matches.items():
            run = [hits[0]]
            for hit in hits[1:] + [None]:
                if hit and hit[0] - run[-1][0] <= MAX_GAP_S + 1:
                    run.append(hit)
                    continue
                if run[-1][0] - run[0][0] + 1 >= min_s:
                    found.append(_candidate(a, b, run, by_drive, max_s))
                if hit:
                    run = [hit]
    found.sort(key=lambda c: (min(c["matched_s"], max_s), c["cross_set"], len(c["force_segments"]),
                              -c["distance_m"]["median"]), reverse=True)
    return found


def _candidate(a: str, b: str, run: list, by_drive, max_s: float) -> dict:
    start = math.ceil(run[0][0])
    duration = int(min(max_s, run[-1][0] - start + 1))
    window = [h for h in run if start <= h[0] <= start + duration]
    force = []
    for _, tb, _ in window:
        s = _segment_at(by_drive, b, tb)
        if s and s.segment_id not in force:
            force.append(s.segment_id)
    own = [s for s in by_drive.get(a, []) if s.t_start < start + duration and s.t_start + s.duration > start]
    covered = sum(s.duration for s in own) >= duration and own and own[0].t_start <= start
    distances = [d for _, _, d in window]
    return {"drive": a, "start_s": float(start), "duration_s": float(duration), "run_s": run[-1][0] - run[0][0] + 1,
            "b_drive": b, "cross_set": a.split("/")[0] != b.split("/")[0], "matched_s": len(window),
            "b_t": [min(h[1] for h in window), max(h[1] for h in window)],
            "distance_m": {"median": round(statistics.median(distances), 1), "max": round(max(distances), 1)},
            "a_indexed": bool(covered), "exclude_segments": [s.segment_id for s in own],
            "force_segments": force}


def clip_name(drive: str, start_s: float) -> str:
    return f"{drive.replace('/', '_')}_t{int(start_s):04d}.mp4"


def _dedupe(found: list[dict]) -> list[dict]:
    """One candidate per street stretch: drops overlapping A windows and mirrors (B's side of a kept pair),
    so a backup never excludes the segments the primary forces."""
    kept = []
    for c in found:
        a0, a1 = c["start_s"], c["start_s"] + c["duration_s"]
        if not any((k["drive"] == c["drive"] and a0 < k["start_s"] + k["duration_s"] and k["start_s"] < a1)
                   or (k["b_drive"] == c["drive"] and a0 <= k["b_t"][1] + 5 and k["b_t"][0] - 5 <= a1)
                   for k in kept):
            kept.append(c)
    return kept


def write(chosen: list[dict], out: Path) -> None:
    excluded = {s for c in chosen for s in c["exclude_segments"]}
    clips, features = [], []
    for c in chosen:
        force = [s for s in c["force_segments"] if s not in excluded]
        if len(force) < len(c["force_segments"]):
            print(f"note: dropped {len(c['force_segments']) - len(force)} forced segments that another clip excludes")
        clips.append({"name": clip_name(c["drive"], c["start_s"]), "drive": c["drive"], "start_s": c["start_s"],
                      "duration_s": c["duration_s"], "source": "s3" if c["a_indexed"] else "local",
                      "b_drive": c["b_drive"], "b_t": c["b_t"], "distance_m": c["distance_m"],
                      "exclude_segments": c["exclude_segments"], "force_segments": force})
        for drive, (t0, t1) in ((c["drive"], (c["start_s"], c["start_s"] + c["duration_s"])), (c["b_drive"], c["b_t"])):
            line = [[lon, lat] for lat, lon in gps.track(drive, t0, t1 - t0)]
            features.append({"type": "Feature", "properties": {"drive": drive, "t": [t0, t1]},
                             "geometry": {"type": "LineString", "coordinates": line}})
    out.write_text(json.dumps({"clips": clips}, indent=1))
    geojson = out.with_name("demo_overlaps.geojson")
    geojson.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"-> {out}\n-> {geojson} (paste into geojson.io to see each overlap)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--top", type=int, default=15)
    parser.add_argument("--min", type=float, default=20, help="shortest stretch in seconds")
    parser.add_argument("--max", type=float, default=30, help="clip length cap in seconds")
    parser.add_argument("--write", type=int, nargs="*", metavar="N",
                        help="candidate numbers for primary then backup (default: 1 2)")
    parser.add_argument("--out", type=Path, default=gps.DATA_DIR / "demo_clips.json")
    args = parser.parse_args()

    if not gps.drives():
        sys.exit("no GPS: run load_gps.py first")
    if not inventory.load():
        sys.exit("no inventory: run build_inventory.py first")
    found = _dedupe(candidates(args.min, args.max))
    if not found:
        sys.exit("no overlapping moving stretches found; try --min 15")
    for n, c in enumerate(found[:args.top], 1):
        print(f"{n:2d}. {c['drive']} t={c['start_s']:.0f}+{c['duration_s']:.0f}s (run {c['run_s']:.0f}s, "
              f"{'indexed' if c['a_indexed'] else 'not indexed: cut from local PIE'}) ~ {c['b_drive']} "
              f"t={c['b_t'][0]:.0f}-{c['b_t'][1]:.0f}s{' [other set]' if c['cross_set'] else ''}; "
              f"{c['distance_m']['median']}/{c['distance_m']['max']} m median/max; "
              f"exclude {len(c['exclude_segments'])}, force {len(c['force_segments'])}: {c['force_segments']}")
    if args.write is not None:
        picks = args.write or list(range(1, min(2, len(found)) + 1))
        if len(picks) < 2:
            print("WARNING: only one clip chosen, there is no backup")
        chosen = [found[n - 1] for n in picks if 1 <= n <= len(found)]
        if len(chosen) != len(picks):
            sys.exit(f"pick numbers between 1 and {len(found)}")
        write(chosen, args.out)


if __name__ == "__main__":
    main()
