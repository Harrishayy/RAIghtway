"""Cosmos finding and localisation with bounded parsing and graceful fallbacks."""
import asyncio
import base64
from contextvars import ContextVar
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess

from pydantic import BaseModel, Field, RootModel

from app import config
from app.models import BBox, Detection, FindResult, SeverityRating
from app.ai import gpu, nemotron
from app.ai.prompts import BOX_PROMPT, FIND_PROMPT, _extract_json, normalise_category, rate_prompt
from app.ai.weave_setup import op

log = logging.getLogger(__name__)
# Confirmed at gate 3: Cosmos uses coordinates from 0 to 1000 on each axis.
BOX_COORDS = os.environ.get("COSMOS_BOX_COORDS", "1000").lower()
if BOX_COORDS not in {"auto", "pixel", "1000", "1"}:
    BOX_COORDS = "auto"
_find_diagnostics: ContextVar[dict | None] = ContextVar("cosmos_find", default=None)
_box_diagnostics: ContextVar[dict | None] = ContextVar("cosmos_box", default=None)


def _duration(path: str) -> float:
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                 "-of", "default=noprint_wrappers=1:nokey=1", path],
                                capture_output=True, text=True, check=True, timeout=5)
        value = float(result.stdout.strip())
        if math.isfinite(value) and value > 0:
            return value
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return 5.0


async def _request(content: list[dict]) -> str:
    if not config.COSMOS3_REASON_URL:
        raise RuntimeError("COSMOS3_REASON_URL is not configured")
    async with gpu.slot():
        response = await gpu.client().post(config.COSMOS3_REASON_URL.rstrip("/") + "/v1/chat/completions",
            json={"model": config.COSMOS3_REASON_MODEL,
                  "messages": [{"role": "user", "content": content}],
                  "temperature": 0.0, "max_tokens": 1000})   # 0: rehearsal and live demo see the same findings
        response.raise_for_status()
    message = response.json()["choices"][0]["message"]
    content = message.get("content")
    if content is None or not content.strip():
        content = message.get("reasoning_content")
    return content


def _number(value) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Expected a finite number")
    return number


def _parse_find(raw: str, duration: float) -> FindResult:
    parsed = _extract_json(raw)
    if not isinstance(parsed.get("issues"), list):
        raise ValueError("Find reply must contain an issues list")
    issues = []
    skipped = 0
    for item in parsed["issues"]:
        try:
            category = normalise_category(item.get("category") or item.get("type") or item.get("label"),
                                          item.get("description", "")) if isinstance(item, dict) else None
            if category is None:
                skipped += 1
                continue
            issues.append(Detection(
                piece_index=0, t_piece=max(0.0, min(duration, _number(item.get("t", 0)))),
                category=category, severity=max(1, min(5, int(_number(item["severity"])))),
                confidence=max(0.0, min(1.0, _number(item["confidence"]))),
                description=" ".join(str(item["description"]).split()[:20])))
        except (KeyError, ValueError, TypeError, OverflowError):
            skipped += 1
    if skipped:
        log.warning("Cosmos find: skipped %d malformed issue items", skipped)
    scene = parsed.get("scene")
    return FindResult(issues=issues, scene=scene if isinstance(scene, str) else None)


