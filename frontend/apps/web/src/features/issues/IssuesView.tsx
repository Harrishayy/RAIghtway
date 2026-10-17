'use client';
// Every issue, grouped by category. Filters, all visible at once: issue-type chips with counts (they follow the
// top-bar preset until used), the rating verdict (confirmed by default; rejected = judged not a defect), search,
// and severity per group: the chips in a group's header toggle levels for that group only, "Min severity" sets
// every group at once. Each group sorts by severity, then confidence. The map and the card
// follow the selection.
import { useMemo, useState } from 'react';
import { CATEGORY, CATEGORIES, SEVERITY, issueLabel, severityDef, type CategoryId, type Issue, type Severity } from '@raightway/core';
import { useIssues } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { MapView } from '@/features/map/MapView';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';
import { Icon } from '@/ui/Icon';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { IssueCard } from './IssueCard';
import { useRouter } from 'next/navigation';

type Sort = 'severity' | 'confidence' | 'sightings';
type Show = 'confirmed' | 'rejected' | 'all';
const LEVELS = SEVERITY.map(s => s.level);
const ALL = new Set<Severity>(LEVELS);
const atLeast = (n: number) => new Set<Severity>(LEVELS.filter(l => l >= n));
const sameSet = (a: Set<Severity>, b: Set<Severity>) => a.size === b.size && [...a].every(x => b.has(x));

const SORTS: Record<Sort, (a: Issue, b: Issue) => number> = {
  severity: (a, b) => b.severity - a.severity || b.confidence - a.confidence,
  confidence: (a, b) => b.confidence - a.confidence || b.severity - a.severity,
  sightings: (a, b) => b.sightings - a.sightings || b.severity - a.severity,
};

interface Group { id: CategoryId; all: Issue[]; shown: Issue[]; counts: number[]; levels: Set<Severity> }

