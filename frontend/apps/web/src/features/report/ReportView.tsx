'use client';
// The operations report. Every number and list comes from code (the backend's report.py, or the console's
// own counts for an older report); Nemotron writes the summary, the crew rationale, each category's repair
// approach and the hotspot notes. Provenance says which models answered and what fell back, so the report
// never overstates itself. A report from before the detail sections still renders: summary, matrix, crews.
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CATEGORIES, CATEGORY, CREW_FOR, SEVERITY, fmtCoord, fmtHours, fmtTimecode, plural, raterDef, summarizeIssues, type Issue, type Report, type ReportIssue, type ReportProvenance, type ReportSection, type Severity } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useIssues, useRegenerateReport, useReport } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { Chip, CategoryLabel, SevDot } from '@/ui/marks';
import { Icon } from '@/ui/Icon';
import { RichText } from '@/ui/RichText';
import { Empty, Failed, Loading } from '@/ui/State';
import { Thumb } from '@/ui/Thumb';

const DEADLINE: Record<ReportIssue['deadline'], ['failed' | 'hold' | 'neutral', string]> = {
  today: ['failed', 'Today'], 'this week': ['hold', 'This week'], 'this month': ['neutral', 'This month'], routine: ['neutral', 'Routine'],
};
const sevOf = (n: number) => Math.min(5, Math.max(1, Math.round(n))) as Severity;

