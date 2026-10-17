// A deterministic city: seven corpus drives along real downtown Toronto streets, the issues they found
// (with work orders and re-sightings), 1 Hz GPS, and a scripted clip that re-sights two known issues so
// dedupe has something to do on stage. Everything is shaped exactly like the backend contract.
import type { BBox, CategoryId, Issue, LatLon, Severity, TrackPoint, Video, WorkOrder } from '../types';
import { CATEGORY, CREW_FOR, severityDef } from '../registry';
import { hashStr, mulberry32 } from '../format';
import { type Axis, gridLL, placeName, streetOf } from '../geo/toronto';
import { DESC, EQUIP, REPAIR, SEV_DIST, STREET_FLAVOR } from './content';

export type Leg = [axis: Axis, line: number, from: number, to: number];
interface DriveDef { id: string; drive: string; seed: number; legs: Leg[] }
export const DRIVES: DriveDef[] = [
  { id: 'v01', drive: 'set01/video_0002', seed: 11, legs: [['row', 2, 0, 4], ['col', 4, 2, 1], ['row', 1, 4, 6]] },
  { id: 'v02', drive: 'set02/video_0004', seed: 23, legs: [['row', 1, 6, 0], ['col', 0, 1, 2], ['row', 2, 0, 0.9]] },
  { id: 'v03', drive: 'set03/video_0001', seed: 37, legs: [['col', 1, 0, 4], ['row', 4, 1, 4]] },
  { id: 'v04', drive: 'set03/video_0006', seed: 41, legs: [['row', 3, 0, 6]] },
  { id: 'v05', drive: 'set05/video_0003', seed: 53, legs: [['row', 0, 0, 6], ['col', 6, 0, 2.5]] },
  { id: 'v06', drive: 'set06/video_0006', seed: 67, legs: [['col', 2, 0, 4], ['row', 4, 2, 3], ['col', 3, 4, 0]] },
  { id: 'v07', drive: 'set02/video_0011', seed: 71, legs: [['col', 5, 0, 4], ['row', 4, 5, 6], ['col', 6, 4, 2.6]] },
];

/** Where on the grid a mock issue sits; the mock planner uses it to draw street-following routes. */
export interface GridPos { axis: Axis; line: number; pos: number }
export const GRID = new Map<string, GridPos>();

