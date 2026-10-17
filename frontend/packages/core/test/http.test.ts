import { describe, expect, it } from 'vitest';
import { DEFAULT_DEPOT, createHttpClient, defaultStage } from '../src/client/http';
import { enrichPlan } from '../src/derive';
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
  it('reads the FastAPI backend payloads (backend/app/models.py) as served', async () => {
    const issue = { id: 'i1', video_id: 'v1', t: 12.5, category: 'pavement', severity: 4, confidence: 0.82, description: 'Pothole in lane',
      frame_url: '/api/frames/i1', bbox: { x: 0.4, y: 0.6, w: 0.2, h: 0.1 }, lat: 43.65, lon: -79.38, duplicate_of: null, sightings: 3,
      work_order: { repair: 'Cold patch', crew: 'roads', minutes: 40, equipment: ['asphalt'], urgency: 'soon' } };
    const video = { id: 'v1', filename: 'set04_video_0008_t0310.mp4', source: 'upload', status: 'failed', progress: 0.4, stage: 'Analysis failed: GPU busy',
      drive: 'set04/video_0008', start_s: 310, duration_s: 30, explanation: null, issue_ids: ['i1'], track: [[43.65, -79.38], [43.651, -79.379]] };
    const report = { generated_at: '2026-10-17T10:00:00Z', summary: 's', counts: { pavement: 3 }, crews: { roads: 2 }, rationale: 'r' };
    const plan = { routes: [{ crew_id: 'roads-1', crew: 'roads', stops: ['i1'], eta_min: [15], path: [[43.65, -79.38]] }, { crew_id: 'roads-2', crew: 'roads', stops: [], eta_min: [], path: [] }],
      unassigned: [], solver: 'fallback', solve_ms: 0 };
    const routes: Record<string, unknown> = { 'GET /api/videos/v1': { video, issues: [issue] }, 'GET /api/videos': [video], 'GET /api/issues': [issue],
      'GET /api/issues/i1/similar': [issue], 'GET /api/report': null, 'POST /api/report': report, 'POST /api/dispatch': plan };
    const c = createHttpClient({ timeoutMs: 1000, fetch: async (u, init) => { return json(routes[`${init?.method} ${String(u)}`] ?? null); } });
    const [v] = await c.listVideos();
    expect(v).toMatchObject({ status: 'failed', stage: null, stage_detail: 'Analysis failed: GPU busy', drive: 'set04/video_0008', track: [[43.65, -79.38], [43.651, -79.379]] });
    expect((await c.getVideo('v1')).issues[0]).toMatchObject({ sightings: 3, work_order: { urgency: 'soon', crew: 'roads' }, bbox: { x: 0.4 } });
    expect((await c.similar('i1'))[0]).toMatchObject({ issue: { id: 'i1' }, distance: null });
    expect(await c.getReport()).toBeNull(); // 200 with a null body before the first report
    expect((await c.regenerateReport()).report.crews).toEqual({ roads: 2 });
    const p = await c.dispatch({ roads: 2 });
    expect(p.solver).toBe('fallback'); expect(p.routes.filter(r => r.stops.length)).toHaveLength(1);
  });
  it('defaults the depot to the backend dispatch depot', () => {
    expect(createHttpClient().depot()).toEqual({ lat: 43.6534, lon: -79.3841, label: 'Toronto City Hall (assumed depot)' });
    expect(createHttpClient({ depot: { lat: 1, lon: 2, label: 'x' } }).depot().lat).toBe(1);
  });
  it('handles idle crews (empty stops, eta_min and path) and a report naming only busy crews', async () => {
    const plan = { routes: [{ crew_id: 'graffiti-1', crew: 'graffiti', stops: [], eta_min: [], path: [] }], unassigned: [], solver: 'cuopt', solve_ms: 40 };
    const report = { generated_at: '2026-10-17T10:00:00Z', summary: 's', counts: { pavement: 1 }, crews: { roads: 1 }, rationale: '' };
    const c = createHttpClient({ fetch: async u => json(String(u).endsWith('/api/report') ? report : plan) });
    const view = enrichPlan(await c.dispatch({ graffiti: 1 }), [], DEFAULT_DEPOT);
    expect(view.routes[0]).toMatchObject({ legs: [], minutes: 0 });
    expect(view).toMatchObject({ crews_needed: 0, crews_dispatched: 1, jobs_routed: 0 });
    const r = (await c.regenerateReport()).report;
    expect(r.crews).toEqual({ roads: 1 }); expect(r.crews.graffiti).toBeUndefined();
  });
});

describe('run', () => {
  it('posts to /api/run and returns the queued video', async () => {
    const seen: string[] = [];
    const c = createHttpClient({ fetch: async (u, init) => { seen.push(`${init?.method} ${String(u)}`); return json({ id: 'r1', filename: 'set04_video_0008_t0300.mp4', source: 'corpus', status: 'queued', progress: 0, stage: 'fetching from VAST', drive: 'set04/video_0008', start_s: 300 }); } });
    const v = await c.run();
    expect(seen).toEqual(['POST /api/run']);
    expect(v).toMatchObject({ id: 'r1', status: 'queued', drive: 'set04/video_0008' });
  });
  it('surfaces "nothing new" as a 409 with the backend message', async () => {
    const c = createHttpClient({ fetch: async () => json({ detail: 'Nothing new in the VAST index: every segment has been analysed' }, 409) });
    await expect(c.run()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Nothing new') });
  });
});
