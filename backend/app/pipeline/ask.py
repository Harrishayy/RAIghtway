"""Ask what happened on a drive: VSS supplies the footage evidence, Nemotron answers from it and the logged issues.

It is a chat: earlier turns go along as context. Nemotron Lightning answers with reasoning off, so a reply takes
about a second once the evidence is in. Evidence, gathered one VSS request at a time (serialised and cached):
- the VSS captions of the segments around the playhead (what the camera saw right there), and
- VSS search hits for the question that fall on this drive (where else on it the question applies).
The logged issues on the drive (rejected ones left out) go alongside. Nemotron must answer from that
evidence only and cite times. If Nemotron fails, the answer quotes the closest VSS caption, marked "vss".
"""
import asyncio
import json
import logging
import re
import time

from pydantic import BaseModel, Field

from app import config
from app.ai.prompts import ASK_PROMPT
from app.ai.summaries import clock
from app.geo import inventory
from app.models import AskAnswer, AskEvidence, IssueRecord, VideoRecord
from app.pipeline import topic_search, vss_client

log = logging.getLogger(__name__)
MIN_QUESTION, MAX_QUESTION = 3, 300
AROUND_S = 2.5                 # segments overlapping [t - AROUND_S, t + AROUND_S] at the playhead (1-2 segments)
SEARCH_HITS = 5                # VSS search hits on this drive passed as evidence
ISSUES = 15                    # logged issues passed (nearest the playhead first)
PLAYHEAD_BUDGET_S = 3.0        # VSS is shared and serialised: chat answers with whatever evidence is in by then
EVIDENCE_BUDGET_S = 3.5
ANSWER_TIMEOUT_S = 20.0
HISTORY_TURNS = 8              # earlier chat turns sent as context
TURN_CHARS = 600
MODEL_LABEL = "Nemotron 3.5 Lightning"


class AskUnavailable(Exception):
    """Neither VSS nor Nemotron could answer. The message is safe to show."""


class AskReply(BaseModel):             # names the Weave trace (nemotron_json schema_name)
    answer: str = Field(min_length=1)


def normalise(question: str) -> str:
    q = re.sub(r"\s+", " ", (question or "").strip())
    if not MIN_QUESTION <= len(q) <= MAX_QUESTION:
        raise ValueError(f"Questions need {MIN_QUESTION}-{MAX_QUESTION} characters")
    return q


def _segments_near(video: VideoRecord, t: float) -> list:
    if not video.drive:
        return []
    lo, hi = video.start_s + t - AROUND_S, video.start_s + t + AROUND_S
    return [s for s in inventory.load() if s.drive == video.drive and s.t_start < hi and s.t_start + s.duration > lo]


def _playhead(video: VideoRecord, t: float) -> list[AskEvidence]:
    """Blocking: VSS captions of the segments at the playhead (cached after the first ask there)."""
    evidence: list[AskEvidence] = []
    for seg in _segments_near(video, t):
        try:
            caption = vss_client.segment_caption(seg.source_uri)
        except Exception as exc:
            log.info("Ask: segment caption skipped (%s)", config.redact(exc))
            break
        if caption:
            start = seg.t_start - video.start_s
            evidence.append(AskEvidence(start=round(start, 2), end=round(start + seg.duration, 2),
                                        caption=re.sub(r"\s+", " ", caption).strip(), kind="segment"))
    return evidence


def _search_hits(video: VideoRecord, question: str) -> list[AskEvidence]:
    """Blocking: VSS search hits for the question on this drive, each with its full caption. [] on any failure."""
    try:
        # llm_top_n=1: chat needs the hits, not VSS's LLM synthesis over three clips (that is what makes a search slow)
        answer = vss_client.search_full(topic_search.normalise(question), top_k=topic_search.TOP_K, llm_top_n=1)
    except ValueError:
        return []                    # a question too short for search still gets the playhead captions
    except Exception as exc:
        log.info("Ask: VSS search skipped (%s)", config.redact(exc))
        return []
    hits = topic_search.map_hits(answer["results"], {video.id: video}, question)[:SEARCH_HITS]
    # full VSS captions by segment start on this drive, so a band carries more than its matching sentence
    segments = inventory.by_id(); full: dict[float, str] = {}
    for r in answer["results"]:
        s = segments.get(str(r.get("filename") or ""))
        if s and s.drive == video.drive and isinstance(r.get("reasoning_content"), str):
            full.setdefault(round(s.t_start - video.start_s, 2), r["reasoning_content"])
    return [AskEvidence(start=h.start, end=h.end, kind="search", caption=re.sub(r"\s+", " ", next(
        (c for start, c in sorted(full.items()) if h.start <= start < h.end), h.caption)).strip()) for h in hits]


