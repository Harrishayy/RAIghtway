import { describe, expect, it } from 'vitest';
import { parse } from '../src/schema';
import { summarizeIssues } from '../src/derive';

const base = { generated_at: '2026-10-17T12:00:00Z', summary: 's', counts: { pavement: 1 }, crews: { roads: 1 }, rationale: 'r' };
const issue = (id: string, extra: object = {}) => ({ id, video_id: 'v', t: 1, category: 'pavement', severity: 4, confidence: 0.8, description: 'pothole', frame_url: '/f', bbox: null, lat: 43.6, lon: -79.4, ...extra });

describe('report detail', () => {
  it('parses a report that predates the detail sections', () => {
    const { report } = parse.report(base);
    expect(report.sections).toBeUndefined();
    expect(report.stats).toBeUndefined();
    expect(report.summary).toBe('s');
  });
  it('keeps good sections and drops broken ones', () => {
    const row = { id: 'a', category: 'pavement', severity: 5, description: 'd', video_id: 'v', t: 3, sightings: 2, confidence: 0.9, deadline: 'today', crew: 'roads', minutes: 60 };
    const { report } = parse.report({ ...base, model: null,
      stats: { open: 3, today: 1, this_week: 1, this_month: 1, routine: 0, located: 3, drives: 1, crews: 2, crew_hours: 4.5, rejected: 1 },
      sections: [{ category: 'pavement', crew: 'roads', open: 3, by_severity: { 5: 1 }, severe: 1, work_minutes: 120, crew_hours: 2.6, crews: 1, top: [row, { id: 'bad', category: 'nope' }] }, { category: 'nope' }],
      priorities: [row, 'junk'], hotspots: [{ id: 'H1', label: 'Queen St area', lat: 43.6, lon: -79.4, issues: 2 }],
      provenance: { report_model: 'nemotron-ultra', rating_models: { 'cosmos3-reason': 3 }, caveats: ['x'] } });
    expect(report.sections).toHaveLength(1);
    expect(report.sections![0]!.top.map(t => t.id)).toEqual(['a']);
    expect(report.priorities!.map(p => p.deadline)).toEqual(['today']);
    expect(report.hotspots![0]!.drives).toEqual([]);
    expect(report.provenance!.rating_models).toEqual({ 'cosmos3-reason': 3 });
    expect(report.stats!.rejected).toBe(1);
  });
  it('reads rating fields and leaves rejected findings out of the open counts', () => {
    const [a, b] = parse.issues([issue('a', { severity_reason: 'Deep pothole.', severity_model: 'cosmos3-reason', verdict: 'confirmed', find_severity: 2 }), issue('b', { verdict: 'rejected', find_severity: 'x' })]);
    expect(a).toMatchObject({ severity_reason: 'Deep pothole.', verdict: 'confirmed', find_severity: 2 });
    expect(b!.find_severity).toBeUndefined();
    expect(summarizeIssues([a!, b!]).total).toBe(1);
  });
});
