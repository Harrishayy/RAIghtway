"""Operations report: every figure and list comes from code; Nemotron writes the prose; a template stands in.

regenerate() builds: an executive summary and crew rationale (Nemotron, else template), headline stats, one
section per category (counts by severity, worst findings with the rater's reason, workload, crews, equipment
rolled up from work orders, recommended repair approach), a priority list (every open severity 4-5 issue with
its deadline), hotspots (findings clustered within a few hundred metres) and data provenance (which models
answered, dedupe and embedding coverage, caveats). Findings the rating pass rejected are counted apart.

schedule_regen() runs one background regeneration at a time, at most once a minute;
the previous report stays visible meanwhile (is_updating() tells the API).
"""
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import logging
import math
from pathlib import Path
import time

from pydantic import BaseModel, Field

from app import config, store
from app.ai import nemotron
from app.ai.prompts import CATEGORIES, DEFAULT_MINUTES, SEVERITY_RUBRIC
from app.models import (CREW_FOR, IssueRecord, Report, ReportCount, ReportCrewPlan, ReportHotspot, ReportIssue,
                        ReportPlanDay, ReportProvenance, ReportSection, ReportSite, ReportStats, ReportTriageItem)

log = logging.getLogger(__name__)
try:
    from app import curation          # demo mode hides hand-reviewed false positives from console views
except Exception:                     # pragma: no cover - older deployments without demo mode
    curation = None
SHIFT_MIN = 480
OVERHEAD = 1.3                       # travel and setup on top of work-order minutes
DEBOUNCE_S = 60.0
TOP_N = 10
SECTION_TOP = 5
PRIORITY_MAX = 40
HOTSPOT_RADIUS_M = 300.0
HOTSPOT_MAX = 6
WEIGHT = {1: 1, 2: 2, 3: 4, 4: 8, 5: 16}
DEADLINE = {5: "today", 4: "this week", 3: "this month"}
TEMPLATE_REPAIR = "Inspect and repair the reported"      # nemotron._template's work orders start with this
PLACE_BUDGET = 30                    # new street-name lookups per report (OSRM's public server: ~1 per second)
REPORT_MODELS = {nemotron.ULTRA: ("nemotron-ultra", "Nemotron 3 Ultra"),
                 nemotron.LIGHTNING: ("nemotron-lightning", "Nemotron 3.5 Lightning")}
LABEL = {"pavement": "Pavement", "graffiti": "Graffiti", "markings": "Road markings", "work_zone": "Work zones",
         "signage": "Signage", "waste": "Waste"}
APPROACH = {
    "pavement": "Make severity 4-5 potholes safe first with cold-patch and cones the same day, then schedule "
                "saw-cut and hot-mix repairs for failed patches and broken asphalt; group curb-side work by street.",
    "markings": "Repaint crosswalks and stop lines at intersections first, then lane lines; bundle by corridor and "
                "paint in dry weather with a lane closure.",
    "work_zone": "Send an inspector to each active closure: check taper, signs and cones, reset knocked-over "
                 "devices, and escalate any unguarded excavation or debris in a live lane to the permit holder.",
    "signage": "Clean or replace defaced and obscured regulatory signs first (stop, yield), trim foliage blocking "
               "them, and straighten or replace bent posts.",
    "graffiti": "Remove offensive content and paint on signs within the week; batch wall tagging by block for "
                "pressure-washing or paint-out, and notify private owners where the wall is not City property.",
    "waste": "Collect dumped bags and bulky items blocking sidewalks or bike lanes first, then empty overflowing "
             "bins on the route and log repeat dumping spots for enforcement.",
}
REPORT_PROMPT = """You write the street-maintenance operations report for a city operations manager.
You get facts computed by the application: open issue counts, the top-priority issues with the inspector model's
reason for each grade, each category's counts, worst findings, workload and equipment, the hotspots, and a
baseline number of crews per crew type (one crew works a 480-minute shift).
Write:
- summary: a factual 3-5 sentence executive summary that quotes the key numbers you were given.
- crews: recommended crews per crew type. Stay close to the baseline; change it only for a clear reason such as
  many severity 4-5 hazards.
- rationale: 2-4 sentences naming the most urgent work and why.
- sections: for each category key given, 2-3 sentences of recommended repair approach for THESE findings
  (what to do first, how to group the work, materials), citing issue ids for the worst ones.
- hotspots: for each hotspot id given, one sentence on what is there and what to send.
- crew_plan: if crew_plan facts are given, 2-3 sentences on the routed plan (day 1 is today: sites, trucks,
  hours, what waits and anything unassigned); mention triage only if triage figures are given; state only what the
  figures show, never assume; otherwise an empty string.
Use only the facts given; do not invent issues, places or numbers. Do not claim repairs were completed.
Severity rubric:
""" + SEVERITY_RUBRIC + """
Return JSON only: {"summary":"<text>","crews":{"<crew type>":<integer>},"rationale":"<text>",
"sections":{"<category>":"<text>"},"hotspots":{"<hotspot id>":"<text>"},"crew_plan":"<text>"}"""


