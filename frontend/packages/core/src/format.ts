import { SHIFT_START_MINUTES } from './registry';

export const cx = (...a: Array<string | false | null | undefined>): string => a.filter(Boolean).join(' ');
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** 312 → "05:12" */
export const fmtClock = (s: number) => `${pad2(s / 60)}:${pad2(s % 60)}`;
/** 312.4 → "05:12.4" */
export const fmtTimecode = (s: number) => `${pad2(s / 60)}:${pad2(Math.floor(s % 60))}.${Math.floor((s % 1) * 10)}`;
/** 27 → "27 s", 610 → "10 min 10 s" */
export const fmtDuration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? `${Math.round(s % 60)} s` : ''}`.trim() : `${Math.round(s)} s`);
/** minutes → hours, one decimal under 10 h */
export const fmtHours = (m: number) => { const h = m / 60; return (h < 10 ? h.toFixed(1) : String(Math.round(h))).replace(/\.0$/, ''); };
/** minutes into the shift → wall clock, "08:00" + 95 → "09:35" */
export const fmtShift = (min: number, start = SHIFT_START_MINUTES) => { const t = start + min; return `${pad2(t / 60)}:${pad2(t % 60)}`; };
export const fmtCoord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon < 0 ? '−' : ''}${Math.abs(lon).toFixed(5)}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface RichPart { text: string; strong?: boolean }
/** Splits model text on `**bold**` markers. Never renders HTML. */
export function parseRich(text: string | null | undefined): RichPart[] {
  if (!text) return [];
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(p => (p.startsWith('**') && p.endsWith('**') ? { text: p.slice(2, -2), strong: true } : { text: p }));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export function haversineKm([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]): number {
  const R = 6371, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Travel minutes the way dispatch prices them: haversine × 1.3 at 25 km/h (architecture §3.8). */
export const travelMinutes = (a: [number, number], b: [number, number]) => Math.max(1, Math.round(((haversineKm(a, b) * 1.3) / 25) * 60));
