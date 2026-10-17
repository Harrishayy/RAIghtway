"""ffmpeg helpers for the live pipeline. All functions are sync: call them via asyncio.to_thread."""
import json
import logging
from pathlib import Path
import shutil
import subprocess
import tempfile

from app import config

log = logging.getLogger(__name__)
PIECE_S = 5.0          # piece length; dedupe derives video time from piece_index * PIECE_S
CROP_PX = 448          # Cosmos-Embed1 input side


def _binary(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    if name == "ffmpeg":
        try:
            import imageio_ffmpeg  # optional fallback, not in requirements.txt
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            pass
    return name


FFMPEG = _binary("ffmpeg")
FFPROBE = _binary("ffprobe")


def _run(args: list[str], timeout: float = 60) -> None:
    result = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args],
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()[-300:]}")


def work_dir(prefix: str = "run-") -> Path:
    """A fresh temp dir under STATE_DIR/work; the caller removes it."""
    root = Path(config.STATE_DIR) / "work"
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=root))


def split(in_path: str, out_dir: str) -> list[str]:
    """720p, silent, 5 s pieces. Forced keyframes keep each cut on a 5 s boundary."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _run(["-i", in_path, "-vf", "scale=-2:720", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-force_key_frames", f"expr:gte(t,n_forced*{PIECE_S:g})",
          "-f", "segment", "-segment_time", f"{PIECE_S:g}", "-reset_timestamps", "1",
          str(out / "seg_%02d.mp4")], timeout=180)
    pieces = sorted(str(p) for p in out.glob("seg_*.mp4"))
    # A sub-second tail piece is noise for Cosmos; drop it.
    if len(pieces) > 1 and probe_duration(pieces[-1]) < 0.5:
        pieces.pop()
    return pieces


def probe_duration(path: str) -> float:
    """Seconds, or 0.0 if unknown."""
    try:
        result = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
                                capture_output=True, text=True, timeout=10, check=True)
        return max(0.0, float(json.loads(result.stdout)["format"]["duration"]))
    except Exception as exc:
        log.warning("ffprobe duration failed (%s)", config.redact(exc))
        return 0.0


def extract_frame(original: str, t: float, out: str) -> str:
    """Full-resolution JPEG at t seconds of the ORIGINAL video; falls back to the last frame past the end."""
    Path(out).unlink(missing_ok=True)
    try:
        _run(["-ss", f"{max(0.0, t):.3f}", "-i", original, "-frames:v", "1", "-q:v", "2", out])
    except RuntimeError:
        pass  # usually t past the end; retry below
    if not Path(out).is_file() or Path(out).stat().st_size == 0:
        _run(["-sseof", "-0.3", "-i", original, "-frames:v", "1", "-q:v", "2", out])
    if not Path(out).is_file():
        raise RuntimeError("ffmpeg produced no frame")
    return out


def crop(jpg: str, bbox, out: str, margin: float = 0.15) -> str:
    """Square crop around the box (plus margin), scaled to 448x448. No box: the whole frame."""
    if bbox is None:
        vf = f"scale={CROP_PX}:{CROP_PX}"
    else:
        cx, cy = bbox.x + bbox.w / 2, bbox.y + bbox.h / 2
        w, h = bbox.w * (1 + 2 * margin), bbox.h * (1 + 2 * margin)
        side = f"min(min(iw,ih),max(iw*{w:.4f},ih*{h:.4f}))"
        vf = (f"crop=w='{side}':h='{side}':x='clip(iw*{cx:.4f}-ow/2,0,iw-ow)':y='clip(ih*{cy:.4f}-oh/2,0,ih-oh)',"
              f"scale={CROP_PX}:{CROP_PX}")
    _run(["-i", jpg, "-vf", vf, "-frames:v", "1", "-q:v", "2", out])
    return out


def still_clip(jpg: str, out: str) -> str:
    """1 s, 8 fps clip of a still image: the embedding input."""
    _run(["-loop", "1", "-i", jpg, "-t", "1", "-r", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", out])
    return out
