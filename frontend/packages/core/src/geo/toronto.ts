// Downtown Toronto as data: the arterial grid by intersection, streets, parks, shoreline and labels,
// all in lat/lon. The map draws this as an offline basemap; the mock data source walks it to make drives.
import type { LatLon } from '../types';

export const TORONTO_ROTATION = 17;
const LL: LatLon[][] = [ // [row][col]; rows Front→College (south→north), cols Bathurst→Parliament (west→east)
  [[43.6411, -79.4015], [43.6431, -79.3937], [43.6449, -79.3838], [43.646, -79.3795], [43.6467, -79.377], [43.6482, -79.3712], [43.6505, -79.3617]],
  [[43.6435, -79.4025], [43.6455, -79.3947], [43.6476, -79.3848], [43.6482, -79.3804], [43.6489, -79.3779], [43.6504, -79.3721], [43.6529, -79.3628]],
  [[43.6467, -79.404], [43.6487, -79.3963], [43.6508, -79.3868], [43.6517, -79.3818], [43.6524, -79.3793], [43.654, -79.3733], [43.6565, -79.364]],
  [[43.6508, -79.4058], [43.6528, -79.398], [43.6548, -79.3884], [43.6554, -79.3827], [43.6561, -79.3802], [43.6577, -79.3744], [43.6602, -79.3652]],
  [[43.6558, -79.4081], [43.6578, -79.4003], [43.66, -79.3904], [43.6606, -79.3854], [43.6613, -79.3829], [43.6629, -79.3768], [43.664, -79.3672]],
];
const NR = LL.length, NC = LL[0]!.length;
const at = (r: number, c: number) => LL[r]![c]!;

/** Bilinear interpolation (linear extrapolation outside) over the intersection table. r: rows, c: cols. */
export function gridLL(r: number, c: number): LatLon {
  const r0 = Math.max(0, Math.min(NR - 2, Math.floor(r))), c0 = Math.max(0, Math.min(NC - 2, Math.floor(c)));
  const fr = r - r0, fc = c - c0;
  const a = at(r0, c0), b = at(r0, c0 + 1), d = at(r0 + 1, c0), e = at(r0 + 1, c0 + 1);
  return [
    a[0] * (1 - fr) * (1 - fc) + b[0] * (1 - fr) * fc + d[0] * fr * (1 - fc) + e[0] * fr * fc,
    a[1] * (1 - fr) * (1 - fc) + b[1] * (1 - fr) * fc + d[1] * fr * (1 - fc) + e[1] * fr * fc,
  ];
}

