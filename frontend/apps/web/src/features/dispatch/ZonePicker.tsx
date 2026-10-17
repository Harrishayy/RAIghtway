'use client';
// Focus: plan the whole city or only some of it. Pick City wards (open jobs and the worst severity in each,
// busiest first), saved drawn areas, or draw a new area on the map (click to add points, double-click or
// Enter to close, Esc to cancel, Backspace to undo, drag a point to move it). cuOpt then routes only the
// jobs inside; crews still start and end at their own sites, which may be outside.
import { useState } from 'react';
import type { LatLon, Severity, Zone } from '@raightway/core';
import { Icon } from '@/ui/Icon';
import { SevDot } from '@/ui/marks';

export interface DrawState { points: LatLon[]; closed: boolean }

export function ZonePicker({ zones, counts, selected, onToggle, onClear, draw, onDraw, onUndo, onClose, onCancel, onSave, onUseOnce, inline, onClearInline, onRemove, pinnedOutside }: {
  zones: Zone[]; counts: Map<string, { n: number; worst: number }>; selected: string[];
  onToggle: (id: string) => void; onClear: () => void;
  draw: DrawState | null; onDraw: () => void; onUndo: () => void; onClose: () => void; onCancel: () => void;
  onSave: (label: string) => void; onUseOnce: () => void; inline: boolean; onClearInline: () => void;
  onRemove: (z: Zone) => void; pinnedOutside: number;
}) {
  const [all, setAll] = useState(false); const [name, setName] = useState('');
  const custom = zones.filter(z => z.kind === 'custom');
  const wards = zones.filter(z => z.kind === 'ward').sort((a, b) => (counts.get(b.id)?.n ?? 0) - (counts.get(a.id)?.n ?? 0) || (a.code ?? 0) - (b.code ?? 0));
  const shown = all ? wards : wards.slice(0, 8);
  const focused = selected.length + (inline ? 1 : 0);
  const row = (z: Zone, removable = false) => {
    const c = counts.get(z.id); const on = selected.includes(z.id);
    return (
      <li key={z.id} className={`zone-row${on ? ' on' : ''}`}>
        <label>
          <input type="checkbox" checked={on} onChange={() => onToggle(z.id)} />
          <span className="zone-name" title={z.label}>{z.label}</span>
          <span className="zone-count num muted">{c?.n ?? 0}</span>
          {c?.worst ? <SevDot level={c.worst as Severity} /> : <span className="zone-dot-none" aria-hidden="true" />}
        </label>
        {removable ? <button type="button" className="btn btn-sm btn-icon btn-secondary" aria-label={`Remove zone ${z.label}`} onClick={() => onRemove(z)}><Icon name="x" /></button> : null}
      </li>
    );
  };
  return (
    <section className="zone-picker" aria-label="Focus zones">
      <div className="plan-row">
        <span className="label">Focus</span>
        <span className="small">{focused ? `${focused} area${focused > 1 ? 's' : ''}` : 'Whole city'}</span>
        {focused ? <button type="button" className="btn btn-sm btn-secondary push" onClick={() => { onClear(); onClearInline(); }}>Whole city</button> : null}
        {!draw ? <button type="button" className={`btn btn-sm btn-secondary${focused ? '' : ' push'}`} onClick={onDraw}><Icon name="pin" />Draw area</button> : null}
      </div>
      {draw ? (
        <div className="zone-draw" role="group" aria-label="Draw an area">
          {!draw.closed ? (<>
            <p className="small">{draw.points.length < 3 ? `Click the map to add points (${draw.points.length} so far).` : 'Double-click or press Enter to close the area.'} Esc cancels, Backspace undoes, drag a point to move it.</p>
            <div className="route-actions">
              <button type="button" className="btn btn-sm btn-secondary" onClick={onUndo} disabled={!draw.points.length}>Undo point</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={onClose} disabled={draw.points.length < 3}>Finish area</button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>Cancel</button>
            </div>
          </>) : (
            <form className="zone-save" onSubmit={e => { e.preventDefault(); onSave(name.trim() || 'Drawn area'); setName(''); }}>
              <label className="roads-field"><span className="label">Name</span><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Queen West blitz" /></label>
              <div className="route-actions">
                <button type="submit" className="btn btn-sm btn-primary"><Icon name="check" />Save zone</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={onUseOnce}>Use without saving</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>Discard</button>
              </div>
            </form>
          )}
        </div>
      ) : null}
      {inline ? <p className="small zone-inline"><Icon name="check" />Using a drawn area for this plan <button type="button" className="linkish" onClick={onClearInline}>remove</button></p> : null}
      {pinnedOutside ? <p className="small rec-caveat"><Icon name="alert" />{pinnedOutside} pinned job{pinnedOutside > 1 ? 's are' : ' is'} outside the focus and won’t be planned.</p> : null}
      {custom.length ? <><p className="label mt">Drawn areas</p><ul className="zone-list">{custom.map(z => row(z, true))}</ul></> : null}
      <p className="label mt">City wards · open jobs</p>
      <ul className="zone-list">{shown.map(z => row(z))}</ul>
      {wards.length > 8 ? <button type="button" className="linkish small" onClick={() => setAll(a => !a)}>{all ? 'Show the busiest 8' : `Show all ${wards.length} wards`}</button> : null}
      {wards[0]?.source_url ? <p className="small muted">Ward boundaries: <a href={wards[0].source_url} target="_blank" rel="noreferrer">City of Toronto Open Data</a>.</p> : null}
    </section>
  );
}
