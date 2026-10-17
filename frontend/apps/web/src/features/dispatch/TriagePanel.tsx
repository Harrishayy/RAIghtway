'use client';
// The day plan before routing: what goes today, later in the plan, or waits, with a reason for each. Says
// who decided (Nemotron, or the rules when no model answered) and how often code overrode the model.
import { useState } from 'react';
import { CATEGORY, CATEGORY_FOR_CREW, type Issue, type Severity, type Triage, type TriageDecisionKind } from '@raightway/core';
import { Chip, CategoryLabel, SevDot } from '@/ui/marks';
import { RichText } from '@/ui/RichText';
import { Seg } from '@/ui/Seg';
import { Empty } from '@/ui/State';
import { nameOf } from './schedule';

const TITLE: Record<TriageDecisionKind, string> = { today: 'Today', later: 'Later in the plan', defer: 'Waiting' };

export function TriagePanel({ triage, byId, onSelect, routed }: { triage: Triage | null | undefined; byId: Map<string, Issue>; onSelect: (id: string) => void; routed: Set<string> }) {
  const [show, setShow] = useState<TriageDecisionKind>('today');
  if (!triage) return <Empty title="No triage yet">Plan routes to see what goes today and what waits.</Empty>;
  const groups = { today: triage.decisions.filter(d => d.decision === 'today'), later: triage.decisions.filter(d => d.decision === 'later'), defer: triage.decisions.filter(d => d.decision === 'defer') };
  const list = groups[show];
  const model = triage.model === 'rules' ? null : triage.model_name ?? triage.model;
  return (
    <div className="triage pad-s">
      <div className="comp-h"><h3>Day plan</h3><Chip tone={model ? 'info' : 'neutral'}>{model ? `${model}` : 'Rules (no model)'}</Chip></div>
      <p className="label">Floor S{triage.min_severity}+ · {triage.days} day{triage.days > 1 ? 's' : ''}{model && triage.clamped ? ` · ${triage.clamped} model decision${triage.clamped > 1 ? 's' : ''} kept to the rules` : ''}</p>
      {triage.model_decisions != null || triage.rule_decisions != null ? <p className="small muted">{model ? `Nemotron decided ${triage.model_decisions ?? 0}` : 'Nemotron decided none'}, rules decided {triage.rule_decisions ?? triage.decisions.length} (severity 5, pinned, below the floor, and anything the model wasn’t asked).</p> : null}
      {triage.note ? <p className="small rec-caveat"><span>{triage.note}</span></p> : null}
      <RichText className="triage-why" text={triage.rationale} />
      {Object.entries(triage.by_crew).length ? (
        <ul className="triage-crews small">{Object.entries(triage.by_crew).map(([crew, note]) => <li key={crew} data-cat={CATEGORY_FOR_CREW[crew as keyof typeof CATEGORY_FOR_CREW]}><b>{CATEGORY[CATEGORY_FOR_CREW[crew as keyof typeof CATEGORY_FOR_CREW]].crewLabel}</b> {note}</li>)}</ul>
      ) : null}
      <Seg size="sm" label="Decisions" value={show} onChange={setShow} options={(['today', 'later', 'defer'] as const).map(k => ({ value: k, label: `${TITLE[k]} · ${groups[k].length}` }))} />
      {!list.length ? <p className="small muted mt">None.</p> : (
        <ul className="triage-list">
          {list.slice(0, 120).map(d => { const i = byId.get(d.issue_id); return (
            <li key={d.issue_id} className={d.pinned ? 'pinned' : undefined}>
              <button type="button" onClick={() => onSelect(d.issue_id)}>
                <span className="triage-row"><SevDot level={Math.min(5, Math.max(1, d.severity)) as Severity} />{i ? <CategoryLabel id={i.category} compact /> : null}<span className="triage-what">{nameOf(i) ?? d.issue_id}</span>{d.pinned ? <Chip tone="info" plain>Pinned</Chip> : null}</span>
                <span className="triage-reason muted small">{d.reason}{d.by === 'model' ? ' · Nemotron' : ''}{d.decision !== 'defer' && !routed.has(d.issue_id) ? ' · not reached by a truck' : ''}</span>
              </button>
            </li>); })}
          {list.length > 120 ? <li className="muted small">…and {list.length - 120} more</li> : null}
        </ul>
      )}
    </div>
  );
}
