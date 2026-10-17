'use client';
// What to plan: the severity floor (which severities to go for), how many days, whether Nemotron triages,
// and the trucks each site sends out per day per crew type (saved on the site, the same numbers the Sites
// tab edits). cuOpt then plans round trips from each site with exactly these.
import { useState } from 'react';
import { CATEGORY, CATEGORY_FOR_CREW, SEVERITY, fmtHours, type CrewType, type Facility, type Issue, type SiteTrucks } from '@raightway/core';
import { Icon } from '@/ui/Icon';
import { Seg } from '@/ui/Seg';
import { Empty } from '@/ui/State';

export const FLOORS = [1, 2, 3, 4, 5] as const;
export const DAYS = [1, 2, 3, 5] as const;
const crewName = (c: CrewType) => CATEGORY[CATEGORY_FOR_CREW[c]].crewLabel;

export interface PlanSettings { floor: number; days: number; triage: boolean }

export function PlanPanel({ settings, onSettings, open, sites, trucks, onTrucks, crewTypes }: {
  settings: PlanSettings; onSettings: (s: PlanSettings) => void;
  /** Open work in the selected categories (canonical, not rejected). */
  open: Issue[];
  sites: Facility[]; trucks: SiteTrucks; onTrucks: (site: Facility, crew: CrewType, n: number) => void;
  crewTypes: CrewType[];
}) {
  const [expanded, setExpanded] = useState<CrewType | null>(null);
  const floorLabel = (n: number) => (n === 1 ? 'All' : n === 5 ? 'S5' : `S${n}+`);
  return (
    <div className="plan-panel pad-s">
      <div className="plan-row">
        <span className="label">Go for</span>
        <Seg size="sm" label="Severity floor" value={settings.floor} onChange={floor => onSettings({ ...settings, floor })} options={FLOORS.map(n => ({ value: n, label: floorLabel(n) }))} />
      </div>
      <p className="small muted plan-hint">{settings.floor === 1 ? 'Every open job is a candidate.' : `${SEVERITY.find(s => s.level === settings.floor)?.label ?? ''} and worse. Lower severities wait, except pinned jobs.`}</p>
      <div className="plan-row">
        <span className="label">Days</span>
        <Seg size="sm" label="Planning horizon in days" value={settings.days} onChange={days => onSettings({ ...settings, days })} options={DAYS.map(n => ({ value: n, label: String(n) }))} />
      </div>
      <label className="plan-row plan-check"><input type="checkbox" checked={settings.triage} onChange={e => onSettings({ ...settings, triage: e.target.checked })} />
        <span>Nemotron triage <span className="muted small">decides today / later / wait within the rules</span></span></label>

      <h3 className="label mt">Trucks per day</h3>
      {!crewTypes.length ? <Empty title="Nothing to dispatch" dash="done">No open jobs in these categories.</Empty> : crewTypes.map(t => {
        const c = CATEGORY_FOR_CREW[t]; const jobs = open.filter(i => CATEGORY[i.category].crew === t);
        const above = jobs.filter(i => i.severity >= settings.floor || i.pinned); const minutes = above.reduce((s, i) => s + (i.work_order?.minutes ?? 30), 0);
        const hosts = sites.filter(f => f.crews.includes(t)); const n = hosts.reduce((s, f) => s + (trucks[f.id]?.[t] ?? 0), 0); const isOpen = expanded === t;
        return (
          <div key={t} className="crew-block" data-cat={c}>
            <button type="button" className="crewrow crew-toggle" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : t)}>
              <span className="g"><Icon name={c} /></span>
              <span className="crewrow-b"><b>{crewName(t)}</b><span className="muted num">{above.length} of {jobs.length} jobs · {fmtHours(minutes)} h</span></span>
              <span className={`crew-total num${n ? '' : ' under'}`}>{n} truck{n === 1 ? '' : 's'}/day</span>
            </button>
            {isOpen && (
              <ul className="crew-sites">
                {!hosts.length ? <li className="muted small">No site hosts this crew. Add one on Sites.</li> : hosts.map(f => { const k = trucks[f.id]?.[t] ?? 0; return (
                  <li key={f.id}>
                    <span className="crew-site-name" title={f.label}>{f.label}</span>
                    <span className="stepper"><button type="button" aria-label={`Fewer ${crewName(t)} trucks at ${f.label}`} onClick={() => onTrucks(f, t, k - 1)} disabled={!k}><Icon name="minus" /></button><b aria-live="polite">{k}</b><button type="button" aria-label={`More ${crewName(t)} trucks at ${f.label}`} onClick={() => onTrucks(f, t, k + 1)} disabled={k >= 20}><Icon name="plus" /></button></span>
                  </li>); })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
