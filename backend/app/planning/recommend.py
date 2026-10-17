"""Workforce recommendation: Nemotron proposes, cuOpt evaluates, Nemotron picks, code validates.

A bounded agent loop, traced step by step in Weave (text only):

1. propose  Nemotron reads the backlog (open jobs by crew type and severity with reasons, pinned jobs,
            hotspots, sites and their trucks per day, the last plan's deferred and unassigned jobs) and
            proposes 2-4 scenarios: trucks per site per crew type per day, a severity floor and an intent.
            Code clamps each (0-20 trucks per site, only crews a site hosts, trucks versus workload) and
            always adds the current settings as a baseline. No model: rules propose (baseline, S4+ focus,
            one more truck at the busiest site).
2. evaluate Code runs triage (rules) and a real cuOpt solve for every scenario over ONE set of street
            matrices (dispatch.prepare), within cuopt.CONCURRENCY and a time budget, and scores each from its
            routes: jobs routed, S5/S4/pinned covered, drive and work hours, km, trucks, unassigned by reason.
            No cuOpt: the nearest-neighbour fallback evaluates, and each scenario's metrics say so.
3. pick     Nemotron reads the scored table and recommends one, citing the numbers; it may ask for one
            refined scenario, which is solved and scored too and replaces the pick only if it scores better.
4. validate The pick must be a solved scenario; otherwise the code rule picks: pinned and S5 coverage first,
            then S4, then fewer drive hours.

The latest recommendation is kept in memory with its solved outcomes (so "Apply and plan" can reuse the
routes while the backlog and sites are unchanged) and in state/recommendation.json. Plans carry it as
Plan.recommendation.
"""
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import tempfile
import time
import uuid

from pydantic import BaseModel, Field

from app import config
from app.ai.weave_setup import op
from app.geo import roads
from app.geo.distance import km
from app.models import CREW_FOR, IssueRecord, Recommendation, Scenario, ScenarioMetrics
from app.planning import dispatch, facilities, triage as triage_mod, zones as zones_mod

log = logging.getLogger(__name__)
SOLVE_BUDGET_S = 30.0         # every scenario's cuOpt solves together
MODEL_TIMEOUT_S = 40.0
FRESH_S = 15 * 60             # solved routes reused by "Apply and plan" for this long
MAX_PROPOSALS = 4
MAX_TOTAL_S = 100.0           # no refinement round after this much time
TRUCK_MINUTES = int((triage_mod.SHIFT_MIN - triage_mod.LUNCH_MIN) * triage_mod.WORK_SHARE)
CREWS = list(dispatch.CREW_LABEL)

PROPOSE_PROMPT = """You plan the City of Toronto's maintenance workforce for the coming days. You get the open
backlog from dashcam findings (severity 1-5: 5 = safety hazard today, 4 = this week, 3 = this month, 1-2 routine),
operator-pinned jobs (must be done), hotspots, the operating sites with the crew types they host and the trucks
each sends out per day now, and the last plan's deferred and unassigned jobs. One truck does about
{truck} minutes of on-site work per day after lunch and driving.

Propose 2 to 4 distinct workforce scenarios that a cuOpt solver will then route and score for you. Each sets
trucks per day for any sites you want to change (site id -> crew type -> trucks; sites you leave out keep their
current trucks), a severity floor (plan S{{floor}} and worse), optionally `zones` (ward ids from the facts) to
focus that scenario on part of the city, a short label and a one-line intent. Make them
genuinely different (for example: cover every S4+; concentrate trucks near a hotspot; fewer trucks with a
higher floor; more trucks to clear S3). Only use crew types a site hosts, 0 to 20 trucks per site and crew.
Also list the crew types and areas to prioritise. Plain text, no markdown."""

PICK_PROMPT = """You get workforce scenarios that the cuOpt solver has routed over real street times, with numbers
computed from the routes: coverage of pinned, severity 5 and severity 4 jobs, jobs routed, drive and work hours,
km, trucks used and why jobs were left unassigned. Recommend ONE scenario id. Covering pinned and severity 5 jobs
matters most, then severity 4, then fewer drive hours per job done. Write a rationale of 2-3 sentences that cites
the numbers, and 2-4 short trade-offs versus the other scenarios. If one small change to a scenario would clearly
do better, you may propose it as `refine` (same format as a scenario); otherwise leave refine null.
Plain text, no markdown."""


