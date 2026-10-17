"""Triage before routing: which open jobs go today, later in the plan's days, or wait.

Nemotron (W&B Inference, traced in Weave through nemotron.chat_json) reads the backlog: counts by crew
and severity, the worst jobs with their severity reasons and sightings, each crew type's capacity per
day, and the user's severity floor. It proposes a decision and a short reason per job. The hard rules
stay in code and the model only chooses within them (clamp()):

- below the severity floor: deferred, always;
- no trucks of that crew type at any site: deferred;
- severity 5, and any job an operator pinned (whatever the floor), goes today whenever the crew type
  has any capacity; pinned jobs say "Pinned by operator";
- severity 4 is never deferred while the horizon has room for it;
- today's minutes per crew type stay within that day's capacity (overflow moves to later);
- a low-severity job may join today only within BUNDLE_KM of another job going today (same crew).

rules() makes the same decisions with no model; Triage.model says which answered.
"""
import asyncio
from collections import Counter, defaultdict
import json
import logging
import time
from typing import Literal

from pydantic import BaseModel, Field

from app import config
from app.ai.prompts import DEFAULT_MINUTES
from app.ai.weave_setup import op
from app.geo.distance import km
from app.models import CREW_FOR, Crew, IssueRecord, Triage, TriageDecision

log = logging.getLogger(__name__)
SHIFT_MIN = 480
LUNCH_MIN = 30
WORK_SHARE = 0.65            # of a shift after lunch, the share spent on site (the rest is driving)
TODAY_SLACK = 1.1            # today may run 10% over the estimate; cuOpt has the final say
BUNDLE_KM = 0.25             # about a city block: close enough to do on the way
MODEL_JOBS = 45              # jobs shown to the model one by one (worst first); the rest follow the rules
TIMEOUT_S = 40.0
CREW_NAME = {"roads": "Roads", "graffiti": "Graffiti", "markings": "Markings", "inspection": "Work-zone inspection",
             "signage": "Signage", "sanitation": "Sanitation"}

PROMPT = """You are the duty supervisor for City of Toronto maintenance crews. You get today's open backlog
from dashcam findings (severity 1-5: 5 = safety hazard today, 4 = this week, 3 = this month, 1-2 routine),
each crew type's work capacity per day in minutes, and how many days this plan covers.

Each listed job carries rule_suggestion: "today" (day 1), "later" (a later day of this plan) or "defer" (not in
this plan). Return decisions only for jobs where you change the suggestion or can give a sharper reason
(at most 25); every other job keeps its suggestion.
Fixed rules you must follow: severity 5 and jobs pinned by the operator are always today; severity 4 is never deferred while there is room;
keep today's minutes for a crew type within its capacity per day; a severity 1-2 job may go today only when
it is next to another job going today (bundle it, and say so). Prefer jobs seen several times, and jobs
whose severity reason describes a risk to people. Defer routine work that does not fit.
Give each decision a short reason (under 20 words) a supervisor would accept. Write a two-sentence
rationale for the day and one sentence per crew type in by_crew. Plain text, no markdown."""

Decision = Literal["today", "later", "defer"]


class _Pick(BaseModel):
    issue_id: str
    decision: Decision
    reason: str = Field(min_length=1)


class _TriageReply(BaseModel):
    rationale: str = Field(min_length=1)
    by_crew: dict[str, str] = {}
    decisions: list[_Pick]


def minutes(issue: IssueRecord) -> int:
    return issue.work_order.minutes if issue.work_order else DEFAULT_MINUTES[issue.category]


def capacity(trucks: dict[str, int]) -> dict[str, int]:
    """Work minutes per day each crew type's trucks can do, after lunch and driving."""
    return {crew: int(n * (SHIFT_MIN - LUNCH_MIN) * WORK_SHARE) for crew, n in trucks.items() if n > 0}


def pinned(i: IssueRecord) -> bool:
    return bool(getattr(i, "pinned", False))


def _must(i: IssueRecord) -> bool:
    return i.severity == 5 or pinned(i)


def _rank(i: IssueRecord) -> tuple:
    return (not pinned(i), -i.severity, -i.sightings, -i.confidence, i.id)


def _near_today(i: IssueRecord, today: list[IssueRecord]) -> IssueRecord | None:
    near = [t for t in today if t.id != i.id and CREW_FOR[t.category] == CREW_FOR[i.category]
            and km((t.lat, t.lon), (i.lat, i.lon)) <= BUNDLE_KM]
    return min(near, key=_rank, default=None)


