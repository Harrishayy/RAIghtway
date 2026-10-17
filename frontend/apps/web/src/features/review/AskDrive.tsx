'use client';
// Ask what happened on the open drive. The backend gathers VSS's captions around the playhead and VSS search hits
// on this drive, then Nemotron answers from them and the logged issues. Times in the answer seek the player.
import { Fragment, useState } from 'react';
import { fmtClock, type AskAnswer, type Issue, type Video } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useAsk } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { Icon } from '@/ui/Icon';

const CLOCK = /\b(\d{1,2}):(\d{2})\b/g;

export function AskDrive({ video, issues }: { video: Video; issues: Issue[] }) {
  const client = useClient(); const { t, seek, select, setPlaying } = usePlayback();
  const [question, setQuestion] = useState(''); const [here, setHere] = useState(true);
  const asking = useAsk(); const answer = asking.data;
  if (!client.capabilities.ask) return null;

  const go = (s: number) => {
    setPlaying(false);
    const near = issues.find(i => Math.abs(i.t - s) <= 2); if (near) select(near.id);
    seek(Math.max(0, Math.min(video.duration_s, s)));
  };
  const submit = () => { const q = question.trim(); if (q.length >= 3) asking.mutate({ videoId: video.id, question: q, t: here ? t : null }); };

  return (
    <div className="ask">
      <form className="ask-form" onSubmit={e => { e.preventDefault(); submit(); }}>
        <label className="search search-in"><Icon name="search" /><span className="sr">Ask about this drive</span>
          <input value={question} onChange={e => setQuestion(e.target.value)} maxLength={300} placeholder="Ask about this drive, e.g. what is happening here?" /></label>
        <label className="ask-here" title="Use the footage around the playhead as evidence"><input type="checkbox" checked={here} onChange={e => setHere(e.target.checked)} />at {fmtClock(t)}</label>
        <button type="submit" className="btn btn-secondary btn-sm" disabled={asking.isPending || question.trim().length < 3}>{asking.isPending ? 'Asking…' : 'Ask'}</button>
      </form>
      {asking.isPending ? <p className="ask-note" role="status">Reading VSS captions and logged issues…</p>
        : asking.isError ? (
          <p className="ask-note bad" role="alert"><Icon name="alert" />{asking.error instanceof Error ? asking.error.message : 'Could not answer'}
            <button type="button" className="btn btn-ghost btn-sm" onClick={submit}><Icon name="refresh" />Retry</button></p>
        ) : answer ? <Answer a={answer} go={go} /> : null}
    </div>
  );
}

/** The answer with its mm:ss times as seek buttons, who answered, and the VSS captions it rests on. */
function Answer({ a, go }: { a: AskAnswer; go: (s: number) => void }) {
  const parts: (string | { label: string; s: number })[] = []; let last = 0;
  for (const m of a.answer.matchAll(CLOCK)) {
    parts.push(a.answer.slice(last, m.index)); parts.push({ label: m[0], s: Number(m[1]) * 60 + Number(m[2]) }); last = (m.index ?? 0) + m[0].length;
  }
  parts.push(a.answer.slice(last));
  return (
    <div className="ask-answer" role="status" aria-live="polite">
      <p>{parts.map((p, k) => typeof p === 'string' ? <Fragment key={k}>{p}</Fragment>
        : <button key={k} type="button" className="ask-t" onClick={() => go(p.s)} aria-label={`Seek to ${p.label}`}>{p.label}</button>)}</p>
      <div className="ask-by">
        <span className="topic-src">{a.source === 'nemotron' ? 'Nemotron' : 'VSS'}</span>
        <span>{a.source === 'nemotron'
          ? `from ${a.evidence.length} VSS caption${a.evidence.length === 1 ? '' : 's'} and ${a.issue_ids.length} logged issue${a.issue_ids.length === 1 ? '' : 's'}`
          : 'Nemotron unavailable: the nearest VSS caption'}</span>
      </div>
      {a.evidence.length ? (
        <details className="ask-ev">
          <summary>VSS evidence</summary>
          <ul>{a.evidence.map((e, k) => (
            <li key={k}><button type="button" className="ask-t" onClick={() => go(e.start)}>{fmtClock(e.start)}</button>{' '}
              <span className="muted">{e.kind === 'segment' ? 'at the playhead' : 'search hit'}</span> {e.caption}</li>
          ))}</ul>
        </details>
      ) : null}
    </div>
  );
}