export function ReportView() {
  const client = useClient(); const report = useReport(); const issues = useIssues(); const regen = useRegenerateReport(); const cats = useCategories();
  const router = useRouter(); const { open } = usePlayback();
  const sum = useMemo(() => summarizeIssues(issues.data ?? [], cats), [issues.data, cats]);
  const byId = useMemo(() => new Map((issues.data ?? []).map(i => [i.id, i])), [issues.data]);
  const updating = report.data?.updating || regen.isPending; const r = report.data?.report;
  const max = Math.max(1, ...Object.values(sum.matrix).flat());
  const writer = raterDef(r?.provenance?.report_model);
  const modelLabel = r?.model ?? (writer ? `${writer.name}${writer.fallback && writer.id !== 'template' ? ' (fallback)' : ''}` : null);
  const sections = (r?.sections ?? []).filter(s => cats.includes(s.category));
  const priorities = (r?.priorities ?? []).filter(p => cats.includes(p.category));
  const frame = (ri: ReportIssue) => client.frameUrl(byId.get(ri.id) ?? ({ ...ri, frame_url: `/api/frames/${ri.id}` } as unknown as Issue));
  const watch = (ri: ReportIssue) => { open(ri.video_id, Math.max(0, ri.t - 0.4), ri.id); router.push('/review'); };

  return (
    <div className="page-grid">
      <section className={`card pad wide report-sum${updating ? ' updating' : ''}`} aria-busy={updating} aria-label="Summary">
        <div className="comp-h"><h2>Summary</h2>
          <span className="row">{modelLabel ? <span className="label" title="Who wrote the prose; every number comes from code">{modelLabel}</span> : null}{client.capabilities.regenerateReport ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => regen.mutate()} disabled={updating}><Icon name="refresh" />{updating ? 'Writing…' : 'Regenerate'}</button> : null}</span>
        </div>
        {report.isPending ? <Loading rows={4} /> : report.isError ? <Failed error={report.error} onRetry={() => void report.refetch()} /> : !r ? <Empty title="No report yet">{client.capabilities.regenerateReport ? 'Generate one from the current issues.' : 'The backend has not produced one.'}</Empty> : (
          <>
            {r.stats ? <Stats stats={r.stats} /> : null}
            <RichText className="lede" text={r.summary} />
            {!r.rationale_by_crew && r.rationale ? <RichText className="note" text={r.rationale} /> : null}
            <p className="label">Generated {new Date(r.generated_at).toLocaleString()}</p>
          </>
        )}
      </section>

      {priorities.length ? (
        <section className="card wide report-pri" aria-label="Priority list">
          <div className="comp-h pad-s"><h2>Priority list</h2><span className="label num">{plural(priorities.length, 'issue')} at severity 4–5</span></div>
          <div className="matrix-wrap">
            <table className="moments pri-tbl">
              <thead><tr><th>Sev</th><th className="d">Finding and why</th><th className="pri-where">Where</th><th>Due</th></tr></thead>
              <tbody>{priorities.map(p => (
                <tr key={p.id} tabIndex={0} onClick={() => watch(p)} onKeyDown={e => { if (e.key === 'Enter') watch(p); }} title="Watch in Review">
                  <td><SevDot level={sevOf(p.severity)} /></td>
                  <td className="d"><span className="pri-f"><Thumb src={frame(p)} category={p.category} /><span className="two"><b>{p.description}</b><span className="muted">{p.severity_reason ?? CATEGORY[p.category].label}</span></span></span></td>
                  <td className="pri-where"><span className="two"><span>{p.place ?? (p.lat != null && p.lon != null ? fmtCoord(p.lat, p.lon) : 'No location')}</span><span className="muted mono small">{p.drive ?? p.video_id} @ {fmtTimecode(p.t)}{p.sightings > 1 ? ` · seen ${p.sightings}×` : ''}</span></span></td>
                  <td><Chip tone={DEADLINE[p.deadline][0]} plain>{DEADLINE[p.deadline][1]}</Chip></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : null}

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

      {r?.hotspots?.length ? (
        <section className="card pad" aria-label="Hotspots">
          <div className="comp-h"><h2>Hotspots</h2><span className="label">findings within {r.hotspots[0]!.radius_m} m</span></div>
          <ol className="hotspots">{r.hotspots.map(h => (
            <li key={h.id}>
              <div className="hs-h"><b>{h.label}</b><span className="num muted">{plural(h.issues, 'issue')}{h.severe ? ` · ${h.severe} severe` : ''}</span></div>
              <div className="hs-cats">{Object.entries(h.categories).filter(([c]) => c in CATEGORY).map(([c, n]) => <span key={c} className="cat" data-cat={c}><Icon name={c as keyof typeof CATEGORY} />{n}</span>)}<SevDot level={sevOf(h.max_severity)} /></div>
              {h.note ? <RichText className="note" text={h.note} /> : null}
              {h.drives.length ? <span className="muted small mono hs-drives">{h.drives.join(' · ')}</span> : null}
            </li>
          ))}</ol>
        </section>
      ) : null}

      {sections.length ? sections.map(s => <Section key={s.category} s={s} frame={frame} onOpen={watch} />) : (
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
      )}
      {sections.length && r?.rationale ? (
        <section className="card pad wide" aria-label="Crew rationale"><div className="comp-h"><h2>Crews and why</h2><span className="label">baseline = workload × 1.3 ÷ 8 h</span></div><RichText className="note" text={r.rationale} /></section>
      ) : null}

      {r?.provenance ? <Provenance p={r.provenance} /> : null}
    </div>
  );
}

function Stats({ stats }: { stats: NonNullable<Report['stats']> }) {
  const tiles: Array<[string, number | string, Severity | null, string]> = [
    ['Open', stats.open, null, 'Open issues, false positives excluded'],
    ['Fix today', stats.today, 5, 'Severity 5'], ['This week', stats.this_week, 4, 'Severity 4'],
    ['This month', stats.this_month, 3, 'Severity 3'], ['Routine', stats.routine, null, 'Severity 1–2'],
    ['Crews', stats.crews, null, 'Recommended crews'], ['Crew-hours', stats.crew_hours.toFixed(1), null, 'Work orders plus 30% travel and setup'],
  ];
  if (stats.rejected) tiles.push(['Not defects', stats.rejected, null, 'Judged false positives by the severity rater; kept on record']);
  return (
    <dl className="stats">{tiles.map(([label, value, sev, hint]) => (
      <div key={label} className="stat" title={hint} data-sev={sev ?? undefined}><dt>{label}</dt><dd className="num">{value}</dd></div>
    ))}</dl>
  );
}

function Section({ s, frame, onOpen }: { s: ReportSection; frame: (r: ReportIssue) => string | null; onOpen: (r: ReportIssue) => void }) {
  return (
    <section className="card pad wide report-sec" data-cat={s.category} aria-label={CATEGORY[s.category].label}>
      <div className="comp-h">
        <h2><CategoryLabel id={s.category} /></h2>
        <span className="label num">{s.open} open · {s.crew_hours.toFixed(1)} crew-h · {plural(s.crews, 'crew')}</span>
      </div>
      <div className="sec-grid">
        <div className="sec-facts">
          <div className="sev-bar" role="img" aria-label={SEVERITY.map(l => `S${l.level}: ${s.by_severity[l.level] ?? 0}`).join(', ')}>
            {SEVERITY.map(l => <span key={l.level} className="sev-count" data-sev={l.level} title={l.label}><span className="sev-dot" data-sev={l.level}>{l.level}</span><span className="num">{s.by_severity[l.level] ?? 0}</span></span>)}
          </div>
          {s.rejected ? <p className="note">{plural(s.rejected, 'finding')} judged not a defect, left out.</p> : null}
          {s.approach ? <><div className="label">Recommended approach</div><RichText className="note sec-approach" text={s.approach} /></> : null}
          {s.equipment.length ? <><div className="label">Equipment and materials</div><div className="kit">{s.equipment.map(e => <span key={e.label} className="kit-i">{e.label}<span className="num muted">{e.count}</span></span>)}</div></> : null}
        </div>
        {s.top.length ? (
          <ul className="sec-top" aria-label="Worst findings">{s.top.map(t => (
            <li key={t.id}><button type="button" onClick={() => onOpen(t)} title="Watch in Review">
              <Thumb src={frame(t)} category={t.category} />
              <span className="two"><span><b>{t.description}</b></span><span className="muted">{t.severity_reason ?? t.repair ?? ''}</span><span className="muted small mono">{t.place ?? t.drive ?? t.video_id}{t.place && t.drive ? ` · ${t.drive}` : ''} @ {fmtTimecode(t.t)}{t.sightings > 1 ? ` · ${t.sightings}×` : ''}</span></span>
              <SevDot level={sevOf(t.severity)} />
            </button></li>
          ))}</ul>
        ) : null}
      </div>
    </section>
  );
}

function Provenance({ p }: { p: ReportProvenance }) {
  const writer = raterDef(p.report_model); const finder = raterDef(p.find_model);
  const raters = Object.entries(p.rating_models).sort((a, b) => b[1] - a[1]);
  const pct = (n: number) => (p.sightings_total ? `${n} of ${p.sightings_total}` : String(n));
  return (
    <section className="card pad wide" aria-label="Data provenance">
      <div className="comp-h"><h2>Data provenance</h2><span className="label">which models answered</span></div>
      <div className="prov-grid">
        <dl className="kv left">
          <dt>Finding</dt><dd>{finder?.name ?? p.find_model} on 5 s dashcam pieces</dd>
          <dt>Severity</dt><dd>{raters.length ? raters.map(([m, n]) => { const d = raterDef(m)!; return `${d.name}${d.fallback ? ' (fallback)' : ''} ${n}`; }).join(' · ') : 'Find pass only'}{p.unrated ? ` · ${p.unrated} not re-graded` : ''}</dd>
          <dt>Report prose</dt><dd>{writer ? `${writer.name}${writer.fallback && writer.id !== 'template' ? ' (fallback)' : ''}` : p.report_model}</dd>
          <dt>Dedupe</dt><dd>{p.sightings_total} sightings → {p.canonical} issues ({p.duplicates_merged} re-sightings merged)</dd>
          <dt>Embeddings</dt><dd>{pct(p.with_embedding)} sightings (Cosmos-Embed1)</dd>
          <dt>GPS · box</dt><dd>{pct(p.with_gps)} located · {pct(p.with_box)} boxed</dd>
          <dt>Work orders</dt><dd>{p.work_orders}{p.template_work_orders ? `, ${p.template_work_orders} from the template` : ''}</dd>
          <dt>Not defects</dt><dd>{p.rejected}</dd>
        </dl>
        {p.caveats.length ? <div><div className="label">Caveats</div><ul className="caveats">{p.caveats.map(c => <li key={c}>{c}</li>)}</ul></div> : null}
      </div>
    </section>
  );
}