class _ReportReply(BaseModel):
    summary: str = Field(min_length=1)
    crews: dict[str, int]
    rationale: str = Field(min_length=1)
    sections: dict[str, str] = {}
    hotspots: dict[str, str] = {}
    crew_plan: str = ""


def _visible(issues: list[IssueRecord]) -> list[IssueRecord]:
    return curation.visible(issues) if curation is not None else issues


def _minutes(issue: IssueRecord) -> int:
    return issue.work_order.minutes if issue.work_order else DEFAULT_MINUTES[issue.category]


def _rank(issue: IssueRecord) -> tuple:
    return (-issue.severity, -issue.sightings, -issue.confidence, issue.id)


def _facts(issues: list[IssueRecord]) -> tuple[dict[str, int], dict[str, int], dict[str, int], list[IssueRecord]]:
    """counts (category + severity_N), workload minutes per crew, baseline crews, top issues."""
    counts = dict(Counter(i.category for i in issues))
    counts.update({f"severity_{s}": n for s, n in sorted(Counter(i.severity for i in issues).items())})
    workload: dict[str, int] = defaultdict(int)
    for issue in issues:
        workload[CREW_FOR[issue.category]] += _minutes(issue)
    baseline = {crew: math.ceil(minutes * OVERHEAD / SHIFT_MIN) for crew, minutes in workload.items() if minutes > 0}
    top = sorted(issues, key=_rank)[:TOP_N]
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


# ---- Places: nearest named street from OSRM, cached on disk ----

def _place_key(lat: float, lon: float) -> str:
    return f"{lat:.4f},{lon:.4f}"


