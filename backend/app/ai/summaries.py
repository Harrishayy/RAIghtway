"""Nemotron summaries that say something specific: each drive's explanation, and the answer to a footage search.

A drive summary is grounded in facts the model can't make up (streets from OSRM, times, counts against
the fleet average, the worst findings) and checked before it is kept: no template wording, no
"This video…" opener, a street and a time named, and not a near copy of another drive's summary.
One retry carries the reasons; after that a fact-built summary stands in, marked "template".

Regenerated summaries live in an overlay (state/explanations.json) applied when a video is served:
video rows are saved once, at "done", and VastDB is insert-only, so the store can't take an edit.
"""
import asyncio
from collections import Counter
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import re
from threading import Lock

from pydantic import BaseModel, Field

from app import config
from app.ai.prompts import DRIVE_SUMMARY_PROMPT, SEARCH_ANSWER_PROMPT
from app.models import IssueRecord, TopicHit, Video, VideoRecord

log = logging.getLogger(__name__)
OVERLAY_FILE = "explanations.json"
ANSWERS_FILE = "search_answers.json"
SUMMARY_TIMEOUT_S = 30.0         # Lightning reasons first (~750+ tokens), so chat_json keeps its 4096-token budget
ANSWER_TIMEOUT_S = 8.0           # the search waits this long for Nemotron, then answers with VSS's synthesis only
MAX_OVERLAP = 0.5                # share of word trigrams a summary may repeat from another drive's
MAX_WORDS = 90
STREET_LOOKUPS = 6               # OSRM nearest calls per drive (the public server allows ~1 a second)

_TEMPLATE = re.compile(r"^\s*(this video contains \d+ recorded maintenance findings"
                       r"|no clearly visible maintenance issues were recorded)", re.IGNORECASE)
_OPENER = re.compile(r"^\W*(this|the)\s+(video|drive|footage|clip)\b", re.IGNORECASE)
_CLOCK = re.compile(r"\b\d{1,2}:\d{2}\b")
_lock = Lock()
_overlay: dict[str, dict] | None = None
_answers: dict[str, str] | None = None
_streets: dict[tuple[float, float], str | None] = {}


def is_template(text: str | None) -> bool:
    return bool(text) and bool(_TEMPLATE.match(text))


def clock(t: float) -> str:
    t = max(0, int(round(t)))
    return f"{t // 60:02d}:{t % 60:02d}"


# ---- Overlay: regenerated summaries, applied when a video is served ----

def _path(name: str) -> Path:
    return Path(config.STATE_DIR) / name


def _read(name: str) -> dict:
    try:
        data = json.loads(_path(name).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(name: str, data: dict) -> None:
    try:
        path = _path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, indent=1))
        temporary.replace(path)
    except OSError as exc:
        log.warning("%s write failed (%s)", name, config.redact(exc))


def _saved() -> dict[str, dict]:
    global _overlay
    if _overlay is None:
        _overlay = _read(OVERLAY_FILE)
    return _overlay


def save(video_id: str, explanation: str, source: str) -> None:
    with _lock:
        _saved()[video_id] = {"explanation": explanation, "explanation_source": source,
                              "at": datetime.now(timezone.utc).isoformat()}
        _write(OVERLAY_FILE, _saved())


def effective(video: Video) -> tuple[str | None, str | None]:
    """(explanation, source) as served: the overlay's, else the stored one classified by its wording."""
    with _lock:
        row = _saved().get(video.id)
    if row and row.get("explanation"):
        return row["explanation"], row.get("explanation_source") or "nemotron"
    if not video.explanation:
        return None, None
    return video.explanation, video.explanation_source or ("template" if is_template(video.explanation) else "nemotron")


def apply(video: Video) -> Video:
    text, source = effective(video)
    return video.model_copy(update={"explanation": text, "explanation_source": source})


# ---- Facts a summary must rest on ----

async def street_at(lat: float | None, lon: float | None) -> str | None:
    """The street name OSRM snaps this point to; None when routing is off or fails."""
    if lat is None or lon is None:
        return None
    key = (round(lat, 4), round(lon, 4))
    if key in _streets:
        return _streets[key]
    name = None
    try:
        from app.geo import roads
        if roads.enabled():
            body = await roads._get(f"/nearest/v1/driving/{lon:.6f},{lat:.6f}", {"number": 1})
            name = ((body.get("waypoints") or [{}])[0].get("name") or "").strip() or None
    except Exception as exc:
        log.info("Street lookup skipped (%s)", config.redact(exc))
    _streets[key] = name
    return name


def _real(issues: list[IssueRecord]) -> list[IssueRecord]:
    return [i for i in issues if i.verdict != "rejected"]


def _label(issue: IssueRecord) -> str:
    text = (issue.name or "").strip() or issue.description
    return text if len(text) <= 90 else text[:89].rstrip() + "…"