const legLen = (l: Leg) => Math.abs(l[3] - l[2]);
const dirWord = (axis: Axis, a: number, b: number) => (axis === 'row' ? (b > a ? 'Eastbound' : 'Westbound') : b > a ? 'Northbound' : 'Southbound');
type Rnd = () => number;
function weighted(rnd: Rnd, table: Partial<Record<CategoryId, number>>): CategoryId {
  const entries = Object.entries(table) as Array<[CategoryId, number]>; const tot = entries.reduce((a, [, v]) => a + v, 0);
  let x = rnd() * tot; for (const [k, v] of entries) { if ((x -= v) <= 0) return k; } return entries[0]![0];
}
function sevFor(rnd: Rnd, cat: CategoryId): Severity { const d = SEV_DIST[cat]; const tot = d.reduce((a, b) => a + b, 0); let x = rnd() * tot; for (let i = 0; i < 5; i++) { if ((x -= d[i]!) <= 0) return (i + 1) as Severity; } return 3; }
const pickOf = <T,>(rnd: Rnd, a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
function nearestKey<T>(m: Partial<Record<Severity, T>>, sev: Severity): T {
  if (m[sev] !== undefined) return m[sev]!;
  const keys = Object.keys(m).map(Number) as Severity[]; const k = keys.reduce((a, b) => (Math.abs(b - sev) < Math.abs(a - sev) ? b : a)); return m[k]!;
}

/** Typical bounding boxes per category for a dashcam at 1.4 m (normalised x, y, w, h). */
export function bboxFor(category: CategoryId, rnd: Rnd): BBox {
  const r = rnd;
  switch (category) {
    case 'graffiti': { const left = r() < 0.6; const w = 0.12 + r() * 0.12; return { x: left ? 0.03 + r() * 0.12 : 0.97 - w - r() * 0.1, y: 0.27 + r() * 0.1, w, h: 0.14 + r() * 0.1 }; }
    case 'pavement': { const w = 0.12 + r() * 0.12; return { x: 0.38 + r() * 0.2, y: 0.66 + r() * 0.08, w, h: 0.1 + r() * 0.06 }; }
    case 'markings': { const w = 0.34 + r() * 0.16; return { x: 0.5 - w / 2 + (r() - 0.5) * 0.08, y: 0.6 + r() * 0.06, w, h: 0.12 + r() * 0.05 }; }
    case 'work_zone': { const w = 0.16 + r() * 0.1; return { x: 0.56 + r() * 0.12, y: 0.42 + r() * 0.08, w, h: 0.2 + r() * 0.08 }; }
    case 'signage': { const w = 0.07 + r() * 0.05; return { x: 0.74 + r() * 0.1, y: 0.2 + r() * 0.08, w, h: 0.22 + r() * 0.08 }; }
    case 'waste': { const left = r() < 0.5; const w = 0.11 + r() * 0.07; return { x: left ? 0.06 + r() * 0.08 : 0.94 - w - r() * 0.08, y: 0.5 + r() * 0.08, w, h: 0.14 + r() * 0.06 }; }
  }
}

function workOrder(cat: CategoryId, sev: Severity, rnd: Rnd): WorkOrder {
  const [lo, hi] = CATEGORY[cat].minutes; const base = lo + (hi - lo) * ((sev - 1) / 4);
  const minutes = Math.max(10, Math.round((base * (0.85 + rnd() * 0.3)) / 5) * 5);
  const eq = EQUIP[cat]; const n = Math.min(eq.length, 1 + Math.floor(rnd() * 3));
  return { repair: nearestKey(REPAIR[cat], sev), crew: CREW_FOR[cat], minutes, equipment: [...eq].sort(() => rnd() - 0.5).slice(0, n), urgency: severityDef(sev).urgency };
}

export function buildIssue(o: { id: string; video: Video; t: number; axis: Axis; line: number; pos: number; cat: CategoryId; sev: Severity; rnd: Rnd; source?: 'upload' | 'corpus' }): Issue {
  const off = (o.rnd() - 0.5) * 0.05; const line = o.line + off;
  const [lat, lon] = o.axis === 'row' ? gridLL(line, o.pos) : gridLL(o.pos, line);
  GRID.set(o.id, { axis: o.axis, line: o.line, pos: o.pos });
  const t = Math.round(o.t * 10) / 10;
  return {
    id: o.id, video_id: o.video.id, t, category: o.cat, severity: o.sev,
    confidence: Math.round((0.62 + o.rnd() * 0.35) * 100) / 100,
    description: pickOf(o.rnd, nearestKey(DESC[o.cat], o.sev)), frame_url: `/api/frames/${o.id}`, frame_seed: hashStr(o.id),
    bbox: bboxFor(o.cat, o.rnd), lat, lon, place: placeName(o.axis, o.line, o.pos),
    duplicate_of: null, sightings: 1, sighting_refs: [{ video_id: o.video.id, drive: o.video.drive, t }],
    work_order: workOrder(o.cat, o.sev, o.rnd), source: o.source ?? 'corpus',
  };
}

/** Position along a set of legs at fraction f, in grid units. */
export function gridAt(legs: Leg[], f: number): [r: number, c: number] {
  const total = legs.reduce((s, l) => s + legLen(l), 0); let d = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < legs.length; i++) { const l = legs[i]!; const len = legLen(l); if (d <= len || i === legs.length - 1) { const [axis, line, a, b] = l; const p = a + Math.sign(b - a) * Math.min(d, len); return axis === 'row' ? [line, p] : [p, line]; } d -= len; }
  return [0, 0];
}
function bearing(a: LatLon, b: LatLon) { const y = Math.sin(((b[1] - a[1]) * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180); const x = Math.cos((a[0] * Math.PI) / 180) * Math.sin((b[0] * Math.PI) / 180) - Math.sin((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.cos(((b[1] - a[1]) * Math.PI) / 180); return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360; }

/** 1 Hz GPS: cruising with drift, stopping at about half the lights. */
export function gpsFor(id: string, legs: Leg[], duration: number): TrackPoint[] {
  const rnd = mulberry32(hashStr(id)); const lights = new Map<string, boolean>(); const out: TrackPoint[] = [];
  for (let t = 0; t <= Math.ceil(duration); t++) {
    const f = t / duration; const [r, c] = gridAt(legs, f); const ll = gridLL(r, c); const ahead = gridLL(...gridAt(legs, Math.min(1, f + 0.004)));
    let v = 31 + 7 * Math.sin(f * 17) + 3 * Math.sin(f * 53);
    ([[r, 'r'], [c, 'c']] as const).forEach(([g, k]) => { if (Number.isInteger(g)) return; const n = Math.round(g); const key = `${k}${n}`; if (!lights.has(key)) lights.set(key, rnd() < 0.5); if (lights.get(key)) v *= 1 - Math.exp(-((Math.abs(g - n) / 0.05) ** 2)); });
    out.push({ t, lat: ll[0], lon: ll[1], heading: Math.round(bearing(ll, ahead)), speed_kmh: Math.round(Math.max(0, v) * 10) / 10 });
  }
  return out;
}
function trackFor(legs: Leg[]): LatLon[] { const pts: LatLon[] = []; for (const [axis, line, a, b] of legs) { const n = Math.max(2, Math.ceil(Math.abs(b - a) * 6)); for (let i = 0; i <= n; i++) { const p = a + ((b - a) * i) / n; pts.push(axis === 'row' ? gridLL(line, p) : gridLL(p, line)); } } return pts; }

function explain(video: Video, legs: Leg[], issues: Issue[]): string {
  const route = legs.map(([axis, line, a, b], i) => {
    const s = streetOf(axis, line); const name = s?.label ? s.label(axis === 'row' ? (a + b) / 2 : 0) : s?.name ?? 'a side street';
    const to = placeName(axis, line, b).replace(/^.* (at|near) /, '');
    return i === 0 ? `${dirWord(axis, a, b)} on ${name} to ${to}` : `then ${name} to ${to}`;
  }).join(', ');
  const byCat = new Map<CategoryId, Issue[]>(); issues.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) ?? []), i]));
  const top = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  let text = `${route}. `;
  if (top) {
    const [cat, list] = top; const street = (list[0]?.place ?? '').replace(/ (near|at) .*/, ''); const serious = list.filter(i => i.severity >= 3).length;
    text += `Most findings are **${CATEGORY[cat].label.toLowerCase()} (${list.length})**, mostly on ${street}${serious ? `; ${serious} ${serious === 1 ? 'is' : 'are'} S3 or worse` : ''}. `;
  }
  const hz = issues.filter(i => i.severity === 5);
  text += hz.length ? `${hz.length === 1 ? 'One hazard' : `${hz.length} hazards`} to fix today: **${hz.slice(0, 2).map(h => `${h.description.toLowerCase()} on ${h.place}`).join('; ')}**.` : 'No safety hazards on this drive.';
  void video; return text;
}