class _Proposed(BaseModel):
    label: str = Field(min_length=1)
    intent: str = ""
    min_severity: int = 3
    sites: dict[str, dict[str, int]] = {}
    zones: list[str] = []                     # focus wards (ids from the facts), [] = the request's focus


class _Proposals(BaseModel):
    scenarios: list[_Proposed]
    priorities: list[str] = []


class _Pick(BaseModel):
    recommended: str
    rationale: str = Field(min_length=1)
    tradeoffs: list[str] = []
    refine: _Proposed | None = None


# ---- State ----

_latest: Recommendation | None = None
_solved: dict[str, dispatch.Outcome] = {}
_prep: dispatch.Prepared | None = None
_fingerprint = ""
_made = 0.0
_progress: dict = {"running": False}


def progress() -> dict:
    """What the running recommendation is doing, for the console's button (polled)."""
    out = dict(_progress)
    if out.get("started"):
        out["elapsed_s"] = round(time.monotonic() - out.pop("started"), 1)
    return out


def _stage(stage: str, **extra) -> None:
    _progress.update({"stage": stage, **extra})


def _path() -> Path:
    return config.STATE_DIR / "recommendation.json"


def fingerprint(jobs: list[IssueRecord]) -> str:
    """Changes when the backlog or the sites change, so stale solved routes are not reused."""
    parts = sorted(f"{i.id}:{i.severity}:{getattr(i, 'pinned', False)}:{i.verdict}" for i in jobs)
    parts += sorted(f"{f.id}:{f.lat}:{f.lon}:{sorted(f.crews)}" for f in facilities.load())
    return hashlib.sha1("|".join(parts).encode()).hexdigest()


def latest() -> Recommendation | None:
    global _latest
    if _latest is None:
        try:
            _latest = Recommendation.model_validate_json(_path().read_text())
        except (OSError, ValueError):
            return None
    return _latest


def _save(rec: Recommendation) -> None:
    path = _path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".recommendation-", suffix=".json", dir=path.parent)
        with os.fdopen(fd, "w") as f:
            f.write(rec.model_dump_json())
        os.replace(tmp, path)
    except OSError as exc:
        log.warning("Recommendation not saved (%s)", config.redact(exc))


def settings(rec_id: str, scenario_id: str) -> Scenario | None:
    rec = latest()
    if rec is None or rec.id != rec_id:
        return None
    return next((s for s in rec.scenarios if s.id == scenario_id), None)


def solved(rec_id: str, scenario_id: str, jobs: list[IssueRecord]):
    """(outcome, prepared, recommendation) when that scenario's routes are still fresh, else None."""
    if (_latest is None or _latest.id != rec_id or scenario_id not in _solved or _prep is None
            or time.monotonic() - _made > FRESH_S or fingerprint(jobs) != _fingerprint):
        return None
    return _solved[scenario_id], _prep, _latest


# ---- Facts for the model ----

def workload(jobs: list[IssueRecord], floor: int) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for i in jobs:
        if i.severity >= floor or dispatch.pinned(i):
            out[CREW_FOR[i.category]] += dispatch._minutes(i)
    return dict(out)


def local_load(jobs: list[IssueRecord], floor: int) -> dict[str, dict[str, int]]:
    """Site -> crew -> work minutes of the jobs that site is nearest to (among the sites hosting the crew)."""
    out: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for i in jobs:
        if i.severity < floor and not dispatch.pinned(i):
            continue
        crew = CREW_FOR[i.category]
        site = facilities.nearest(crew, (i.lat, i.lon))
        if site:
            out[site.id][crew] += dispatch._minutes(i)
    return {k: dict(v) for k, v in out.items()}


def hotspots(jobs: list[IssueRecord], floor: int, top: int = 8) -> list[dict]:
    cells: dict[tuple, list[IssueRecord]] = defaultdict(list)
    for i in jobs:
        if i.severity >= floor or dispatch.pinned(i):
            cells[(round(i.lat / 0.01), round(i.lon / 0.01))].append(i)
    out = []
    for (la, lo), items in sorted(cells.items(), key=lambda kv: -sum(2 ** x.severity for x in kv[1]))[:top]:
        lat, lon = la * 0.01, lo * 0.01
        out.append({"lat": round(lat, 3), "lon": round(lon, 3), "jobs": len(items),
                    "severe": sum(i.severity >= 4 for i in items), "pinned": sum(dispatch.pinned(i) for i in items),
                    "by_crew": dict(Counter(CREW_FOR[i.category] for i in items)),
                    "example": items[0].description[:100]})
    return out