async def _gather(video: VideoRecord, question: str, t: float | None) -> list[AskEvidence]:
    """VSS evidence within EVIDENCE_BUDGET_S: the playhead captions first, then search hits. A request still running
    when its budget ends is left to finish in the background (it fills the cache for the next turn)."""
    began = time.monotonic()
    evidence: list[AskEvidence] = []
    if t is not None:
        job = asyncio.ensure_future(asyncio.to_thread(_playhead, video, t))
        try:
            evidence = await asyncio.wait_for(asyncio.shield(job), PLAYHEAD_BUDGET_S)
        except asyncio.TimeoutError:
            log.info("Ask: playhead captions still loading after %.0f s; answering without them", PLAYHEAD_BUDGET_S)
    job = asyncio.ensure_future(asyncio.to_thread(_search_hits, video, question))
    try:
        hits = await asyncio.wait_for(asyncio.shield(job), max(0.5, EVIDENCE_BUDGET_S - (time.monotonic() - began)))
    except asyncio.TimeoutError:
        log.info("Ask: VSS search still running; answering without it")
        hits = []
    seen = {(e.start, e.end) for e in evidence}
    return evidence + [h for h in hits if (h.start, h.end) not in seen]


def _issues(issues: list[IssueRecord], t: float | None) -> list[IssueRecord]:
    real = [i for i in issues if i.verdict != "rejected"]
    key = (lambda i: abs(i.t - t)) if t is not None else (lambda i: (-i.severity, i.t))
    return sorted(real, key=key)[:ISSUES]


def _quote(evidence: list[AskEvidence], t: float | None) -> str:
    """The fallback answer: the VSS caption nearest the playhead (or the best search hit)."""
    best = min(evidence, key=lambda e: abs(e.start - t)) if t is not None else evidence[0]
    first = " ".join(re.split(r"(?<=[.!?])\s", best.caption)[:2])
    return f"VSS caption at {clock(best.start)}: {first}"


def _times(text: str, duration: float) -> list[float]:
    """The mm:ss moments the answer cites, in order (the text is what the operator reads, so it is the source)."""
    out: list[float] = []
    for m in re.finditer(r"\b(\d{1,2}):(\d{2})\b", text):
        s = int(m[1]) * 60 + int(m[2])
        if s <= duration and float(s) not in out:
            out.append(float(s))
    return out[:8]


def _history(turns: list[dict] | None) -> list[dict]:
    """The last HISTORY_TURNS chat turns as model messages, each trimmed; the evidence goes with the new question only."""
    out = []
    for turn in (turns or [])[-HISTORY_TURNS:]:
        role, content = turn.get("role"), re.sub(r"\s+", " ", str(turn.get("content") or "")).strip()
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content[:TURN_CHARS]})
    return out


async def ask(video: VideoRecord, question: str, t: float | None, issues: list[IssueRecord],
              history: list[dict] | None = None) -> AskAnswer:
    """Answer the latest question in a chat about one drive. ValueError on a bad question; AskUnavailable if nothing could answer."""
    from app.ai import nemotron
    q = normalise(question)
    if t is not None:
        t = min(max(0.0, t), max(video.duration_s, 0.0))
    evidence = await _gather(video, q, t)
    logged = _issues(issues, t)
    payload = {"question": q, "drive": video.drive or video.filename, "duration": clock(video.duration_s),
               "playhead": clock(t) if t is not None else None,
               "vss_segments": [{"time": f"{clock(e.start)}-{clock(e.end)}", "kind": e.kind, "caption": e.caption}
                                for e in evidence],
               "logged_issues": [{"time": clock(i.t), "category": i.category, "severity": i.severity,
                                  "label": (i.name or "").strip() or i.description} for i in logged]}
    try:
        # reasoning off: a grounded chat answer in about a second instead of 10-30 s (Lightning only, never Ultra)
        reply = await nemotron.chat_json([{"role": "system", "content": ASK_PROMPT}, *_history(history),
                                          {"role": "user", "content": json.dumps(payload)}],
                                         AskReply, model=nemotron.LIGHTNING, timeout=ANSWER_TIMEOUT_S, think=False)
    except Exception as exc:
        log.warning("Ask: Nemotron failed for %s (%s)", video.id, config.redact(exc))
        if not evidence:
            raise AskUnavailable("Neither VSS nor Nemotron could answer right now") from None
        quote = _quote(evidence, t)
        return AskAnswer(question=q, answer=quote, source="vss", times=_times(quote, video.duration_s),
                         evidence=evidence, model="VSS caption")
    answer = re.sub(r"\s+", " ", reply.answer).strip()
    log.info("Ask %s %r: %d VSS segments, %d issues, %d earlier turns -> nemotron", video.id, q, len(evidence),
             len(logged), len(_history(history)))
    return AskAnswer(question=q, answer=answer, source="nemotron", times=_times(answer, video.duration_s),
                     evidence=evidence, issue_ids=[i.id for i in logged], model=MODEL_LABEL)