def rules(jobs: list[IssueRecord], min_severity: int, cap: dict[str, int], days: int) -> dict[str, TriageDecision]:
    """The no-model triage: worst first into today's capacity, then the horizon's, then bundling."""
    out: dict[str, TriageDecision] = {}
    today_used: dict[str, int] = defaultdict(int)
    total_used: dict[str, int] = defaultdict(int)
    today: list[IssueRecord] = []

    def put(i: IssueRecord, decision: Decision, reason: str) -> None:
        out[i.id] = TriageDecision(issue_id=i.id, crew=CREW_FOR[i.category], severity=i.severity,
                                   decision=decision, reason=reason, by="rule", pinned=pinned(i))

    for i in sorted(jobs, key=_rank):
        crew, m = CREW_FOR[i.category], minutes(i)
        day_cap = cap.get(crew, 0)
        if day_cap <= 0:
            put(i, "defer", f"No {CREW_NAME[crew].lower()} trucks at any site"
                + (" (pinned, but nobody can do it)" if pinned(i) else ""))
        elif pinned(i):
            today_used[crew] += m
            total_used[crew] += m
            today.append(i)
            put(i, "today", "Pinned by operator: must-do today")
        elif i.severity < min_severity:
            put(i, "defer", f"Below the S{min_severity}+ floor chosen for this plan")
        elif i.severity == 5:
            today_used[crew] += m
            total_used[crew] += m
            today.append(i)
            put(i, "today", "Safety hazard: goes out today")
        elif i.severity >= 3 and today_used[crew] + m <= day_cap:
            today_used[crew] += m
            total_used[crew] += m
            today.append(i)
            put(i, "today", f"S{i.severity}, fits today's {CREW_NAME[crew].lower()} capacity")
        elif total_used[crew] + m <= day_cap * days and (i.severity >= 3 or days > 1):
            total_used[crew] += m
            put(i, "later", f"S{i.severity}, after today's worse jobs" if i.severity >= 3
                else f"Routine S{i.severity}: fill-in when a truck has room")
        else:
            put(i, "defer", f"Routine S{i.severity}: waits for a quieter day" if i.severity <= 2 else
                f"Beyond {days} day{'s' if days > 1 else ''} of {CREW_NAME[crew].lower()} capacity")
    # Routine jobs next to today's work ride along when there is a little room.
    for i in sorted(jobs, key=_rank):
        d = out[i.id]
        if d.decision == "today" or i.severity > 2 or i.severity < min_severity or cap.get(CREW_FOR[i.category], 0) <= 0:
            continue
        crew = CREW_FOR[i.category]
        anchor = _near_today(i, today)
        if anchor and today_used[crew] + minutes(i) <= cap.get(crew, 0) * TODAY_SLACK:
            today_used[crew] += minutes(i)
            put(i, "today", f"Bundled with the S{anchor.severity} job in the same block")
    return out


def clamp(proposed: dict[str, tuple[Decision, str]], jobs: list[IssueRecord], baseline: dict[str, TriageDecision],
          min_severity: int, cap: dict[str, int], days: int) -> tuple[dict[str, TriageDecision], int]:
    """The model's decisions inside the hard rules. Returns the decisions and how many were overridden."""
    by_id = {i.id: i for i in jobs}
    out = dict(baseline)
    clamped = 0
    for issue_id, (decision, reason) in proposed.items():
        i = by_id.get(issue_id)
        if i is None:
            continue
        crew = CREW_FOR[i.category]
        reason = " ".join(reason.split())[:160] or "Model decision"
        fixed = baseline[issue_id]
        # Hard rules: the floor, no trucks, pinned jobs and severity 5 are not the model's call.
        if (i.severity < min_severity and not pinned(i)) or cap.get(crew, 0) <= 0 or _must(i):
            clamped += decision != fixed.decision
            continue
        if i.severity == 4 and decision == "defer":
            decision, reason, by = "later", "Severity 4 stays in the plan (rule)", "rule"
            clamped += 1
        else:
            by = "model"
        out[issue_id] = TriageDecision(issue_id=i.id, crew=crew, severity=i.severity, decision=decision,
                                       reason=reason, by=by, pinned=pinned(i))
    # Today's minutes stay within each crew type's day: overflow (lowest priority first) moves to later.
    today = sorted((by_id[d.issue_id] for d in out.values() if d.decision == "today"), key=_rank)
    used: dict[str, int] = defaultdict(int)
    kept: list[IssueRecord] = []
    for i in today:
        crew = CREW_FOR[i.category]
        limit = cap.get(crew, 0) * TODAY_SLACK
        if _must(i) or used[crew] + minutes(i) <= limit:
            used[crew] += minutes(i)
            kept.append(i)
            continue
        d = out[i.id]
        out[i.id] = d.model_copy(update={"decision": "later", "by": "rule",
                                         "reason": "Today is full; moved to a later day (rule)"})
        clamped += d.by == "model"
    # A routine job the model sent today must sit next to other work going today.
    for i in kept:
        d = out[i.id]
        if d.by == "model" and i.severity <= 2 and not _near_today(i, [k for k in kept if k.severity >= 3]):
            out[i.id] = d.model_copy(update={"decision": "later" if days > 1 else "defer", "by": "rule",
                                             "reason": "Routine and not next to today's work (rule)"})
            clamped += 1
    return out, clamped