def ward_backlog(jobs: list[IssueRecord], floor: int, top: int = 10) -> list[dict]:
    """Open work per ward (official City wards), worst first: what a zone-focused scenario could target."""
    rows: dict[str, dict] = {}
    for i in jobs:
        if i.severity < floor and not dispatch.pinned(i):
            continue
        ward = zones_mod.ward_of((i.lat, i.lon))
        if ward is None:
            continue
        row = rows.setdefault(ward.id, {"id": ward.id, "label": ward.label, "jobs": 0, "by_severity": Counter(),
                                        "by_crew": Counter(), "pinned": 0, "score": 0})
        row["jobs"] += 1
        row["by_severity"][str(i.severity)] += 1
        row["by_crew"][CREW_FOR[i.category]] += 1
        row["pinned"] += dispatch.pinned(i)
        row["score"] += 2 ** i.severity
    out = sorted(rows.values(), key=lambda r: -r["score"])[:top]
    return [{**r, "by_severity": dict(r["by_severity"]), "by_crew": dict(r["by_crew"])} for r in out]


def facts(jobs: list[IssueRecord], floor: int, days: int, sites_now: dict[str, dict[str, int]]) -> dict:
    by_crew: dict[str, Counter] = defaultdict(Counter)
    for i in jobs:
        by_crew[CREW_FOR[i.category]][str(i.severity)] += 1
    loads = local_load(jobs, 1)
    last = None
    try:
        from app import store
        last = store.latest_plan()
    except Exception:
        pass
    by_id = {i.id: i for i in jobs}
    top = sorted(jobs, key=lambda i: (not dispatch.pinned(i), -i.severity, -i.sightings))[:14]
    return {
        "days": days, "current_severity_floor": floor, "work_minutes_per_truck_day": TRUCK_MINUTES,
        "backlog": {crew: {"open_by_severity": dict(c), "work_minutes_at_or_above_floor": workload(jobs, floor).get(crew, 0)}
                    for crew, c in by_crew.items()},
        "worst_jobs": [{"id": i.id, "crew": CREW_FOR[i.category], "severity": i.severity, "pinned": dispatch.pinned(i),
                        "sightings": i.sightings, "what": dispatch.label(i)[:110],
                        "why": (i.severity_reason or "")[:120] or None} for i in top],
        "pinned": [i.id for i in jobs if dispatch.pinned(i)],
        "hotspots": hotspots(jobs, floor),
        "wards": ward_backlog(jobs, floor),
        "sites": [{"id": f.id, "label": f.label, "kind": f.kind, "crews": f.crews,
                   "trucks_per_day_now": sites_now.get(f.id, {}),
                   "nearest_open_work_minutes": loads.get(f.id, {})} for f in facilities.load()],
        "last_plan": None if last is None else {
            "deferred_by_crew": dict(Counter(CREW_FOR[by_id[d].category] for d in last.deferred if d in by_id)),
            "unassigned_reasons": dict(Counter(r.split(":")[0] for r in last.unassigned_reasons.values())),
            "severity_floor": last.min_severity},
    }


# ---- Scenarios ----

def _totals(sites: dict[str, dict[str, int]]) -> dict[str, int]:
    out: Counter = Counter()
    for crews in sites.values():
        out.update({c: n for c, n in crews.items() if n > 0})
    return dict(out)


