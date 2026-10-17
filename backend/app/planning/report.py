"""Situation report: counts, baseline crews in code, Nemotron wording, template fallback.

schedule_regen() runs one background regeneration at a time, at most once a minute;
the previous report stays visible meanwhile (is_updating() tells the API).
"""
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import logging
import math
import time

from pydantic import BaseModel, Field

from app import config, store
from app.ai import nemotron
from app.ai.prompts import DEFAULT_MINUTES, SEVERITY_RUBRIC
from app.models import CREW_FOR, IssueRecord, Report

log = logging.getLogger(__name__)
SHIFT_MIN = 480
OVERHEAD = 1.3                       # travel and setup on top of work-order minutes
DEBOUNCE_S = 60.0
TOP_N = 10
REPORT_PROMPT = """You write the daily street-maintenance situation report for a city operations manager.
You get open issue counts, the top-priority issues, each crew type's workload in minutes and a
baseline number of crews per type computed by the application (one crew works a 480-minute shift).
Write a factual 2–4 sentence summary of the situation, recommend crews per crew type, and give a
short rationale (2–4 sentences) that names the most urgent work. Stay close to the baseline: change it
only for a clear reason such as many severity 4–5 hazards. Don't invent issues or locations.
Severity rubric:
""" + SEVERITY_RUBRIC + """
Return JSON only: {"summary":"<text>","crews":{"<crew type>":<integer>},"rationale":"<text>"}"""


class _ReportReply(BaseModel):
    summary: str = Field(min_length=1)
    crews: dict[str, int]
    rationale: str = Field(min_length=1)


def _minutes(issue: IssueRecord) -> int:
    return issue.work_order.minutes if issue.work_order else DEFAULT_MINUTES[issue.category]


def _facts(issues: list[IssueRecord]) -> tuple[dict[str, int], dict[str, int], dict[str, int], list[IssueRecord]]:
    """counts (category + severity_N), workload minutes per crew, baseline crews, top issues."""
    counts = dict(Counter(i.category for i in issues))
    counts.update({f"severity_{s}": n for s, n in sorted(Counter(i.severity for i in issues).items())})
    workload: dict[str, int] = defaultdict(int)
    for issue in issues:
        workload[CREW_FOR[issue.category]] += _minutes(issue)
    baseline = {crew: math.ceil(minutes * OVERHEAD / SHIFT_MIN) for crew, minutes in workload.items() if minutes > 0}
    top = sorted(issues, key=lambda i: (-i.severity, -i.confidence))[:TOP_N]
    return counts, dict(workload), baseline, top


def _clamp(llm: dict[str, int], baseline: dict[str, int]) -> dict[str, int]:
    """LLM crews within [baseline-1, baseline+2], never below 0; crew types with no work get none."""
    crews = {}
    for crew, base in baseline.items():
        value = llm.get(crew, base)
        crews[crew] = max(0, base - 1, min(base + 2, int(value)))
    return crews


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _template(issues: list[IssueRecord], counts: dict[str, int], workload: dict[str, int],
              baseline: dict[str, int]) -> tuple[str, str]:
    if not issues:
        return "No open maintenance issues are recorded.", "No crews are needed until new issues are found."
    categories = ", ".join(f"{n} {c.replace('_', ' ')}" for c, n in sorted(counts.items())
                           if not c.startswith("severity_"))
    urgent = sum(n for c, n in counts.items() if c in ("severity_4", "severity_5"))
    summary = (f"{_plural(len(issues), 'open issue')} across the surveyed streets: {categories}. "
               f"{_plural(urgent, 'issue')} {'is' if urgent == 1 else 'are'} severity 4 or 5 and should be "
               "repaired this week.")
    rationale = " ".join(
        f"{crew}: {workload[crew] / 60:.1f} h of work orders plus 30% travel and setup → {_plural(n, 'crew')}."
        for crew, n in sorted(baseline.items()))
    return summary, rationale + " Baseline from work-order minutes over a 480-minute shift."


async def _nemotron(counts, workload, baseline, top) -> _ReportReply | None:
    facts = {"counts": counts, "workload_minutes": workload, "baseline_crews": baseline,
             "top_issues": [i.model_dump(include={"id", "category", "severity", "description"}) for i in top]}
    messages = [{"role": "system", "content": REPORT_PROMPT},
                {"role": "user", "content": json.dumps(facts)}]
    # Ultra measured 5.2 s on a report-sized prompt; Lightning is the backup.
    for model, timeout in ((nemotron.ULTRA, 10.0), (nemotron.LIGHTNING, 15.0)):
        try:
            return await nemotron.chat_json(messages, _ReportReply, model=model, timeout=timeout)
        except Exception as exc:
            log.warning("Report via %s failed (%s)", model.rsplit("/", 1)[-1], config.redact(exc))
    return None


async def regenerate() -> Report:
    """Build a fresh report from the canonical issues. Never raises on model failure."""
    issues = await asyncio.to_thread(store.canonical_issues)
    counts, workload, baseline, top = _facts(issues)
    summary, rationale = _template(issues, counts, workload, baseline)
    crews = dict(baseline)
    if issues:
        reply = await _nemotron(counts, workload, baseline, top)
        if reply is not None:
            summary, rationale, crews = reply.summary, reply.rationale, _clamp(reply.crews, baseline)
        else:
            log.info("Report: template fallback")
    return Report(generated_at=datetime.now(timezone.utc), summary=summary, counts=counts,
                  crews=crews, rationale=rationale)


# ---- Debounced background regeneration ----

_loop: asyncio.AbstractEventLoop | None = None
_task: asyncio.Task | None = None
_timer: asyncio.TimerHandle | None = None
_pending = False
_last_start = -math.inf


def is_updating() -> bool:
    return (_task is not None and not _task.done()) or _timer is not None


async def _run() -> None:
    try:
        result = await regenerate()
        await asyncio.to_thread(store.set_report, result)
    except Exception as exc:
        log.warning("Background report failed (%s)", config.redact(exc))


def _start() -> None:
    global _task, _timer, _last_start, _pending
    _timer, _pending = None, False
    _last_start = time.monotonic()
    _task = _loop.create_task(_run())
    _task.add_done_callback(_finished)


def _finished(_: asyncio.Task) -> None:
    global _task
    _task = None
    if _pending:
        _schedule()


def _schedule() -> None:
    global _timer, _pending
    if (_task is not None and not _task.done()) or _timer is not None:
        _pending = True                 # picked up when the running or waiting one starts/ends
        return
    wait = _last_start + DEBOUNCE_S - time.monotonic()
    if wait <= 0:
        _start()
    else:
        _timer = _loop.call_later(wait, _start)


def schedule_regen() -> None:
    """Sync, non-blocking: queue one background regeneration (≤ once per 60 s)."""
    global _loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Called from a worker thread: hand it to the loop we saw last.
        if _loop is None or _loop.is_closed():
            log.info("schedule_regen: no event loop; skipped")
            return
        _loop.call_soon_threadsafe(_schedule)
        return
    _loop = loop
    _schedule()
