'use client';
// Chat about the open drive, in the Review desk's right pane. Each question goes to POST /api/videos/{id}/ask with
// the earlier turns: VSS supplies captions around the playhead and matching moments on the drive, and Nemotron 3.5
// Lightning (reasoning off, so about a second) answers from them and the logged issues. Times in a reply are chips
// that seek the player and select the issue logged there.
import { Fragment, useEffect, useRef, useState } from 'react';
import { fmtClock, issueLabel, type AskAnswer, type Issue, type Video } from '@raightway/core';
import { useClient } from '@/domain/client';
import { usePlayback } from '@/state/playback';
import { chatId, history, useChat, type ChatMessage } from '@/state/chat';
import { Icon } from '@/ui/Icon';
import { Empty, Failed } from '@/ui/State';

const MODEL = 'Nemotron 3.5 Lightning';
const CLOCK = /\b(\d{1,2}):(\d{2})\b/g;
const NONE: ChatMessage[] = [];

export function ChatPanel({ video, issues }: { video?: Video; issues: Issue[] }) {
  const client = useClient(); const { t } = usePlayback();
  const thread = useChat(s => (video ? s.threads[video.id] : undefined)) ?? NONE;
  const { push, patch, clear } = useChat.getState();
  const [draft, setDraft] = useState(''); const [here, setHere] = useState(true);
  const list = useRef<HTMLDivElement>(null); const box = useRef<HTMLTextAreaElement>(null);
  const busy = thread.some(m => m.pending);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [thread]);

  if (!video) return <Empty title="No drive open">Pick one from Footage to chat about it.</Empty>;
  if (!client.capabilities.ask) return <Empty title="Chat is off">This backend doesn’t answer questions about footage.</Empty>;
  const id = video.id;

  /** Ask `text` as the reply `replyId` (new, or a failed one being retried) with the turns before it as context. */
  const run = (text: string, at: number | null, replyId: string, before: ChatMessage[]) => {
    client.ask(id, { question: text, t: at, history: history(before) })
      .then(answer => patch(id, replyId, { pending: false, error: undefined, answer, text: answer.answer }))
      .catch(e => patch(id, replyId, { pending: false, error: e instanceof Error ? e.message : 'Could not answer' }));
  };
  const send = (raw: string, at: number | null) => {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text.length < 3 || busy) return;
    const before = useChat.getState().threads[id] ?? [];
    const replyId = chatId();
    push(id, { id: chatId(), role: 'user', text, t: at });
    push(id, { id: replyId, role: 'assistant', text: '', pending: true, question: { text, t: at } });
    setDraft(''); run(text, at, replyId, before);
  };
  const retry = (m: ChatMessage) => {
    if (!m.question || busy) return;
    const all = useChat.getState().threads[id] ?? []; const k = all.findIndex(x => x.id === m.id);
    patch(id, m.id, { pending: true, error: undefined });
    run(m.question.text, m.question.t, m.id, all.slice(0, Math.max(0, k - 1)));
  };
  const starters: [string, number | null][] = [
    ['What’s the worst thing on this drive?', null], [`What is happening at ${fmtClock(t)}?`, t],
    [`Any hazards near ${fmtClock(t)}?`, t], ['Summarise this drive', null],
  ];

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-who"><span className="topic-src">{MODEL}</span><span className="muted">on {video.drive ?? video.filename}</span></span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => clear(id)} disabled={!thread.length || busy}>Clear chat</button>
      </div>
      <div className="chat-log" ref={list} role="log" aria-live="polite" aria-label={`Chat about ${video.drive ?? video.filename}`}>
        {!thread.length ? (
          <div className="chat-empty">
            <Empty title="Ask about this drive">Answers come from VSS captions of the footage and the issues logged on it.</Empty>
            <div className="chat-starters" role="group" aria-label="Suggested questions">
              {starters.map(([q, at]) => <button key={q} type="button" className="chat-starter" onClick={() => send(q, at)}>{q}</button>)}
            </div>
          </div>
        ) : thread.map(m => m.role === 'user'
          ? <div key={m.id} className="msg msg-user"><p>{m.text}</p>{m.t != null ? <span className="msg-at">at {fmtClock(m.t)}</span> : null}</div>
          : <Reply key={m.id} m={m} issues={issues} duration={video.duration_s} onRetry={() => retry(m)} />)}
      </div>
      <form className="chat-compose" onSubmit={e => { e.preventDefault(); send(draft, here ? t : null); }}>
        <label className="sr" htmlFor="chat-q">Ask about this drive</label>
        <textarea id="chat-q" ref={box} value={draft} rows={2} maxLength={300} placeholder="Ask about this drive…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft, here ? t : null); }
            else if (e.key === 'Escape') box.current?.blur();
          }} />
        <div className="chat-bar">
          <label className="ask-here" title="Use the footage around the playhead as evidence"><input type="checkbox" checked={here} onChange={e => setHere(e.target.checked)} />at {fmtClock(t)}</label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || draft.trim().length < 3}>{busy ? 'Answering…' : 'Send'}</button>
        </div>
      </form>
    </div>
  );
}

