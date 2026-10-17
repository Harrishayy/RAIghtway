"""Build one playable 480p MP4 per corpus video (drive) for GET /api/videos/{id}/file.

Corpus videos span many 5 s S3 segments, so there is no single file to play. This downloads a drive's
segments in time order, re-encodes each to 480p with a keyframe every 0.5 s (so scrubbing is snappy),
and joins them into STATE_DIR/videos/corpus-setNN-video_XXXX.mp4. Video time 0 is the drive's first
indexed segment, the same origin issue.t uses. Existing files are skipped, so it is safe to re-run.

    .venv/bin/python ../scripts/build_video_proxies.py                 # all drives
    .venv/bin/python ../scripts/build_video_proxies.py --drive set04/video_0002
"""
import argparse
import logging
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import config  # noqa: E402
from app.geo import inventory  # noqa: E402
from app.pipeline import precompute  # noqa: E402

log = logging.getLogger("build_video_proxies")
WORKERS = 6
ENCODE = ["-vf", "scale=-2:480,fps=30", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
          "-g", "15", "-pix_fmt", "yuv420p", "-f", "mpegts"]


def piece(seg, work: Path) -> Path:
    """One segment -> 480p MPEG-TS (joins cleanly with -c copy)."""
    raw, out = work / f"{seg.segment_id}", work / f"{seg.segment_id}.ts"
    precompute._download(seg.source_uri, str(raw))
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), *ENCODE, str(out)], check=True, timeout=120)
    finally:
        raw.unlink(missing_ok=True)
    return out


def build(drive: str, segs: list, out_dir: Path) -> None:
    out = out_dir / f"{precompute._video_id(drive)}.mp4"
    if out.exists():
        log.info("%s exists; skipping", out.name)
        return
    segs = sorted(segs, key=lambda s: s.t_start)
    gaps = [round(b.t_start - (a.t_start + a.duration), 2) for a, b in zip(segs, segs[1:])
            if abs(b.t_start - (a.t_start + a.duration)) > 0.05]
    if gaps:
        log.warning("%s has gaps %s; footage after a gap will run early", drive, gaps[:5])
    work = Path(tempfile.mkdtemp(prefix="proxy-", dir=out_dir))
    try:
        with ThreadPoolExecutor(WORKERS) as pool:
            pieces = list(pool.map(lambda s: piece(s, work), segs))
        listing = work / "list.txt"
        listing.write_text("".join(f"file '{p.name}'\n" for p in pieces))
        partial = work / "joined.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-c", "copy", "-movflags", "+faststart", str(partial)], check=True, timeout=300)
        partial.replace(out)
        log.info("%s: %d segments -> %s (%.1f MB)", drive, len(segs), out.name, out.stat().st_size / 1e6)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--drive", help="only this drive, e.g. set04/video_0002")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("botocore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    by_drive: dict[str, list] = {}
    for seg in inventory.load():
        by_drive.setdefault(seg.drive, []).append(seg)
    out_dir = Path(config.STATE_DIR) / "videos"
    out_dir.mkdir(parents=True, exist_ok=True)
    for drive in [args.drive] if args.drive else sorted(by_drive):
        try:
            build(drive, by_drive[drive], out_dir)
        except Exception as exc:
            log.warning("%s failed (%s)", drive, config.redact(exc))


if __name__ == "__main__":
    main()
