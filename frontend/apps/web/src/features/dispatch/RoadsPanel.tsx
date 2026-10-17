'use client';
// Roads: the planner side of dispatch. Directions from a base to the selected job, steering around
// closures (the backend compares road alternatives against the city's restriction feed and the work
// zones our footage found), and the road alerts themselves, worst first. Nothing here is computed in
// the browser: paths, minutes and warnings all come from POST /api/directions and the Plan.
import { useEffect, useState } from 'react';
import { CATEGORY, travelMinutes, type Directions, type Facility, type Hazard, type Issue, type LatLon } from '@raightway/core';
import { useDirections } from '@/domain/queries';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/marks';
import { Empty } from '@/ui/State';

const SEV_WORD: Record<number, string> = { 5: 'Closed', 4: 'Closed one way', 3: 'Construction', 2: 'Lane works' };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null);

export interface Base { id: string; label: string; at: LatLon }

export function RoadsPanel({ bases, hazards, issue, onPath, onFocus }: {
  bases: Base[]; hazards: Hazard[]; issue?: Issue;
  /** The planned path to draw, or null to clear it. */
  onPath: (d: { path: LatLon[]; category: Issue['category'] } | null) => void;
  onFocus: (at: LatLon[]) => void;
}) {
  const directions = useDirections();
  const [from, setFrom] = useState<string | null>(null);
  const to: LatLon | null = issue && issue.lat != null && issue.lon != null ? [issue.lat, issue.lon] : null;
  // until someone picks a start, use the base nearest the job
  const nearest = to ? [...bases].sort((a, b) => travelMinutes(a.at, to) - travelMinutes(b.at, to))[0] : bases[0];
  const base = bases.find(b => b.id === from) ?? nearest;
  const result: Directions | undefined = directions.data;
  // a new destination or start clears the old answer
  useEffect(() => { directions.reset(); onPath(null); }, [issue?.id, base?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = () => { if (base && to && issue) directions.mutate({ from: base.at, to }, { onSuccess: d => { onPath({ path: d.path, category: issue.category }); onFocus(d.path); } }); };
  const city = hazards.filter(h => h.source === 'city'); const cam = hazards.filter(h => h.source === 'dashcam');

  return (
    <div className="roads pad-s">
      <section className="roads-plan" aria-label="Directions">
        <div className="comp-h"><h3>Directions</h3>{result ? <Chip tone={result.path_source === 'road' ? 'done' : 'hold'}>{result.path_source === 'road' ? 'Street route' : 'Straight line'}</Chip> : null}</div>
        <label className="roads-field"><span className="label">From</span>
          <select value={base?.id ?? ''} onChange={e => setFrom(e.target.value)} disabled={!bases.length}>
            {bases.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </label>
        <div className="roads-field"><span className="label">To</span>
          {issue ? <span className="roads-to">{CATEGORY[issue.category].label} · {issue.description}</span> : <span className="muted">Select a job on the map</span>}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={go} disabled={!base || !to || directions.isPending}><Icon name="route" />{directions.isPending ? 'Finding a way…' : 'Best route'}</button>
        {result && (
          <div className="roads-result">
            <p className="num"><b>{result.minutes} min</b> · {result.distance_km.toFixed(1)} km{result.alternatives > 1 ? ` · best of ${result.alternatives} routes` : ''}</p>
            {result.warnings.length ? (
              <ul className="roads-warn">{result.warnings.map(w => <li key={w.hazard_id} className={w.avoided ? 'avoided' : undefined}><Icon name={w.avoided ? 'check' : 'alert'} /><span>{w.label}</span><span className="muted small">{w.avoided ? 'avoided' : w.source === 'dashcam' ? 'seen on camera' : 'on the way'}</span></li>)}</ul>
            ) : <p className="muted small">No closures or work zones on the way.</p>}
            <a className="btn btn-secondary btn-sm" href={result.maps_url} target="_blank" rel="noreferrer">Open in Google Maps</a>
            {result.warnings.some(w => w.avoided) ? <p className="muted small">Google Maps plans its own way and may not avoid these closures. The route on this map does.</p> : null}
          </div>
        )}
      </section>

      <section aria-label="Road alerts">
        <div className="comp-h mt"><h3>Road alerts</h3><Chip tone={hazards.some(h => h.severity >= 4) ? 'failed' : 'neutral'}>{hazards.length}</Chip></div>
        {!hazards.length ? <Empty title="No road alerts" dash="done">No closures or work zones near today’s work.</Empty> : (
          <>
            {cam.length ? <p className="label">Seen by the fleet · {cam.length}</p> : null}
            <ul className="roads-alerts">{cam.map(h => <AlertRow key={h.id} h={h} onFocus={onFocus} />)}</ul>
            {city.length ? <p className="label mt">City of Toronto restrictions · {city.length}</p> : null}
            <ul className="roads-alerts">{city.slice(0, 40).map(h => <AlertRow key={h.id} h={h} onFocus={onFocus} />)}</ul>
          </>
        )}
      </section>
    </div>
  );
}

function AlertRow({ h, onFocus }: { h: Hazard; onFocus: (at: LatLon[]) => void }) {
  const until = when(h.until);
  return (
    <li>
      <button type="button" onClick={() => onFocus(h.path?.length ? h.path : [[h.lat, h.lon]])}>
        <span className={`roads-sev s${Math.min(5, Math.max(2, h.severity))}`}>{h.source === 'dashcam' ? `S${h.severity}` : SEV_WORD[h.severity] ?? 'Works'}</span>
        <span className="roads-label">{h.label}</span>
        <span className="muted small">{[h.detail, until ? `until ${until}` : null].filter(Boolean).join(' · ')}</span>
      </button>
    </li>
  );
}

export const basesOf = (facilities: Facility[] | undefined, fallback: { lat: number; lon: number; label: string }): Base[] =>
  facilities?.length ? facilities.map(f => ({ id: f.id, label: f.label, at: [f.lat, f.lon] })) : [{ id: 'depot', label: fallback.label, at: [fallback.lat, fallback.lon] }];
