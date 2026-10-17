'use client';
// "Nemotron + cuOpt recommends": Nemotron proposes workforce scenarios, cuOpt routes every one over street
// times, Nemotron picks from the scored table and code checks the pick. The card shows the live stage and
// a timer while it runs (tens of seconds), then the comparison, the pick and its reasons. It names who
// answered: the rules when no model did, and the fallback router when cuOpt did not.
import { useEffect, useState } from 'react';
import type { Recommendation, Scenario } from '@raightway/core';
import { useRecommendProgress } from '@/domain/queries';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/marks';
import { RichText } from '@/ui/RichText';

const cov = (a: number, b: number) => (b ? `${a}/${b}` : '–');

export function RecommendCard({ rec, running, onRun, onApply, onApplyPlan, planning }: {
  rec: Recommendation | null | undefined; running: boolean; planning: boolean;
  onRun: () => void; onApply: (s: Scenario) => void; onApplyPlan: (s: Scenario) => void;
}) {
  const progress = useRecommendProgress(running);
  // a local timer, so the seconds tick even between progress polls
  const [tick, setTick] = useState({ t0: 0, now: 0 });
  useEffect(() => { if (!running) return; const t0 = Date.now(); const id = setInterval(() => setTick({ t0, now: Date.now() }), 250); return () => clearInterval(id); }, [running]);
  const elapsed = progress.data?.elapsed_s ?? (tick.t0 ? (tick.now - tick.t0) / 1000 : 0);
  const p = progress.data;
  const stage = p?.stage && p.stage !== 'done' ? p.stage : 'Starting';
  const pick = rec?.scenarios.find(s => s.id === rec.recommended);
  const anyFallback = rec?.scenarios.some(s => s.metrics?.solver === 'fallback');
  const agent = rec ? (rec.agent_model === 'rules' ? 'Rules' : rec.agent_model_name ?? rec.agent_model) : null;

  return (
    <section className="rec-card" aria-label="Workforce recommendation" aria-busy={running}>
      <div className="comp-h">
        <h3 className="rec-title"><Icon name="spark" />{rec && !running ? `${agent} + ${anyFallback ? 'fallback router' : 'cuOpt'} recommends` : 'Nemotron + cuOpt recommend'}</h3>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRun} disabled={running}>{running ? 'Working…' : rec ? 'Ask again' : 'Recommend'}</button>
      </div>
      {running ? (
        <div className="rec-progress" role="status" aria-live="polite">
          <span className="rec-spinner" aria-hidden="true" />
          <span>{stage}{p?.scenarios_total ? ` · ${p.scenarios_done ?? 0}/${p.scenarios_total} solved` : ''}</span>
          <span className="num muted">{elapsed.toFixed(0)} s</span>
          {p?.scenarios_total ? <span className="rec-bar" aria-hidden="true"><i style={{ width: `${((p.scenarios_done ?? 0) / p.scenarios_total) * 100}%` }} /></span> : null}
        </div>
      ) : !rec ? (
        <p className="small muted">Nemotron proposes a few workforce scenarios (trucks per site, severity floor), cuOpt routes each on street times, and the scored table decides.</p>
      ) : (
        <>
          <p className="label">{rec.proposer === 'nemotron' ? 'Nemotron proposed' : 'Rules proposed'} · {anyFallback ? 'fallback router evaluated' : 'cuOpt solved'} · {rec.picker === 'nemotron' ? 'Nemotron picked' : 'code rule picked'} · {rec.matrix_source === 'road' ? 'street times' : 'straight-line times'} · {rec.timings.total ?? 0} s</p>
          <div className="rec-table-wrap">
            <table className="rec-table">
              <thead><tr><th scope="col">Scenario</th><th scope="col" title="Severity 5 covered">S5</th><th scope="col" title="Severity 4 covered">S4</th><th scope="col" title="Jobs routed">Jobs</th><th scope="col" title="Drive hours">Drive</th><th scope="col" title="Kilometres (estimate)">km</th></tr></thead>
              <tbody>
                {rec.scenarios.map(s => { const m = s.metrics; return (
                  <tr key={s.id} className={s.id === rec.recommended ? 'pick' : undefined}>
                    <th scope="row"><span className="rec-name" title={`${s.intent}${s.clamped.length ? `\nAdjusted: ${s.clamped.join('; ')}` : ''}`}>{s.id === rec.recommended ? <Icon name="check" /> : null}{s.label}</span>
                      <span className="muted small">S{s.min_severity}+ · {Object.values(s.trucks).reduce((a, b) => a + (b ?? 0), 0)} trucks{m?.pinned_total ? ` · pinned ${cov(m.pinned_covered, m.pinned_total)}` : ''}</span></th>
                    {m ? (<><td className="num">{cov(m.s5_covered, m.s5_total)}</td><td className="num">{cov(m.s4_covered, m.s4_total)}</td><td className="num">{m.jobs_routed}</td><td className="num">{m.drive_hours} h</td><td className="num">{Math.round(m.distance_km)}</td></>)
                      : <td colSpan={5} className="muted small">{s.error ?? 'Not evaluated'}</td>}
                  </tr>); })}
              </tbody>
            </table>
          </div>
          {pick ? <div className="rec-why"><b>Pick: {pick.label}</b><RichText text={rec.rationale} /></div> : null}
          {rec.tradeoffs.length ? <ul className="rec-trade small">{rec.tradeoffs.map(t => <li key={t}>{t}</li>)}</ul> : null}
          {rec.priorities.length ? <p className="small muted">Prioritise: {rec.priorities.join(' · ')}</p> : null}
          {rec.caveats.map(c => <p key={c} className="small rec-caveat"><Icon name="alert" />{c}</p>)}
          {pick ? (
            <div className="route-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onApply(pick)}>Apply</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onApplyPlan(pick)} disabled={planning}><Icon name="route" />Apply and plan</button>
              {pick.source === 'baseline' ? <Chip tone="neutral">Current settings already win</Chip> : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
