'use client';
// Every issue, grouped by category. Each group is sorted (demo picks first, then severity, then confidence),
// shows how many issues sit at each severity, and filters by severity on its own: the chips in a group's
// header toggle levels for that group only; "Min severity" sets every group at once. The map and the card
// follow the selection. Findings the severity rater judged not to be defects are hidden unless asked for.
import { useMemo, useState } from 'react';
import { CATEGORY, CATEGORIES, SEVERITY, severityDef, type CategoryId, type Issue, type Severity } from '@raightway/core';
import { useIssues } from '@/domain/queries';
import { pickRank } from '@/domain/derive';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { MapView } from '@/features/map/MapView';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { IssueCard } from './IssueCard';
import { useRouter } from 'next/navigation';

type Sort = 'severity' | 'confidence' | 'sightings';
type Show = 'open' | 'rejected' | 'all';
const LEVELS = SEVERITY.map(s => s.level);
const ALL = new Set<Severity>(LEVELS);
const atLeast = (n: number) => new Set<Severity>(LEVELS.filter(l => l >= n));
const sameSet = (a: Set<Severity>, b: Set<Severity>) => a.size === b.size && [...a].every(x => b.has(x));

const SORTS: Record<Sort, (a: Issue, b: Issue) => number> = {
  severity: (a, b) => pickRank(a) - pickRank(b) || b.severity - a.severity || b.confidence - a.confidence,
  confidence: (a, b) => b.confidence - a.confidence || b.severity - a.severity,
  sightings: (a, b) => b.sightings - a.sightings || b.severity - a.severity,
};

interface Group { id: CategoryId; all: Issue[]; shown: Issue[]; counts: number[]; levels: Set<Severity> }

