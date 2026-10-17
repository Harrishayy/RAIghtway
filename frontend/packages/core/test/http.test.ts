import { describe, expect, it } from 'vitest';
import { createHttpClient, defaultStage } from '../src/client/http';
import { ApiError } from '../src/client/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('http client', () => {
  it('uses configured paths, base URL and headers', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const c = createHttpClient({
      baseUrl: 'https://api.test/', endpoints: { issues: '/v2/findings' }, headers: () => ({ Authorization: 'Bearer t' }),
      transform: { issues: raw => (raw as { items: unknown[] }).items },
      fetch: async (u, init) => { seen.push({ url: String(u), auth: new Headers(init?.headers).get('Authorization') }); return json({ items: [{ id: 'x', video_id: 'v', t: 2, category: 'pavement', severity: 4, confidence: 0.9, description: 'd', frame_url: '/api/frames/x', bbox: null, lat: 1, lon: 2 }] }); },
    });
    const issues = await c.listIssues();
    expect(seen[0]).toEqual({ url: 'https://api.test/v2/findings', auth: 'Bearer t' });
    expect(issues[0]!.id).toBe('x');
    expect(c.frameUrl(issues[0]!)).toBe('https://api.test/api/frames/x');
  });
  it('maps free-text stages and their progress', async () => {
    const c = createHttpClient({ fetch: async () => json([{ id: 'u1', filename: 'a.mp4', status: 'analysing', progress: 0.3, stage: 'checking 3/6' }]) });
    const [v] = await c.listVideos();
    expect(v).toMatchObject({ stage: 'find', stage_detail: 'checking 3/6', stage_progress: 0.5 });
    expect(defaultStage('dedupe')).toBe('history');
    // the real backend's vocabulary (backend/app/main.py)
    expect(['segmenting', 'checking 3/6', 'checking history', 'planning repairs', 'done', 'done (replayed)', 'queued', 'Analysis failed: x'].map(defaultStage))
      .toEqual(['segment', 'find', 'history', 'plan', null, null, null, null]);
  });
  it('treats a missing report as none yet, and surfaces API errors with status', async () => {
    const c = createHttpClient({ fetch: async u => (String(u).endsWith('/api/report') ? new Response('', { status: 404 }) : json({ detail: 'cuOpt is down' }, 503)) });
    expect(await c.getReport()).toBeNull();
    const err = await c.dispatch({ roads: 1 }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError); expect(err.message).toBe('cuOpt is down'); expect(err.retryable).toBe(true);
  });
  it('reports an unreachable backend as a retryable network error', async () => {
    const c = createHttpClient({ fetch: async () => { throw new TypeError('fetch failed'); } });
    const err = await c.listVideos().catch(e => e);
    expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(0);
  });
});
