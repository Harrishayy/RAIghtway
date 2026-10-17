"""VM-only manual gates: python -m app.ai.gatecheck --help."""
import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import tempfile
from time import perf_counter

from pydantic import BaseModel

from app import config
from app.ai import cosmos, embed, gpu, nemotron, weave_setup
from app.ai.prompts import CATEGORIES


class _TinyReply(BaseModel):
    ok: bool


class _ReportReply(BaseModel):
    summary: str
    counts: dict[str, int]
    crews: dict[str, int]
    rationale: str


def _row(call: str, ok: bool, elapsed: float, result) -> None:
    rendered = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
    print(f"{call:<28} {'ok' if ok else 'failed':<6} {elapsed:>7.2f}s  {rendered}")


async def _timed(call: str, operation):
    start = perf_counter()
    try:
        result = await operation
        return True, perf_counter() - start, result
    except Exception as exc:
        elapsed = perf_counter() - start
        _row(call, False, elapsed, {"error": config.redact(exc)})
        return False, elapsed, None


def _still_clip(image: str, output: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1",
                    "-i", image, "-t", "1", "-r", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-vf", "scale=448:448", output],
                   capture_output=True, check=True, timeout=30)


async def _run(args) -> bool:
    weave_setup.init()
    print(f"{'call':<28} {'status':<6} {'latency':>8}  result")
    passed = True
    attempts = valid = succeeded = 0
    latencies = []
    for index, video in enumerate(args.video, start=1):
        label = f"find[{index}] {Path(video).name}"
        ok, elapsed, result = await _timed(label, cosmos.find_issues(video))
        diagnostic = cosmos._find_diagnostics.get() or {}
        ok = ok and bool(diagnostic.get("ok"))
        attempts += diagnostic.get("attempts", 0)
        valid += diagnostic.get("valid_replies", 0)
        succeeded += int(ok)
        latencies.append(elapsed)
        passed &= ok
        if result is not None:
            _row(label, ok, elapsed, result.model_dump(exclude_none=True))
    if latencies:
        rate = f"{100 * valid / attempts:.1f}%" if attempts else "n/a"
        print(f"Find JSON validity: {valid}/{attempts} request attempts ({rate}); "
              f"valid segments: {succeeded}/{len(latencies)}; "
              f"mean segment latency: {sum(latencies) / len(latencies):.2f}s")

    if args.image:
        ok, elapsed, result = await _timed("box", cosmos.box(args.image, args.category, args.description))
        diagnostic = cosmos._box_diagnostics.get() or {}
        print("Box raw reply:", json.dumps(diagnostic.get("raw"), ensure_ascii=True))
        if diagnostic.get("fallback_raw") is not None:
            print("Nemotron box parsed reply:", json.dumps(diagnostic["fallback_raw"]))
        ok = ok and result is not None
        _row("box", ok, elapsed, {"coords": cosmos.BOX_COORDS, "source": diagnostic.get("source"),
                                  "box": result.model_dump() if result is not None else None})
        passed &= ok
        with tempfile.TemporaryDirectory(prefix="citymaint-gate-") as directory:
            output = str(Path(directory) / "still.mp4")
            built, elapsed, _ = await _timed("still clip", asyncio.to_thread(_still_clip, args.image, output))
            if built:
                _row("still clip", True, elapsed, {"seconds": 1, "fps": 8, "size": "448x448"})
                ok, elapsed, embedding = await _timed("embed", embed.embed_clip(output))
                if ok:
                    _row("embed", True, elapsed, {"length": len(embedding)})
                passed &= ok
            else:
                passed = False

    if args.nemotron:
        ok, elapsed, reply = await _timed("nemotron tiny", nemotron.chat_json(
            [{"role": "user", "content": 'Return {"ok":true}.'}], _TinyReply, timeout=15.0))
        if ok:
            _row("nemotron tiny", reply.ok, elapsed, reply.model_dump())
            ok = reply.ok
        passed &= ok
        records = [{"id": f"gate-{i}", "category": CATEGORIES[i % len(CATEGORIES)],
                    "severity": i % 5 + 1, "sightings": i % 3 + 1,
                    "description": "Visible street-maintenance defect requiring crew assessment"}
                   for i in range(60)]
        messages = [{"role": "user", "content":
            "Prepare a city maintenance report from these synthetic gate-check issues. "
            "Give a factual summary, counts by category, recommended crew counts and rationale. "
            "Use crews roads, graffiti, markings, inspection, signage and sanitation. " + json.dumps(records)}]
        for name, model in (("LIGHTNING", nemotron.LIGHTNING), ("ULTRA", nemotron.ULTRA)):
            label = "report " + name
            ok, elapsed, reply = await _timed(label, nemotron.chat_json(
                messages, _ReportReply, model=model, timeout=10.0))
            if ok:
                _row(label, True, elapsed, reply.model_dump())
            passed &= ok
        print("Verify on the day: confirm these calls and their latencies appear in Weave.")
    return passed


async def _main(args) -> bool:
    try:
        return await _run(args)
    finally:
        if gpu._client is not None:
            await gpu._client.aclose()
        if nemotron._client is not None:
            await nemotron._client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", nargs="+", default=[], help="Local video pieces for gate 3")
    parser.add_argument("--image", help="JPEG with an obvious issue for box and embedding gates")
    parser.add_argument("--category", choices=CATEGORIES, default="pavement")
    parser.add_argument("--description", default="the clearly visible pavement defect")
    parser.add_argument("--nemotron", action="store_true", help="Run gate 6 (10s report budget per model)")
    args = parser.parse_args()
    if not (args.video or args.image or args.nemotron):
        parser.error("provide --video, --image or --nemotron")
    raise SystemExit(0 if asyncio.run(_main(args)) else 1)


if __name__ == "__main__":
    main()