export interface MockWorld { videos: Video[]; issues: Issue[]; legs: Map<string, Leg[]>; anchors: Issue[] }
export function buildWorld(): MockWorld {
  GRID.clear();
  const rnd = mulberry32(20261019); const videos: Video[] = []; const issues: Issue[] = []; const legsBy = new Map<string, Leg[]>();
  let n = 1; const nextId = () => `iss_${String(n++).padStart(4, '0')}`;
  for (const d of DRIVES) {
    const total = d.legs.reduce((s, l) => s + legLen(l), 0); const duration = Math.round(420 + rnd() * 190);
    const video: Video = { id: d.id, filename: `pie_${d.drive.replace('/', '_')}.mp4`, source: 'corpus', status: 'done', progress: 1, stage: null, drive: d.drive, start_s: 0, duration_s: duration, explanation: null, issue_ids: [], track: trackFor(d.legs), camera_id: 'pie_cam-3', gps: gpsFor(d.id, d.legs, duration), recorded_at: null };
    const vr = mulberry32(d.seed); let walked = 0;
    for (const leg of d.legs) {
      const [axis, line, a, b] = leg; const len = legLen(leg); const dir = Math.sign(b - a);
      const flavor = STREET_FLAVOR[streetOf(axis, line)?.name ?? 'Queen St'] ?? STREET_FLAVOR['Queen St']!;
      let p = 0.08 + vr() * 0.15;
      while (p < len - 0.02) {
        const cat = weighted(vr, flavor); const iss = buildIssue({ id: nextId(), video, t: ((walked + p) / total) * duration, axis, line, pos: a + dir * p, cat, sev: sevFor(vr, cat), rnd: vr });
        issues.push(iss); video.issue_ids.push(iss.id); p += 0.2 + vr() * 0.42;
      }
      walked += len;
    }
    videos.push(video); legsBy.set(d.id, d.legs);
  }
  // Two issues set01 found on Queen St W just east of Spadina: the scripted clip re-sights them.
  const v01 = videos[0]!; const ar = mulberry32(909); const anchors: Issue[] = [];
  for (const { pos, cat } of [{ pos: 1.13, cat: 'graffiti' as const }, { pos: 1.29, cat: 'markings' as const }]) {
    const iss = buildIssue({ id: nextId(), video: v01, t: (pos / 6.6) * v01.duration_s, axis: 'row', line: 2, pos, cat, sev: 3, rnd: ar });
    issues.push(iss); v01.issue_ids.push(iss.id); anchors.push(iss);
  }
  // Re-sightings where drives overlap or wait at lights.
  const sr = mulberry32(77);
  for (const i of issues) if (sr() < 0.28) { const v = videos[Math.floor(sr() * videos.length)]!; i.sighting_refs!.push({ video_id: v.id, drive: v.drive, t: Math.round(sr() * v.duration_s * 10) / 10 }); i.sightings = i.sighting_refs!.length; }
  for (const v of videos) { v.issue_ids.sort((a, b) => (issues.find(i => i.id === a)!.t - issues.find(i => i.id === b)!.t)); v.explanation = explain(v, legsBy.get(v.id)!, issues.filter(i => i.video_id === v.id)); }
  return { videos, issues, legs: legsBy, anchors };
}

