// Shift timelines for Dispatch: the backend's schedule when it sends one (round trips: leave the site,
// drive / arrive / work / leave per stop, lunch, back), else one rebuilt from stop ETAs and work-order
// minutes (older plans). Playback reads the same timeline, so the map and the run sheet always agree.
import { clamp, travelMinutes, type Issue, type LatLon, type Route, type ScheduleEntry, type ShiftTotals } from '@raightway/core';

/** The operator's name for an issue when it has one, else its description. */
export const nameOf = (i?: Issue | null): string | undefined => (i ? (i as Issue & { name?: string | null }).name?.trim() || i.description : undefined);

export function timeline(r: Route, byId: Map<string, Issue>, home: LatLon): ScheduleEntry[] {
  if (r.schedule?.length) return r.schedule;
  const out: ScheduleEntry[] = [{ kind: 'depart', label: `Leave ${r.depot_label ?? 'depot'}`, lat: home[0], lon: home[1], drive_min: 0, arrive_min: 0, work_min: 0, depart_min: 0, idle_min: 0 }];
  let prev = home, t = 0;
  r.stops.forEach((id, k) => {
    const i = byId.get(id); const at: LatLon = i?.lat != null && i.lon != null ? [i.lat, i.lon] : prev;
    const arrive = r.eta_min[k] ?? t; const work = i?.work_order?.minutes ?? 30;
    out.push({ kind: 'job', issue_id: id, label: nameOf(i) ?? id, lat: at[0], lon: at[1], drive_min: Math.max(0, arrive - t), arrive_min: arrive, work_min: work, depart_min: arrive + work, idle_min: 0, severity: i?.severity ?? null, pinned: i?.pinned });
    t = arrive + work; prev = at;
  });
  const back = r.stops.length ? travelMinutes(prev, home) : 0;
  out.push({ kind: 'return', label: `Back at ${r.depot_label ?? 'depot'}`, lat: home[0], lon: home[1], drive_min: back, arrive_min: t + back, work_min: 0, depart_min: t + back, idle_min: 0 });
  return out;
}

export function totalsOf(r: Route, tl: ScheduleEntry[]): ShiftTotals {
  if (r.totals) return r.totals;
  const sum = (f: (e: ScheduleEntry) => number) => tl.reduce((s, e) => s + f(e), 0);
  const back = tl[tl.length - 1]?.arrive_min ?? 0; const drive = sum(e => e.drive_min); const work = sum(e => (e.kind === 'job' ? e.work_min : 0));
  return { drive_min: drive, work_min: work, break_min: 0, idle_min: Math.max(0, back - drive - work), distance_km: r.distance_km ?? null, back_min: back, jobs: r.stops.length, lunch: 'none' };
}

const lerp = (a: LatLon, b: LatLon, f: number): LatLon => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
/** Where the truck is at minute m: on site during a job or lunch, else between the previous point and the next. */
export function truckAt(tl: ScheduleEntry[], m: number): LatLon {
  let from: LatLon = [tl[0]!.lat, tl[0]!.lon]; let leave = tl[0]!.depart_min;
  if (m <= leave) return from;
  for (const e of tl.slice(1)) {
    const to: LatLon = [e.lat, e.lon];
    if (m < e.arrive_min) return lerp(from, to, clamp((m - leave) / Math.max(1, e.arrive_min - leave), 0, 1));
    if (m < e.depart_min) return to;
    from = to; leave = e.depart_min;
  }
  return from;
}

export const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}` : `${Math.round(min)} min`);
