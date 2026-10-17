import type { LatLon } from '@raightway/core';

const R = 6371000, rad = Math.PI / 180;
export const metres = (a: LatLon, b: LatLon) => { const x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad), y = (b[0] - a[0]) * rad; return Math.hypot(x, y) * R; };

/** Cumulative distances along a path, for constant-speed traversal. */
export function measure(path: LatLon[]): number[] { const d = [0]; for (let i = 1; i < path.length; i++) d.push(d[i - 1]! + metres(path[i - 1]!, path[i]!)); return d; }

/** The path from its start to fraction f of its length, plus the point at f. Coordinates as [lon, lat]. */
export function slice(path: LatLon[], f: number, cum = measure(path)): { line: Array<[number, number]>; at: [number, number] | null } {
  if (!path.length) return { line: [], at: null };
  const total = cum[cum.length - 1]!; const target = Math.max(0, Math.min(1, f)) * total; const line: Array<[number, number]> = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    if (cum[i]! <= target) { line.push([p[1], p[0]]); continue; }
    const a = path[i - 1]!; const seg = cum[i]! - cum[i - 1]!; const k = seg ? (target - cum[i - 1]!) / seg : 0;
    const at: [number, number] = [a[1] + (p[1] - a[1]) * k, a[0] + (p[0] - a[0]) * k]; line.push(at); return { line, at };
  }
  const last = path[path.length - 1]!; return { line, at: [last[1], last[0]] };
}