def _place_cache() -> dict[str, str]:
    try:
        data = json.loads((Path(config.STATE_DIR) / "street_names.json").read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


async def _places(points: list[tuple[float, float]], budget: int = PLACE_BUDGET) -> dict[str, str]:
    """Street names for points (key _place_key). Cached forever; at most `budget` new OSRM lookups."""
    cache = _place_cache()
    missing = list(dict.fromkeys(_place_key(*p) for p in points if _place_key(*p) not in cache))[:budget]
    if missing:
        try:
            from app.geo import roads
            if roads.enabled():
                for key in missing:
                    lat, lon = map(float, key.split(","))
                    try:
                        body = await roads._get(f"/nearest/v1/driving/{lon:.5f},{lat:.5f}", {"number": 1})
                        cache[key] = str((body.get("waypoints") or [{}])[0].get("name") or "")
                    except Exception as exc:
                        log.info("Street name lookup failed (%s)", config.redact(exc))
                        break
                path = Path(config.STATE_DIR) / "street_names.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(cache))
        except Exception as exc:
            log.warning("Street names unavailable (%s)", config.redact(exc))
    return {k: v for k, v in cache.items() if v}


# ---- Facts: everything below is computed, never written by a model ----

def _deadline(severity: int) -> str:
    return DEADLINE.get(severity, "routine")


def _report_issue(issue: IssueRecord, drives: dict[str, str], places: dict[str, str]) -> ReportIssue:
    place = places.get(_place_key(issue.lat, issue.lon)) if issue.lat is not None and issue.lon is not None else None
    return ReportIssue(
        id=issue.id, category=issue.category, severity=issue.severity, severity_reason=issue.severity_reason,
        description=issue.description, video_id=issue.video_id, drive=drives.get(issue.video_id), t=issue.t,
        lat=issue.lat, lon=issue.lon, place=place, sightings=issue.sightings, confidence=issue.confidence,
        deadline=_deadline(issue.severity), crew=CREW_FOR[issue.category],
        repair=issue.work_order.repair if issue.work_order else None, minutes=_minutes(issue))


def _equipment(issues: list[IssueRecord], limit: int = 8) -> list[ReportCount]:
    counts: Counter = Counter()
    labels: dict[str, str] = {}
    for issue in issues:
        if issue.work_order is None or issue.work_order.repair.startswith(TEMPLATE_REPAIR):
            continue
        keys = set()
        for item in issue.work_order.equipment:
            key = " ".join(str(item).lower().split())
            if key:
                keys.add(key)
                labels.setdefault(key, " ".join(str(item).split()))
        counts.update(keys)                     # count = work orders that need it
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    return [ReportCount(label=labels[k], count=n) for k, n in ranked]


def _sections(open_issues: list[IssueRecord], rejected: list[IssueRecord], baseline: dict[str, int],
              drives: dict[str, str], places: dict[str, str]) -> list[ReportSection]:
    sections = []
    for category in CATEGORIES:
        mine = sorted((i for i in open_issues if i.category == category), key=_rank)
        dropped = sum(i.category == category for i in rejected)
        if not mine and not dropped:
            continue
        minutes = sum(_minutes(i) for i in mine)
        by_sev = Counter(i.severity for i in mine)
        sections.append(ReportSection(
            category=category, crew=CREW_FOR[category], open=len(mine),
            by_severity={str(s): by_sev.get(s, 0) for s in range(1, 6)},
            severe=by_sev.get(4, 0) + by_sev.get(5, 0), rejected=dropped, work_minutes=minutes,
            crew_hours=round(minutes * OVERHEAD / 60, 1), crews=baseline.get(CREW_FOR[category], 0),
            equipment=_equipment(mine), top=[_report_issue(i, drives, places) for i in mine[:SECTION_TOP]],
            approach=APPROACH.get(category)))
    return sections


def _hotspots(open_issues: list[IssueRecord], drives: dict[str, str]) -> list[ReportHotspot]:
    """Greedy clusters: worst findings seed a cluster; others join the first centre within HOTSPOT_RADIUS_M."""
    from app.geo.distance import km
    located = sorted((i for i in open_issues if i.lat is not None and i.lon is not None), key=_rank)
    clusters: list[list[IssueRecord]] = []
    for issue in located:
        for cluster in clusters:
            if km((cluster[0].lat, cluster[0].lon), (issue.lat, issue.lon)) * 1000 <= HOTSPOT_RADIUS_M:
                cluster.append(issue)
                break
        else:
            clusters.append([issue])
    scored = []
    for cluster in clusters:
        if len(cluster) < 2:
            continue
        lat = sum(i.lat for i in cluster) / len(cluster)
        lon = sum(i.lon for i in cluster) / len(cluster)
        score = sum(WEIGHT.get(i.severity, 1) * max(1, i.sightings) ** 0.5 for i in cluster)
        scored.append((score, lat, lon, cluster))
    scored.sort(key=lambda c: (-c[0], c[3][0].id))
    hotspots = []
    for n, (score, lat, lon, cluster) in enumerate(scored[:HOTSPOT_MAX], 1):
        drive_list = sorted({drives[i.video_id] for i in cluster if drives.get(i.video_id)})
        hotspots.append(ReportHotspot(
            id=f"H{n}", label=f"Hotspot {n}", lat=round(lat, 6), lon=round(lon, 6), radius_m=int(HOTSPOT_RADIUS_M),
            issues=len(cluster), severe=sum(i.severity >= 4 for i in cluster),
            max_severity=max(i.severity for i in cluster), score=round(score, 1),
            categories=dict(Counter(i.category for i in cluster).most_common()), drives=drive_list,
            issue_ids=[i.id for i in cluster]))
    return hotspots


def _provenance(sightings: list[IssueRecord], canonical: list[IssueRecord], rejected: list[IssueRecord],
                report_model: str) -> ReportProvenance:
    rating_models = Counter(i.severity_model for i in sightings if i.severity_model)
    unrated = sum(not i.severity_model for i in sightings)
    with_orders = [i for i in canonical if i.work_order is not None]
    templated = sum(i.work_order.repair.startswith(TEMPLATE_REPAIR) for i in with_orders)
    duplicates = sum(bool(i.duplicate_of) for i in sightings)
    no_gps = sum(i.lat is None or i.lon is None for i in canonical)
    caveats = []
    if unrated:
        caveats.append(f"{_plural(unrated, 'sighting')} still carry the find pass's severity (not re-graded).")
    fallback = rating_models.get("nemotron-super-vl", 0)
    if fallback:
        caveats.append(f"{_plural(fallback, 'sighting')} were graded by Nemotron Super-VL because Cosmos3-Reason "
                       "did not answer.")
    if rejected:
        caveats.append(f"{_plural(len(rejected), 'finding')} judged not to be a defect "
                       f"{'is' if len(rejected) == 1 else 'are'} left out of the counts, crews and routes "
                       "(kept on record, reversible).")
    if templated:
        caveats.append(f"{_plural(templated, 'work order')} {'is a' if templated == 1 else 'are'} template "
                       f"{'fallback' if templated == 1 else 'fallbacks'}: repair time and kit need crew confirmation.")
    missing_orders = sum(i.work_order is None for i in canonical)
    if missing_orders:
        caveats.append(f"{_plural(missing_orders, 'issue')} {'has' if missing_orders == 1 else 'have'} no work order; "
                       "workload uses the category default minutes.")
    if no_gps:
        caveats.append(f"{_plural(no_gps, 'issue')} {'has' if no_gps == 1 else 'have'} no GPS fix and cannot be routed.")
    if report_model == "template":
        caveats.append("Nemotron did not answer, so the narrative is the application's template.")
    caveats.append("Severity is graded from a single keyframe; crews should confirm on site.")
    return ReportProvenance(
        report_model=report_model, rating_models=dict(rating_models), unrated=unrated, rejected=len(rejected),
        sightings_total=len(sightings), canonical=len(canonical), duplicates_merged=duplicates,
        with_embedding=sum(i.embedding is not None for i in sightings),
        with_gps=sum(i.lat is not None and i.lon is not None for i in sightings),
        with_box=sum(i.bbox is not None for i in sightings), work_orders=len(with_orders),
        template_work_orders=templated, caveats=caveats)


def _stats(open_issues: list[IssueRecord], rejected: int, drives: dict[str, str], crews: dict[str, int],
           workload: dict[str, int]) -> ReportStats:
    by_sev = Counter(i.severity for i in open_issues)
    return ReportStats(
        open=len(open_issues), today=by_sev.get(5, 0), this_week=by_sev.get(4, 0), this_month=by_sev.get(3, 0),
        routine=by_sev.get(1, 0) + by_sev.get(2, 0),
        located=sum(i.lat is not None and i.lon is not None for i in open_issues),
        drives=len({drives.get(i.video_id) or i.video_id for i in open_issues}), crews=sum(crews.values()),
        crew_hours=round(sum(workload.values()) * OVERHEAD / 60, 1), rejected=rejected)


# ---- Crew plan: the latest stored dispatch plan, read defensively (older plans lack the multi-day fields) ----

SHIFT_START_MIN = 8 * 60
TRIAGE_MAX = 40
UNASSIGNED_MAX = 40
_DECISION_ORDER = {"today": 0, "later": 1, "defer": 2}


def _clock(minutes) -> str | None:
    if minutes is None:
        return None
    total = SHIFT_START_MIN + int(minutes)
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def _get(obj, name, default=None):
    value = obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)
    return default if value is None else value


