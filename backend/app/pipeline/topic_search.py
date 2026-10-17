"""Plain-language footage search over the VSS index: VSS segment hits -> moments on the console's drives.

VSS returns 5 s segments of the `pie_cam-3` index. Each maps through the inventory
(segment -> drive, t_start) to a corpus video and a time range on its timeline;
touching segments on one drive merge into one band. There is no fallback: when VSS
is down the caller answers 503, so a result here always came from VSS. Nemotron then
answers the search from the bands and the issues already logged inside them
(app/ai/summaries.py); if it is slow or down the answer is left empty.
"""
import asyncio
import logging
import re

from app import config
from app.geo import inventory
from app.models import IssueRecord, TopicHit, TopicSearch, Video
from app.pipeline import vss_client

log = logging.getLogger(__name__)
TOP_K = 50                  # VSS caps top_k at 100; 50 covers the 12 drives without long waits
TIMEOUT_S = 12.0            # under the console's 15 s request timeout; the VSS client is serialised, so a query can queue
LLM_TOP_N = 3               # clips VSS summarises into `synthesis`
CAPTION_CHARS = 160
RELATIVE_FLOOR = 0.6        # drop bands below this share of the best similarity (VSS pads weak queries with noise)
MIN_SIMILARITY = 0.1        # and below this outright: "flooding" over dry streets scores about 0.04
MIN_QUERY, MAX_QUERY = 3, 200


class SearchUnavailable(Exception):
    """VSS could not answer (not configured, down or busy). The message is safe to show."""


def normalise(query: str) -> str:
    """Trimmed, lower-case, single-spaced, so repeat queries hit the VSS cache. ValueError if unusable."""
    q = re.sub(r"\s+", " ", (query or "").strip().lower())
    if not MIN_QUERY <= len(q) <= MAX_QUERY:
        raise ValueError(f"Search needs {MIN_QUERY}-{MAX_QUERY} characters")
    return q


def _stems(text: str) -> set[str]:
    return {w[:5] for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in _STOP}


_STOP = {"the", "and", "with", "for", "from", "into", "onto", "that", "this", "are", "was", "near", "some", "any"}


def _caption(text, query: str = "") -> str:
    """The sentence of the VSS caption that shares most words with the query (the first opens with scene-setting)."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    sentences = [x for x in re.split(r"(?<=[.!?])\s", text) if x] or [""]
    want = _stems(query)
    best = max(sentences, key=lambda x: len(want & _stems(x))) if want else sentences[0]
    return best if len(best) <= CAPTION_CHARS else best[:CAPTION_CHARS - 1].rstrip() + "…"


def _float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def map_hits(results: list[dict], videos: dict[str, Video], query: str = "") -> list[TopicHit]:
    """VSS segment hits -> merged bands on the given videos, best first. Unmapped and weak hits are dropped."""
    segments = inventory.by_id()
    floor = max(MIN_SIMILARITY, RELATIVE_FLOOR * max((_float(h.get("similarity_score")) for h in results), default=0.0))
    by_drive = {v.drive: v for v in videos.values() if v.source == "corpus" and v.drive}
    bands: list[dict] = []
    for rank, hit in enumerate(results):
        name = str(hit.get("filename") or "") or str(hit.get("source") or "").rsplit("/", 1)[-1]
        seg = segments.get(name)
        video = by_drive.get(seg.drive) if seg else None
        if video is None or _float(hit.get("similarity_score")) < floor:
            continue
        start = seg.t_start - (video.start_s or 0.0)
        end = start + (seg.duration or 5.0)
        if end <= 0 or start >= video.duration_s:
            continue
        bands.append({"video_id": video.id, "start": max(0.0, start), "end": min(video.duration_s, end),
                      "rank": rank, "similarity": _float(hit.get("similarity_score")),
                      "caption": _caption(hit.get("reasoning_content"), query)})
    merged: list[dict] = []
    for band in sorted(bands, key=lambda b: (b["video_id"], b["start"])):
        last = merged[-1] if merged else None
        if last and last["video_id"] == band["video_id"] and band["start"] <= last["end"] + 0.01:
            last["end"] = max(last["end"], band["end"])
            if band["rank"] < last["rank"]:
                last.update(rank=band["rank"], similarity=band["similarity"], caption=band["caption"])
        else:
            merged.append(dict(band))
    merged.sort(key=lambda b: b["rank"])
    n = len(merged)
    return [TopicHit(video_id=b["video_id"], start=round(b["start"], 2), end=round(b["end"], 2),
                     score=round(1.0 - i / n, 3) if n > 1 else 1.0, similarity=round(b["similarity"], 4),
                     caption=b["caption"]) for i, b in enumerate(merged)]


LOGGED_SLACK_S = 2.0        # an issue this close to a band counts as logged there


def logged_in(hits: list[TopicHit], issues: list[IssueRecord]) -> dict[int, list[str]]:
    """For each band (by index), the labels of the issues already logged inside it."""
    by_video: dict[str, list[IssueRecord]] = {}
    for i in issues:
        by_video.setdefault(i.video_id, []).append(i)
    out = {}
    for k, h in enumerate(hits):
        inside = [i for i in by_video.get(h.video_id, []) if h.start - LOGGED_SLACK_S <= i.t <= h.end + LOGGED_SLACK_S]
        if inside:
            out[k] = [f"{i.category} severity {i.severity}: {(i.name or '').strip() or i.description}"
                      for i in sorted(inside, key=lambda i: -i.severity)[:3]]
    return out


async def search(query: str, videos: dict[str, Video], logged: list[IssueRecord] = ()) -> TopicSearch:
    """Ask VSS, map its hits onto `videos`, then let Nemotron answer. ValueError on a bad query, SearchUnavailable if VSS can't answer."""
    q = normalise(query)
    # The thread keeps running after a timeout and fills the cache, so a retry is instant.
    job = asyncio.ensure_future(asyncio.to_thread(vss_client.search_full, q, top_k=TOP_K, llm_top_n=LLM_TOP_N))
    try:
        answer = await asyncio.wait_for(asyncio.shield(job), TIMEOUT_S)
    except asyncio.TimeoutError:
        log.warning("VSS search %r still running after %.0f s", q, TIMEOUT_S)
        raise SearchUnavailable("VSS search is busy; try again in a moment") from None
    except Exception as exc:
        log.warning("VSS search %r failed (%s)", q, config.redact(exc))
        raise SearchUnavailable("VSS search is unavailable") from None
    hits = map_hits(answer["results"], videos, q)
    inside = logged_in(hits, list(logged))
    try:   # the answer is an extra: a missing or broken summaries module leaves it empty
        from app.ai import summaries
        reply = await summaries.search_answer(q, hits, inside, videos)
    except Exception as exc:
        log.warning("Search answer unavailable (%s)", config.redact(exc))
        reply = ""
    log.info("VSS topic search %r: %d segments -> %d bands, %d logged%s; answer %s", q, len(answer["results"]),
             len(hits), len(inside), " (cached)" if answer.get("cached") else "", "nemotron" if reply else "none")
    return TopicSearch(query=q, hits=hits, synthesis=answer.get("synthesis", ""), answer=reply,
                       answer_source="nemotron" if reply else None, logged=len(inside), cached=bool(answer.get("cached")))
