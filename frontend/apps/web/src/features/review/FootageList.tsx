'use client';
import { useMemo, useState } from 'react';
import { CATEGORY, fmtClock, type Issue, type Video } from '@raightway/core';
import { useIssues, useVideos } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories, useUi } from '@/state/ui';
import { CATEGORY_PRESETS } from '@raightway/core';
import { Chip, StatusChip } from '@/ui/marks';
import { Icon } from '@/ui/Icon';
import { StageTrack } from '@/ui/StageTrack';
import { Empty, Failed, Loading } from '@/ui/State';

export function FootageList() {
  const videos = useVideos(); const issues = useIssues(); const cats = useCategories();
  const preset = useUi(s => s.preset); const hidden = useUi(s => s.hidden); const toggle = useUi(s => s.toggleCategory);
  const { videoId, t, open } = usePlayback(); const [q, setQ] = useState('');
  const byVideo = useMemo(() => { const m = new Map<string, Issue[]>(); (issues.data ?? []).forEach(i => { if (cats.includes(i.category)) m.set(i.video_id, [...(m.get(i.video_id) ?? []), i]); }); return m; }, [issues.data, cats]);
  // running jobs first, then uploads (newest first), then the corpus; backends list in any order
  const rank = (v: Video) => (v.status === 'analysing' || v.status === 'queued' ? 0 : v.source === 'upload' ? 1 : 2);
  const ordered = (videos.data ?? []).map((v, i) => ({ v, i })).sort((a, b) => rank(a.v) - rank(b.v) || (rank(a.v) === 1 ? b.i - a.i : a.i - b.i)).map(x => x.v);
  const list = ordered.filter(v => !q || `${v.drive ?? ''} ${v.filename} ${v.explanation ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="filters" role="group" aria-label="Categories">
        {CATEGORY_PRESETS[preset].ids.map(c => <button key={c} type="button" className="fchip" data-cat={c} aria-pressed={!hidden.includes(c)} onClick={() => toggle(c)}><Icon name={c} />{CATEGORY[c].label}</button>)}
      </div>
      <label className="search search-in"><Icon name="search" /><span className="sr">Filter drives</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter drives" /></label>
      {videos.isPending ? <Loading rows={6} /> : videos.isError ? <Failed error={videos.error} onRetry={() => void videos.refetch()} /> : !list.length ? <Empty title={q ? 'No drives match' : 'No footage yet'}>{q ? 'Try another street or set.' : 'Analysed drives appear here.'}</Empty> :
        list.map(v => <VideoRow key={v.id} v={v} issues={byVideo.get(v.id) ?? []} current={v.id === videoId} t={v.id === videoId ? t : 0} onOpen={() => { const first = (byVideo.get(v.id) ?? []).sort((a, b) => a.t - b.t)[0]; open(v.id, first ? Math.max(0, first.t - 0.4) : 0, first?.id ?? null); }} />)}
    </>
  );
}

function VideoRow({ v, issues, current, t, onOpen }: { v: Video; issues: Issue[]; current: boolean; t: number; onOpen: () => void }) {
  const hz = issues.filter(i => i.severity === 5 && !i.duplicate_of).length; const live = v.status === 'analysing' || v.status === 'queued';
  const where = (v.explanation ?? '').replace(/\*\*/g, '').split(/[,.]/)[0] || v.filename;
  return (
    <button type="button" className={`vrow${live ? ' live' : ''}`} aria-current={current} onClick={onOpen}>
      <span className="vrow-top"><span className="vrow-id">{v.drive ?? v.filename}</span>{live || v.status === 'failed' ? <StatusChip status={v.status} /> : hz ? <Chip tone="failed">{hz} hazard{hz > 1 ? 's' : ''}</Chip> : <StatusChip status={v.status} />}</span>
      <span className={`vrow-where${v.status === 'failed' ? ' bad' : ''}`} title={v.status === 'failed' ? v.stage_detail : undefined}>{live ? (v.stage_detail ?? 'Waiting to start') : v.status === 'failed' ? (v.stage_detail ?? 'Analysis failed') : where}</span>
      {live ? <StageTrack stage={v.stage} status={v.status} /> : (
        <span className="strip" aria-hidden="true">
          {v.duration_s > 0 && issues.map(i => <i key={i.id} data-sev={i.severity} style={{ left: `${(i.t / v.duration_s) * 100}%` }} />)}
          {current && v.duration_s > 0 ? <b style={{ left: `${(t / v.duration_s) * 100}%` }} /> : null}
        </span>
      )}
      <span className="vrow-meta"><span className="num">{v.duration_s ? fmtClock(v.duration_s) : '—'}</span><span>{live ? `${Math.round(v.progress * 100)}%${v.eta_s ? ` · ${v.eta_s} s left` : ''}` : `${issues.length} finding${issues.length === 1 ? '' : 's'}`}</span></span>
    </button>
  );
}
