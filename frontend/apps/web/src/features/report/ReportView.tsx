'use client';
// The report: Nemotron's summary, the severity × category matrix (counts come from code, not the
// model), and the crew rationale. Regenerating shows which parts are being rewritten.
import { useMemo } from 'react';
import { CATEGORIES, CREW_FOR, SEVERITY, fmtHours, plural, summarizeIssues } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useIssues, useRegenerateReport, useReport } from '@/domain/queries';
import { useCategories } from '@/state/ui';
import { Chip, CategoryLabel } from '@/ui/marks';
import { Icon } from '@/ui/Icon';
import { RichText } from '@/ui/RichText';
import { Empty, Failed, Loading } from '@/ui/State';

export function ReportView() {
  const client = useClient(); const report = useReport(); const issues = useIssues(); const regen = useRegenerateReport(); const cats = useCategories();
  const sum = useMemo(() => summarizeIssues(issues.data ?? [], cats), [issues.data, cats]);
  const updating = report.data?.updating || regen.isPending; const r = report.data?.report;
  const max = Math.max(1, ...Object.values(sum.matrix).flat());
  return (
    <div className="page-grid">
      <section className={`card pad report-sum${updating ? ' updating' : ''}`} aria-busy={updating}>
        <div className="comp-h"><h2>Summary</h2>
          <span className="row">{r?.model ? <span className="label">{r.model}</span> : null}{client.capabilities.regenerateReport ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => regen.mutate()} disabled={updating}><Icon name="refresh" />{updating ? 'Writing…' : 'Regenerate'}</button> : null}</span>
        </div>
        {report.isPending ? <Loading rows={4} /> : report.isError ? <Failed error={report.error} onRetry={() => void report.refetch()} /> : !r ? <Empty title="No report yet">{client.capabilities.regenerateReport ? 'Generate one from the current issues.' : 'The backend has not produced one.'}</Empty> : (
          <><RichText className="lede" text={r.summary} />{!r.rationale_by_crew && r.rationale ? <RichText className="note" text={r.rationale} /> : null}<p className="label">Generated {new Date(r.generated_at).toLocaleString()}</p></>
        )}
      </section>
      <section className="card pad" aria-label="Open issues by severity">
        <div className="comp-h"><h2>Open issues</h2><span className="label num">{sum.total} open · {sum.hazards.length} hazards</span></div>
        {issues.isPending ? <Loading rows={6} /> : (
          <div className="matrix-wrap"><table className="matrix">
            <thead><tr><th>Category</th>{SEVERITY.map(s => <th key={s.level} title={s.label}><span className="sev-dot" data-sev={s.level}>{s.level}</span></th>)}<th>Total</th></tr></thead>
            <tbody>{cats.map(c => { const row = sum.matrix[c] ?? [0, 0, 0, 0, 0]; return (
              <tr key={c}><th scope="row"><CategoryLabel id={c} /></th>{row.map((n, k) => <td key={k} data-sev={k + 1} style={{ ['--a' as string]: n ? 0.18 + (n / max) * 0.82 : 0 }} className="num">{n || '·'}</td>)}<td className="num"><b>{row.reduce((a, b) => a + b, 0)}</b></td></tr>
            ); })}</tbody>
          </table></div>
        )}
      </section>
      <section className="card pad wide" aria-label="Crews">
        <div className="comp-h"><h2>Crews and why</h2><span className="label">baseline = workload × 1.3 ÷ 8 h</span></div>
        <div className="crew-grid">
          {CATEGORIES.filter(c => cats.includes(c.id) && sum.jobs[c.crew]).map(c => (
            <article key={c.id} className="crew-card" data-cat={c.id}>
              <header><CategoryLabel id={c.id} /><Chip tone="neutral" plain>{plural(r?.crews[c.crew] ?? sum.baselineCrews[c.crew] ?? 0, 'crew')}</Chip></header>
              <p className="num muted">{sum.jobs[c.crew]} jobs · {fmtHours(sum.workload[c.crew] ?? 0)} h of work</p>
              {r?.rationale_by_crew?.[CREW_FOR[c.id]] ? <p>{r.rationale_by_crew[CREW_FOR[c.id]]}</p> : null}
            </article>
          ))}
          {!sum.total && !issues.isPending ? <Empty title="No open issues" dash="done" /> : null}
        </div>
      </section>
    </div>
  );
}
