// Everything configurable at deploy time, read once and validated. NEXT_PUBLIC_* values are inlined
// at build time by Next, so each one is referenced literally here.
import type { Capabilities, Endpoints } from '@raightway/core';

export type Direction = 'survey' | 'night' | 'paint';
const json = <T,>(raw: string | undefined, what: string): Partial<T> => {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { console.warn(`[raightway] ${what} is not valid JSON; ignoring it`); return {}; }
};
const int = (raw: string | undefined, d: number) => { const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : d; };

const depotRaw = process.env.NEXT_PUBLIC_DEPOT?.split(',');
export const env = {
  dataSource: (process.env.NEXT_PUBLIC_DATA_SOURCE === 'http' || process.env.NEXT_PUBLIC_DATA_SOURCE === 'api' ? 'http' : 'mock') as 'http' | 'mock',
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? '',
  endpoints: json<Endpoints>(process.env.NEXT_PUBLIC_API_ENDPOINTS, 'NEXT_PUBLIC_API_ENDPOINTS'),
  capabilities: json<Capabilities>(process.env.NEXT_PUBLIC_API_CAPABILITIES, 'NEXT_PUBLIC_API_CAPABILITIES'),
  timeoutMs: int(process.env.NEXT_PUBLIC_API_TIMEOUT_MS, 15000),
  pollLiveMs: int(process.env.NEXT_PUBLIC_POLL_LIVE_MS, 1000),
  pollIdleMs: int(process.env.NEXT_PUBLIC_POLL_IDLE_MS, 10000),
  depot: depotRaw && depotRaw.length >= 2 && depotRaw.slice(0, 2).every(x => Number.isFinite(Number(x)))
    ? { lat: Number(depotRaw[0]), lon: Number(depotRaw[1]), label: depotRaw.slice(2).join(',').trim() || 'Depot' } : undefined,
  basemap: (process.env.NEXT_PUBLIC_BASEMAP === 'none' ? 'none' : 'toronto') as 'toronto' | 'none',
  defaultDirection: (['survey', 'night', 'paint'].includes(process.env.NEXT_PUBLIC_DEFAULT_DIRECTION ?? '') ? process.env.NEXT_PUBLIC_DEFAULT_DIRECTION : 'survey') as Direction,
};
