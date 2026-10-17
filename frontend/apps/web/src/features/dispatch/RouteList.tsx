'use client';
// One card per truck for the chosen day: its colour on the map, its site, totals (driving, on site, idle,
// km, back at base) and, opened, the full shift: leave the site, drive / arrive / work per stop, lunch,
// back. The run sheet, road alerts and Google Maps links go with it.
import { CATEGORY, fmtShift, type Issue, type Severity } from '@raightway/core';
import { Icon } from '@/ui/Icon';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';
import type { RouteRow } from './DispatchView';
import { hm, nameOf } from './schedule';

export function RouteList({ byTruck = false, rows, clock, open, onOpen, selectedIssue, onSelect, byId, onCopy }: {
  byTruck?: boolean; rows: RouteRow[]; clock: number; open: string | null; onOpen: (id: string | null) => void;
  selectedIssue: string | null; onSelect: (id: string) => void; byId: Map<string, Issue>; onCopy: (text: string) => void;
}) {
  return (
    <>
      {rows.map(({ r, tl, totals, tone }) => {
        const isOpen = open === r.crew_id; const jobs = tl.filter(e => e.kind === 'job');
        const doneN = jobs.filter(e => clock >= e.depart_min).length; const next = jobs.find(e => clock < e.depart_min);
        return (
          <section key={r.crew_id} className={`route-card${isOpen ? ' open' : ''}`} data-cat={r.category} data-tone={byTruck ? tone : undefined}>
            <button type="button" className="route-h" aria-expanded={isOpen} onClick={() => onOpen(isOpen ? null : r.crew_id)}>
              <span className="route-id"><i className="route-swatch" aria-hidden="true" />{r.vehicle_id ?? r.crew_id}</span><CategoryLabel id={r.category} compact />
              {r.depot_label ? <span className="route-base muted small">from {r.depot_label}</span> : null}
              {r.warnings?.length ? <span className="route-alerts small" title={r.warnings.map(w => w.label).join('\n')}><Icon name="alert" />{r.warnings.filter(w => w.avoided).length ? `${r.warnings.filter(w => w.avoided).length} avoided · ` : ''}{r.warnings.filter(w => !w.avoided).length} on the way</span> : null}
              <span className="route-meta num">{doneN}/{jobs.length} · back {fmtShift(totals.back_min)}</span>
              <span className="route-totals small muted num">{hm(totals.drive_min)} driving · {hm(totals.work_min)} on site{totals.idle_min ? ` · ${hm(totals.idle_min)} idle` : ''}{totals.distance_km ? ` · ${totals.distance_km.toFixed(1)} km` : ''}{totals.lunch === 'solver' ? ' · lunch by cuOpt' : totals.lunch === 'reserved' ? ' · lunch reserved' : ''}</span>
              <span className="route-bar" aria-hidden="true"><i style={{ width: `${(doneN / Math.max(1, jobs.length)) * 100}%` }} /></span>
              {next ? <span className="route-next muted small">Next: {clock < next.arrive_min ? `ETA ${fmtShift(next.arrive_min)}` : 'on site'} · {next.label}</span> : <span className="route-next muted small">Shift complete</span>}
            </button>
            {isOpen && (
              <ol className="track" aria-label={`${r.crew_id} shift`}>
                {tl.map((e, k) => {
                  if (e.kind === 'depart') return <li key={k} className="track-depot"><span className="track-dot" /><span>{fmtShift(e.depart_min)} · Leave {r.depot_label ?? 'the site'}</span></li>;
                  if (e.kind === 'return') return <li key={k} className="track-depot"><span className="track-dot" /><span>{fmtShift(e.arrive_min)} · Back at {r.depot_label ?? 'the site'}{e.drive_min ? ` · ${e.drive_min} min drive` : ''}</span></li>;
                  if (e.kind === 'break') return <li key={k} className="track-break"><span className="track-dot"><Icon name="clock" /></span><span className="small">{fmtShift(e.arrive_min)}–{fmtShift(e.depart_min)} · Lunch{e.drive_min ? ` (${e.drive_min} min drive)` : ''}</span></li>;
                  const issue = e.issue_id ? byId.get(e.issue_id) : undefined; const n = jobs.indexOf(e) + 1;
                  const state = clock >= e.depart_min ? 'done' : clock >= e.arrive_min ? 'on' : clock >= e.arrive_min - e.drive_min ? 'driving' : 'todo';
                  return (
                    <li key={k} className={`track-stop ${state}${e.issue_id === selectedIssue ? ' sel' : ''}${e.pinned ? ' pinned' : ''}`}>
                      <span className="track-dot">{n}</span>
                      <button type="button" onClick={() => e.issue_id && onSelect(e.issue_id)}>
                        <span className="track-row"><b className="num">{fmtShift(e.arrive_min)}</b>{e.severity ? <SevDot level={e.severity as Severity} /> : null}<span className="track-what">{nameOf(issue) ?? e.label}</span>{e.pinned ? <Chip tone="info" plain>Pinned</Chip> : null}</span>
                        <span className="track-sub muted small num">{e.drive_min ? `${e.drive_min} min drive · ` : ''}{e.idle_min ? `${e.idle_min} min wait · ` : ''}{e.work_min} min on site · leave {fmtShift(e.depart_min)}{issue?.place ? ` · ${issue.place}` : ''}{issue ? ` · ${CATEGORY[issue.category].short}` : ''}</span>
                      </button>
                      {state === 'driving' || state === 'on' ? <span className="track-live" aria-hidden="true" /> : null}
                    </li>
                  );
                })}
              </ol>
            )}
            {isOpen && (r.warnings?.length || r.maps_urls?.length || r.brief) ? (
              <div className="route-send">
                {r.warnings?.length ? <ul className="roads-warn">{r.warnings.map(w => <li key={w.hazard_id} className={w.avoided ? 'avoided' : undefined}><Icon name={w.avoided ? 'check' : 'alert'} /><span>{w.label}</span><span className="muted small">{w.avoided ? 'avoided' : w.source === 'dashcam' ? 'seen on camera' : 'on the way'}</span></li>)}</ul> : null}
                <div className="route-actions">
                  {r.maps_urls?.map((u, k, all) => <a key={u} className="btn btn-secondary btn-sm" href={u} target="_blank" rel="noreferrer">{all.length > 1 ? `Google Maps ${k + 1}/${all.length}` : 'Open in Google Maps'}</a>)}
                  {r.brief ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCopy(r.brief!)}>Copy run sheet</button> : null}
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