export function IssuesView() {
  const issues = useIssues(); const cats = useCategories(); const router = useRouter();
  const { selectedIssue, select, open } = usePlayback();
  const [sort, setSort] = useState<Sort>('severity'); const [q, setQ] = useState(''); const [show, setShow] = useState<Show>('confirmed');
  const [pinnedOnly, setPinnedOnly] = useState(false);   // only issues pinned into the next plan
  // Categories shown on this page: follows the top-bar preset until the chips here are used.
  const [picked, setPicked] = useState<Set<CategoryId> | null>(null);
  const shownCats = useMemo(() => (picked ? CATEGORIES.map(c => c.id).filter(id => picked.has(id)) : cats), [picked, cats]);
  // Per-category severity levels shown; a category missing from the map shows every level.
  const [levels, setLevels] = useState<Partial<Record<CategoryId, Set<Severity>>>>({});
  const [closed, setClosed] = useState<Set<CategoryId>>(new Set());

  // Canonical issues that pass the verdict filter and the search, before category and severity filters.
  const { pool, verdicts } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const found = (issues.data ?? []).filter(i => !i.duplicate_of && (!pinnedOnly || i.pinned)
      && (!needle || `${i.name ?? ''} ${i.description} ${i.severity_reason ?? ''} ${i.place ?? ''} ${i.id}`.toLowerCase().includes(needle)));
    const verdicts = { confirmed: found.filter(i => i.verdict !== 'rejected').length, rejected: found.filter(i => i.verdict === 'rejected').length, all: found.length };
    return { pool: found.filter(i => show === 'all' || (show === 'rejected') === (i.verdict === 'rejected')), verdicts };
  }, [issues.data, q, show, pinnedOnly]);
  const pinnedN = useMemo(() => (issues.data ?? []).filter(i => !i.duplicate_of && i.pinned).length, [issues.data]);
  const perCat = useMemo(() => { const m = new Map<CategoryId, number>(); pool.forEach(i => m.set(i.category, (m.get(i.category) ?? 0) + 1)); return m; }, [pool]);

  const groups = useMemo<Group[]>(() => CATEGORIES.filter(c => shownCats.includes(c.id)).map(c => {
    const all = pool.filter(i => i.category === c.id).sort(SORTS[sort]);
    const lv = levels[c.id] ?? ALL; const counts = [0, 0, 0, 0, 0];
    all.forEach(i => { counts[i.severity - 1]!++; });
    return { id: c.id, all, shown: all.filter(i => lv.has(i.severity)), counts, levels: lv };
  }).filter(g => g.all.length), [pool, shownCats, sort, levels]);
  const toggleCat = (id: CategoryId) => setPicked(prev => {
    const next = new Set(prev ?? shownCats);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next.size ? next : new Set(CATEGORIES.map(c => c.id));   // none selected reads as all
  });

  const visible = useMemo(() => groups.flatMap(g => (closed.has(g.id) ? [] : g.shown)), [groups, closed]);
  const total = groups.reduce((n, g) => n + g.shown.length, 0);
  const sel = visible.find(i => i.id === selectedIssue) ?? groups.flatMap(g => g.shown).find(i => i.id === selectedIssue) ?? visible[0] ?? null;
  const watch = (i: Issue) => { open(i.video_id, Math.max(0, i.t - 0.4), i.id); router.push('/review'); };

  // "Min severity" reads as pressed only while every group uses that same threshold.
  const minSev = useMemo(() => {
    const sets = shownCats.map(c => levels[c] ?? ALL);
    return LEVELS.find(n => sets.every(s => sameSet(s, atLeast(n)))) ?? -1;
  }, [levels, shownCats]);
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
        <div className="toolbar issues-bar">
          <label className="search search-in"><span className="sr">Search issues</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, description, reason, street, id" /></label>
          <button type="button" className="cat-chip pin-filter" aria-pressed={pinnedOnly} onClick={() => setPinnedOnly(p => !p)} title="Show only issues pinned into the next plan">
            <Icon name="pin" /><span>Pinned</span><span className="num">{pinnedN}</span>
          </button>
          <Seg label="Verdict from the severity rating" size="sm" value={show} onChange={setShow} options={[{ value: 'confirmed', label: `Confirmed ${verdicts.confirmed}` }, { value: 'rejected', label: `Rejected ${verdicts.rejected}` }, { value: 'all', label: `All ${verdicts.all}` }]} />
          <div className="cat-chips" role="group" aria-label="Issue types shown">
            {CATEGORIES.map(c => (
              <button key={c.id} type="button" className="cat-chip" data-cat={c.id} aria-pressed={shownCats.includes(c.id)} onClick={() => toggleCat(c.id)} title={`${c.label}: ${perCat.get(c.id) ?? 0}`}>
                <CategoryLabel id={c.id} compact /><span className="num">{perCat.get(c.id) ?? 0}</span>
              </button>
            ))}
            {picked ? <button type="button" className="link small" onClick={() => setPicked(null)}>Follow top bar</button> : null}
          </div>
          <Seg label="Minimum severity in every category" size="sm" value={minSev} onChange={setAll} options={SEVERITY.map(s => ({ value: s.level as number, label: s.level === 1 ? 'All' : `S${s.level}+` }))} />
          <Seg label="Sort within each category" size="sm" value={sort} onChange={setSort} options={[{ value: 'severity', label: 'Severity' }, { value: 'confidence', label: 'Confidence' }, { value: 'sightings', label: 'Seen' }]} />
          <span className="label num shown-n" aria-live="polite">{total} of {pool.length} shown</span>
        </div>
        <div className="scroll">
          {issues.isPending ? <Loading rows={8} /> : issues.isError ? <Failed error={issues.error} onRetry={() => void issues.refetch()} /> : !groups.length ? <Empty title="No issues match">{pinnedOnly && !pinnedN ? 'Nothing is pinned yet. Use "Include in plan" on an issue, or mark one on footage in Review.' : show === 'rejected' && !verdicts.rejected ? 'Nothing was judged a false positive.' : 'Loosen the filters or pick more issue types.'}</Empty> : (
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
                        <td className="d" title={[i.name, i.description, i.severity_reason, i.place].filter(Boolean).join(' · ')}>
                          <span className="two"><b>{issueLabel(i)}</b>
                            <span className="muted">{i.source === 'manual' ? <Chip tone="neutral" plain>Manual</Chip> : null}{i.pinned ? <Chip tone="info" plain>Pinned</Chip> : null}{i.verdict === 'rejected' ? <Chip tone="neutral" plain>Not a defect</Chip> : null}{i.severity_reason ?? i.place ?? i.id}</span></span>
                        </td>
                        <td className="num seen-c">{i.sightings}×</td><td className="num seen-c" title={i.source === 'manual' ? 'Operator-reported: no model confidence' : undefined}>{i.source === 'manual' ? '—' : `${Math.round(i.confidence * 100)}%`}</td>
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
