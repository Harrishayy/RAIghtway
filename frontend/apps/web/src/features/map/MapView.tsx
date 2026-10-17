'use client';
// One map API for every screen. Uses real vector tiles (TileMap) when they load, and falls back to the
// offline schematic (SchematicMap) if WebGL or the tile service is unavailable, so the demo never shows
// an empty box. Adds the alert bar (counts per issue type, hazards you can step through) and a legend.
import dynamic from 'next/dynamic';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { CATEGORIES, SEVERITY, type CategoryId, type Issue, type LatLon } from '@raightway/core';
import { env } from '@/config/env';
import { ALERT_NOUN, GLYPH } from './glyphs';
import SchematicMap from './SchematicMap';

export interface MapStop { at: LatLon; n: number; eta: string; done?: boolean }
export interface MapRoute {
  id: string; category: CategoryId; path: LatLon[]; dim?: boolean;
  /** Numbered stops with ETAs, drawn on the route. */
  stops?: MapStop[];
  /** Where the crew is now. Omit to animate a crew dot along the route. */
  at?: LatLon | null;
}
export interface MapViewProps {
  issues: Issue[];
  /** Issues from the focused drive draw full strength; others are dimmed. */
  emphasise?: (i: Issue) => boolean;
  selectedId?: string | null;
  onSelect?: (i: Issue) => void;
  track?: LatLon[];
  /** 0..1 of the track already driven. */
  travelled?: number;
  vehicle?: { at: LatLon; heading: number } | null;
  routes?: MapRoute[];
  depot?: { lat: number; lon: number; label: string } | null;
  /** What to fit in view. Defaults to the track, else every pin. */
  focus?: LatLon[];
  /** Smallest span to show, in metres, so a single pin isn't zoomed to street level. */
  minSpan?: number;
  /** Map rotation in degrees; Toronto's grid reads square at -17. */
  bearing?: number;
  label: string;
  overlay?: ReactNode;
  /** Hide the alert bar (e.g. when the screen already lists alerts). */
  quiet?: boolean;
  className?: string;
}

const TileMap = dynamic(() => import('./TileMap'), { ssr: false, loading: () => <div className="tilemap loading" aria-hidden="true" /> });

function MapViewImpl(props: MapViewProps) {
  const [failed, setFailed] = useState(false);
  const [legend, setLegend] = useState(false);
  const [hzIdx, setHzIdx] = useState(-1);
  const useTiles = env.basemap === 'tiles' && !failed;
  const shown = useMemo(() => props.issues.filter(i => !props.emphasise || props.emphasise(i)), [props]);
  const counts = useMemo(() => CATEGORIES.map(c => ({ id: c.id, n: shown.filter(i => i.category === c.id).length })).filter(c => c.n), [shown]);
  const hazards = useMemo(() => shown.filter(i => i.severity === 5 && i.lat != null).sort((a, b) => b.confidence - a.confidence), [shown]);
  const hz = hzIdx >= 0 ? hazards[hzIdx % Math.max(1, hazards.length)] : undefined;
  const focus: LatLon[] | undefined = hz ? [[hz.lat!, hz.lon!]] : props.focus;
  const nextHazard = () => { const k = (hzIdx + 1) % Math.max(1, hazards.length); setHzIdx(k); const h = hazards[k]; if (h) props.onSelect?.(h); };
  const engineProps = { ...props, focus, minSpan: hz ? 700 : props.minSpan, bearing: props.bearing ?? (env.basemap !== 'none' ? -17 : 0) };

  return (
    <div className={`mapbox${props.className ? ` ${props.className}` : ''}`}>
      {useTiles ? <TileMap {...engineProps} onFail={() => setFailed(true)} /> : <SchematicMap {...engineProps} />}
      <div className="map-overlay">
        {!props.quiet && (counts.length > 0 || hazards.length > 0) && (
          <div className="map-alerts" role="group" aria-label="Alerts on the map">
            {hazards.length > 0 && (
              <button type="button" className="map-chip hz" onClick={nextHazard} title="Step through safety hazards">
                <span className="pulse" aria-hidden="true" />{hazards.length} hazard{hazards.length > 1 ? 's' : ''}{hz ? <span className="muted"> · {(hzIdx % hazards.length) + 1}/{hazards.length}</span> : null}
              </button>
            )}
            {counts.map(c => (
              <span key={c.id} className="map-chip" data-cat={c.id} title={`${ALERT_NOUN[c.id]}: ${c.n}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={GLYPH[c.id]} /></svg><span className="num">{c.n}</span>
              </span>
            ))}
          </div>
        )}
        {props.overlay}
      </div>
      <button type="button" className="map-legend-btn" aria-expanded={legend} onClick={() => setLegend(l => !l)}>{legend ? 'Hide key' : 'Key'}</button>
      {legend && (
        <div className="map-legend" role="note" aria-label="Map key">
          <ul>{CATEGORIES.map(c => <li key={c.id} data-cat={c.id}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={GLYPH[c.id]} /></svg>{ALERT_NOUN[c.id]}</li>)}</ul>
          <div className="map-legend-sev">{SEVERITY.map(s => <span key={s.level} title={s.label}><i className="sev-dot" data-sev={s.level}>{s.level}</i>{s.when}</span>)}</div>
        </div>
      )}
      {!useTiles && env.basemap === 'tiles' ? <span className="map-offline" title="Map tiles are unavailable; showing the offline map">Offline map</span> : null}
    </div>
  );
}
export const MapView = memo(MapViewImpl);
