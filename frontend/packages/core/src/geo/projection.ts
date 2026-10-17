// Local tangent-plane projection: lat/lon → metres (x east, y down), optionally rotated so a city's
// street grid reads square ("Toronto north" is ~17° clockwise of true north). Works for any city;
// accuracy is fine across the tens of kilometres a fleet covers in a day.
import type { LatLon } from '../types';

export interface Projector { (lat: number, lon: number): [x: number, y: number]; lat0: number; lon0: number; rotationDeg: number }

export function makeProjector(lat0: number, lon0: number, rotationDeg = 0): Projector {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110574;
  const th = (rotationDeg * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
  const f = ((lat: number, lon: number) => {
    const x = (lon - lon0) * kx, y = -(lat - lat0) * ky;
    return [x * cos - y * sin, x * sin + y * cos] as [number, number];
  }) as Projector;
  f.lat0 = lat0; f.lon0 = lon0; f.rotationDeg = rotationDeg;
  return f;
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }
export function boundsOf(points: Array<[number, number]>): Bounds | null {
  if (!points.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}
/** Pads bounds and widens them to an aspect ratio, never smaller than `minSpan` metres. */
export function fitBounds(b: Bounds, aspect: number, pad = 0.12, minSpan = 400): [x: number, y: number, w: number, h: number] {
  let w = Math.max(minSpan, b.x1 - b.x0), h = Math.max(minSpan / aspect, b.y1 - b.y0);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  w *= 1 + pad * 2; h *= 1 + pad * 2;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  return [cx - w / 2, cy - h / 2, w, h];
}
export const centroid = (pts: LatLon[]): LatLon => {
  if (!pts.length) return [0, 0];
  const s = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
};
