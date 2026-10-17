"""PIE annotations_vehicle/*_obd.xml -> data/gps.csv (1 Hz) + data/clip_durations.json.

Run from backend/:  .venv/bin/python ../scripts/load_gps.py [--src DIR] [--db]
--db also inserts the rows into the CityMaint `gps` table (insert-only: run it once).
"""
import argparse
import csv
import json
from pathlib import Path
import re
import statistics
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import config  # noqa: E402
from app.geo import gps  # noqa: E402

FPS = 30
LAT_RANGE, LON_RANGE = (43.5, 43.9), (-79.7, -79.1)     # Toronto
COLUMNS = ["drive", "t", "lat", "lon", "heading", "speed"]


def drive_id(path: Path) -> str | None:
    """set04/video_0008 from .../set04/video_0008_obd.xml (or set04_video_0008_obd.xml)."""
    text = path.as_posix()
    video = re.search(r"(video_\d+)", path.name, re.IGNORECASE)
    sets = re.findall(r"(set\d+)", text, re.IGNORECASE)
    return f"{sets[-1].lower()}/{video[1].lower()}" if video and sets else None


def _float(attrs: dict, *names: str) -> float | None:
    for name in names:
        try:
            return float(attrs[name])
        except (KeyError, TypeError, ValueError):
            continue
    return None


def parse(path: Path) -> tuple[int, list[dict], dict]:
    """(frame count, 1 Hz rows, drop counts). Keeps the frame at each whole second (id % 30 == 0)."""
    drive = drive_id(path)
    frames, rows, dropped = 0, [], {"zero": 0, "outside": 0, "bad": 0}
    for _, elem in ET.iterparse(path, events=("end",)):
        if elem.tag != "frame":
            continue
        attrs = elem.attrib
        frame = int(_float(attrs, "id") or frames)
        frames = max(frames, frame + 1)
        if frame % FPS == 0:
            lat, lon = _float(attrs, "latitude"), _float(attrs, "longitude")
            if lat is None or lon is None:
                dropped["bad"] += 1
            elif lat == 0 or lon == 0:
                dropped["zero"] += 1
            elif not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
                dropped["outside"] += 1
            else:
                rows.append({"drive": drive, "t": frame / FPS, "lat": lat, "lon": lon,
                             "heading": _float(attrs, "heading_angle") or 0.0,
                             "speed": _float(attrs, "OBD_speed", "GPS_speed") or 0.0})
        elem.clear()
    return frames, rows, dropped


def heading_check(rows: list[dict]) -> str:
    """Compares the logged heading_angle with the course over ground while moving."""
    diffs = []
    for a, b in zip(rows, rows[1:]):
        if a["drive"] == b["drive"] and b["t"] - a["t"] == 1 and a["speed"] >= 10:
            if gps.distance_m(a["lat"], a["lon"], b["lat"], b["lon"]) >= 2:
                course = gps.bearing(a["lat"], a["lon"], b["lat"], b["lon"])
                diffs.append((a["heading"] - course + 180) % 360 - 180)
    if not diffs:
        return "heading check: no moving samples"
    return (f"heading check: logged heading - course over ground, median {statistics.median(diffs):+.1f} deg, "
            f"median |diff| {statistics.median(abs(d) for d in diffs):.1f} deg over {len(diffs)} samples "
            "(near 0 = compass degrees; locate() uses the course when moving anyway)")


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, default=root / "data/pie/annotations_vehicle")
    parser.add_argument("--out", type=Path, default=gps.GPS_CSV)
    parser.add_argument("--durations", type=Path, default=gps.DATA_DIR / "clip_durations.json")
    parser.add_argument("--db", action="store_true", help="also insert rows into VastDB gps (once)")
    args = parser.parse_args()

    files = sorted(p for p in args.src.rglob("*") if p.is_file() and p.name.lower().endswith("_obd.xml"))
    if not files:
        sys.exit(f"no *_obd.xml under {args.src}")
    all_rows, durations, totals = [], {}, {"zero": 0, "outside": 0, "bad": 0}
    for path in files:
        drive = drive_id(path)
        if not drive:
            print(f"skip {path}: no setXX/video_YYYY in the path")
            continue
        try:
            frames, rows, dropped = parse(path)
        except ET.ParseError as exc:
            print(f"skip {path}: {exc}")
            continue
        durations[drive] = round(frames / FPS, 3)
        all_rows += rows
        for key, value in dropped.items():
            totals[key] += value
        note = ", ".join(f"{k} {v}" for k, v in dropped.items() if v)
        print(f"{drive}: {frames} frames = {frames / FPS:.1f} s, {len(rows)} rows kept" + (f" (dropped {note})" if note else ""))

    all_rows.sort(key=lambda r: (r["drive"], r["t"]))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        for r in all_rows:
            writer.writerow([r["drive"], f"{r['t']:.3f}", f"{r['lat']:.7f}", f"{r['lon']:.7f}",
                             f"{r['heading']:.2f}", f"{r['speed']:.2f}"])
    args.durations.write_text(json.dumps(dict(sorted(durations.items())), indent=1))

    stopped = sum(r["speed"] < 2 for r in all_rows)
    print(f"\n{len(files)} files, {len(durations)} drives, {sum(durations.values()) / 3600:.2f} h")
    print(f"{len(all_rows)} rows -> {args.out}; dropped at 1 Hz: {totals}")
    print(f"stopped (< 2 km/h): {stopped / max(len(all_rows), 1):.0%}")
    print(heading_check(all_rows))
    print(f"durations -> {args.durations}")

    if args.db:
        from app.vast import db
        try:
            for start in range(0, len(all_rows), 10000):
                db.insert_gps(all_rows[start:start + 10000])
                print(f"VastDB gps: {min(start + 10000, len(all_rows))}/{len(all_rows)}")
        except Exception as exc:
            sys.exit(f"VastDB insert failed ({config.redact(exc)}); gps.csv is the fallback")


if __name__ == "__main__":
    main()
