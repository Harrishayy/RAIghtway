"""Shared prompts, deterministic work-order rules and reply parsing."""
import json
import re

from app.models import CREW_FOR

CATEGORIES = ("pavement", "graffiti", "markings", "work_zone", "signage", "waste")
SEVERITY_RUBRIC = """| Severity | Meaning | Urgency | Examples |
|---|---|---|---|
| 1 | Cosmetic | routine | light tagging, slightly faded paint |
| 2 | Minor | routine | small crack, worn but visible markings |
| 3 | Repair this month | soon | pothole forming, faded crosswalk, overflowing bin |
| 4 | Repair this week | soon | pothole in a traffic lane, hard-to-read sign |
| 5 | Safety hazard, fix today | urgent | deep pothole, blocked or missing stop sign, unguarded work zone |"""
# Labels a model (or another pipeline's structured output) uses for our categories, checked in order:
# the first category with a matching word wins. Category names themselves always match.
CATEGORY_ALIASES = (
    ("work_zone", ("work zone", "workzone", "construction", "roadwork", "road work", "traffic cone", "cones",
                   "barricade", "detour", "excavation", "lane closure", "road closure", "closed lane")),
    ("pavement", ("pothole", "pot hole", "crack", "pavement", "asphalt", "road surface", "rutting", "sinkhole",
                  "broken road", "road damage")),
    ("graffiti", ("graffiti", "tag", "tagging", "vandal", "spray paint", "spray-paint", "mural")),
    ("waste", ("waste", "garbage", "trash", "litter", "rubbish", "dumping", "dumped", "bin", "debris",
               "refuse", "junk", "bulky item")),
    ("markings", ("marking", "lane line", "crosswalk", "crossing", "zebra", "stop line", "road paint")),
    ("signage", ("sign", "signage", "signpost", "traffic sign")),
)


def normalise_category(label, description: str = "") -> str | None:
    """Map a free-form label onto one of CATEGORIES; the description breaks ties. None if nothing fits."""
    text = str(label or "").strip().lower().replace("-", "_")
    if text in CATEGORIES:
        return text
    for haystack in (text.replace("_", " "), str(description or "").lower()):
        if not haystack:
            continue
        words = set(re.findall(r"[a-z]+", haystack))
        for category, aliases in CATEGORY_ALIASES:
            if any((alias in haystack) if " " in alias else (alias in words or alias + "s" in words)
                   for alias in aliases):
                return category
    return None


DEFAULT_MINUTES = {"pavement": 60, "graffiti": 30, "markings": 45,
                   "work_zone": 30, "signage": 45, "waste": 20}


def URGENCY_FOR(severity: int) -> str:
    return "urgent" if severity >= 5 else "soon" if severity >= 3 else "routine"


FIND_PROMPT = """You are inspecting a 5-second dashcam clip for street-maintenance defects.
Most clips contain NO defects. An empty issues list is the normal, expected answer.
Report a defect only if you can clearly see it and could point to it in a frame.
Do NOT report: vehicles, people, tram/streetcar tracks, normal road seams or patches in good
condition, manhole covers, shadows, puddles, road markings that are clearly visible, or signs
that are intact but small, distant or seen at an angle.
Categories (use exactly these names):
- pavement: potholes, deep cracks, broken or crumbling road surface.
- graffiti: unwanted paint or tagging on public surfaces.
- markings: lane lines or crossings that are faded or missing to the point of being hard to see.
- work_zone: road works that look unsafe or unguarded.
- signage: damaged, obscured, unreadable or missing traffic signs.
- waste: litter, dumped rubbish or overflowing bins.
Severity rubric:
""" + SEVERITY_RUBRIC + """
Return JSON only, no reasoning or markdown:
{"issues":[{"category":"<category>","severity":<integer severity>,"description":"<visible defect description>",
"t":<seconds>,"confidence":<confidence>}],"scene":"<street scene description>"}
Descriptions must be at most 20 words. t is seconds from this video's start;
confidence is 0 to 1. Return an empty issues list when no issue is clearly visible."""

BOX_PROMPT = """Locate this clearly visible issue: category={category}; description={description}.
Return exactly one tight bounding box as JSON [x1,y1,x2,y2], top-left then
bottom-right. Use coordinates from 0 to 1000 on each axis. No reasoning or markdown.
If the issue is not visible, return null."""

WORK_ORDER_PROMPT = """Produce work orders for the supplied new canonical issues only,
and a factual 2–4 sentence explanation of this video's visible findings.
For each issue fill only issue_id, repair (concise practical action), minutes
(positive integer), and equipment (list of strings). Crew and urgency are fixed
by the application; do not change or return them. Use all_issues for the explanation,
including re-sightings, but do not invent findings or claim repairs were completed.
Choose realistic per-issue minutes that differ by category and severity.
Return JSON only: {"orders":[{"issue_id":"<issue id>","repair":"<repair action>","minutes":<integer minutes>,
"equipment":["<tool>"]}],"explanation":"<two to four sentences>"}"""


def _extract_json(reply: str, *, array: bool = False):
    if not isinstance(reply, str):
        raise ValueError("Model reply must be text")
    reply = re.split(r"</think>", reply, flags=re.IGNORECASE)[-1]
    cleaned = re.sub(r"<think\b[^>]*>.*?(?:</think\s*>|$)", "", reply,
                     flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"```(?:json)?", "", cleaned, flags=re.IGNORECASE).strip()
    if array and cleaned == "null":
        return None
    starts = "[{" if array else "{"
    start = next((i for i, char in enumerate(cleaned) if char in starts), None)
    if start is None:
        raise ValueError("Model reply contains no JSON object or box")
    # raw_decode respects quoted braces and stops before any trailing prose.
    try:
        value, _ = json.JSONDecoder().raw_decode(cleaned[start:])
    except json.JSONDecodeError:
        raise ValueError("Model reply contains invalid or incomplete JSON") from None
    if not isinstance(value, (dict, list) if array else dict):
        raise ValueError("Unexpected JSON value")
    return value
