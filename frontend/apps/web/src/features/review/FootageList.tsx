'use client';
import { useMemo, useState } from 'react';
import { CATEGORY, fmtClock, type Issue, type TopicHit, type Video } from '@raightway/core';
import { landingIssue } from '@/domain/derive';
import { useClient } from '@/domain/client';
import { useIssues, useVideos } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories, useUi } from '@/state/ui';
import { CATEGORY_PRESETS } from '@raightway/core';
import { Chip, StatusChip } from '@/ui/marks';
import { Icon } from '@/ui/Icon';
import { StageTrack } from '@/ui/StageTrack';
import { Empty, Failed, Loading } from '@/ui/State';
import { FootageSearch, loggedIn, useFootageSearch } from './FootageSearch';

const isLive = (v: Video) => v.status === 'analysing' || v.status === 'queued';

/** One row per piece of footage: repeat uploads of the same file collapse into their newest run. */
interface Row { v: Video; runs: Video[]; issues: Issue[] }

export function FootageList() {
  const videos = useVideos(); const issues = useIssues(); const cats = useCategories();
  const preset = useUi(s => s.preset); const hidden = useUi(s => s.hidden); const toggle = useUi(s => s.toggleCategory);
  const { videoId, t, open } = usePlayback(); const [q, setQ] = useState('');
  const client = useClient(); const { topic, hits } = useFootageSearch();
  // VSS hits per drive, best first (the backend sends them ranked)
  const found = useMemo(() => { const m = new Map<string, TopicHit[]>(); (hits ?? []).forEach(h => m.set(h.video_id, [...(m.get(h.video_id) ?? []), h])); return m; }, [hits]);
  const byVideo = useMemo(() => { const m = new Map<string, Issue[]>(); (issues.data ?? []).forEach(i => { if (cats.includes(i.category) && i.verdict !== 'rejected') m.set(i.video_id, [...(m.get(i.video_id) ?? []), i]); }); return m; }, [issues.data, cats]);
  const rows = useMemo(() => {
    // backends list in creation order, so a later index is a newer run
    const groups = new Map<string, Video[]>();
    (videos.data ?? []).forEach(v => { const k = v.source === 'upload' ? `upload:${v.filename}` : v.id; groups.set(k, [...(groups.get(k) ?? []), v]); });
    const out: (Row & { i: number })[] = [];
    [...groups.values()].forEach(runs => {
      const newest = [...runs].reverse(); const v = newest.find(isLive) ?? newest.find(r => r.status === 'done') ?? newest[0]!;
      const own = byVideo.get(v.id) ?? [];
      out.push({ v, runs, issues: own, i: (videos.data ?? []).indexOf(runs[runs.length - 1]!) });
    });
    // running jobs first, then uploads and runs (newest first), then the corpus
    const rank = (r: Row) => (isLive(r.v) ? 0 : r.v.source === 'upload' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? b.i - a.i : a.i - b.i));
  }, [videos.data, byVideo]);
  // while a search has answered, only drives with matches, the best match first
  const searched = hits ? rows.filter(r => found.has(r.v.id)).sort((a, b) => hits.indexOf(found.get(a.v.id)![0]!) - hits.indexOf(found.get(b.v.id)![0]!)) : rows;
  const list = searched.filter(r => !q || `${r.v.drive ?? ''} ${r.v.filename} ${r.v.explanation ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="filters" role="group" aria-label="Categories">
        {CATEGORY_PRESETS[preset].ids.map(c => <button key={c} type="button" className="fchip" data-cat={c} aria-pressed={!hidden.includes(c)} onClick={() => toggle(c)}><Icon name={c} />{CATEGORY[c].label}</button>)}
      </div>
      {client.capabilities.topicSearch ? <FootageSearch /> : null}
      <label className="search search-in"><Icon name="search" /><span className="sr">Filter drives</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter drives" /></label>
      {videos.isPending ? <Loading rows={6} /> : videos.isError ? <Failed error={videos.error} onRetry={() => void videos.refetch()} /> : !list.length ? (hits && !q
        ? <Empty title="No matches in the footage">VSS found nothing for “{topic}” on these drives. Try other words.</Empty>
        : <Empty title={q ? 'No drives match' : 'No footage yet'}>{q ? 'Try another street or set.' : 'Analysed drives appear here.'}</Empty>) :
        list.map(r => { const current = r.runs.some(x => x.id === videoId); const own = found.get(r.v.id); return (
          <VideoRow key={r.v.id} row={r} hits={own} current={current} t={r.v.id === videoId ? t : 0}
            onOpen={() => { if (own?.[0]) { open(r.v.id, own[0].start, loggedIn(own[0], r.issues)[0]?.id ?? null); return; } const first = landingIssue(r.issues); open(r.v.id, first ? Math.max(0, first.t - 0.4) : 0, first?.id ?? null); }} />
        ); })}
    </>
  );
}

/** The row's one-line headline: the drive summary's first sentence, else the file name.
 *  `template` marks a summary Nemotron didn't write (the backend's fact-built stand-in). */
function headline(v: Video): { text: string; template: boolean } {
  const text = (v.explanation ?? '').replace(/\*\*/g, '').trim();
  // the old template ("This video contains N recorded maintenance findings: …") says less than the counts below
  if (!text || /^this video contains/i.test(text)) return { text: v.filename, template: false };
  return { text: text.split(/(?<=[.!?])\s/)[0] ?? text, template: v.explanation_source === 'template' };
}

function VideoRow({ row: { v, runs, issues }, hits, current, t, onOpen }: { row: Row; hits?: TopicHit[]; current: boolean; t: number; onOpen: () => void }) {
  const hz = issues.filter(i => i.severity === 5 && !i.duplicate_of).length; const live = isLive(v);
  // during a search the row says what VSS saw at its best match
  const head = headline(v); const where = hits?.[0] ? `${fmtClock(hits[0].start)} · ${hits[0].caption}` : head.text;
  const logged = hits ? hits.filter(h => loggedIn(h, issues).length).length : 0;
  return (
    <button type="button" className={`vrow${live ? ' live' : ''}`} aria-current={current} onClick={onOpen}>
      <span className="vrow-top"><span className="vrow-id">{v.drive ?? v.filename}</span>{live || v.status === 'failed' ? <StatusChip status={v.status} /> : hz ? <Chip tone="failed">{hz} hazard{hz > 1 ? 's' : ''}</Chip> : <StatusChip status={v.status} />}</span>
      <span className={`vrow-where${v.status === 'failed' ? ' bad' : ''}`} title={v.status === 'failed' ? v.stage_detail : !hits && head.template ? `${where} (template summary: Nemotron didn't write this one)` : where}>{live ? (v.stage_detail ?? 'Waiting to start') : v.status === 'failed' ? (v.stage_detail ?? 'Analysis failed') : where}{!live && !hits && head.template ? <span className="vrow-tpl">template</span> : null}</span>
      {live ? <StageTrack stage={v.stage} status={v.status} /> : (
        <span className="strip" aria-hidden="true">
          {v.duration_s > 0 && hits?.map((h, k) => <u key={k} style={{ left: `${(h.start / v.duration_s) * 100}%`, width: `${((h.end - h.start) / v.duration_s) * 100}%` }} />)}
          {v.duration_s > 0 && issues.map(i => <i key={i.id} data-sev={i.severity} style={{ left: `${(i.t / v.duration_s) * 100}%` }} />)}
          {current && v.duration_s > 0 ? <b style={{ left: `${(t / v.duration_s) * 100}%` }} /> : null}
        </span>
      )}
      <span className="vrow-meta"><span className="num">{v.duration_s ? fmtClock(v.duration_s) : '—'}{runs.length > 1 ? ` · ${runs.length} runs` : ''}{v.run_kind === 'recheck' ? ' · re-check' : v.run_kind === 'new' ? ' · new footage' : ''}</span><span>{live ? `${Math.round(v.progress * 100)}%${v.eta_s ? ` · ${v.eta_s} s left` : ''}` : hits ? `${hits.length} match${hits.length === 1 ? '' : 'es'} · ${logged} logged` : `${issues.length} finding${issues.length === 1 ? '' : 's'}`}</span></span>
    </button>
  );
}