@op
async def find_issues(piece_path: str) -> FindResult:
    diagnostic = {"attempts": 0, "valid_replies": 0, "ok": False}
    _find_diagnostics.set(diagnostic)
    try:
        data = await asyncio.to_thread(Path(piece_path).read_bytes)
        duration = await asyncio.to_thread(_duration, piece_path)
        content = [{"type": "text", "text": FIND_PROMPT},
                   {"type": "video_url", "video_url": {
                       "url": "data:video/mp4;base64," + base64.b64encode(data).decode("ascii")}}]
        for attempt in range(2):
            diagnostic["attempts"] += 1
            raw = await _request(content)
            try:
                result = _parse_find(raw, duration)
                diagnostic.update(valid_replies=1, ok=True)
                return result
            except (ValueError, TypeError):
                log.warning("Cosmos find: invalid JSON/schema (attempt %d)", attempt + 1)
                content[0] = {"type": "text", "text": FIND_PROMPT +
                              "\nYour previous reply was invalid. Return complete JSON only."}
    except Exception as exc:
        log.warning("Cosmos find: empty fallback (%s)", config.redact(exc))
    return FindResult(issues=[])


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """Read dimensions from a JPEG Start Of Frame marker without Pillow."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("Expected a JPEG image")
    pos = 2
    sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while pos < len(data):
        if data[pos] != 0xFF:
            raise ValueError("Invalid JPEG marker")
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]
        pos += 1
        if marker in {0xD9, 0xDA}:
            break
        if marker in {0x01, 0xD8, *range(0xD0, 0xD8)}:
            continue
        if pos + 2 > len(data):
            break
        length = int.from_bytes(data[pos:pos + 2], "big")
        if length < 2 or pos + length > len(data):
            break
        if marker in sof and length >= 8:
            height = int.from_bytes(data[pos + 3:pos + 5], "big")
            width = int.from_bytes(data[pos + 5:pos + 7], "big")
            if width > 0 and height > 0:
                return width, height
            break
        pos += length
    raise ValueError("JPEG dimensions not found")


def _normalise_box(coords, dimensions: tuple[int, int] | None, space: str = BOX_COORDS) -> BBox:
    # Cosmos sometimes answers corner pairs [[x1, y1], [x2, y2]] instead of a flat list.
    if isinstance(coords, list) and len(coords) == 2 and all(isinstance(p, list) and len(p) == 2 for p in coords):
        coords = [*coords[0], *coords[1]]
    if not isinstance(coords, list) or len(coords) != 4:
        raise ValueError("Expected four box coordinates")
    values = [_number(value) for value in coords]
    if space == "auto":
        space = "1" if max(values) <= 1 else "pixel" if max(values) > 1000 else "1000"
    if space == "pixel":
        if dimensions is None:
            raise ValueError("Pixel box needs JPEG dimensions")
        sx, sy = dimensions
    elif space in {"1", "1000"}:
        sx = sy = float(space)
    else:
        raise ValueError("Unsupported box coordinate space")
    x1, y1, x2, y2 = [max(0.0, min(1.0, value / scale))
                       for value, scale in zip(values, (sx, sy, sx, sy))]
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    if x1 == x2 or y1 == y2:
        raise ValueError("Box has no visible area")
    return BBox(x=x1, y=y1, w=x2 - x1, h=y2 - y1)


class _BoxReply(RootModel[list[float]]):
    root: list[float] = Field(min_length=4, max_length=4)


@op
async def box(frame_path: str, category: str, description: str) -> BBox | None:
    diagnostic = {"raw": None, "fallback_raw": None, "source": None}
    _box_diagnostics.set(diagnostic)
    try:
        data = await asyncio.to_thread(Path(frame_path).read_bytes)
        try:
            dimensions = _jpeg_size(data)
        except ValueError:
            dimensions = None
        content = [{"type": "text", "text": BOX_PROMPT.format(category=category, description=description)},
                   {"type": "image_url", "image_url": {
                       "url": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")}}]
    except Exception as exc:
        log.warning("Cosmos box: image unavailable (%s)", config.redact(exc))
        return None
    try:
        raw = await _request(content)
        diagnostic["raw"] = raw
        # Tuple syntax "[(680, 731), (773, 791)]" (seen at gate 3) isn't JSON; read it as arrays.
        coords = _extract_json(raw.replace("(", "[").replace(")", "]"), array=True)
        if coords is None:
            diagnostic["source"] = "cosmos"
            return None
        if isinstance(coords, dict):
            coords = coords.get("bbox", coords.get("box"))
        result = _normalise_box(coords, dimensions, BOX_COORDS)
        diagnostic["source"] = "cosmos"
        return result
    except Exception as exc:
        log.warning("Cosmos box: trying Nemotron VL (%s)", config.redact(exc))
    try:
        reply = await nemotron.chat_json([{"role": "user", "content": content}], _BoxReply,
                                         model=nemotron.SUPER_VL, timeout=15.0)
        diagnostic["fallback_raw"] = reply.root
        result = _normalise_box(reply.root, dimensions, BOX_COORDS)
        diagnostic["source"] = "nemotron"
        return result
    except Exception as exc:
        log.warning("Cosmos box: no box fallback (%s)", config.redact(exc))
        return None


# ---- Severity rating (app/ai/rating.py drives it over many issues) ----

COSMOS_RATER = "cosmos3-reason"
NEMOTRON_RATER = "nemotron-super-vl"
_TRUE = {"true", "yes", "y", "1", "real"}
_FALSE = {"false", "no", "n", "0", "not real", "false positive"}


class _RateReply(BaseModel):
    observed: str = ""
    reason: str = ""
    real: bool | str = True
    severity: int | float | str


def _parse_rating(value, model: str) -> SeverityRating:
    """A rater's JSON -> SeverityRating. Lenient on spelling ("yes", "4"), strict on meaning: a missing or
    out-of-range severity, or a verdict it can't read, is an error rather than a guess."""
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if not isinstance(value, dict):
        raise ValueError("Rating reply must be a JSON object")
    severity = int(round(_number(value.get("severity"))))
    if not 1 <= severity <= 5:
        raise ValueError("Severity out of range")
    real = value.get("real", True)
    if isinstance(real, str):
        text = real.strip().lower()
        if text not in _TRUE | _FALSE:
            raise ValueError("Unreadable verdict")
        real = text in _TRUE
    observed = " ".join(str(value.get("observed") or "").split()[:30]) or None
    reason = " ".join(str(value.get("reason") or "").split()[:40]) or observed
    if not reason:
        raise ValueError("Rating has no reason")
    return SeverityRating(severity=severity, reason=reason, observed=observed, model=model,
                          verdict="confirmed" if bool(real) else "rejected")


