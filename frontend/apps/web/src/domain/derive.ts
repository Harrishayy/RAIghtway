// Pure view helpers shared by the review desk, issues and dispatch screens.
import type { Issue, LatLon, TrackPoint, Video } from '@raightway/core';
import type { DashState } from '@/ui/Dash';

/** Position, heading and speed at time t. Uses 1 Hz GPS when the backend sends it, else the track. */
export function fixAt(video: Video | undefined, t: number): { at: LatLon; heading: number; speed: number | null } | null {
  if (!video) return null;
  const g = video.gps;
  if (g && g.length) {
    let i = g.findIndex(p => p.t > t); if (i <= 0) i = i === 0 ? 1 : g.length - 1;
    const a: TrackPoint = g[Math.max(0, i - 1)]!, b: TrackPoint = g[Math.min(g.length - 1, i)]!; const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    return { at: [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f], heading: a.heading, speed: a.speed_kmh + (b.speed_kmh - a.speed_kmh) * f };
  }
  const tr = video.track; if (!tr.length) return null;
  const f = video.duration_s ? Math.min(1, Math.max(0, t / video.duration_s)) : 0; const x = f * (tr.length - 1); const i = Math.floor(x); const a = tr[i]!, b = tr[Math.min(tr.length - 1, i + 1)]!;
  const k = x - i; const heading = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return { at: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], heading: (heading + 360) % 360, speed: null };
}

export const byTime = (a: Issue, b: Issue) => a.t - b.t;

/** The finding the frame should show at t: nearest within a short window, else none. */
export function issueAt(issues: Issue[], t: number): Issue | null {
  let best: Issue | null = null, bd = Infinity;
  for (const i of issues) { const d = t - i.t; if (d > -1.2 && d < 7 && Math.abs(d) < bd) { bd = Math.abs(d); best = i; } }
  return best;
}

export function dashFor(videos: Video[] | undefined): DashState {
  const live = videos?.find(v => v.status === 'analysing' || v.status === 'queued');
  if (live) return live.stage === 'history' ? 'check' : live.stage === 'plan' ? 'plan' : 'scan';
  if (videos?.[0]?.status === 'failed') return 'fail';
  return 'idle';
}