async def drive_facts(video: VideoRecord, issues: list[IssueRecord], fleet: dict[str, list[IssueRecord]]) -> dict:
    """What is specific about this drive: streets, counts against the fleet, worst findings, busiest stretch."""
    mine = _real(issues)
    counts = Counter(i.category for i in mine)
    drives = max(1, len(fleet))
    totals = Counter(i.category for found in fleet.values() for i in _real(found))
    by_category = {c: {"here": n, "fleet_avg": round(totals[c] / drives, 1)} for c, n in counts.most_common()}
    standout = sorted(((c, n, totals[c] / drives) for c, n in counts.items() if n >= 3 and totals[c]),
                      key=lambda x: x[1] / max(x[2], 0.1), reverse=True)
    canonical = [i for i in mine if not i.duplicate_of]
    worst = sorted(canonical, key=lambda i: (-i.severity, -i.confidence, i.t))[:3]
    busiest = None
    ordered = sorted(mine, key=lambda i: i.t)
    for k, first in enumerate(ordered):
        inside = [i for i in ordered[k:] if i.t - first.t <= 60]
        if busiest is None or len(inside) > len(busiest):
            busiest = inside
    # street lookups: the worst findings, the busiest stretch, then points spread along the drive
    probes: list[IssueRecord] = [*worst]
    if busiest:
        probes.append(busiest[len(busiest) // 2])
    located = [i for i in ordered if i.lat is not None]
    if located:
        step = max(1, len(located) // 3)
        probes.extend(located[::step])
    names: dict[str, str | None] = {}
    for issue in probes:
        if issue.id in names or len(names) >= STREET_LOOKUPS:
            continue
        names[issue.id] = await street_at(issue.lat, issue.lon)
    streets = list(dict.fromkeys(n for i in sorted(probes, key=lambda i: i.t) if (n := names.get(i.id))))
    return {
        "drive": video.drive or video.filename, "duration": clock(video.duration_s), "findings": len(mine),
        "by_category_vs_fleet_avg": by_category,
        "stands_out": [{"category": c, "here": n, "fleet_avg": round(avg, 1)} for c, n, avg in standout[:2]
                       if n >= 1.4 * avg],
        "most_severe": [{"time": clock(i.t), "category": i.category, "severity": i.severity, "label": _label(i),
                         "street": names.get(i.id)} for i in worst],
        "busiest_stretch": ({"from": clock(busiest[0].t), "to": clock(busiest[-1].t), "findings": len(busiest),
                             "street": names.get(busiest[len(busiest) // 2].id)} if busiest and len(busiest) > 2 else None),
        "streets": streets,
    }


def fact_summary(facts: dict) -> str:
    """The stand-in when Nemotron can't write one: still specific, built only from the facts."""
    if not facts["findings"]:
        return f"No maintenance findings on {facts['drive']} ({facts['duration']})."
    parts = []
    if facts["stands_out"]:
        s = facts["stands_out"][0]
        parts.append(f"{s['here']} {s['category'].replace('_', ' ')} findings, against a fleet average of {s['fleet_avg']}")
    else:
        top = next(iter(facts["by_category_vs_fleet_avg"].items()))
        parts.append(f"{facts['findings']} findings, mostly {top[0].replace('_', ' ')} ({top[1]['here']})")
    stretch = facts["busiest_stretch"]
    if stretch:
        where = f" on {stretch['street']}" if stretch["street"] else ""
        parts.append(f"busiest {stretch['from']}–{stretch['to']}{where} ({stretch['findings']} findings)")
    text = "; ".join(parts) + "."
    if facts["most_severe"]:
        w = facts["most_severe"][0]
        where = f" on {w['street']}" if w["street"] else ""
        text += f" Most severe: {w['label'].rstrip('.!? ')} (severity {w['severity']}) at {w['time']}{where}."
    return text[0].upper() + text[1:]


# ---- Checks ----

def _trigrams(text: str) -> set[tuple[str, ...]]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {tuple(words[k:k + 3]) for k in range(len(words) - 2)}


def overlap(a: str, b: str) -> float:
    """Share of the shorter text's word trigrams that the other repeats (0 = nothing shared)."""
    x, y = _trigrams(a), _trigrams(b)
    return len(x & y) / min(len(x), len(y)) if x and y else 0.0


def problems(text: str, facts: dict, others: dict[str, str]) -> list[str]:
    """Why a summary can't be kept; empty when it can."""
    out = []
    words = len(text.split())
    if not words or words > MAX_WORDS:
        out.append(f"must be 1 to {MAX_WORDS} words (was {words})")
    if is_template(text):
        out.append("repeats the template wording")
    if _OPENER.match(text):
        out.append('opens with "This video" or similar; lead with what stands out')
    if facts["streets"] and not any(s.split()[0].lower() in text.lower() for s in facts["streets"]):
        out.append("names no street from the facts")
    if (facts["most_severe"] or facts["busiest_stretch"]) and not _CLOCK.search(text):
        out.append("gives no time (mm:ss)")
    for video_id, other in others.items():
        if overlap(text, other) > MAX_OVERLAP:
            out.append(f"reads too much like the summary of {video_id}")
            break
    return out


class DriveSummary(BaseModel):         # names the Weave trace (nemotron_json schema_name)
    summary: str = Field(min_length=1)


class SearchAnswer(BaseModel):
    answer: str = Field(min_length=1)


async def summarise_drive(video: VideoRecord, issues: list[IssueRecord], fleet: dict[str, list[IssueRecord]],
                          others: dict[str, str]) -> tuple[str, str]:
    """(summary, "nemotron") when a checked Nemotron summary exists, else (fact summary, "template"). Never raises."""
    from app.ai import nemotron
    facts = await drive_facts(video, issues, fleet)
    messages = [{"role": "system", "content": DRIVE_SUMMARY_PROMPT},
                {"role": "user", "content": json.dumps(facts)}]
    for attempt in range(2):
        try:
            reply = await nemotron.chat_json(messages, DriveSummary, timeout=SUMMARY_TIMEOUT_S)
        except Exception as exc:
            log.warning("Drive summary for %s: Nemotron failed (%s)", video.id, config.redact(exc))
            break
        text = re.sub(r"\s+", " ", reply.summary).strip()
        wrong = problems(text, facts, others)
        if not wrong:
            log.info("Drive summary for %s: nemotron (attempt %d)", video.id, attempt + 1)
            return text, "nemotron"
        log.info("Drive summary for %s rejected: %s", video.id, "; ".join(wrong))
        nearest = sorted(others.values(), key=lambda o: overlap(text, o), reverse=True)[:3]
        messages += [{"role": "assistant", "content": json.dumps({"summary": text})},
                     {"role": "user", "content": "Rejected: " + "; ".join(wrong) + ". Rewrite it. It must read "
                      "differently from these other drives' summaries: " + json.dumps(nearest)}]
    return fact_summary(facts), "template"


# ---- Backfill: regenerate summaries inside the API, one drive at a time ----

_job: dict = {"running": False, "done": 0, "total": 0, "current": None, "results": [], "started": None}
_task: asyncio.Task | None = None


def status() -> dict:
    return {k: (list(v) if isinstance(v, list) else v) for k, v in _job.items()}


def start(video_ids: list[str] | None = None, only_template: bool = True) -> dict:
    """Queue a sequential regeneration (corpus drives by default, those without a Nemotron summary). Idempotent while running."""
    global _task
    if _task and not _task.done():
        return status()
    from app import store
    videos = [v for v in store.list_videos() if v.status == "done"
              and (v.id in video_ids if video_ids else v.source == "corpus")]
    if only_template:
        videos = [v for v in videos if effective(v)[1] != "nemotron"]
    _job.update(running=True, done=0, total=len(videos), current=None, results=[],
                started=datetime.now(timezone.utc).isoformat())
    _task = asyncio.create_task(_run([v.id for v in videos]))
    return status()


async def _run(video_ids: list[str]) -> None:
    from app import store
    try:
        drives = [v for v in store.list_videos() if v.source == "corpus"]
        fleet = {v.id: store.issues_for_video(v.id) for v in drives}
        for video_id in video_ids:
            video = store.get_video(video_id)
            if video is None:
                continue
            _job["current"] = video_id
            others = {v.id: text for v in drives if v.id != video_id
                      for text, source in [effective(v)] if text and source == "nemotron"}
            text, source = await summarise_drive(video, store.issues_for_video(video_id), fleet, others)
            save(video_id, text, source)
            _job["results"].append({"video_id": video_id, "source": source})
            _job["done"] += 1
    except Exception as exc:
        log.warning("Summary regeneration stopped (%s)", config.redact(exc))
        _job["results"].append({"error": config.redact(str(exc))})
    finally:
        _job.update(running=False, current=None)


# ---- Search answer ----

def _answers_cache() -> dict[str, str]:
    global _answers
    if _answers is None:
        _answers = {k: v for k, v in _read(ANSWERS_FILE).items() if isinstance(v, str)}
    return _answers


async def search_answer(query: str, hits: list[TopicHit], logged: dict[int, list[str]],
                        videos: dict[str, Video]) -> str:
    """Nemotron's two-sentence answer to a footage search; "" when it can't answer in time. Cached per result."""
    from app.ai import nemotron
    if not hits:
        return ""
    top = hits[:8]
    key = json.dumps([query, [(h.video_id, h.start) for h in top], [len(logged.get(k, [])) for k in range(len(top))]])
    with _lock:
        if key in _answers_cache():
            return _answers_cache()[key]
    matches = [{"drive": (videos[h.video_id].drive if h.video_id in videos else None) or h.video_id,
                "time": clock(h.start), "caption": h.caption, "logged_issues": logged.get(k, [])}
               for k, h in enumerate(top)]
    try:
        reply = await nemotron.chat_json([
            {"role": "system", "content": SEARCH_ANSWER_PROMPT},
            {"role": "user", "content": json.dumps({"search": query, "matches_shown": len(top),
                                                    "matches_total": len(hits), "matches": matches})},
        ], SearchAnswer, timeout=ANSWER_TIMEOUT_S)
    except Exception as exc:
        log.warning("Search answer for %r skipped (%s)", query, config.redact(exc))
        return ""
    answer = re.sub(r"\s+", " ", reply.answer.replace("**", "")).strip()
    with _lock:
        _answers_cache()[key] = answer
        _write(ANSWERS_FILE, _answers_cache())
    return answer