export type Axis = 'row' | 'col';
export interface StreetDef { name: string; at: number; from: number; to: number; axis: Axis; kind: 'arterial' | 'street'; label?: (c: number) => string }
const W = (name: string) => (c: number) => (c < 4 ? `${name} W` : `${name} E`);
export const STREETS: StreetDef[] = [
  { name: 'Front St', at: 0, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Front St') },
  { name: 'King St', at: 1, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('King St') },
  { name: 'Queen St', at: 2, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Queen St') },
  { name: 'Dundas St', at: 3, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Dundas St') },
  { name: 'College St', at: 4, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: c => (c < 4 ? 'College St' : 'Carlton St') },
  { name: 'Wellington St', at: 0.5, from: -0.2, to: 5.2, axis: 'row', kind: 'street', label: W('Wellington St') },
  { name: 'Adelaide St', at: 1.34, from: -3.5, to: 10, axis: 'row', kind: 'street', label: W('Adelaide St') },
  { name: 'Richmond St', at: 1.67, from: -3.5, to: 10, axis: 'row', kind: 'street', label: W('Richmond St') },
  { name: 'Shuter St', at: 2.45, from: 4, to: 6.6, axis: 'row', kind: 'street' },
  { name: 'Baldwin St', at: 3.45, from: 0.6, to: 2, axis: 'row', kind: 'street' },
  { name: 'Gerrard St', at: 3.5, from: 2, to: 6.6, axis: 'row', kind: 'street', label: W('Gerrard St') },
  { name: 'Queens Quay', at: -0.95, from: -0.4, to: 5.6, axis: 'row', kind: 'street', label: W('Queens Quay') },
  { name: 'Bathurst St', at: 0, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Spadina Ave', at: 1, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'University Ave', at: 2, from: 0, to: 4.1, axis: 'col', kind: 'arterial' },
  { name: 'Bay St', at: 3, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Yonge St', at: 4, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Jarvis St', at: 5, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Parliament St', at: 6, from: -0.5, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Bloor St', at: 5.9, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Bloor St') },
  { name: 'Ossington Ave', at: -2, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Dovercourt Rd', at: -1.2, from: -0.6, to: 6.5, axis: 'col', kind: 'street' },
  { name: 'Strachan Ave', at: -1.6, from: -1.1, to: 2, axis: 'col', kind: 'street' },
  { name: 'River St', at: 7.6, from: 1, to: 6.5, axis: 'col', kind: 'street' },
  { name: 'Broadview Ave', at: 8.6, from: 1.6, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Sumach St', at: 7.1, from: 0.4, to: 4.6, axis: 'col', kind: 'street' },
  { name: 'Eastern Ave', at: 0.4, from: 6.2, to: 10, axis: 'row', kind: 'street' },
  { name: 'Harbord St', at: 4.9, from: -2, to: 2, axis: 'row', kind: 'street' },
  { name: 'Wellesley St', at: 5.0, from: 3, to: 7, axis: 'row', kind: 'street' },
  { name: 'Portland St', at: 0.5, from: -0.3, to: 2, axis: 'col', kind: 'street' },
  { name: 'Augusta Ave', at: 0.62, from: 2, to: 4, axis: 'col', kind: 'street' },
  { name: 'Peter St', at: 1.3, from: 1, to: 2, axis: 'col', kind: 'street' },
  { name: 'John St', at: 1.55, from: 0, to: 2, axis: 'col', kind: 'street' },
  { name: 'Beverley St', at: 1.45, from: 2, to: 4, axis: 'col', kind: 'street' },
  { name: 'McCaul St', at: 1.72, from: 2, to: 4, axis: 'col', kind: 'street' },
  { name: 'Simcoe St', at: 1.85, from: -0.3, to: 2, axis: 'col', kind: 'street' },
  { name: 'York St', at: 2.5, from: -0.6, to: 2, axis: 'col', kind: 'street' },
  { name: 'Church St', at: 4.5, from: -0.6, to: 4.6, axis: 'col', kind: 'street' },
  { name: 'Sherbourne St', at: 5.45, from: -0.6, to: 4.6, axis: 'col', kind: 'street' },
];

export const pointOn = (axis: Axis, line: number, pos: number): LatLon => (axis === 'row' ? gridLL(line, pos) : gridLL(pos, line));
function streetLine(s: StreetDef, step = 0.25): LatLon[] {
  const pts: LatLon[] = [];
  for (let t = s.from; t < s.to; t += step) pts.push(pointOn(s.axis, s.at, t));
  pts.push(pointOn(s.axis, s.at, s.to));
  return pts;
}
const quad = (r0: number, r1: number, c0: number, c1: number): LatLon[] => [gridLL(r0, c0), gridLL(r0, c1), gridLL(r1, c1), gridLL(r1, c0)];

export interface Basemap {
  id: string; rotationDeg: number;
  streets: Array<{ name: string; kind: 'arterial' | 'street'; line: LatLon[] }>;
  parks: LatLon[][]; water: LatLon[][];
  /** Labels in priority order; the map drops any that would collide. */
  labels: Array<{ text: string; at: LatLon; vertical: boolean }>;
}

let cached: Basemap | null = null;
export function torontoBasemap(): Basemap {
  if (cached) return cached;
  const shore: LatLon[] = [];
  for (let c = -4; c <= 11; c += 0.2) { const slip = (c > 1.8 && c < 2) || (c > 3.2 && c < 3.4) || (c > 4.6 && c < 4.8); shore.push(gridLL(slip ? -1.18 : -1.3, c)); }
  const labels: Basemap['labels'] = [];
  for (const [text, r, c] of [['Queen St W', 2, 0.27], ['Queen St W', 2, 2.72], ['Queen St E', 2, 5.25], ['King St W', 1, 0.27], ['King St W', 1, 2.72], ['King St E', 1, 5.25], ['Dundas St W', 3, 0.27], ['Dundas St W', 3, 2.25], ['Dundas St E', 3, 5.25], ['College St', 4, 0.27], ['Carlton St', 4, 5.25], ['Front St W', 0, 0.27], ['Front St E', 0, 5.25]] as const) labels.push({ text, at: gridLL(r, c), vertical: false });
  for (const [text, r, c] of [['Bathurst', 2.55, 0], ['Spadina', 2.55, 1], ['University', 1.5, 2], ['Bay', 3.5, 3], ['Yonge', 1.5, 4], ['Jarvis', 2.55, 5], ['Parliament', 3.5, 6]] as const) labels.push({ text, at: gridLL(r, c), vertical: true });
  cached = {
    id: 'toronto-downtown', rotationDeg: TORONTO_ROTATION,
    streets: STREETS.map(s => ({ name: s.name, kind: s.kind, line: streetLine(s) })),
    parks: [quad(2.3, 2.75, 1.5, 1.7), quad(2.08, 2.45, 2.42, 2.82), quad(2.1, 2.55, 5.5, 5.85), quad(1.05, 1.3, 4.6, 4.85), quad(0.58, 0.85, 1.05, 1.22), quad(0.55, 0.8, 0.12, 0.35), quad(3.55, 4.0, 5.55, 5.95), quad(4.08, 4.6, 1.85, 2.2)],
    water: [[...shore, gridLL(-4, 11), gridLL(-4, -4)]],
    labels,
  };
  return cached;
}

/** "Queen St W near Portland St" for a point on a grid street. */
export function placeName(axis: Axis, line: number, pos: number): string {
  const cross = STREETS.filter(s => s.axis !== axis && line >= s.from && line <= s.to);
  let best: StreetDef | null = null, bd = 9;
  for (const s of cross) { const d = Math.abs(s.at - pos); if (d < bd) { bd = d; best = s; } }
  const self = STREETS.find(s => s.axis === axis && Math.abs(s.at - line) < 0.02);
  const selfName = self ? (self.label ? self.label(axis === 'row' ? pos : 0) : self.name) : 'Unnamed street';
  if (!best) return selfName;
  const crossName = best.label ? best.label(axis === 'row' ? 0 : line) : best.name;
  return bd < 0.06 ? `${selfName} at ${crossName}` : `${selfName} near ${crossName}`;
}
export const streetOf = (axis: Axis, line: number) => STREETS.find(s => s.axis === axis && Math.abs(s.at - line) < 0.02);
