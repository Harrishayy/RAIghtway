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
# Per-category anchors for each level, so a grade means the same thing across categories. Calibrated against a
# frame-by-frame human review of the corpus keyframes (tests/ and scripts/rate_severity.py --eval).
SEVERITY_ANCHORS = {
    "pavement": "1 sealed or hairline cracks; 2 isolated cracks, worn or slightly uneven patch; 3 pothole forming, "
                "failed patch, alligator cracking, or a pothole or broken asphalt at the curb or crosswalk; 4 pothole, "
                "broken asphalt or sunken catch basin in a wheel path or travel lane; 5 deep or wide pothole, sinkhole "
                "or broken surface that vehicles must swerve around",
    "markings": "1 slightly faded paint; 2 worn but readable lines; 3 crosswalk or lane line faded and hard to see in "
                "places; 4 crosswalk, stop line or lane line largely gone at an intersection or on a busy road; "
                "5 markings missing where traffic needs them, such as no crosswalk at a signalised crossing",
    "work_zone": "1 tidy closure entirely off the road; 2 tidy, signed, coned or barrelled lane closure; 3 trucks, "
                 "equipment or a closure occupying a travel lane, or a flagger directing traffic; 4 knocked-over cones "
                 "or barrels, barriers or plates intruding into traffic without a clear taper or signs; 5 unguarded "
                 "hazard: open excavation, debris or workers in a live lane with no protection",
    "signage": "1 sticker or slight fading; 2 faded or slightly tilted but readable; 3 bent, faded or partly obscured "
               "but recognisable; 4 regulatory sign defaced with stickers or paint, heavily obscured by foliage, or "
               "damaged; 5 stop or yield sign missing, knocked down or fully obscured",
    "graffiti": "1 small tag on a utility box or pole; 2 tagging on a wall or fence; 3 large or repeated tagging across "
                "a wall or on public property; 4 offensive content, or paint covering part of a traffic sign or "
                "signal; 5 paint making a regulatory sign unreadable",
    "waste": "1 a few pieces of litter; 2 litter build-up or a single bag; 3 overflowing bin or dumped bags on the "
             "sidewalk or boulevard; 4 bulky items dumped, blocking a sidewalk or bike lane; 5 debris in a live "
             "travel lane",
}
# What counts as real for each category: the find pass's known false alarms, named.
RATE_NOTES = {
    "pavement": "Count potholes, broken or crumbling asphalt, failed patches, sunken catch basins and wide cracks. "
                "Not defects: sound pavement, sealed seams, manhole covers, tram tracks, brick paving, shadows, wet "
                "patches, grass or curbs.",
    "markings": "Real only if paint is clearly worn away. Crisp, bright lines and crosswalks are not defects.",
    "work_zone": "Real if there is active road work: cones, barrels, barriers, signs, work trucks with crews, or "
                 "excavation. A tidy closure is still real (low severity). Not work zones: parked trucks or vans with "
                 "no cones or crew, sculptures, ordinary construction behind hoarding.",
    "signage": "Real if a sign is damaged, defaced (stickers, paint), bent, missing or blocked from view. A small, "
               "distant or angled but intact sign is not a defect.",
    "graffiti": "Real if unwanted tagging or spray paint. Commissioned murals and public art are not graffiti.",
    "waste": "Real if litter, bags, dumped items or overflowing bins. Store signs, bins in normal use and leaves are "
             "not.",
}

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


_RATE_BODY = """Report: category={category}; claim={description}
The detector over-reports: it calls crisp markings faded, intact signs unreadable, parked trucks work zones,
murals graffiti and clean pavement potholes. It also understates real damage.
Decide "real": true if the {view} shows a genuine {category} condition for a city crew (even if smaller or different
than claimed); false only if nothing of the kind is there (wrong object, intact sign, crisp paint, sound pavement).
{category} notes: {notes}
Then grade severity 1-5 with the rubric and the {category} anchors.
""" + SEVERITY_RUBRIC + """
{category} anchors: {anchors}
Return JSON only, in this key order: {{"observed":"<what the {view} actually shows, at most 20 words>",
"reason":"<one sentence, at most 25 words, why this grade>","real":<true or false>,"severity":<1-5>}}"""

# Cosmos takes two images: the frame with the box drawn on, and a clean close-up of the box.
RATE_PROMPT = """You are a city street-maintenance inspector verifying an automatic detector's report from a dashcam.
Image 1 is the full frame; a thin yellow rectangle (our annotation, not part of the scene) marks the reported spot.
Image 2 is a zoomed, unannotated close-up of that spot.
""" + _RATE_BODY
# Nemotron Super-VL accepts one image per prompt: the annotated frame only.
RATE_PROMPT_SINGLE = """You are a city street-maintenance inspector verifying an automatic detector's report from a dashcam.
The image is the full frame; a thin yellow rectangle (our annotation, not part of the scene) marks the reported spot.
""" + _RATE_BODY


def rate_prompt(category: str, description: str, *, single: bool = False) -> str:
    view = "marked area" if single else "close-up"
    return (RATE_PROMPT_SINGLE if single else RATE_PROMPT).format(
        category=category, description=description, view=view,
        notes=RATE_NOTES.get(category, ""), anchors=SEVERITY_ANCHORS.get(category, ""))


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