def clamp(raw: _Proposed, sites_now: dict[str, dict[str, int]], jobs: list[IssueRecord], sid: str,
          source: str = "model") -> Scenario:
    """A proposal inside the rules: known sites, hosted crews, 0-20 trucks, trucks versus workload."""
    notes = []
    known = {f.id: f for f in facilities.load()}
    sites = {fid: dict(c) for fid, c in sites_now.items() if fid in known}
    for fid, crews in (raw.sites or {}).items():
        site = known.get(fid)
        if site is None:
            notes.append(f"Unknown site {fid} ignored")
            continue
        for crew, n in crews.items():
            if crew not in site.crews:
                notes.append(f"{site.label} does not host {crew}; ignored")
                continue
            value = max(0, min(facilities.MAX_VEHICLES, int(n)))
            if value != n:
                notes.append(f"{site.label} {crew}: {n} trucks clamped to {value}")
            sites.setdefault(fid, {})[crew] = value
    floor = max(1, min(5, int(raw.min_severity)))
    if floor != raw.min_severity:
        notes.append(f"Severity floor {raw.min_severity} clamped to {floor}")
    # Trucks versus workload: no more than the work needs (plus two), unless that is fewer than now.
    need = workload(jobs, floor)
    loads = local_load(jobs, floor)
    now = _totals(sites_now)
    for crew, asked in _totals(sites).items():
        cap = max(now.get(crew, 0), math.ceil(need.get(crew, 0) / TRUCK_MINUTES) + 2)
        total = asked
        while total > cap:                     # take from the site with the least work per truck
            fid = min((f for f in sites if sites[f].get(crew, 0) > 0),
                      key=lambda f: loads.get(f, {}).get(crew, 0) / sites[f][crew])
            sites[fid][crew] -= 1
            total -= 1
        if total < asked:
            notes.append(f"{crew}: {asked} trucks trimmed to {cap} for {need.get(crew, 0)} min of work")
    sites = {fid: {c: n for c, n in crews.items() if n > 0} for fid, crews in sites.items()}
    sites = {fid: c for fid, c in sites.items() if c}
    zone_ids = [z for z in raw.zones if zones_mod.get(z)]
    if len(zone_ids) < len(raw.zones):
        notes.append("Unknown zones ignored: " + ", ".join(z for z in raw.zones if z not in zone_ids)[:80])
    return Scenario(id=sid, label=raw.label.strip()[:60] or sid, intent=" ".join(raw.intent.split())[:160],
                    source=source, min_severity=floor, sites=sites, trucks=_totals(sites), clamped=notes[:8],
                    zones=zone_ids)


def baseline(sites_now: dict[str, dict[str, int]], floor: int) -> Scenario:
    sites = {fid: {c: n for c, n in crews.items() if n > 0} for fid, crews in sites_now.items()}
    return Scenario(id="baseline", label="Current settings", intent="The trucks and floor set now",
                    source="baseline", min_severity=floor, sites={k: v for k, v in sites.items() if v},
                    trucks=_totals(sites))


def rule_scenarios(sites_now: dict[str, dict[str, int]], floor: int, jobs: list[IssueRecord]) -> list[Scenario]:
    """No model: an S4+ focus and one more truck where the work per truck is highest."""
    out = []
    focus = 4 if floor < 4 else 3
    out.append(clamp(_Proposed(label="S4+ focus" if focus == 4 else "Widen to S3+",
                               intent="Same trucks, " + ("only this-week work and hazards" if focus == 4
                                                         else "take on this-month work too"),
                               min_severity=focus), sites_now, jobs, "rules-1", "rules"))
    loads = local_load(jobs, floor)
    best, score = None, -1.0
    for f in facilities.load():
        for crew, minutes in loads.get(f.id, {}).items():
            per = minutes / (sites_now.get(f.id, {}).get(crew, 0) + 1)
            if per > score and sites_now.get(f.id, {}).get(crew, 0) < facilities.MAX_VEHICLES:
                best, score = (f, crew), per
    if best:
        f, crew = best
        out.append(clamp(_Proposed(label=f"+1 {crew} truck at {f.label.split(' (')[0]}",
                                   intent=f"One more {crew} truck where the work per truck is highest",
                                   min_severity=floor, sites={f.id: {crew: sites_now.get(f.id, {}).get(crew, 0) + 1}}),
                         sites_now, jobs, "rules-2", "rules"))
    return out


# ---- Evaluation and scoring ----

