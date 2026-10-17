import { describe, expect, it } from 'vitest';
import { parse } from '../src/schema';
import { createMockClient } from '../src/mock/client';

describe('footage search and ask parsing', () => {
  it('reads the full search answer and tolerates a bare hit list', () => {
    const full = parse.topicSearch({ query: 'cones', search: 'vss', hits: [{ video_id: 'v', start: 530, end: 540, score: 1, similarity: '0.34', caption: 'Cones.' }],
      synthesis: 'VSS says cones.', answer: 'Cones on 1 drive; 1 logged.', answer_source: 'nemotron', logged: 1 }, 'cones');
    expect(full).toMatchObject({ search: 'vss', answer_source: 'nemotron', logged: 1, synthesis: 'VSS says cones.' });
    expect(full.hits[0]).toMatchObject({ start: 530, similarity: 0.34 });
    const bare = parse.topicSearch([{ video_id: 'v', start: 1, end: 2, score: 1, caption: 'x' }], 'q');
    expect(bare).toMatchObject({ query: 'q', answer: '', answer_source: null, logged: 0 });
    expect(parse.topicSearch({ hits: [], answer_pending: true }, 'q').answer_pending).toBe(true);
    expect(bare.hits).toHaveLength(1);
    // an answer_source without text is no answer
    expect(parse.topicSearch({ hits: [], answer_source: 'nemotron', answer: '' }, 'q').answer_source).toBeNull();
  });

  it('reads an ask answer and rejects garbage', () => {
    const a = parse.askAnswer({ question: 'what?', answer: 'Cones at 08:50.', source: 'nemotron', times: ['530'], evidence: [{ start: 525, end: 530, caption: 'c', kind: 'segment' }], issue_ids: [1] });
    expect(a).toMatchObject({ source: 'nemotron', times: [530], issue_ids: ['1'] });
    expect(() => parse.askAnswer({ nope: true })).toThrow();
  });

  it('mock answers searches and questions', async () => {
    const c = createMockClient({ latencyMs: 0 });
    const vids = await c.listVideos();
    const r = await c.searchFootage('graffiti');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.answer_source).toBe('nemotron');
    const a = await c.ask(vids.find(v => v.source === 'corpus')!.id, { question: 'what happened here?', t: 30, history: [{ role: 'user', content: 'hi' }] });
    expect(a.answer).toMatch(/Sample answer/);
  });
});
