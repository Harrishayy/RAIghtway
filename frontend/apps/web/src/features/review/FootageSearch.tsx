'use client';
// Plain-language search over every drive through the VSS index. The query lives in the ui store, so the footage
// list ranks drives by their matches and the open drive's timeline draws them as a lane. The answer line is
// Nemotron's reading of the matches and the issues already logged there; without it, VSS's own synthesis.
import { useState } from 'react';
import type { Issue, TopicHit, TopicSearch } from '@raightway/core';
import { useTopic } from '@/domain/queries';
import { useUi } from '@/state/ui';
import { Icon } from '@/ui/Icon';

/** Issues already logged inside a VSS match (2 s slack, as the backend counts them), most severe first. */
export const loggedIn = (h: TopicHit, issues: Issue[]) => issues.filter(i => i.video_id === h.video_id && i.t >= h.start - 2 && i.t <= h.end + 2).sort((a, b) => b.severity - a.severity);

/** The current search's answer and hits (best first), and its query state. Shared by the footage list and the timeline. */
export function useFootageSearch() {
  const topic = useUi(s => s.topic); const found = useTopic(topic);
  const result: TopicSearch | undefined = topic.length > 2 ? found.data : undefined;
  return { topic, found, result, hits: result?.hits as TopicHit[] | undefined };
}

export function FootageSearch() {
  const topic = useUi(s => s.topic); const setTopic = useUi(s => s.setTopic);
  const [draft, setDraft] = useState(topic);
  const { found, result, hits } = useFootageSearch();
  const drives = new Set((hits ?? []).map(h => h.video_id)).size;
  const tooShort = draft.trim().length > 0 && draft.trim().length < 3;
  const answer = result?.answer_source === 'nemotron' ? result.answer : result?.synthesis;

  return (
    <>
      <form className="topic topic-vss" role="search" onSubmit={e => { e.preventDefault(); if (!tooShort) setTopic(draft); }}>
        <label className="search search-in"><Icon name="search" /><span className="sr">Search footage with VSS</span>
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Search footage, e.g. traffic cones" maxLength={200} /></label>
        {topic ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setTopic(''); setDraft(''); }}>Clear</button> : null}
      </form>
      {topic ? (
        <div className={`topic-sum${found.isError ? ' bad' : ''}`} role="status" aria-live="polite">
          {found.isError ? (
            <><Icon name="alert" /><span>{found.error instanceof Error ? found.error.message : 'VSS search is unavailable'}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void found.refetch()}><Icon name="refresh" />Retry</button></>
          ) : found.isFetching && !hits ? <span>Searching the VSS index…</span>
            : <span><b>{hits?.length ?? 0}</b> moment{hits?.length === 1 ? '' : 's'} on <b>{drives}</b> drive{drives === 1 ? '' : 's'}{result?.logged ? <>, <b>{result.logged}</b> already logged</> : null}</span>}
          <span className="topic-src" title="Matches come from the VAST DataEngine video search index">VSS</span>
        </div>
      ) : tooShort ? <div className="topic-sum"><span>Type at least 3 characters</span></div> : null}
      {topic && answer && !found.isError ? (
        <p className="topic-answer" title={answer}>
          {answer}
          <span className="topic-by">{result?.answer_source === 'nemotron' ? 'Nemotron, from VSS matches and logged issues' : 'VSS summary'}</span>
        </p>
      ) : null}
    </>
  );
}