def metrics(out: dispatch.Outcome, jobs: list[IssueRecord], vehicles: int, elapsed: float) -> ScenarioMetrics:
    routed = [x.issue for td, _ in out.truck_days for x in td.visits if x.kind == "job"]
    routed_ids = {i.id for i in routed}
    crews = {v.crew for v in out.vehicles}
    reachable = [i for i in jobs if CREW_FOR[i.category] in crews]
    drive = work = 0
    dist = 0.0
    for td, ctx in out.truck_days:
        _, totals = dispatch.schedule(td, ctx)
        drive += totals.drive_min
        work += totals.work_min
        base = (td.vehicle.facility.lat, td.vehicle.facility.lon)
        pts = [base, *((x.issue.lat, x.issue.lon) for x in td.visits if x.kind == "job"), base]
        dist += sum(km(a, b) for a, b in zip(pts, pts[1:])) * roads.DETOUR
    reasons = Counter(r.split(":")[0].split(" at ")[0] for r in out.reasons.values())
    pinned = [i for i in jobs if dispatch.pinned(i)]
    return ScenarioMetrics(
        jobs_selected=len(out.selected), jobs_routed=len(routed_ids),
        s5_total=sum(i.severity == 5 for i in reachable), s5_covered=sum(i.severity == 5 for i in routed),
        s4_total=sum(i.severity == 4 for i in reachable), s4_covered=sum(i.severity == 4 for i in routed),
        pinned_total=len(pinned), pinned_covered=sum(i.id in routed_ids for i in pinned),
        drive_hours=round(drive / 60, 1), work_hours=round(work / 60, 1), distance_km=round(dist, 1),
        trucks_used=len({td.vehicle.id for td, _ in out.truck_days}), trucks_available=vehicles,
        deferred=len(out.deferred), unassigned_by_reason=dict(reasons), solver=out.solver,
        triage=out.triage.model, days=out.horizon, solve_ms=int(elapsed * 1000))


def score(m: ScenarioMetrics) -> tuple:
    """Lower is better: pinned and S5 jobs missed, then S4 missed, then drive hours per job, then fewer jobs."""
    per_job = m.drive_hours / max(1, m.jobs_routed)
    return (m.pinned_total - m.pinned_covered, m.s5_total - m.s5_covered, m.s4_total - m.s4_covered,
            round(per_job, 3), -m.jobs_routed)


def rule_pick(scenarios: list[Scenario]) -> Scenario | None:
    done = [s for s in scenarios if s.metrics]
    return min(done, key=lambda s: score(s.metrics), default=None)


@op
def scenario_solved(scenario: str, summary: dict) -> dict:
    """Weave: one scenario's settings and scored outcome (text only)."""
    return summary


async def evaluate(prep: dispatch.Prepared, scenarios: list[Scenario], days: int,
                   budget: float, focus: "zones_mod.Focus | None" = None) -> dict[str, dispatch.Outcome]:
    """Triage (rules) and solve every scenario concurrently over the shared matrices, within the budget.
    A scenario's own zones replace the request's focus."""
    async def one(s: Scenario):
        started = time.perf_counter()
        vehicles = dispatch.site_fleet(s.sites)
        where = zones_mod.focus(s.zones) if s.zones else focus
        out = await dispatch.run(prep, vehicles, s.min_severity, days, use_model=False, focus=where)
        s.metrics = metrics(out, prep.jobs, len(vehicles), time.perf_counter() - started)
        _progress["scenarios_done"] = _progress.get("scenarios_done", 0) + 1
        try:
            scenario_solved(s.id, {"label": s.label, "min_severity": s.min_severity, "trucks": s.trucks,
                                   "metrics": s.metrics.model_dump()})
        except Exception:
            pass
        return s.id, out

    tasks = {asyncio.ensure_future(one(s)): s for s in scenarios}
    done, pending = await asyncio.wait(tasks, timeout=budget)
    for t in pending:
        t.cancel()
        tasks[t].error = f"Not evaluated within the {budget:.0f} s budget"
    out = {}
    for t in done:
        try:
            sid, outcome = t.result()
            out[sid] = outcome
        except Exception as exc:
            tasks[t].error = f"Evaluation failed: {config.redact(exc)[:120]}"
            log.warning("Scenario %s failed (%s)", tasks[t].id, config.redact(exc))
    return out


@op
async def recommend_propose(facts: dict) -> dict:
    from app.ai import nemotron
    reply = await nemotron.chat_json([{"role": "system", "content": PROPOSE_PROMPT.format(truck=TRUCK_MINUTES)},
                                      {"role": "user", "content": json.dumps(facts)}],
                                     _Proposals, model=nemotron.ULTRA, timeout=MODEL_TIMEOUT_S, max_tokens=12000)
    return reply.model_dump()


