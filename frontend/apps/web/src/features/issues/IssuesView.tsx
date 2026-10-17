'use client';
// Every open issue: filter, sort, select. The map and the card follow the selection.
import { useMemo, useState } from 'react';
import { CATEGORY, SEVERITY, type Issue, type Severity } from '@raightway/core';
import { useIssues } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { MapView } from '@/features/map/MapView';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { IssueCard } from './IssueCard';
import { useRouter } from 'next/navigation';

type Sort = 'severity' | 'confidence' | 'sightings';
export function IssuesView() {
  const issues = useIssues(); const cats = useCategories(); const router = useRouter();
  const { selectedIssue, select, open } = usePlayback();
  const [minSev, setMinSev] = useState<Severity>(1); const [sort, setSort] = useState<Sort>('severity'); const [q, setQ] = useState('');
  const list = useMemo(() => (issues.data ?? [])
    .filter(i => !i.duplicate_of && cats.includes(i.category) && i.severity >= minSev && (!q || `${i.description} ${i.place ?? ''} ${i.id}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (sort === 'severity' ? b.severity - a.severity || b.confidence - a.confidence : sort === 'confidence' ? b.confidence - a.confidence : b.sightings - a.sightings)), [issues.data, cats, minSev, sort, q]);
  const sel = list.find(i => i.id === selectedIssue) ?? list[0] ?? null;
  const watch = (i: Issue) => { open(i.video_id, Math.max(0, i.t - 0.4), i.id); router.push('/review'); };

  return (
    <div className="split">
      <section className="card split-main" aria-label="Issues">
        <div className="toolbar">
          <label className="search search-in"><span className="sr">Search issues</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search description, street, id" /></label>
          <Seg label="Minimum severity" size="sm" value={minSev} onChange={setMinSev} options={SEVERITY.map(s => ({ value: s.level, label: `S${s.level}+` }))} />
          <Seg label="Sort" size="sm" value={sort} onChange={setSort} options={[{ value: 'severity', label: 'Severity' }, { value: 'confidence', label: 'Confidence' }, { value: 'sightings', label: 'Seen' }]} />
          <span className="label num">{list.length} open</span>
        </div>
        <div className="scroll">
          {issues.isPending ? <Loading rows={8} /> : issues.isError ? <Failed error={issues.error} onRetry={() => void issues.refetch()} /> : !list.length ? <Empty title="No issues match">Loosen the filters or switch the category preset.</Empty> : (
            <table className="moments issues-tbl">
              <thead><tr><th>Sev</th><th>Finding</th><th className="d">What and where</th><th className="seen-c">Seen</th><th className="seen-c">Conf.</th></tr></thead>
              <tbody>{list.map(i => (
                <tr key={i.id} aria-selected={i.id === sel?.id} tabIndex={0} onClick={() => select(i.id)} onKeyDown={e => { if (e.key === 'Enter') select(i.id); }} className={i.provisional ? 'prov' : undefined}>
                  <td><SevDot level={i.severity} /></td><td><CategoryLabel id={i.category} compact /></td>
                  <td className="d" title={`${i.description} · ${i.place ?? ''}`}><span className="two"><b>{i.description}</b><span className="muted">{i.place ?? i.id}</span></span></td>
                  <td className="num seen-c">{i.sightings}×</td><td className="num seen-c">{Math.round(i.confidence * 100)}%</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      </section>
      <aside className="card split-side" aria-label="Selected issue">
        <MapView label="Map of open issues" issues={list} selectedId={sel?.id} onSelect={i => select(i.id)} focus={sel && sel.lat != null ? [[sel.lat, sel.lon!]] : undefined} minSpan={1800} className="map-tall" />
        <IssueCard issue={sel} />
        {sel ? <div className="pad-s actions"><button type="button" className="btn btn-secondary btn-sm" onClick={() => watch(sel)}>Watch in Review</button>{sel.severity === 5 ? <Chip tone="failed">{CATEGORY[sel.category].crewLabel} today</Chip> : null}</div> : null}
      </aside>
    </div>
  );
}