/** The clip that gets "uploaded" on stage: Queen St W east of Spadina, cut from set04/video_0008 at 05:10. */
export function scriptedClip(world: MockWorld, k: number, filename: string) {
  const id = `u${String(k).padStart(2, '0')}`; const legs: Leg[] = [['row', 2, 1.0, 1.45]]; const duration = 27;
  const video: Video = { id, filename, source: 'upload', status: 'queued', progress: 0, stage: null, drive: 'set04/video_0008', start_s: 310, duration_s: duration, explanation: null, issue_ids: [], track: trackFor(legs), camera_id: 'pie_cam-3', gps: gpsFor(id, legs, duration), recorded_at: null };
  const lr = mulberry32(4242 + k); let j = 1; const nid = () => `iss_${id}_${j++}`;
  const plan: Array<{ piece: number; cat?: CategoryId; sev?: Severity; pos?: number; match?: Issue }> = [
    { piece: 0, cat: 'graffiti', sev: 3, pos: 1.06 }, { piece: 1, match: world.anchors[0] }, { piece: 2, cat: 'waste', sev: 3, pos: 1.2 },
    { piece: 3, match: world.anchors[1] }, { piece: 4, cat: 'pavement', sev: 5, pos: 1.33 }, { piece: 5, cat: 'graffiti', sev: 2, pos: 1.41 },
  ];
  const detections = plan.map(d => {
    const t = d.piece * 5 + 1 + lr() * 3;
    if (d.match) { const m = d.match; return { piece: d.piece, matches: m.id as string | null, issue: { ...m, id: nid(), video_id: id, t: Math.round(t * 10) / 10, source: 'upload' as const, frame_seed: hashStr(`${id}-${d.piece}`), work_order: null, sighting_refs: [{ video_id: id, drive: video.drive, t }] } }; }
    const iss = buildIssue({ id: nid(), video, t, axis: 'row', line: 2, pos: d.pos!, cat: d.cat!, sev: d.sev!, rnd: lr, source: 'upload' });
    if (d.cat === 'pavement') iss.description = 'Deep pothole in the curb lane, cyclists swerving';
    if (d.cat === 'graffiti' && d.sev === 3) iss.description = 'Throw-up across a roller shutter, about 2 m wide';
    return { piece: d.piece, matches: null, issue: iss };
  });
  const explanation = 'Eastbound on Queen St W from Spadina Ave, 27 s. **6 detections: 4 new issues and 2 re-sightings** of issues set01/video_0002 found on the same stretch. One hazard to fix today: **a deep pothole in the curb lane near Peter St**, where cyclists are swerving into the streetcar rail.';
  return { video, detections, explanation, pieces: 6 };
}