def _data_url(path: str) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(Path(path).read_bytes()).decode("ascii")


@op
async def rate(frame_path: str, category: str, description: str, bbox: BBox | None = None) -> SeverityRating | None:
    """Re-grade one finding from its keyframe: Cosmos3-Reason sees the boxed frame and a close-up; Nemotron
    Super-VL (one image per prompt) is the fallback. None when neither answers. Never raises."""
    from app.pipeline import segment     # ffmpeg helpers; imported here to keep this module light for tests
    try:
        work = await asyncio.to_thread(segment.work_dir, "rate-")
    except Exception as exc:
        log.warning("Rate: no work dir (%s)", config.redact(exc))
        return None
    try:
        try:
            marked, zoom = await asyncio.to_thread(segment.rating_views, frame_path, bbox,
                                                   str(work / "frame.jpg"), str(work / "zoom.jpg"))
            marked_url, zoom_url = await asyncio.to_thread(_data_url, marked), await asyncio.to_thread(_data_url, zoom)
        except Exception as exc:
            log.warning("Rate: frame unavailable (%s)", config.redact(exc))
            return None
        content = [{"type": "text", "text": rate_prompt(category, description)},
                   {"type": "image_url", "image_url": {"url": marked_url}},
                   {"type": "image_url", "image_url": {"url": zoom_url}}]
        for attempt in range(2):
            try:
                raw = await _request(content)
                return _parse_rating(_extract_json(raw), COSMOS_RATER)
            except (ValueError, TypeError) as exc:
                log.warning("Cosmos rate: invalid reply (attempt %d: %s)", attempt + 1, config.redact(exc))
                content[0] = {"type": "text", "text": rate_prompt(category, description) +
                              "\nYour previous reply was invalid. Return the complete JSON object only."}
            except Exception as exc:
                log.warning("Cosmos rate: trying Nemotron VL (%s)", config.redact(exc))
                break
        try:
            reply = await nemotron.chat_json([{"role": "user", "content": [
                {"type": "text", "text": rate_prompt(category, description, single=True)},
                {"type": "image_url", "image_url": {"url": marked_url}}]}],
                _RateReply, model=nemotron.SUPER_VL, timeout=40.0)
            return _parse_rating(reply, NEMOTRON_RATER)
        except Exception as exc:
            log.warning("Rate: no rating (%s)", config.redact(exc))
            return None
    finally:
        shutil.rmtree(work, ignore_errors=True)
