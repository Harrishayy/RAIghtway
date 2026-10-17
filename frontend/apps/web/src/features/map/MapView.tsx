'use client';
// One map API for every screen. Uses real vector tiles (TileMap) when they load, and falls back to the
// offline schematic (SchematicMap) if WebGL or the tile service is unavailable, so the console never shows
// an empty box. Adds the alert bar (counts per issue type, hazards you can step through) and a legend.
import dynamic from 'next/dynamic';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CATEGORIES, SEVERITY, type CategoryId, type Issue, type LatLon } from '@raightway/core';
import { env } from '@/config/env';
import { ALERT_NOUN, GLYPH, SITE_GLYPH, SITE_NOUN, type SiteKind } from './glyphs';
import SchematicMap from './SchematicMap';

export interface MapStop { at: LatLon; n: number; eta: string; done?: boolean }
export interface MapRoute {
  id: string; category: CategoryId; path: LatLon[]; dim?: boolean;
  /** Numbered stops with ETAs, drawn on the route. */
  stops?: MapStop[];
  /** Where the crew is now. Omit to animate a crew dot along the route. */
  at?: LatLon | null;
  /** A per-truck colour (0-based, wraps at 8 tokens: --route-1…--route-8). Omit to colour by category. */
  tone?: number;
}
/** A planning zone: a City ward or a drawn area. `count`/`worst` drive the light per-zone count layer. */
export interface MapZone { id: string; label: string; short?: string; kind: 'ward' | 'custom'; polygons: LatLon[][]; selected?: boolean; count?: number; worst?: number }
/** Polygon drawing: clicks add vertices, double-click or Enter closes, Esc cancels, Backspace undoes; vertices drag. */
export interface MapDrawing { points: LatLon[]; onPoints: (points: LatLon[]) => void; onClose: () => void; onCancel: () => void }
/** An operating site: drawn as a labelled square badge with its kind's glyph, never like an issue pin. */
export interface MapSite { id: string; lat: number; lon: number; label: string; kind: SiteKind; assumed?: boolean; dim?: boolean }
export interface MapRoadAlert { id: string; lat: number; lon: number; path?: LatLon[]; severity: number; label: string }
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
  /** More bases (transfer stations, works yards), drawn like the depot. */
  depots?: Array<{ lat: number; lon: number; label: string }>;
  /** Road closures and work zones: a stretch when the path is known, else a point. */
  roadAlerts?: MapRoadAlert[];
  /** Operating sites (transfer stations, collection, road and cleaning yards). */
  sites?: MapSite[];
  selectedSiteId?: string | null;
  onSiteSelect?: (id: string) => void;
  /** A click on the map away from any marker (e.g. to place a new site). */
  onMapClick?: (at: LatLon) => void;
  /** Planning zones: outlines, a count label each, the selected ones highlighted and everything outside them dimmed. */
  zones?: MapZone[];
  onZoneSelect?: (id: string) => void;
  /** Drawing a zone: the in-progress ring and its callbacks. While set, clicks add vertices. */
  drawing?: MapDrawing | null;
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
  const drawing = props.drawing;
  // keyboard for drawing: Enter closes the ring, Escape cancels, Backspace removes the last point
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'Enter' && drawing.points.length >= 3) { e.preventDefault(); drawing.onClose(); }
      else if (e.key === 'Escape') { e.preventDefault(); drawing.onCancel(); }
      else if (e.key === 'Backspace' && drawing.points.length) { e.preventDefault(); drawing.onPoints(drawing.points.slice(0, -1)); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [drawing]);
  const engineProps = { ...props, focus, minSpan: hz ? 700 : props.minSpan, bearing: props.bearing ?? (env.basemap !== 'none' ? -17 : 0),
    onMapClick: drawing ? (at: LatLon) => drawing.onPoints([...drawing.points, at]) : props.onMapClick };

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
          {props.sites?.length ? <ul className="map-legend-sites">{[...new Set(props.sites.map(x => x.kind))].map(k => <li key={k} className="site-chip" data-kind={k}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={SITE_GLYPH[k]} /></svg>{SITE_NOUN[k]}</li>)}</ul> : null}
        </div>
      )}
      {!useTiles && env.basemap === 'tiles' ? <span className="map-offline" title="Map tiles are unavailable; showing the offline map">Offline map</span> : null}
    </div>
  );
}
export const MapView = memo(MapViewImpl);