function Reply({ m, issues, duration, onRetry }: { m: ChatMessage; issues: Issue[]; duration: number; onRetry: () => void }) {
  const { seek, select, setPlaying } = usePlayback();
  if (m.pending) return <div className="msg msg-bot msg-typing" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>Reading VSS captions and logged issues…</div>;
  if (m.error) return <div className="msg msg-bot msg-bad"><Failed compact error={new Error(m.error)} onRetry={onRetry} /></div>;
  const a = m.answer!;
  const go = (s: number) => {
    setPlaying(false);
    const near = issues.filter(i => Math.abs(i.t - s) <= 2.5).sort((x, y) => Math.abs(x.t - s) - Math.abs(y.t - s))[0];
    if (near) select(near.id);
    seek(Math.max(0, Math.min(duration, s)));
  };
  return (
    <div className="msg msg-bot">
      <p><Timed text={a.answer} go={go} issues={issues} /></p>
      <Meta a={a} go={go} />
    </div>
  );
}

/** The reply with each mm:ss as a chip; a chip names the issue logged there in its tooltip. */
function Timed({ text, go, issues }: { text: string; go: (s: number) => void; issues: Issue[] }) {
  const out: React.ReactNode[] = []; let last = 0;
  for (const m of text.matchAll(CLOCK)) {
    const s = Number(m[1]) * 60 + Number(m[2]); const at = issues.find(i => Math.abs(i.t - s) <= 2.5);
    out.push(<Fragment key={`t${m.index}`}>{text.slice(last, m.index)}</Fragment>);
    out.push(<button key={`c${m.index}`} type="button" className="tchip" onClick={() => go(s)} title={at ? `Seek and select: ${issueLabel(at)}` : 'Seek the player'}
      aria-label={`Seek to ${m[0]}${at ? `, ${issueLabel(at)}` : ''}`}>{at ? <Icon name={at.category} /> : null}{m[0]}</button>);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

function Meta({ a, go }: { a: AskAnswer; go: (s: number) => void }) {
  return (
    <div className="msg-meta">
      <span className="topic-src">{a.source === 'nemotron' ? (a.model ?? MODEL) : 'VSS caption'}</span>
      <span>{a.source === 'nemotron'
        ? `from ${a.evidence.length} VSS caption${a.evidence.length === 1 ? '' : 's'} · ${a.issue_ids.length} logged issue${a.issue_ids.length === 1 ? '' : 's'}`
        : 'Nemotron unavailable: the nearest VSS caption'}</span>
      {a.evidence.length ? (
        <details className="ask-ev">
          <summary>VSS evidence</summary>
          <ul>{a.evidence.map((e, k) => (
            <li key={k}><button type="button" className="tchip" onClick={() => go(e.start)}>{fmtClock(e.start)}</button>{' '}
              <span className="muted">{e.kind === 'segment' ? 'at the playhead' : 'search hit'}</span> {e.caption}</li>
          ))}</ul>
        </details>
      ) : null}
    </div>
  );
}