@op
async def recommend_pick(table: dict) -> dict:
    from app.ai import nemotron
    reply = await nemotron.chat_json([{"role": "system", "content": PICK_PROMPT},
                                      {"role": "user", "content": json.dumps(table)}],
                                     _Pick, model=nemotron.ULTRA, timeout=MODEL_TIMEOUT_S, max_tokens=12000)
    return reply.model_dump()


def _table(scenarios: list[Scenario]) -> dict:
    return {"scenarios": [{"id": s.id, "label": s.label, "intent": s.intent, "min_severity": s.min_severity,
                           "trucks": s.trucks, "metrics": s.metrics.model_dump() if s.metrics else None,
                           "error": s.error} for s in scenarios]}


def _template_rationale(pick: Scenario, scenarios: list[Scenario]) -> tuple[str, list[str]]:
    m = pick.metrics
    text = (f"{pick.label} routes {m.jobs_routed} jobs, covering {m.s5_covered}/{m.s5_total} S5 and "
            f"{m.s4_covered}/{m.s4_total} S4" + (f" and {m.pinned_covered}/{m.pinned_total} pinned" if m.pinned_total else "")
            + f" jobs with {m.drive_hours} h of driving over {m.trucks_used} trucks. Picked by the code rule: "
            "pinned and S5 coverage first, then S4, then drive hours per job.")
    trade = [f"{s.label}: {s.metrics.jobs_routed} jobs, S4 {s.metrics.s4_covered}/{s.metrics.s4_total}, "
             f"{s.metrics.drive_hours} h driving" for s in scenarios if s.metrics and s.id != pick.id][:3]
    return text, trade


async def recommend(days: int = 1, min_severity: int = 3, sites: dict[str, dict[str, int]] | None = None,
                    use_model: bool = True, zones: list[str] | None = None, polygon: list | None = None) -> Recommendation:
    """The loop above. Never raises for a model or solver failure: the rules and the fallback router stand in."""
    global _latest, _solved, _prep, _fingerprint, _made
    _progress.clear()
    _progress.update({"running": True, "started": time.monotonic(), "stage": "Nemotron proposing scenarios"
                      if use_model else "Rules proposing scenarios", "scenarios_done": 0, "scenarios_total": 0})
    try:
        return await _recommend(days, min_severity, sites, use_model, zones, polygon)
    finally:
        _progress.update({"running": False, "stage": "done"})


