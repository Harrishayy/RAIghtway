'use client';
// Dispatch: choose crews per type (seeded from the report's baseline), solve, then read the plan as a
// schedule and as routes on the map. Unassigned jobs are listed with the reason.
import { useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY, CATEGORY_FOR_CREW, SHIFT_MINUTES, enrichPlan, fmtHours, fmtShift, summarizeIssues, type CrewCounts, type CrewType } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useDispatch, useIssues, useReport } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { MapView } from '@/features/map/MapView';
import { IssueCard } from '@/features/issues/IssueCard';
import { Dash } from '@/ui/Dash';
import { Icon } from '@/ui/Icon';
import { CategoryLabel, Chip } from '@/ui/marks';
import { Empty, Failed, Loading } from '@/ui/State';

export function DispatchView() {
  const client = useClient(); const issues = useIssues(); const report = useReport(); const cats = useCategories(); const solve = useDispatch();
  const { selectedIssue, select } = usePlayback();
  const sum = useMemo(() => summarizeIssues(issues.data ?? [], cats), [issues.data, cats]);
  const types = CATEGORIES.filter(c => cats.includes(c.id) && sum.jobs[c.crew]).map(c => c.crew);
  // the operator's changes sit on top of the report's recommendation (else the computed baseline)
  const [overrides, setOverrides] = useState<CrewCounts>({});
  const crews: CrewCounts = Object.fromEntries(types.map(t => [t, overrides[t] ?? report.data?.report.crews[t] ?? sum.baselineCrews[t] ?? 1]));
  const plan = useMemo(() => (solve.data && issues.data ? enrichPlan(solve.data, issues.data, client.depot()) : null), [solve.data, issues.data, client]);
  const total = Object.values(crews).reduce((a, b) => a + (b ?? 0), 0);
  const byId = useMemo(() => new Map((issues.data ?? []).map(i => [i.id, i])), [issues.data]);
  const set = (t: CrewType, d: number) => setOverrides(o => ({ ...o, [t]: Math.max(0, Math.min(12, (crews[t] ?? 0) + d)) }));

  if (!client.capabilities.dispatch) return <Empty title="Dispatch is off for this backend">Set capabilities.dispatch to enable it.</Empty>;
  return (
    <div className="split">
      <section className="card split-main" aria-label="Crews and schedule">
        <div className="toolbar">
          <h2>Crews for tomorrow</h2><span className="label num">{total} crews</span>
          <button type="button" className="btn btn-primary btn-sm push" onClick={() => solve.mutate(crews)} disabled={solve.isPending || !total}><Icon name="route" />{solve.isPending ? 'Routing…' : plan ? 'Re-plan' : 'Plan routes'}</button>
        </div>
        <div className="scroll pad-s">
          {issues.isPending ? <Loading rows={6} /> : issues.isError ? <Failed error={issues.error} onRetry={() => void issues.refetch()} /> : !types.length ? <Empty title="Nothing to dispatch" dash="done">No open jobs in these categories.</Empty> : (
            <div className="crew-list">{types.map(t => { const c = CATEGORY_FOR_CREW[t]; const base = sum.baselineCrews[t] ?? 0; const n = crews[t] ?? 0; return (
              <div key={t} className="crewrow" data-cat={c}>
                <span className="g"><Icon name={c} /></span>
                <div className="crewrow-b"><b>{CATEGORY[c].crewLabel}</b><span className="muted num">{sum.jobs[t]} jobs · {fmtHours(sum.workload[t] ?? 0)} h · baseline {base}</span></div>
                <span className="stepper"><button type="button" aria-label={`Fewer ${CATEGORY[c].crewLabel} crews`} onClick={() => set(t, -1)}><Icon name="minus" /></button><b className={n < base ? 'under' : undefined} aria-live="polite">{n}</b><button type="button" aria-label={`More ${CATEGORY[c].crewLabel} crews`} onClick={() => set(t, 1)}><Icon name="plus" /></button></span>
              </div>); })}</div>
          )}
          {solve.isPending ? <div className="solving"><Dash state="route" size={44} /><span>Routing {total} crews…</span></div> : solve.isError ? <Failed compact error={solve.error} onRetry={() => solve.mutate(crews)} /> : plan ? (
            <>
              <div className="comp-h mt"><h3>Schedule</h3><span className="label">{plan.solver === 'cuopt' ? 'cuOpt' : 'Fallback solver'} · {(plan.solve_ms / 1000).toFixed(1)} s · {plan.jobs_routed} jobs</span></div>
              <div className="gantt">{plan.routes.filter(r => r.stops.length).map(r => (
                <div key={r.crew_id} className="grow" data-cat={r.category}><b>{r.crew_id}</b>
                  <span className="glane">{r.legs.filter(l => l.type === 'job').map(l => <button key={`${l.issue}`} type="button" data-sev={l.severity} className={l.issue === selectedIssue ? 'on' : undefined} style={{ left: `${(l.start / SHIFT_MINUTES) * 100}%`, width: `${Math.max(0.8, ((l.end - l.start) / SHIFT_MINUTES) * 100)}%` }} title={`${fmtShift(l.start)} · ${byId.get(l.issue!)?.description ?? l.issue}`} aria-label={`${r.crew_id} at ${fmtShift(l.start)}: ${byId.get(l.issue!)?.description ?? l.issue}`} onClick={() => select(l.issue!)} />)}</span>
                </div>))}
                <div className="gaxis">{[0, 120, 240, 360, 480].map(m => <span key={m}>{fmtShift(m)}</span>)}</div>
              </div>
              {plan.unassigned.length ? (<><div className="comp-h mt"><h3>Not routed</h3><Chip tone="hold">{plan.unassigned.length}</Chip></div>
                <ul className="unassigned">{plan.unassigned.slice(0, 30).map(id => { const i = byId.get(id); return <li key={id}><button type="button" onClick={() => select(id)}>{i ? <CategoryLabel id={i.category} compact /> : null}<span>{i?.description ?? id}</span><span className="muted">{plan.reasons[id]}</span></button></li>; })}</ul></>) : null}
            </>
          ) : <p className="muted mt">Set the crews, then plan. Hazards are routed first.</p>}
        </div>
      </section>
      <aside className="card split-side" aria-label="Routes">
        <MapView label="Crew routes" issues={(issues.data ?? []).filter(i => !i.duplicate_of && cats.includes(i.category))} emphasise={i => !plan || plan.routes.some(r => r.stops.includes(i.id))}
          selectedId={selectedIssue} onSelect={i => select(i.id)} routes={plan?.routes.filter(r => r.stops.length).map(r => ({ id: r.crew_id, category: r.category, path: r.path }))} depot={client.depot()} className="map-tall" />
        <IssueCard issue={selectedIssue ? byId.get(selectedIssue) : null} />
      </aside>
    </div>
  );
}
