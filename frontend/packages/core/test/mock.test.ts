import { describe, expect, it } from 'vitest';
import { createMockClient } from '../src/mock/client';
import { enrichPlan, summarizeIssues } from '../src/derive';

describe('mock client', () => {
  it('serves a populated city that matches the contract', async () => {
    const c = createMockClient({ latencyMs: 0 });
    const [videos, issues] = await Promise.all([c.listVideos(), c.listIssues()]);
    expect(videos.length).toBe(7); expect(issues.length).toBeGreaterThan(80);
    expect(issues.every(i => i.lat != null && i.bbox && i.work_order)).toBe(true);
    const { video, issues: vi } = await c.getVideo(videos[0]!.id);
    expect(video.gps!.length).toBeGreaterThan(400); expect(vi.every(i => i.video_id === video.id)).toBe(true);
  });
  it('walks an upload through the pipeline and merges the re-sightings', async () => {
    const c = createMockClient({ latencyMs: 0, speed: 40 });
    const v = await c.upload(new File(['x'], 'clip.mp4'));
    expect(v.status).toBe('queued');
    await new Promise(r => setTimeout(r, 420));
    const done = await c.getVideo(v.id);
    expect(done.video.status).toBe('done');
    expect(done.issues.filter(i => i.duplicate_of).length).toBe(2);
    expect(done.video.result).toEqual({ found: 6, merged: 2, fresh: 4 });
  });
  it('plans routes that respect the shift and cover the hazards', async () => {
    const c = createMockClient({ latencyMs: 0 });
    const issues = await c.listIssues(); const s = summarizeIssues(issues);
    const plan = enrichPlan(await c.dispatch(s.baselineCrews), issues, c.depot());
    expect(plan.routes.every(r => r.minutes <= 540)).toBe(true);
    const routed = new Set(plan.routes.flatMap(r => r.stops));
    expect(s.hazards.filter(h => routed.has(h.id)).length).toBeGreaterThanOrEqual(s.hazards.length - 1);
  });
});
