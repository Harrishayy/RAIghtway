"""Ask what happened on a drive: VSS supplies the footage evidence, Nemotron answers from it and the logged issues.

Evidence, gathered one VSS request at a time (vss_client is serialised and cached):
- the VSS captions of the segments around the playhead (what the camera saw right there), and
- VSS search hits for the question that fall on this drive (where else on it the question applies).
The logged issues on the drive (rejected ones left out) go alongside. Nemotron must answer from that
evidence only and cite times. If Nemotron fails, the answer quotes the closest VSS caption, marked "vss".
"""
import asyncio
import json
import logging
import re

from pydantic import BaseModel, Field

from app import config
from app.ai.prompts import ASK_PROMPT
from app.ai.summaries import clock
from app.geo import inventory
from app.models import AskAnswer, AskEvidence, IssueRecord, VideoRecord
from app.pipeline import topic_search, vss_client

log = logging.getLogger(__name__)
MIN_QUESTION, MAX_QUESTION = 3, 300
AROUND_S = 5.0                 # segments overlapping [t - AROUND_S, t + AROUND_S] at the playhead (2-3 segments)
SEARCH_HITS = 5                # VSS search hits on this drive passed as evidence
ISSUES = 15                    # logged issues passed (nearest the playhead first)
VSS_TIMEOUT_S = 15.0
ANSWER_TIMEOUT_S = 25.0


class AskUnavailable(Exception):
    """Neither VSS nor Nemotron could answer. The message is safe to show."""


class AskReply(BaseModel):             # names the Weave trace (nemotron_json schema_name)
    answer: str = Field(min_length=1)
    times: list[float] = []


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


def _gather(video: VideoRecord, question: str, t: float | None) -> list[AskEvidence]:
    """Blocking: VSS captions at the playhead, then VSS search hits on this drive. Partial on VSS errors."""
    evidence: list[AskEvidence] = []
    if t is not None:
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
    try:
        answer = vss_client.search_full(topic_search.normalise(question), top_k=topic_search.TOP_K,
                                        llm_top_n=topic_search.LLM_TOP_N)
        hits = [h for h in topic_search.map_hits(answer["results"], {video.id: video}, question)][:SEARCH_HITS]
        # full VSS captions by segment start on this drive, so a band carries more than its matching sentence
        segments = inventory.by_id(); full: dict[float, str] = {}
        for r in answer["results"]:
            s = segments.get(str(r.get("filename") or ""))
            if s and s.drive == video.drive and isinstance(r.get("reasoning_content"), str):
                full.setdefault(round(s.t_start - video.start_s, 2), r["reasoning_content"])
        seen = {(e.start, e.end) for e in evidence}
        for h in hits:
            if (h.start, h.end) in seen:
                continue
            caption = next((c for start, c in sorted(full.items()) if h.start <= start < h.end), h.caption)
            evidence.append(AskEvidence(start=h.start, end=h.end, kind="search",
                                        caption=re.sub(r"\s+", " ", caption).strip()))
    except ValueError:
        pass                         # a question too short for search still gets the playhead captions
    except Exception as exc:
        log.info("Ask: VSS search skipped (%s)", config.redact(exc))
    return evidence


def _issues(issues: list[IssueRecord], t: float | None) -> list[IssueRecord]:
    real = [i for i in issues if i.verdict != "rejected"]
    key = (lambda i: abs(i.t - t)) if t is not None else (lambda i: (-i.severity, i.t))
    return sorted(real, key=key)[:ISSUES]


def _quote(evidence: list[AskEvidence], t: float | None) -> str:
    """The fallback answer: the VSS caption nearest the playhead (or the best search hit)."""
    best = min(evidence, key=lambda e: abs(e.start - t)) if t is not None else evidence[0]
    first = " ".join(re.split(r"(?<=[.!?])\s", best.caption)[:2])
    return f"VSS caption at {clock(best.start)}: {first}"


async def ask(video: VideoRecord, question: str, t: float | None, issues: list[IssueRecord]) -> AskAnswer:
    """Answer a question about one drive. ValueError on a bad question; AskUnavailable if nothing could answer."""
    from app.ai import nemotron
    q = normalise(question)
    if t is not None:
        t = min(max(0.0, t), max(video.duration_s, 0.0))
    try:
        evidence = await asyncio.wait_for(asyncio.to_thread(_gather, video, q, t), VSS_TIMEOUT_S)
    except asyncio.TimeoutError:
        log.warning("Ask: VSS evidence timed out for %s", video.id)
        evidence = []
    logged = _issues(issues, t)
    payload = {"question": q, "drive": video.drive or video.filename, "duration": clock(video.duration_s),
               "playhead": clock(t) if t is not None else None,
               "vss_segments": [{"time": f"{clock(e.start)}-{clock(e.end)}", "kind": e.kind, "caption": e.caption}
                                for e in evidence],
               "logged_issues": [{"time": clock(i.t), "category": i.category, "severity": i.severity,
                                  "label": (i.name or "").strip() or i.description} for i in logged]}
    try:
        reply = await nemotron.chat_json([{"role": "system", "content": ASK_PROMPT},
                                          {"role": "user", "content": json.dumps(payload)}],
                                         AskReply, timeout=ANSWER_TIMEOUT_S)
    except Exception as exc:
        log.warning("Ask: Nemotron failed for %s (%s)", video.id, config.redact(exc))
        if not evidence:
            raise AskUnavailable("Neither VSS nor Nemotron could answer right now") from None
        return AskAnswer(question=q, answer=_quote(evidence, t), source="vss",
                         times=[evidence[0].start], evidence=evidence)
    times = sorted({round(x, 1) for x in reply.times if 0 <= x <= max(video.duration_s, 0.0)})
    if not times:   # models often cite mm:ss in the text but leave the list empty
        times = sorted({int(m[1]) * 60 + int(m[2]) for m in re.finditer(r"\b(\d{1,2}):(\d{2})\b", reply.answer)
                        if int(m[1]) * 60 + int(m[2]) <= video.duration_s})
    log.info("Ask %s %r: %d VSS segments, %d issues -> nemotron", video.id, q, len(evidence), len(logged))
    return AskAnswer(question=q, answer=re.sub(r"\s+", " ", reply.answer).strip(), source="nemotron",
                     times=[float(x) for x in times][:6], evidence=evidence, issue_ids=[i.id for i in logged])