async def _recommend(days: int, min_severity: int, sites: dict[str, dict[str, int]] | None,
                     use_model: bool, zone_ids: list[str] | None = None, polygon: list | None = None) -> Recommendation:
    global _latest, _solved, _prep, _fingerprint, _made
    started = time.perf_counter()
    timings: dict[str, float] = {}
    days = max(1, min(dispatch.MAX_DAYS, int(days)))
    min_severity = max(1, min(5, int(min_severity)))
    jobs = dispatch._jobs()
    focus = zones_mod.focus(zone_ids, polygon)
    sites_now = dispatch.current_sites() if sites is None else {k: dict(v) for k, v in sites.items()}
    caveats = []

    async def timed(name, call):
        mark = time.perf_counter()
        try:
            return await call
        finally:
            timings[name] = round(time.perf_counter() - mark, 1)

    async def propose():
        if not use_model:
            return None
        try:
            known = facts(jobs, min_severity, days, sites_now)
            if focus:
                known["focus_zones"] = focus.labels
            return _Proposals.model_validate(await asyncio.wait_for(recommend_propose(known), MODEL_TIMEOUT_S + 5))
        except Exception as exc:
            log.warning("Recommend: rules propose (%s)", config.redact(exc))
            return None

    # Matrices for every job and every site (scenarios move trucks between sites) while the model proposes.
    proposals, prep = await asyncio.gather(timed("propose", propose()), timed("matrix", dispatch.prepare(jobs, 1)))
    scenarios = [baseline(sites_now, min_severity)]
    if proposals and proposals.scenarios:
        proposer = "nemotron"
        for n, raw in enumerate(proposals.scenarios[:MAX_PROPOSALS], 1):
            scenarios.append(clamp(raw, sites_now, jobs, f"s{n}"))
        priorities = [" ".join(p.split())[:120] for p in proposals.priorities[:5]]
    else:
        proposer, priorities = "rules", []
        scenarios += rule_scenarios(sites_now, min_severity, jobs)
    unique, seen = [], set()
    for s in scenarios:                        # identical settings are solved once
        key = (s.min_severity, json.dumps(s.sites, sort_keys=True))
        if key in seen:
            continue
        seen.add(key)
        unique.append(s)
    scenarios = unique

    _stage("cuOpt solving scenarios", scenarios_total=len(scenarios), scenarios_done=0)
    solved_out = await timed("evaluate", evaluate(prep, scenarios, days, SOLVE_BUDGET_S, focus))
    if not solved_out:
        caveats.append("No scenario finished within the time budget")

    picker, rationale, tradeoffs, refined = "rules", "", [], False
    pick = None
    if use_model and proposer == "nemotron" and solved_out:
        try:
            _stage("Nemotron comparing scenarios")
            mark = time.perf_counter()
            reply = _Pick.model_validate(await asyncio.wait_for(recommend_pick(_table(scenarios)), MODEL_TIMEOUT_S + 5))
            timings["pick"] = round(time.perf_counter() - mark, 1)
            pick = next((s for s in scenarios if s.id == reply.recommended and s.metrics), None)
            if pick is None:
                caveats.append(f"Nemotron picked {reply.recommended!r}, which was not a solved scenario; the code rule picked")
            else:
                picker = "nemotron"
                rationale = " ".join(reply.rationale.split())[:700]
                tradeoffs = [" ".join(t.split())[:200] for t in reply.tradeoffs[:4]]
            if pick is not None and reply.refine and time.perf_counter() - started < MAX_TOTAL_S:
                tweak = clamp(reply.refine, pick.sites, jobs, "refined", "refined")
                tweak.label = tweak.label or f"{pick.label} (refined)"
                _stage("cuOpt solving a refined scenario", scenarios_total=_progress.get("scenarios_total", 0) + 1)
                more = await timed("refine", evaluate(prep, [tweak], days, SOLVE_BUDGET_S / 2, focus))
                scenarios.append(tweak)
                solved_out |= more
                refined = True
                if tweak.metrics and score(tweak.metrics) < score(pick.metrics):
                    rationale += f" Refined: {tweak.label} scored better on the code rule, so it is recommended instead."
                    pick = tweak
                elif tweak.metrics:
                    rationale += f" A refinement ({tweak.label}) was solved but did not score better."
        except Exception as exc:
            log.warning("Recommend: rules pick (%s)", config.redact(exc))
    if pick is None:
        pick = rule_pick(scenarios) or scenarios[0]
        picker = "rules"
        if pick.metrics:
            rationale, tradeoffs = _template_rationale(pick, scenarios)
        else:
            rationale = "No scenario could be evaluated; keeping the current settings."
    from app.ai import nemotron
    model, model_name = ("rules", None)
    if "nemotron" in (proposer, picker):
        model, model_name = triage_mod.MODELS.get(nemotron.ULTRA, ("nemotron", nemotron.ULTRA))
    if any(s.metrics and s.metrics.solver == "fallback" for s in scenarios):
        caveats.append("cuOpt did not answer for some scenarios; the nearest-neighbour fallback evaluated them")
    timings["total"] = round(time.perf_counter() - started, 1)
    rec = Recommendation(id=uuid.uuid4().hex[:12], generated_at=datetime.now(timezone.utc), agent_model=model,
                         agent_model_name=model_name, proposer=proposer, picker=picker, recommended=pick.id,
                         rationale=rationale, tradeoffs=tradeoffs, priorities=priorities, scenarios=scenarios,
                         matrix_source=prep.matrix_source, days=days, refined=refined, timings=timings,
                         caveats=caveats, zones=focus.ids if focus else [], zone_labels=focus.labels if focus else [])
    _latest, _solved, _prep, _fingerprint, _made = rec, solved_out, prep, fingerprint(jobs), time.monotonic()
    await asyncio.to_thread(_save, rec)
    log.info("Recommend: %d scenarios (proposer=%s, picker=%s), picked %s, solvers=%s, matrix=%s, %s",
             len(scenarios), proposer, picker, pick.id,
             ",".join(sorted({s.metrics.solver for s in scenarios if s.metrics})) or "-", prep.matrix_source,
             ", ".join(f"{k} {v} s" for k, v in timings.items()))
    return rec
