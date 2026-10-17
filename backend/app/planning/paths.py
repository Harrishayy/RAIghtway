"""Road paths that steer around closures: the Google-Maps-style part of dispatch.

A path is routed through its points on the street network. Any leg that runs through a
hard hazard (a closure, or a severe work zone seen on camera) is re-asked with alternatives; if
none of those is clear, it is re-routed through a point a block either side of the closure, which
pushes it onto a parallel street. The candidate touching the fewest hard hazards wins, ties to the fastest. What could not be avoided, and
softer restrictions on the way, come back as warnings for the crew.
"""
from dataclasses import dataclass, field
import math

from app.geo import roads
from app.geo.distance import LatLon
from app.models import Hazard, RouteWarning
from app.planning import hazards as hz


@dataclass
class Budget:
    """Detour calls left for one request, so a big plan can't queue minutes of OSRM calls.
    Every path gets its first road request; only the re-routes around closures draw on this."""
    calls: int

    def take(self) -> bool:
        if self.calls <= 0:
            return False
        self.calls -= 1
        return True


@dataclass
class PathResult:
    path: list[LatLon]
    minutes: float
    km: float
    source: str
    warnings: list[RouteWarning] = field(default_factory=list)
    alternatives: int = 1


DETOUR_M = 200.0              # about a block in downtown Toronto


def _hard(hit: list[Hazard]) -> list[Hazard]:
    return [h for h in hit if h.severity >= hz.AVOID_AT]


def vias(h: Hazard, metres: float = DETOUR_M) -> list[LatLon]:
    """Two points a block either side of a closure, square to its direction (or N/S for a point)."""
    (lat, lon), line = (h.lat, h.lon), h.path
    if len(line) > 1:
        lat, lon = (line[0][0] + line[-1][0]) / 2, (line[0][1] + line[-1][1]) / 2
        dy, dx = line[-1][0] - line[0][0], (line[-1][1] - line[0][1]) * math.cos(math.radians(lat))
    else:
        dy, dx = 0.0, 1.0
    norm = math.hypot(dx, dy) or 1.0
    py, px = dx / norm, -dy / norm                        # unit perpendicular, in metres-ish space
    dlat, dlon = py * metres / 111320, px * metres / (111320 * math.cos(math.radians(lat)))
    return [(lat + dlat, lon + dlon), (lat - dlat, lon - dlon)]


async def steer(points: list[LatLon], hazards: list[Hazard], budget: Budget,
                skip: set[str] = frozenset(), road: bool = True) -> PathResult:
    """Road path through the points in order, re-routing legs around hard hazards when it can.
    road=False skips the routing server: a straight line, with no road alerts (they'd be guesses)."""
    if not road:
        line = roads.straight_path(points)
        return PathResult(line.path, line.minutes, line.km, "straight")
    first, source = await roads.route_or_straight(points)
    if source != "road":
        hit = hz.hits(first.path, hazards, skip)
        return PathResult(first.path, first.minutes, first.km, source, hz.warnings(hit, []))

    legs, minutes, distance, avoided, compared = list(first.legs), first.minutes, first.km, [], 1
    if len(legs) == len(points) - 1:
        for i, leg in enumerate(legs):
            blocked = sorted(_hard(hz.hits(leg, hazards, skip)), key=lambda h: (-h.severity, h.source != "city"))
            if not blocked or not budget.take():
                continue
            try:
                options = await roads.route([points[i], points[i + 1]], alternatives=True)
            except Exception:
                continue
            score = lambda c: (len(_hard(hz.hits(c.path, hazards, skip))), c.minutes)  # noqa: E731
            best = min(options, key=score)
            for via in vias(blocked[0]) if score(best)[0] else []:
                if not budget.take():
                    break
                try:
                    detour = (await roads.route([points[i], via, points[i + 1]]))[0]
                except Exception:
                    continue
                options.append(roads.Candidate(detour.path, detour.minutes, detour.km, [detour.path]))
                best = min(options, key=score)
                if not score(best)[0]:
                    break
            compared += len(options) - 1
            if best is options[0]:
                continue
            still = {h.id for h in _hard(hz.hits(best.path, hazards, skip))}
            avoided += [h for h in blocked if h.id not in still]
            minutes += best.minutes - options[0].minutes
            distance += best.km - options[0].km
            legs[i] = best.path
    path = [p for n, leg in enumerate(legs) for p in (leg if n == 0 else leg[1:])]
    hit = hz.hits(path, hazards, skip)
    return PathResult(path, minutes, distance, "road", hz.warnings(hit, avoided), compared)
