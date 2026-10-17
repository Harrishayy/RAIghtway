"""Severity rating pass: a vision model re-grades each finding from its keyframe against the rubric.

The find pass grades severity from a 5 s clip in the same breath as finding the issue, and leans on 2.
This pass looks at one finding at a time (the boxed frame plus a close-up), checks the claim, and returns a
1-5 grade with a one-sentence reason and a verdict ("rejected" = not a real defect). Cosmos3-Reason answers;
Nemotron Super-VL is the fallback (cosmos.rate). Ratings are rows applied on top of the stored issue
(store.apply_rating_row), so the find pass's severity is kept as find_severity and a re-grade can be undone.
"""
import asyncio
from datetime import datetime, timezone
import logging
from pathlib import Path

from app import config
from app.models import IssueRecord, SeverityRating

log = logging.getLogger(__name__)
LIVE_CONCURRENCY = 4          # cosmos.rate takes gpu.slot() itself; this only bounds our share of the pool
LIVE_BUDGET_S = 15.0          # a live upload waits at most this long; unrated findings keep the find grade


def frame_path(issue_id: str) -> str | None:
    path = Path(config.STATE_DIR) / "frames" / f"{issue_id}.jpg"
    return str(path) if path.is_file() else None


def row(issue: IssueRecord, rating: SeverityRating, when: datetime | None = None) -> dict:
    """The persisted form of one rating (state/ratings.jsonl, VastDB `ratings`)."""
    return {"issue_id": issue.id, "severity": rating.severity,
            "find_severity": issue.find_severity or issue.severity, "reason": rating.reason,
            "model": rating.model, "verdict": rating.verdict, "observed": rating.observed or "",
            "rated_at": (when or datetime.now(timezone.utc)).isoformat()}


def cleared_row(issue: IssueRecord, when: datetime | None = None) -> dict:
    """A row that undoes the rating: severity goes back to the find pass's."""
    return {"issue_id": issue.id, "severity": issue.find_severity or issue.severity,
            "find_severity": issue.find_severity or issue.severity, "reason": "", "model": "", "verdict": "",
            "observed": "", "rated_at": (when or datetime.now(timezone.utc)).isoformat()}


async def rate_issues(issues: list[IssueRecord], *, concurrency: int = LIVE_CONCURRENCY,
                      budget_s: float | None = None, on_done=None) -> dict[str, SeverityRating]:
    """Rate many issues with bounded concurrency. Never raises; issues without a frame or an answer are left out.
    With budget_s, whatever has not answered by then is cancelled and keeps its find-pass grade."""
    from app.ai import cosmos
    gate = asyncio.Semaphore(max(1, concurrency))

    async def one(issue: IssueRecord) -> tuple[str, SeverityRating | None]:
        async with gate:
            path = frame_path(issue.id)
            if path is None:
                return issue.id, None
            try:
                rating = await cosmos.rate(path, issue.category, issue.description, issue.bbox)
            except Exception as exc:                 # cosmos.rate never raises; belt and braces for tracing
                log.warning("Rate %s failed (%s)", issue.id, config.redact(exc))
                rating = None
            if on_done is not None:
                try:
                    on_done(issue, rating)
                except Exception as exc:
                    log.warning("Rate callback failed (%s)", config.redact(exc))
            return issue.id, rating

    if not issues:
        return {}
    tasks = [asyncio.create_task(one(issue)) for issue in issues]
    done, pending = await asyncio.wait(tasks, timeout=budget_s)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
        log.warning("Rate: %d of %d unrated after %.0fs; they keep the find grade", len(pending), len(tasks), budget_s)
    ratings = {}
    for task in done:
        if not task.cancelled() and task.exception() is None:
            id, rating = task.result()
            if rating is not None:
                ratings[id] = rating
    models = {}
    for rating in ratings.values():
        models[rating.model] = models.get(rating.model, 0) + 1
    log.info("Rate: %d/%d rated %s, %d rejected", len(ratings), len(issues),
             " ".join(f"{m}={n}" for m, n in sorted(models.items())) or "-",
             sum(r.verdict == "rejected" for r in ratings.values()))
    return ratings
