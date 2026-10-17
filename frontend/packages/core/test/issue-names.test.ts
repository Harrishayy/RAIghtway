import { describe, expect, it } from 'vitest';
import { issueLabel } from '../src/derive';
import { createMockClient } from '../src/mock/client';
import { parse } from '../src/schema';

const raw = { id: 'c-1', video_id: 'v', t: 4, category: 'pavement', severity: 4, confidence: 0.9, description: 'pothole', frame_url: '/api/frames/c-1', bbox: null, lat: 43.6, lon: -79.4 };

describe('operator names for issues', () => {
  it('issueLabel prefers the name, else the description', () => {
    expect(issueLabel({ description: 'pothole' })).toBe('pothole');
    expect(issueLabel({ description: 'pothole', name: null })).toBe('pothole');
    expect(issueLabel({ description: 'pothole', name: '   ' })).toBe('pothole');
    expect(issueLabel({ description: 'pothole', name: 'King St crater' })).toBe('King St crater');
  });

  it('the schema accepts name, and degrades a drifting one', () => {
    expect(parse.issue({ ...raw, name: 'King St crater' }).name).toBe('King St crater');
    expect(parse.issue({ ...raw, name: null }).name).toBeNull();
    expect(parse.issue(raw).name).toBeUndefined();
    expect(parse.issue({ ...raw, name: 42 }).name).toBeUndefined();
  });

  it('the mock names, renames and clears an issue', async () => {
    const c = createMockClient({ latencyMs: 0 });
    const [first] = await c.listIssues();
    const named = await c.updateIssue(first!.id, { name: '  Spadina   sinkhole ' });
    expect(named.name).toBe('Spadina sinkhole');
    expect((await c.listIssues()).find(i => i.id === first!.id)?.name).toBe('Spadina sinkhole');
    expect((await c.updateIssue(first!.id, { name: '' })).name).toBeNull();
  });
});
