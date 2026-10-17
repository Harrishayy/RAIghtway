import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/client/http';
import { createMockClient } from '../src/mock/client';
import { parse } from '../src/schema';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const raw = { id: 'm-1', video_id: 'v', t: 4, category: 'pavement', severity: 5, confidence: 1, description: 'pothole', frame_url: '/api/frames/m-1', bbox: null, lat: 43.6, lon: -79.4 };

describe('operator input: manual issues and pins', () => {
  it('accepts source "manual" and defaults pinned to false', () => {
    expect(parse.issue({ ...raw, source: 'manual', pinned: true })).toMatchObject({ source: 'manual', pinned: true });
    expect(parse.issue(raw).pinned).toBe(false);
    expect(parse.issue({ ...raw, pinned: 'yes' }).pinned).toBe(false);          // a drifting backend degrades, never crashes
  });

  it('posts a marked issue and patches pins over HTTP', async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    const c = createHttpClient({
      fetch: async (u, init) => {
        seen.push({ method: init?.method ?? 'GET', url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null });
        return json({ ...raw, source: 'manual', pinned: init?.method === 'POST' ? true : false });
      },
    });
    const made = await c.createIssue({ video_id: 'v', t: 4, category: 'pavement', severity: 5, description: 'pothole', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, pinned: true });
    expect(made).toMatchObject({ id: 'm-1', source: 'manual', pinned: true });
    const unpinned = await c.updateIssue('m-1', { pinned: false });
    expect(unpinned.pinned).toBe(false);
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual(['POST /api/issues', 'PATCH /api/issues/m-1']);
    expect(seen[0]!.body).toMatchObject({ video_id: 'v', category: 'pavement', pinned: true, bbox: { x: 0.1 } });
    expect(seen[1]!.body).toEqual({ pinned: false });
  });

  it('mock: a marked issue joins its drive and the issue list, and pins toggle', async () => {
    const c = createMockClient({ latencyMs: 0 });
    const [video] = await c.listVideos();
    const made = await c.createIssue({ video_id: video!.id, t: 12, category: 'waste', severity: 4, description: '', pinned: true });
    expect(made).toMatchObject({ source: 'manual', pinned: true, severity: 4, severity_model: 'operator', duplicate_of: null });
    expect(made.lat).not.toBeNull();
    const detail = await c.getVideo(video!.id);
    expect(detail.issues.some(i => i.id === made.id)).toBe(true);
    expect((await c.listIssues()).find(i => i.id === made.id)?.pinned).toBe(true);
    await c.updateIssue(made.id, { pinned: false });
    expect((await c.listIssues()).find(i => i.id === made.id)?.pinned).toBe(false);
    const other = (await c.listIssues()).find(i => i.source !== 'manual')!;
    const pinned = await c.updateIssue(other.id, { pinned: true, severity: 5 });
    expect(pinned).toMatchObject({ pinned: true, severity: 5, severity_model: 'operator' });
    const back = await c.updateIssue(other.id, { revert_severity: true });
    expect(back.severity).toBe(other.severity);
  });
});
