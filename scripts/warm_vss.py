"""Warm the VSS search cache with the demo's footage queries, and preview what each returns.

Run from backend/ on the VM:  .venv/bin/python ../scripts/warm_vss.py ["query" ...] [--show 3]
Queries run one at a time through vss_client (>= 2 s apart, cached in state/vss_search_cache.json),
so on stage the console's search is answered from the cache. A cached query costs no VSS request.
Uses the same normalisation, top_k and llm_top_n as POST /api/search, so the cache keys match.
"""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.geo import inventory  # noqa: E402
from app.models import VideoRecord  # noqa: E402
from app.pipeline import topic_search, vss_client  # noqa: E402

# Checked on the corpus 2026-10-17: these return on-topic bands. "flooding or standing water" returns none
# (VSS's answer says so), which is a fair thing to show too.
DEMO_QUERIES = ["traffic cones and construction", "graffiti on a wall", "damaged sidewalk", "faded crosswalk",
                "debris on the road", "pothole", "flooding or standing water"]


def corpus_videos() -> dict[str, VideoRecord]:
    """One corpus video per inventory drive, as precompute names them (start 0, spans its segments)."""
    spans: dict[str, float] = {}
    for s in inventory.load():
        spans[s.drive] = max(spans.get(s.drive, 0.0), s.t_start + s.duration)
    now = datetime.now(timezone.utc)
    return {f"corpus-{d.replace('/', '-')}": VideoRecord(id=f"corpus-{d.replace('/', '-')}", filename=d, source="corpus",
                                                         status="done", progress=1.0, drive=d, duration_s=end, created_at=now)
            for d, end in spans.items()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("queries", nargs="*", help=f"defaults to the {len(DEMO_QUERIES)} demo queries")
    parser.add_argument("--show", type=int, default=3, help="top bands to print per query")
    args = parser.parse_args()
    videos = corpus_videos()
    if not videos:
        print("No inventory; run build_inventory.py first", file=sys.stderr)
        return 1
    failed = 0
    for raw in args.queries or DEMO_QUERIES:
        q = topic_search.normalise(raw)
        try:
            answer = vss_client.search_full(q, top_k=topic_search.TOP_K, llm_top_n=topic_search.LLM_TOP_N)
        except Exception as exc:
            print(f"✗ {q!r}: {exc}")
            failed += 1
            continue
        hits = topic_search.map_hits(answer["results"], videos, q)
        drives = len({h.video_id for h in hits})
        print(f"{'·' if answer['cached'] else '✓'} {q!r}: {len(answer['results'])} segments -> {len(hits)} bands on {drives} drives")
        if answer["synthesis"]:
            print(f"    VSS: {answer['synthesis'][:200]}")
        for h in hits[:args.show]:
            print(f"    {h.video_id} {h.start:>6.1f}-{h.end:<6.1f} sim {h.similarity:.3f}  {h.caption}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