export function IssuesView() {
  const issues = useIssues(); const cats = useCategories(); const router = useRouter();
  const { selectedIssue, select, open } = usePlayback();
  const [sort, setSort] = useState<Sort>('severity'); const [q, setQ] = useState(''); const [show, setShow] = useState<Show>('open');
  // Per-category severity levels shown; a category missing from the map shows every level.
  const [levels, setLevels] = useState<Partial<Record<CategoryId, Set<Severity>>>>({});
  const [closed, setClosed] = useState<Set<CategoryId>>(new Set());
  const rejectedCount = useMemo(() => (issues.data ?? []).filter(i => !i.duplicate_of && i.verdict === 'rejected' && cats.includes(i.category)).length, [issues.data, cats]);

  const groups = useMemo<Group[]>(() => {
    const needle = q.trim().toLowerCase();
    const base = (issues.data ?? []).filter(i => !i.duplicate_of && cats.includes(i.category)
      && (show === 'all' || (show === 'rejected') === (i.verdict === 'rejected'))
      && (!needle || `${i.description} ${i.severity_reason ?? ''} ${i.place ?? ''} ${i.id}`.toLowerCase().includes(needle)));
    return CATEGORIES.filter(c => cats.includes(c.id)).map(c => {
      const all = base.filter(i => i.category === c.id).sort(SORTS[sort]);
      const lv = levels[c.id] ?? ALL; const counts = [0, 0, 0, 0, 0];
      all.forEach(i => { counts[i.severity - 1]!++; });
      return { id: c.id, all, shown: all.filter(i => lv.has(i.severity)), counts, levels: lv };
    }).filter(g => g.all.length);
  }, [issues.data, cats, show, q, sort, levels]);

  const visible = useMemo(() => groups.flatMap(g => (closed.has(g.id) ? [] : g.shown)), [groups, closed]);
  const total = groups.reduce((n, g) => n + g.shown.length, 0);
  const sel = visible.find(i => i.id === selectedIssue) ?? groups.flatMap(g => g.shown).find(i => i.id === selectedIssue) ?? visible[0] ?? null;
  const watch = (i: Issue) => { open(i.video_id, Math.max(0, i.t - 0.4), i.id); router.push('/review'); };

  // "Min severity" reads as pressed only while every group uses that same threshold.
  const minSev = useMemo(() => {
    const sets = CATEGORIES.filter(c => cats.includes(c.id)).map(c => levels[c.id] ?? ALL);
    return LEVELS.find(n => sets.every(s => sameSet(s, atLeast(n)))) ?? -1;
  }, [levels, cats]);
  const setAll = (n: number) => setLevels(Object.fromEntries(CATEGORIES.map(c => [c.id, atLeast(n)])) as Record<CategoryId, Set<Severity>>);
  const toggleLevel = (cat: CategoryId, level: Severity) => setLevels(prev => {
    const next = new Set(prev[cat] ?? ALL);
    if (next.has(level)) next.delete(level); else next.add(level);
    return { ...prev, [cat]: next.size ? next : new Set(ALL) };   // clearing the last level shows everything again
  });
  const onlyLevel = (cat: CategoryId, level: Severity) => setLevels(prev => ({ ...prev, [cat]: new Set([level]) }));
  const toggleGroup = (cat: CategoryId) => setClosed(prev => { const n = new Set(prev); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; });

  return (
    <div className="split">
      <section className="card split-main" aria-label="Issues">
        <div className="toolbar">
          <label className="search search-in"><span className="sr">Search issues</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search description, reason, street, id" /></label>
          <Seg label="Minimum severity in every category" size="sm" value={minSev} onChange={setAll} options={SEVERITY.map(s => ({ value: s.level as number, label: s.level === 1 ? 'All' : `S${s.level}+` }))} />
          <Seg label="Sort within each category" size="sm" value={sort} onChange={setSort} options={[{ value: 'severity', label: 'Severity' }, { value: 'confidence', label: 'Confidence' }, { value: 'sightings', label: 'Seen' }]} />
          {rejectedCount || show !== 'open' ? <Seg label="Which findings" size="sm" value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'rejected', label: `Not defects ${rejectedCount}` }, { value: 'all', label: 'All' }]} /> : null}
          <span className="label num">{total} {show === 'rejected' ? 'flagged' : 'open'}</span>
        </div>
        <div className="scroll">
          {issues.isPending ? <Loading rows={8} /> : issues.isError ? <Failed error={issues.error} onRetry={() => void issues.refetch()} /> : !groups.length ? <Empty title="No issues match">{show === 'rejected' ? 'Nothing was judged a false positive.' : 'Loosen the filters or switch the category preset.'}</Empty> : (
            <table className="moments issues-tbl grouped">
              <thead><tr><th>Sev</th><th className="d">Finding and why it got that grade</th><th className="seen-c">Seen</th><th className="seen-c">Conf.</th></tr></thead>
              {groups.map(g => {
                const isClosed = closed.has(g.id); const filtered = g.shown.length !== g.all.length;
                return (
                  <tbody key={g.id} data-cat={g.id}>
                    <tr className="grp"><th colSpan={4} scope="rowgroup">
                      <div className="grp-h">
                        <button type="button" className="grp-t" aria-expanded={!isClosed} onClick={() => toggleGroup(g.id)} title={isClosed ? 'Show this category' : 'Hide this category'}>
                          <CategoryLabel id={g.id} /><span className="num muted">{filtered ? `${g.shown.length} of ${g.all.length}` : g.all.length}</span>
                        </button>
                        <span className="sev-chips" role="group" aria-label={`${CATEGORY[g.id].label}: severity levels shown`}>
                          {LEVELS.map(l => (
                            <button key={l} type="button" className="sev-chip" aria-pressed={g.levels.has(l)} disabled={!g.counts[l - 1] && !g.levels.has(l)}
                              onClick={e => (e.altKey ? onlyLevel(g.id, l) : toggleLevel(g.id, l))}
                              title={`${severityDef(l).label}: ${g.counts[l - 1]} in ${CATEGORY[g.id].label}. Click to show or hide; Alt-click to show only this level.`}>
                              <span className="sev-dot" data-sev={l} aria-hidden="true">{l}</span><span className="num">{g.counts[l - 1]}</span>
                            </button>
                          ))}
                        </span>
                      </div>
                    </th></tr>
                    {isClosed ? null : !g.shown.length ? (
                      <tr className="grp-empty"><td colSpan={4} className="muted">No {CATEGORY[g.id].label.toLowerCase()} issues at the selected levels.</td></tr>
                    ) : g.shown.map(i => (
                      <tr key={i.id} aria-selected={i.id === sel?.id} tabIndex={0} onClick={() => select(i.id)} onKeyDown={e => { if (e.key === 'Enter') select(i.id); }} className={[i.provisional ? 'prov' : '', i.verdict === 'rejected' ? 'rejected' : ''].join(' ').trim() || undefined}>
                        <td><SevDot level={i.severity} /></td>
                        <td className="d" title={[i.description, i.severity_reason, i.place].filter(Boolean).join(' · ')}>
                          <span className="two"><b>{i.featured ? <span className="pick" title="Demo pick">#{i.featured}</span> : null}{i.description}</b>
                            <span className="muted">{i.verdict === 'rejected' ? <Chip tone="neutral" plain>Not a defect</Chip> : null}{i.severity_reason ?? i.place ?? i.id}</span></span>
                        </td>
                        <td className="num seen-c">{i.sightings}×</td><td className="num seen-c">{Math.round(i.confidence * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                );
              })}
            </table>
          )}
        </div>
      </section>
      <aside className="card split-side" aria-label="Selected issue">
        <MapView label="Map of open issues" issues={visible} selectedId={sel?.id} onSelect={i => select(i.id)} focus={sel && sel.lat != null ? [[sel.lat, sel.lon!]] : undefined} minSpan={1800} className="map-tall" />
        <IssueCard issue={sel} frame />
        {sel ? <div className="pad-s actions"><button type="button" className="btn btn-secondary btn-sm" onClick={() => watch(sel)}>Watch in Review</button>{sel.severity === 5 && sel.verdict !== 'rejected' ? <Chip tone="failed">{CATEGORY[sel.category].crewLabel} today</Chip> : null}</div> : null}
      </aside>
    </div>
  );
}
