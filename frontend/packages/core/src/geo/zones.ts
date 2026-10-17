// Point-in-zone for the console (ward counts on Dispatch, the mock planner). Same ray casting as the
// backend's app/planning/zones.py; rings are [lat, lon].
import type { Issue, LatLon, Zone } from '../types';

export function inRing([lat, lon]: LatLon, ring: LatLon[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, oi] = ring[i]!, [aj, oj] = ring[j]!;
    if ((ai > lat) !== (aj > lat) && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) hit = !hit;
  }
  return hit;
}
export const inZone = (p: LatLon, z: Pick<Zone, 'polygons'>) => z.polygons.some(r => r.length >= 3 && inRing(p, r));
/** The first zone containing the point, or undefined. */
export const zoneOf = (p: LatLon, zones: Zone[]) => zones.find(z => inZone(p, z));
/** A label point for a zone: the mean of its largest ring (good enough for city wards). */
export function zoneCentre(z: Pick<Zone, 'polygons'>): LatLon {
  const ring = [...z.polygons].sort((a, b) => b.length - a.length)[0] ?? [];
  if (!ring.length) return [0, 0];
  const s = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1]] as LatLon, [0, 0] as LatLon);
  return [s[0] / ring.length, s[1] / ring.length];
}
/** Open issues per zone: count and worst severity, for the zone picker and the map's count labels. */
export function zoneCounts(zones: Zone[], issues: Issue[]): Map<string, { n: number; worst: number }> {
  const out = new Map<string, { n: number; worst: number }>();
  for (const i of issues) {
    if (i.lat == null || i.lon == null) continue;
    const z = zoneOf([i.lat, i.lon], zones); if (!z) continue;
    const c = out.get(z.id) ?? { n: 0, worst: 0 }; c.n += 1; c.worst = Math.max(c.worst, i.severity); out.set(z.id, c);
  }
  return out;
}