def _facts(jobs: list[IssueRecord], baseline: dict[str, TriageDecision], min_severity: int,
           cap: dict[str, int], trucks: dict[str, int], days: int) -> dict:
    eligible = sorted((i for i in jobs if (i.severity >= min_severity or pinned(i))
                       and cap.get(CREW_FOR[i.category], 0) > 0), key=_rank)
    counts: dict[str, Counter] = defaultdict(Counter)
    work: dict[str, int] = defaultdict(int)
    for i in jobs:
        counts[CREW_FOR[i.category]][str(i.severity)] += 1
        if i.severity >= min_severity:
            work[CREW_FOR[i.category]] += minutes(i)
    return {
        "days_in_plan": days, "severity_floor": min_severity,
        "crews": {crew: {"trucks_per_day": trucks.get(crew, 0), "capacity_minutes_per_day": cap.get(crew, 0),
                         "open_by_severity": dict(counts[crew]), "minutes_at_or_above_floor": work[crew]}
                  for crew in sorted(set(counts) | set(trucks))},
        "jobs": [{"id": i.id, "crew": CREW_FOR[i.category], "category": i.category, "severity": i.severity,
                  "minutes": minutes(i), "sightings": i.sightings, "pinned_by_operator": pinned(i), "description": ((getattr(i, "name", None) or "").strip() or i.description)[:140],
                  "severity_reason": (i.severity_reason or "")[:160] or None,
                  "lat": round(i.lat, 4), "lon": round(i.lon, 4),
                  "rule_suggestion": baseline[i.id].decision} for i in eligible[:MODEL_JOBS]],
    }


@op
async def triage_with_model(facts: dict) -> dict:
    """One Nemotron call; returns the raw reply as a dict (the Weave trace shows the facts and the reply)."""
    from app.ai import nemotron
    # Ultra answers this size of prompt in ~10-20 s; reasoning tokens count against max_tokens.
    reply = await nemotron.chat_json([{"role": "system", "content": PROMPT},
                                      {"role": "user", "content": json.dumps(facts)}],
                                     _TriageReply, model=nemotron.ULTRA, timeout=TIMEOUT_S, max_tokens=12000)
    return reply.model_dump()


MODELS = {"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": ("nemotron-ultra", "Nemotron 3 Ultra"),
          "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B": ("nemotron-lightning", "Nemotron 3.5 Lightning")}


def _template(decisions: dict[str, TriageDecision], min_severity: int, days: int) -> tuple[str, dict[str, str]]:
    by_crew: dict[str, Counter] = defaultdict(Counter)
    for d in decisions.values():
        by_crew[d.crew][d.decision] += 1
    total = Counter(d.decision for d in decisions.values())
    floor = "all severities" if min_severity <= 1 else f"S{min_severity} and worse"
    rationale = (f"Planning {floor} over {days} day{'s' if days > 1 else ''}: {total['today']} jobs today, "
                 f"{total['later']} later, {total['defer']} waiting. Safety hazards go first, then the worst "
                 "jobs that fit each crew type's day; routine jobs in the same block ride along.")
    notes = {crew: f"{c['today']} today, {c['later']} later, {c['defer']} waiting." for crew, c in by_crew.items()}
    return rationale, notes


async def decide(jobs: list[IssueRecord], min_severity: int, trucks: dict[str, int], days: int,
                 use_model: bool = True) -> Triage:
    """Triage the open, located jobs. Never raises: with no model the rules decide, and Triage.model says so."""
    cap = capacity(trucks)
    baseline = rules(jobs, min_severity, cap, days)
    decisions, clamped = baseline, 0
    rationale, by_crew = _template(baseline, min_severity, days)
    model, model_name = "rules", None
    candidates = [i for i in jobs if i.severity >= min_severity and cap.get(CREW_FOR[i.category], 0) > 0]
    if use_model and candidates:
        started = time.perf_counter()
        try:
            raw = await asyncio.wait_for(
                triage_with_model(_facts(jobs, baseline, min_severity, cap, trucks, days)), TIMEOUT_S + 5)
            reply = _TriageReply.model_validate(raw)
            proposed = {p.issue_id: (p.decision, p.reason) for p in reply.decisions}
            decisions, clamped = clamp(proposed, jobs, baseline, min_severity, cap, days)
            from app.ai import nemotron
            model, model_name = MODELS.get(nemotron.ULTRA, ("nemotron", nemotron.ULTRA))
            rationale = " ".join(reply.rationale.split())[:600]
            by_crew = {c: " ".join(t.split())[:240] for c, t in reply.by_crew.items() if c in CREW_NAME and t.strip()}
            log.info("Triage: %s answered %d decisions in %.1f s, %d clamped", model, len(proposed),
                     time.perf_counter() - started, clamped)
        except Exception as exc:
            log.warning("Triage: rules fallback (%s)", config.redact(exc))
    order = {i.id: n for n, i in enumerate(sorted(jobs, key=_rank))}
    return Triage(model=model, model_name=model_name, min_severity=min_severity, days=days, rationale=rationale,
                  by_crew=by_crew, capacity_min=cap, clamped=clamped,
                  decisions=sorted(decisions.values(), key=lambda d: order[d.issue_id]))