def _route_minutes(route, minutes: dict[str, int]) -> tuple[int, int]:
    """Drive and work minutes of an older route without totals: work from the stops' work orders, drive from the
    arrival times (each arrival minus the work done before it)."""
    stops, etas = list(_get(route, "stops", [])), list(_get(route, "eta_min", []))
    work = sum(minutes.get(str(s), 0) for s in stops)
    if not stops or len(etas) < len(stops):
        return 0, work
    return max(0, int(etas[len(stops) - 1]) - sum(minutes.get(str(s), 0) for s in stops[:-1])), work


def _crew_plan(plan, severity: dict[str, int], minutes: dict[str, int] | None = None) -> ReportCrewPlan | None:
    """Summarise a Plan (or None). Every figure is counted here; nothing is asked of a model."""
    if plan is None:
        return None
    routes = list(_get(plan, "routes", []))
    by_day: dict[int, list] = defaultdict(list)
    for route in routes:
        by_day[int(_get(route, "day", 1))].append(route)
    stated = {int(_get(d, "day", 0)): d for d in _get(plan, "days", [])}
    days = []
    for day in sorted(set(by_day) | set(stated)):
        rs, info = by_day.get(day, []), stated.get(day)
        totals = [_get(r, "totals") for r in rs if _get(r, "totals") is not None]
        drive = sum(int(_get(t, "drive_min", 0)) for t in totals) if totals else int(_get(info, "drive_min", 0) or 0)
        work = sum(int(_get(t, "work_min", 0)) for t in totals) if totals else int(_get(info, "work_min", 0) or 0)
        if not totals and not drive and not work and minutes:
            pairs = [_route_minutes(r, minutes) for r in rs]
            drive, work = sum(p[0] for p in pairs), sum(p[1] for p in pairs)
        kms = [(_get(t, "distance_km") if _get(t, "distance_km") is not None else None) for t in totals] or \
              [_get(r, "distance_km") for r in rs]
        kms = [float(k) for k in kms if k is not None]
        backs = [int(_get(t, "back_min")) for t in totals if _get(t, "back_min") is not None]
        jobs = int(_get(info, "jobs", 0) or 0) or sum(len(_get(r, "stops", [])) for r in rs)
        trucks = int(_get(info, "trucks", 0) or 0) or sum(bool(_get(r, "stops", [])) for r in rs)
        days.append(ReportPlanDay(day=day, jobs=jobs, trucks=trucks, drive_h=round(drive / 60, 1),
                                  work_h=round(work / 60, 1), km=round(sum(kms), 1) if kms else None,
                                  back_first=_clock(min(backs)) if backs else None,
                                  back_last=_clock(max(backs)) if backs else None,
                                  solver=_get(info, "solver") or (_get(rs[0], "solver") if rs else None)))
    site_routes: dict[str, list] = defaultdict(list)
    for route in routes:
        if _get(route, "facility_id"):
            site_routes[_get(route, "facility_id")].append(route)
    sites = []
    for facility in _get(plan, "facilities", []):
        id = str(_get(facility, "id", ""))
        rs = site_routes.get(id, [])
        trucks = {str(k): int(v) for k, v in dict(_get(facility, "vehicles", {}) or {}).items()}
        if not trucks and rs:              # no per-site setting: distinct trucks per crew type per day in the plan
            n_days = max(1, len({int(_get(r, "day", 1)) for r in rs}))
            per: dict[str, set] = defaultdict(set)
            for r in rs:
                per[str(_get(r, "crew"))].add((_get(r, "vehicle_id") or _get(r, "crew_id"), int(_get(r, "day", 1))))
            trucks = {crew: math.ceil(len(v) / n_days) for crew, v in per.items()}
        sites.append(ReportSite(id=id, label=str(_get(facility, "label", id)), kind=str(_get(facility, "kind", "yard")),
                                crews=[str(c) for c in _get(facility, "crews", [])], trucks=trucks, routes=len(rs),
                                jobs=sum(len(_get(r, "stops", [])) for r in rs),
                                assumed=bool(_get(facility, "assumed", False))))
    sites.sort(key=lambda x: (-x.jobs, x.label))
    triage = _get(plan, "triage")
    decisions = [ReportTriageItem(issue_id=str(_get(d, "issue_id", "")), crew=str(_get(d, "crew", "")),
                                  severity=int(_get(d, "severity", 0) or 0), decision=str(_get(d, "decision", "")),
                                  reason=str(_get(d, "reason", "")), by=str(_get(d, "by", "")))
                 for d in (_get(triage, "decisions", []) if triage is not None else [])]
    counts = Counter(d.decision for d in decisions)
    decisions.sort(key=lambda d: (_DECISION_ORDER.get(d.decision, 3), -d.severity, d.issue_id))
    reasons = dict(_get(plan, "unassigned_reasons", {}) or {})
    unassigned_ids = list(_get(plan, "unassigned", []))
    unassigned = [ReportTriageItem(issue_id=str(i), crew="", severity=severity.get(str(i), 0), decision="unassigned",
                                   reason=str(reasons.get(i) or "Not routed"), by="solver")
                  for i in unassigned_ids]
    unassigned.sort(key=lambda d: (-d.severity, d.issue_id))
    stops = sum(len(_get(r, "stops", [])) for r in routes)
    trucks = len({_get(r, "vehicle_id") or _get(r, "crew_id") for r in routes if _get(r, "stops", [])})
    return ReportCrewPlan(
        solver=str(_get(plan, "solver", "fallback")), matrix_source=str(_get(plan, "matrix_source", "straight")),
        solve_ms=int(_get(plan, "solve_ms", 0) or 0), routes=len(routes), trucks=trucks, jobs=stops, days=days,
        sites=sites, triage_model=_get(triage, "model") if triage is not None else None,
        triage_model_name=_get(triage, "model_name") if triage is not None else None,
        triage_rationale=_get(triage, "rationale") if triage is not None else None,
        today=counts.get("today", 0), later=counts.get("later", 0),
        deferred=counts.get("defer", 0) or len(_get(plan, "deferred", [])),
        triage=decisions[:TRIAGE_MAX], unassigned=unassigned[:UNASSIGNED_MAX], unassigned_total=len(unassigned_ids))


