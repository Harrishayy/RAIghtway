"""Where each crew type is based: transfer stations for sanitation, works yards for the rest.

Transfer stations are the City of Toronto's published sites; the works yards are assumed points
(architecture §8) and say so. FACILITIES_FILE swaps in a different list without a code change.
"""
from functools import lru_cache
import json
import logging
from pathlib import Path

from app import config
from app.geo.distance import km
from app.models import Crew, Facility

log = logging.getLogger(__name__)
DEFAULT_FILE = Path(__file__).with_name("facilities.json")


@lru_cache(maxsize=1)
def load() -> tuple[Facility, ...]:
    path = Path(config.FACILITIES_FILE) if config.FACILITIES_FILE else DEFAULT_FILE
    try:
        return tuple(Facility.model_validate(f) for f in json.loads(path.read_text()))
    except (OSError, ValueError) as exc:
        log.warning("Facilities file unreadable (%s); using the bundled list", config.redact(exc))
        return tuple(Facility.model_validate(f) for f in json.loads(DEFAULT_FILE.read_text()))


def for_crew(crew: Crew) -> list[Facility]:
    return [f for f in load() if crew in f.crews]


def nearest(crew: Crew, point: tuple[float, float], among: list[Facility] | None = None) -> Facility | None:
    options = among if among is not None else for_crew(crew)
    return min(options, key=lambda f: km((f.lat, f.lon), point), default=None)
