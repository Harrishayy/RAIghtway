"""Cut a 20-30 s demo clip (720p, no audio, <= 5 MB) named like set04_video_0008_t0310.mp4 into data/clips/.

Run from backend/:
  .venv/bin/python ../scripts/cut_demo_clip.py --all [--src-dir ~/PIE_clips]       # every clip in demo_clips.json
  .venv/bin/python ../scripts/cut_demo_clip.py --drive set04/video_0008 --start 310 --duration 25 [--src FILE]
The source is a local PIE clip (--src, or {set}_{video}.mp4 / {set}/{video}.mp4 in --src-dir) or, inside the
indexed range, the 30 s chunks in S3_CHUNKS_BUCKET, downloaded READ-ONLY and concatenated.
t in the name is seconds from the PIE clip's start, so parse_upload_name + gps.locate line up.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import config  # noqa: E402
from app.geo import gps, inventory  # noqa: E402

MAX_BYTES = 5 * 1024 * 1024
CRF_STEPS = (23, 26, 29, 32)
CLIPS_DIR = gps.DATA_DIR / "clips"


def clip_name(drive: str, start_s: float) -> str:
    return f"{drive.replace('/', '_')}_t{int(start_s):04d}.mp4"


def encode(inputs: list[str], seek: float, duration: float, out: Path) -> None:
    """ffmpeg cut + 720p re-encode; raises the CRF until the file is <= 5 MB."""
    for crf in CRF_STEPS:
        # -ss before the input seeks fast; with a re-encode it is still frame-accurate.
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{seek:.3f}", *inputs, "-t", f"{duration:.3f}",
               "-vf", "scale=-2:720", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
        subprocess.run(cmd, check=True)
        if out.stat().st_size <= MAX_BYTES:
            return
        print(f"  {out.stat().st_size / 1e6:.1f} MB at crf {crf}, retrying smaller")
    print("  WARNING: still over 5 MB; use a shorter --duration")


def _s3():
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=config.S3_ENDPOINT, aws_access_key_id=config.ACCESS_KEY,
                        aws_secret_access_key=config.SECRET_KEY, verify=False,
                        config=Config(s3={"addressing_style": "path"}, retries={"total_max_attempts": 2}))


def from_chunks(drive: str, start: float, duration: float, out: Path) -> None:
    """Downloads (never writes) the S3 chunks covering [start, start + duration] and cuts across them."""
    segments = [s for s in inventory.load() if s.drive == drive and s.stream_position_sec is not None]
    if not segments:
        sys.exit(f"{drive} has no indexed segments; pass --src with a local PIE clip")
    offset = segments[0].stream_position_sec - segments[0].t_start       # clip start within the set stream
    first, last = offset + start, offset + start + duration
    chunks = {}
    for s in segments:
        chunk_start = s.chunk_start_sec if s.chunk_start_sec is not None else s.stream_position_sec
        if s.original_video and chunk_start < last and chunk_start + 30 > first:
            chunks[s.original_video] = chunk_start
    ordered = sorted(chunks.items(), key=lambda kv: kv[1])
    if not ordered or ordered[0][1] > first + 0.01 or ordered[-1][1] + 30 < last - 0.01:
        sys.exit(f"{drive} t={start:.0f}+{duration:.0f}s is outside the indexed chunks; pass --src")
    client = _s3()
    with tempfile.TemporaryDirectory() as tmp:
        listing = Path(tmp) / "list.txt"
        lines = []
        for n, (uri, _) in enumerate(ordered):
            bucket, key = uri.removeprefix("s3://").split("/", 1)
            local = Path(tmp) / f"chunk_{n:03d}.mp4"
            try:
                client.download_file(bucket, key, str(local))          # read-only
            except Exception as exc:
                sys.exit(f"chunk download failed ({config.redact(exc)})")
            lines.append(f"file '{local}'")
        listing.write_text("\n".join(lines) + "\n")
        print(f"  {len(ordered)} chunks from S3, seek {first - ordered[0][1]:.1f} s")
        encode(["-f", "concat", "-safe", "0", "-i", str(listing)], first - ordered[0][1], duration, out)


def local_source(drive: str, src: Path | None, src_dir: Path | None) -> Path | None:
    if src:
        return src
    if src_dir:
        set_id, video = drive.split("/")
        for path in (src_dir / f"{set_id}_{video}.mp4", src_dir / set_id / f"{video}.mp4"):
            if path.is_file():
                return path
    return None


def cut(drive: str, start: float, duration: float, src: Path | None, src_dir: Path | None, out_dir: Path) -> Path:
    if int(start) != start:
        print(f"  start {start} rounded down to {int(start)} s (names carry whole seconds)")
        start = float(int(start))
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / clip_name(drive, start)
    source = local_source(drive, src, src_dir)
    print(f"{out.name}: {drive} t={start:.0f}+{duration:.0f}s from {source or 'S3 chunks'}")
    if source:
        encode(["-i", str(source)], start, duration, out)
    else:
        from_chunks(drive, start, duration, out)
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=width,height:format=duration", "-of", "json", str(out)],
                           capture_output=True, text=True)
    info = json.loads(probe.stdout or "{}")
    size = (info.get("streams") or [{}])[0]
    print(f"  {size.get('width')}x{size.get('height')}, {float(info.get('format', {}).get('duration', 0)):.1f} s, "
          f"{out.stat().st_size / 1e6:.2f} MB")
    print(f"  parse_upload_name -> {gps.parse_upload_name(out.name)}; "
          f"locate(start) -> {gps.locate(drive, start)}; track points {len(gps.track(drive, start, duration))}")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true", help="cut every clip in data/demo_clips.json")
    parser.add_argument("--drive", help="e.g. set04/video_0008")
    parser.add_argument("--start", type=float, help="seconds from the PIE clip's start")
    parser.add_argument("--duration", type=float, default=25)
    parser.add_argument("--src", type=Path, help="local PIE clip file for --drive")
    parser.add_argument("--src-dir", type=Path, help="folder of local PIE clips")
    parser.add_argument("--out-dir", type=Path, default=CLIPS_DIR)
    args = parser.parse_args()

    if args.all:
        clips = json.loads((gps.DATA_DIR / "demo_clips.json").read_text())["clips"]
        for c in clips:
            cut(c["drive"], c["start_s"], c["duration_s"], None, args.src_dir, args.out_dir)
    elif args.drive and args.start is not None:
        if not 1 <= args.duration <= 60:
            sys.exit("--duration must be 1-60 s (demo clips are 20-30 s)")
        cut(args.drive, args.start, args.duration, args.src, args.src_dir, args.out_dir)
    else:
        parser.error("use --all, or --drive and --start")


if __name__ == "__main__":
    main()
