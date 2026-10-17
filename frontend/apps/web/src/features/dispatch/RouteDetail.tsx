'use client';
// One truck's shift in a panel over the map: drag it by its header (or arrow keys on the grip), widen it,
// fold it down to its header, or close it. Leave the site, drive / arrive / work per stop, lunch, back,
// then the road alerts, Google Maps links and the run sheet.
import { useRef, useState } from 'react';
import { CATEGORY, clamp, fmtShift, type Issue, type Severity } from '@raightway/core';
import { Icon } from '@/ui/Icon';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';
import type { RouteRow } from './DispatchView';
import { hm, nameOf } from './schedule';

export function RouteDetail({ row, byTruck, clock, selectedIssue, onSelect, byId, onCopy, onClose }: {
  row: RouteRow; byTruck: boolean; clock: number; selectedIssue: string | null; onSelect: (id: string) => void;
  byId: Map<string, Issue>; onCopy: (text: string) => void; onClose: () => void;
}) {
  const { r, tl, totals, tone } = row;
  const ref = useRef<HTMLElement>(null);
  const [pos, setPos] = useState({ x: 14, y: 56 }); const [wide, setWide] = useState(false); const [folded, setFolded] = useState(false);
  const jobs = tl.filter(e => e.kind === 'job'); const doneN = jobs.filter(e => clock >= e.depart_min).length;

  // keep the panel inside the map space
  const moveTo = (x: number, y: number) => {
    const el = ref.current, box = el?.parentElement?.getBoundingClientRect(); if (!el || !box) return;
    setPos({ x: clamp(x, 0, Math.max(0, box.width - el.offsetWidth)), y: clamp(y, 0, Math.max(0, box.height - 40)) });
  };
  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button:not(.rd-grip)')) return;
    e.preventDefault(); const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const ox = e.clientX - pos.x, oy = e.clientY - pos.y;
    el.onpointermove = ev => moveTo(ev.clientX - ox, ev.clientY - oy);
    el.onpointerup = () => { el.onpointermove = null; };
  };
  const keyMove = (e: React.KeyboardEvent) => {
    const d = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[e.key]; if (!d) return;
    e.preventDefault(); moveTo(pos.x + d[0]!, pos.y + d[1]!);
  };

  return (
    <section ref={ref} className={`route-detail card${wide ? ' wide' : ''}${folded ? ' folded' : ''}`} style={{ left: pos.x, top: pos.y, ['--y' as string]: `${pos.y}px` }}
      data-cat={r.category} data-tone={byTruck ? tone : undefined} aria-label={`${r.vehicle_id ?? r.crew_id} route`}>
      <header className="rd-h" onPointerDown={startDrag}>
        <button type="button" className="rd-grip pane-grip" aria-label="Move the route panel. Drag, or use the arrow keys" onKeyDown={keyMove}><Icon name="grip" className="fill" /></button>
        <span className="route-id"><i className="route-swatch" aria-hidden="true" />{r.vehicle_id ?? r.crew_id}</span><CategoryLabel id={r.category} compact />
        <span className="rd-meta num muted small">{doneN}/{jobs.length} · back {fmtShift(totals.back_min)}</span>
        <span className="rd-act">
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => setFolded(f => !f)} aria-label={folded ? 'Show route detail' : 'Hide route detail'} aria-expanded={!folded}><Icon name={folded ? 'plus' : 'minus'} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => { setWide(w => !w); setFolded(false); }} aria-label={wide ? 'Shrink route panel' : 'Expand route panel'} aria-pressed={wide}><Icon name="expand" /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close route panel"><Icon name="x" /></button>
        </span>
      </header>
      {folded ? null : (
        <div className="rd-b">
          <p className="small muted num rd-sum">{r.depot_label ? `From ${r.depot_label} · ` : ''}{hm(totals.drive_min)} driving · {hm(totals.work_min)} on site{totals.idle_min ? ` · ${hm(totals.idle_min)} idle` : ''}{totals.distance_km ? ` · ${totals.distance_km.toFixed(1)} km` : ''}{totals.lunch === 'solver' ? ' · lunch by cuOpt' : totals.lunch === 'reserved' ? ' · lunch reserved' : ''}</p>
          <span className="route-bar" aria-hidden="true"><i style={{ width: `${(doneN / Math.max(1, jobs.length)) * 100}%` }} /></span>
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
          {r.warnings?.length || r.maps_urls?.length || r.brief ? (
            <div className="route-send">
              {r.warnings?.length ? <ul className="roads-warn">{r.warnings.map(w => <li key={w.hazard_id} className={w.avoided ? 'avoided' : undefined}><Icon name={w.avoided ? 'check' : 'alert'} /><span>{w.label}</span><span className="muted small">{w.avoided ? 'avoided' : w.source === 'dashcam' ? 'seen on camera' : 'on the way'}</span></li>)}</ul> : null}
              <div className="route-actions">
                {r.maps_urls?.map((u, k, all) => <a key={u} className="btn btn-secondary btn-sm" href={u} target="_blank" rel="noreferrer">{all.length > 1 ? `Google Maps ${k + 1}/${all.length}` : 'Open in Google Maps'}</a>)}
                {r.brief ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCopy(r.brief!)}>Copy run sheet</button> : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