def _brief(issue: ReportIssue) -> dict:
    out = issue.model_dump(include={"id", "category", "severity", "severity_reason", "description", "sightings",
                                    "deadline", "drive", "place"})
    return {k: v for k, v in out.items() if v not in (None, "")}


async def _nemotron(facts: dict) -> tuple[_ReportReply | None, str]:
    messages = [{"role": "system", "content": REPORT_PROMPT},
                {"role": "user", "content": json.dumps(facts)}]
    # Measured on the 469-issue corpus: Ultra ~11 s with ~3k reasoning + ~1.5k answer tokens; Lightning reasons
    # longer, so both get a budget well past 4096 (reasoning counts against max_tokens).
    for model, timeout, tokens in ((nemotron.ULTRA, 45.0, 12000), (nemotron.LIGHTNING, 40.0, 16000)):
        try:
            reply = await nemotron.chat_json(messages, _ReportReply, model=model, timeout=timeout, max_tokens=tokens)
            return reply, model
        except Exception as exc:
            log.warning("Report via %s failed (%s)", model.rsplit("/", 1)[-1], config.redact(exc))
    return None, ""


async def regenerate() -> Report:
    """Build a fresh report from the canonical issues. Never raises on model failure."""
    canonical = await asyncio.to_thread(lambda: _visible(store.canonical_issues()))
    sightings = await asyncio.to_thread(store.all_issues)
    videos = await asyncio.to_thread(store.list_videos)
    drives = {v.id: v.drive or v.filename for v in videos}
    open_issues = [i for i in canonical if i.verdict != "rejected"]
    rejected = [i for i in canonical if i.verdict == "rejected"]
    counts, workload, baseline, top = _facts(open_issues)
    summary, rationale = _template(open_issues, counts, workload, baseline)
    crews = dict(baseline)

    priority_issues = sorted((i for i in open_issues if i.severity >= 4), key=_rank)[:PRIORITY_MAX]
    hotspots = _hotspots(open_issues, drives)
    points = [(i.lat, i.lon) for i in priority_issues if i.lat is not None and i.lon is not None]
    points += [(h.lat, h.lon) for h in hotspots]
    try:
        places = await asyncio.wait_for(_places(points), timeout=45.0)
    except Exception as exc:
        log.warning("Street names skipped (%s)", config.redact(exc))
        places = _place_cache()
    for h in hotspots:
        street = places.get(_place_key(h.lat, h.lon))
        if street:
            h.label = f"{street} area"
        elif h.drives:
            h.label = f"Along {h.drives[0]}"
    priorities = [_report_issue(i, drives, places) for i in priority_issues]
    sections = _sections(open_issues, rejected, baseline, drives, places)

    try:
        plan = await asyncio.to_thread(store.latest_plan)
        sev_of = {i.id: i.severity for i in canonical}
        crew_plan = _crew_plan(plan, sev_of, {i.id: _minutes(i) for i in canonical})
    except Exception as exc:
        log.warning("Report crew plan skipped (%s)", config.redact(exc))
        plan, sev_of, crew_plan = None, {}, None

    report_model, model_name = "template", None
    if open_issues:
        facts = {
            "open_issues": len(open_issues), "rejected_as_not_defects": len(rejected),
            "by_severity": {k: v for k, v in counts.items() if k.startswith("severity_")},
            "workload_minutes": workload, "baseline_crews": baseline,
            "top_issues": [_brief(_report_issue(i, drives, places)) for i in top],
            "categories": {s.category: {"open": s.open, "by_severity": s.by_severity, "crew_hours": s.crew_hours,
                                        "worst": [_brief(t) for t in s.top[:3]],
                                        "equipment": [e.label for e in s.equipment[:5]]} for s in sections if s.open},
            "hotspots": {h.id: {"label": h.label, "issues": h.issues, "severe": h.severe,
                                "categories": h.categories, "drives": h.drives} for h in hotspots},
        }
        if crew_plan is not None:
            # Day 1 is today. Triage counts only exist when the plan was triaged; never send zeros that read as facts.
            include = {"solver", "matrix_source", "routes", "trucks", "jobs", "unassigned_total"}
            if crew_plan.triage_model:
                include |= {"today", "later", "deferred", "triage_model"}
            facts["crew_plan"] = crew_plan.model_dump(include=include) | {
                "day_1": "today",
                "unassigned_by_severity": dict(Counter(f"severity_{sev_of[str(u)]}" for u in _get(plan, "unassigned", [])
                                                       if str(u) in sev_of)),
                "days": [d.model_dump(include={"day", "jobs", "trucks", "drive_h", "work_h", "km", "back_last"})
                         for d in crew_plan.days],
                "sites": [{"label": x.label, "trucks": x.trucks, "jobs": x.jobs} for x in crew_plan.sites[:8]]}
        reply, model = await _nemotron(facts)
        if reply is not None:
            summary, rationale, crews = reply.summary, reply.rationale, _clamp(reply.crews, baseline)
            report_model, model_name = REPORT_MODELS.get(model, (model.rsplit("/", 1)[-1], model))
            for section in sections:
                text = (reply.sections.get(section.category) or "").strip()
                if text:
                    section.approach = text
            for h in hotspots:
                h.note = (reply.hotspots.get(h.id) or "").strip() or None
            if crew_plan is not None:
                crew_plan.note = reply.crew_plan.strip() or None
        else:
            log.info("Report: template fallback")
    for section in sections:
        section.crews = crews.get(section.crew, section.crews)
    stats = _stats(open_issues, len(rejected), drives, crews, workload)
    provenance = _provenance(sightings, canonical, rejected, report_model)
    log.info("Report: %d open, %d severity 4-5, %d hotspots, narrative=%s", len(open_issues),
             len(priority_issues), len(hotspots), report_model)
    return Report(generated_at=datetime.now(timezone.utc), summary=summary, counts=counts, crews=crews,
                  rationale=rationale, model=model_name, stats=stats, sections=sections, priorities=priorities,
                  hotspots=hotspots, provenance=provenance, crew_plan=crew_plan)


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
