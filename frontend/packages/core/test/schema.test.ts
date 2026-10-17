import { describe, expect, it } from 'vitest';
import { parse } from '../src/schema';

describe('parse', () => {
  it('repairs loose payloads instead of failing', () => {
    const v = parse.video({ id: 7, filename: 'a.mp4', status: 'weird', progress: '0.5', track: [['43.6', '-79.3']] });
    expect(v).toMatchObject({ id: '7', status: 'done', progress: 0.5, stage: null, issue_ids: [] });
    expect(v.track[0]).toEqual([43.6, -79.3]);
  });
  it('drops list items that cannot be repaired and keeps the rest', () => {
    const list = parse.issues([
      { id: 'a', video_id: 'v', t: 1, category: 'graffiti', severity: 9, confidence: 0.8, description: 'x', frame_url: '/f', bbox: null, lat: null, lon: null },
      { id: 'b', category: 'not-a-category' },
    ]);
    expect(list.map(i => i.id)).toEqual(['a']);
    expect(list[0]!.severity).toBe(3); // out of range → middle of the rubric
  });
  it('accepts a report with or without an envelope', () => {
    const bare = parse.report({ generated_at: 'now', summary: 's', counts: {}, crews: { roads: '2' }, rationale: '' });
    expect(bare.report.crews.roads).toBe(2); expect(bare.updating).toBe(false);
    expect(parse.report({ report: { summary: 'x' }, updating: true }).updating).toBe(true);
  });
  it('reads similar issues as Issue[] or {issue, distance}[]', () => {
    const i = { id: 'a', video_id: 'v', t: 1, category: 'waste', severity: 2, confidence: 1, description: '', frame_url: '', bbox: null, lat: 1, lon: 2 };
    expect(parse.similar([i])[0]!.issue.id).toBe('a');
    expect(parse.similar([{ issue: i, distance: 0.2 }])[0]!.distance).toBe(0.2);
  });
});
