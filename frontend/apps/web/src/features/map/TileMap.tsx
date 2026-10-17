'use client';
// The real map: MapLibre GL over keyless CARTO vector tiles, restyled to match the active look.
// Alerts are canvas-drawn glyph markers per issue type × severity, clustered when zoomed out; hazards
// pulse; crew routes draw in and carry moving crew dots; the drive traces behind the vehicle.
// All animation runs in one requestAnimationFrame loop that idles when nothing moves or motion is reduced.
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MLMap, MapMouseEvent, Popup } from 'maplibre-gl';
import type * as Maplibre from 'maplibre-gl';
import type * as GeoJSON from 'geojson';
import { issueLabel, severityDef, type CategoryId, type Issue, type LatLon, type Severity } from '@raightway/core';
import { useUi } from '@/state/ui';
import type { Direction } from '@/config/env';
import { ALERT_NOUN, GLYPH, ROUTE_TONES, SITE_GLYPH, SITE_NOUN, SITE_TOKEN, type SiteKind } from './glyphs';
import { measure, slice } from './geometry';
import type { MapViewProps } from './MapView';

const STYLE: Record<Direction, string> = {
  survey: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  night: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  paint: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
};
const FONT = ['Montserrat Medium', 'Open Sans Bold', 'Noto Sans Regular'];
const CATS = Object.keys(GLYPH) as CategoryId[];
const DASHES = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
type FC = GeoJSON.FeatureCollection;
const fc = (features: GeoJSON.Feature[] = []): FC => ({ type: 'FeatureCollection', features });
const pt = (lon: number, lat: number, properties: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
const ln = (coords: Array<[number, number]>, properties: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties });

let workerSet = false;

/** Colours come from the design tokens, so the map follows the look like everything else. */
function palette() {
  const cs = getComputedStyle(document.documentElement); const v = (n: string) => cs.getPropertyValue(n).trim() || 'gray';
  const cat: Record<CategoryId, string> = { graffiti: v('--c-graffiti'), markings: v('--c-markings'), work_zone: v('--c-workzone'), pavement: v('--c-pavement'), signage: v('--c-signage'), waste: v('--c-waste') };
  const site = Object.fromEntries((Object.keys(SITE_TOKEN) as SiteKind[]).map(k => [k, v(SITE_TOKEN[k])])) as Record<SiteKind, string>;
  const route = Array.from({ length: ROUTE_TONES }, (_, n) => v(`--route-${n + 1}`));
  return { site, route, sev: [1, 2, 3, 4, 5].map(n => v(`--sev-${n}`)), onLo: v('--on-sev-lo'), onHi: v('--on-sev-hi'), cat, accent: v('--accent-text'), accentFill: v('--accent'), ink: v('--ink'), ink2: v('--ink-2'), surface: v('--surface'), bad: v('--bad') };
}

/** A round alert marker: severity fill, issue-type glyph, surface ring. Drawn at 2× for crisp edges. */
function alertImage(cat: CategoryId, sev: number, p: ReturnType<typeof palette>): ImageData {
  const S = 60, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2); g.fillStyle = p.surface; g.fill();
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2); g.fillStyle = p.sev[sev - 1]!; g.fill();
  g.save(); g.translate(S / 2 - 14.4, S / 2 - 14.4); g.scale(1.2, 1.2);
  g.strokeStyle = sev >= 3 ? p.onHi : p.onLo; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(new Path2D(GLYPH[cat])); g.restore();
  return g.getImageData(0, 0, S, S);
}
/** A site badge: rounded square in the kind's colour with its glyph, distinct from round issue pins. Filled when selected. */
function siteImage(kind: SiteKind, p: ReturnType<typeof palette>, selected: boolean): ImageData {
  const S = 52, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!; const col = p.site[kind];
  g.beginPath(); g.roundRect(4, 4, S - 8, S - 8, 7); g.fillStyle = selected ? col : p.surface; g.fill(); g.lineWidth = 3.5; g.strokeStyle = col; g.stroke();
  g.save(); g.translate(S / 2 - 14.4, S / 2 - 14.4); g.scale(1.2, 1.2);
  g.strokeStyle = selected ? p.surface : col; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(new Path2D(SITE_GLYPH[kind])); g.restore();
  return g.getImageData(0, 0, S, S);
}
const routeColor = (r: { tone?: number; category: CategoryId }, p: ReturnType<typeof palette>) => (r.tone != null ? p.route[r.tone % ROUTE_TONES]! : p.cat[r.category]);
function vehicleImage(p: ReturnType<typeof palette>): ImageData {
  const S = 44, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.translate(S / 2, S / 2); g.beginPath(); g.moveTo(0, -15); g.lineTo(11, 12); g.lineTo(0, 6); g.lineTo(-11, 12); g.closePath();
  g.fillStyle = p.ink; g.strokeStyle = p.surface; g.lineWidth = 3; g.lineJoin = 'round'; g.stroke(); g.fill();
  return g.getImageData(0, 0, S, S);
}

function alertCard(i: Issue): HTMLElement {
  const el = document.createElement('div'); el.className = 'map-alert';
  const head = document.createElement('div'); head.className = 'map-alert-h';
  const sev = document.createElement('span'); sev.className = 'sev-dot'; sev.dataset.sev = String(i.severity); sev.textContent = String(i.severity);
  const kind = document.createElement('b'); kind.textContent = ALERT_NOUN[i.category];
  const when = document.createElement('span'); when.className = 'map-alert-when'; when.textContent = severityDef(i.severity as Severity).when;
  head.append(sev, kind, when);
  const d = document.createElement('p'); d.textContent = issueLabel(i);
  const where = document.createElement('p'); where.className = 'muted'; where.textContent = `${i.place ?? ''}${i.sightings > 1 ? `${i.place ? ' · ' : ''}seen ${i.sightings}×` : ''}`;
  el.append(head, d);
  if (i.name?.trim() && i.description !== i.name) { const desc = document.createElement('p'); desc.className = 'muted'; desc.textContent = i.description; el.append(desc); }
  if (where.textContent) el.append(where);
  const tags = [i.source === 'manual' ? 'Operator-reported' : '', i.pinned ? 'Pinned for the next plan' : ''].filter(Boolean).join(' · ');
  if (tags) { const t = document.createElement('p'); t.className = 'map-alert-pin'; t.textContent = tags; el.append(t); }
  return el;
}

export default function TileMap(props: MapViewProps & { onFail: () => void }) {
  const box = useRef<HTMLDivElement>(null); const mapRef = useRef<MLMap | null>(null); const ready = useRef(false);
  const latest = useRef(props); const camera = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const routeAnim = useRef<{ start: number; key: string; cums: number[][] }>({ start: 0, key: '', cums: [] });
  const dir = useUi(s => s.direction);
  useEffect(() => { latest.current = props; });

  // ---- create the map (again when the look changes, keeping the camera)
  useEffect(() => {
    let disposed = false; let map: MLMap | null = null; let popup: Popup | null = null; let ro: ResizeObserver | null = null;
    (async () => {
      let ml: typeof Maplibre;
      try { ml = await import('maplibre-gl'); } catch { latest.current.onFail(); return; }
      if (disposed || !box.current) return;
      if (!workerSet) { ml.setWorkerUrl(new URL('/maplibre/maplibre-gl-worker.mjs', window.location.href).href); workerSet = true; }
      const first = latest.current.focus?.[0] ?? latest.current.track?.[0] ?? [43.6532, -79.3832];
      try {
        map = new ml.Map({
          container: box.current, style: STYLE[dir], center: camera.current?.center ?? [first[1], first[0]], zoom: camera.current?.zoom ?? 13.5,
          bearing: latest.current.bearing ?? 0, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 150,
        });
      } catch { latest.current.onFail(); return; }
      mapRef.current = map;
      const failTimer = setTimeout(() => { if (!ready.current) latest.current.onFail(); }, 9000);
      map.on('error', e => { if (!ready.current) { clearTimeout(failTimer); console.warn('[raightway] map tiles unavailable; using the offline map', e.error?.message); latest.current.onFail(); } });
      ro = new ResizeObserver(() => map?.resize()); ro.observe(box.current);
      map.on('moveend', () => { if (map) camera.current = { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() }; });
      map.on('load', () => {
        if (!map) return; clearTimeout(failTimer); const p = palette();
        // quieter basemap: no POIs or house numbers competing with alerts
        map.getStyle().layers.forEach(l => { if (/poi|housenumber|aeroway/i.test(l.id)) map!.setLayoutProperty(l.id, 'visibility', 'none'); });
        CATS.forEach(c => [1, 2, 3, 4, 5].forEach(s => map!.addImage(`a-${c}-${s}`, alertImage(c, s, p), { pixelRatio: 2 })));
        map.addImage('veh', vehicleImage(p), { pixelRatio: 2 });
        (Object.keys(SITE_GLYPH) as SiteKind[]).forEach(k => { map!.addImage(`site-${k}`, siteImage(k, p, false), { pixelRatio: 2 }); map!.addImage(`site-${k}-sel`, siteImage(k, p, true), { pixelRatio: 2 }); });
        const src = (id: string, extra: Record<string, unknown> = {}) => map!.addSource(id, { type: 'geojson', data: fc(), ...extra });
        src('track'); src('done'); src('stops'); src('routes', { lineMetrics: true }); src('crews'); src('depot'); src('sites'); src('sel'); src('veh'); src('ralerts'); src('zones'); src('zone-mask'); src('zone-labels'); src('draw'); src('draw-pts');
        src('issues', { cluster: true, clusterMaxZoom: 14, clusterRadius: 34, clusterProperties: { maxSev: ['max', ['get', 'sev']], hz: ['+', ['get', 'hz']] } });
        const sevColor = ['match', ['get', 'maxSev'], 1, p.sev[0]!, 2, p.sev[1]!, 3, p.sev[2]!, 4, p.sev[3]!, p.sev[4]!] as unknown as string;
        map.addLayer({ id: 'track', type: 'line', source: 'track', paint: { 'line-color': p.ink2, 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [2, 2] }, layout: { 'line-cap': 'round' } });
        map.addLayer({ id: 'done', type: 'line', source: 'done', paint: { 'line-color': p.accent, 'line-width': 3 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
        // road alerts sit under the routes: closed stretches as thick red bands, the rest as rings
        // planning zones under everything: a light count fill, outlines (drawn zones dashed), the selection, a mask outside it
        map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': p.sev[2]!, 'fill-opacity': ['get', 'fill'] } });
        map.addLayer({ id: 'zone-line', type: 'line', source: 'zones', paint: { 'line-color': ['case', ['==', ['get', 'sel'], 1], p.accentFill, ['==', ['get', 'custom'], 1], p.accentFill, p.ink2], 'line-width': ['case', ['==', ['get', 'sel'], 1], 2.5, 1], 'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.45] } });
        map.addLayer({ id: 'zone-mask', type: 'fill', source: 'zone-mask', paint: { 'fill-color': p.ink, 'fill-opacity': 0.16 } });
        map.addLayer({ id: 'zone-label', type: 'symbol', source: 'zone-labels', layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-optional': true, 'text-max-width': 14 }, paint: { 'text-color': ['case', ['==', ['get', 'sel'], 1], p.accent, p.ink2], 'text-halo-color': p.surface, 'text-halo-width': 1.6 } });
        map.addLayer({ id: 'ralert-line', type: 'line', source: 'ralerts', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': p.bad, 'line-width': ['case', ['>=', ['get', 'sev'], 4], 6, 4], 'line-opacity': ['case', ['>=', ['get', 'sev'], 4], 0.55, 0.3] }, layout: { 'line-cap': 'round' } });
        map.addLayer({ id: 'ralert-pt', type: 'circle', source: 'ralerts', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': p.bad, 'circle-stroke-width': 2, 'circle-stroke-opacity': ['case', ['>=', ['get', 'sev'], 4], 0.9, 0.5] } });
        map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.12, 0.9] }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
        map.addLayer({ id: 'routes-flow', type: 'line', source: 'routes', paint: { 'line-color': p.surface, 'line-width': 1.2, 'line-opacity': 0.85, 'line-dasharray': DASHES[0]! }, layout: { 'line-join': 'round' } });
        // operating sites: square badges per kind, labelled where the name fits (labels drop on collision)
        map.addLayer({ id: 'sites', type: 'symbol', source: 'sites', layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'sel'] }, paint: { 'icon-opacity': ['case', ['==', ['get', 'dim'], 1], 0.4, 1] } });
        map.addLayer({ id: 'sites-label', type: 'symbol', source: 'sites', layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 12 }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': p.surface, 'text-halo-width': 1.8, 'text-opacity': ['case', ['==', ['get', 'dim'], 1], 0.5, 1] } });
        map.addLayer({ id: 'depot', type: 'circle', source: 'depot', paint: { 'circle-radius': 6, 'circle-color': p.ink, 'circle-stroke-color': p.surface, 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'crews', type: 'circle', source: 'crews', paint: { 'circle-radius': 4.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': p.surface, 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: { 'circle-radius': 8, 'circle-color': p.surface, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-opacity': ['case', ['==', ['get', 'done'], 1], 0.55, 1] } });
        map.addLayer({ id: 'stops-n', type: 'symbol', source: 'stops', layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': FONT, 'text-size': 10, 'text-allow-overlap': true }, paint: { 'text-color': p.ink } });
        // ETAs only where they fit: MapLibre's collision detection drops any label that would overlap
        map.addLayer({ id: 'stops-eta', type: 'symbol', source: 'stops', minzoom: 13, layout: { 'text-field': ['get', 'eta'], 'text-font': FONT, 'text-size': 10.5, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': p.ink2, 'text-halo-color': p.surface, 'text-halo-width': 1.6 } });
        map.addLayer({ id: 'hz', type: 'circle', source: 'issues', filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'hz'], 1]], paint: { 'circle-radius': 16, 'circle-color': p.bad, 'circle-opacity': 0.3 } });
        map.addLayer({ id: 'clusters', type: 'circle', source: 'issues', filter: ['has', 'point_count'], paint: { 'circle-color': sevColor, 'circle-radius': ['step', ['get', 'point_count'], 13, 8, 16, 25, 20], 'circle-stroke-color': p.surface, 'circle-stroke-width': 2, 'circle-opacity': 0.92 } });
        map.addLayer({ id: 'cluster-n', type: 'symbol', source: 'issues', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 11.5, 'text-allow-overlap': true }, paint: { 'text-color': ['case', ['>=', ['get', 'maxSev'], 3], p.onHi, p.onLo] } });
        // operator-pinned issues (in the next plan): an ink ring and an accent badge, under the pin itself
        const pinnedOnly = ['all', ['!', ['has', 'point_count']], ['==', ['get', 'pinned'], 1]] as Maplibre.FilterSpecification;
        map.addLayer({ id: 'pinned-ring', type: 'circle', source: 'issues', filter: pinnedOnly, paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': p.ink, 'circle-stroke-width': 2.5 } });
        map.addLayer({ id: 'pins', type: 'symbol', source: 'issues', filter: ['!', ['has', 'point_count']], layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'sev'] }, paint: { 'icon-opacity': ['case', ['==', ['get', 'em'], 1], 1, 0.38] } });
        map.addLayer({ id: 'pinned-badge', type: 'circle', source: 'issues', filter: pinnedOnly, paint: { 'circle-radius': 4.5, 'circle-color': p.accentFill, 'circle-stroke-color': p.surface, 'circle-stroke-width': 1.5, 'circle-translate': [11, -11] } });
        // the selected issue is never clustered: its own larger pin, an accent halo centred on it, and a label
        map.addLayer({ id: 'sel', type: 'circle', source: 'sel', paint: { 'circle-radius': 22, 'circle-color': p.accentFill, 'circle-opacity': 0.16, 'circle-stroke-color': p.accentFill, 'circle-stroke-width': 2.5 } });
        map.addLayer({ id: 'sel-pin', type: 'symbol', source: 'sel', layout: { 'icon-image': ['get', 'icon'], 'icon-size': 1.2, 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
        map.addLayer({ id: 'sel-label', type: 'symbol', source: 'sel', layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11.5, 'text-offset': [0, 2.4], 'text-anchor': 'top', 'text-max-width': 40, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': p.accent, 'text-halo-color': p.surface, 'text-halo-width': 2 } });
        map.addLayer({ id: 'veh', type: 'symbol', source: 'veh', layout: { 'icon-image': 'veh', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });

        // the zone being drawn, on top of everything
        map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': p.accentFill, 'fill-opacity': 0.12 } });
        map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': p.accentFill, 'line-width': 2, 'line-dasharray': [2, 1.5] } });
        map.addLayer({ id: 'draw-pts', type: 'circle', source: 'draw-pts', paint: { 'circle-radius': 6, 'circle-color': p.surface, 'circle-stroke-color': p.accentFill, 'circle-stroke-width': 2 } });
        // alerts: hover for the card, click to select; clusters zoom in
        popup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 18, maxWidth: '280px', className: 'map-pop' });
        const byId = (id: unknown) => latest.current.issues.find(i => i.id === id);
        map.on('mousemove', 'pins', (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
          const f = e.features?.[0]; const i = f && byId(f.properties?.id); if (!i || !map) return;
          map.getCanvas().style.cursor = 'pointer'; popup!.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(alertCard(i)).addTo(map);
        });
        map.on('mouseleave', 'pins', () => { if (map) map.getCanvas().style.cursor = ''; popup?.remove(); });
        for (const layer of ['ralert-line', 'ralert-pt']) {
          map.on('mousemove', layer, (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
            const label = e.features?.[0]?.properties?.label; if (!label || !map) return;
            const el = document.createElement('div'); el.className = 'map-alert'; const b = document.createElement('b'); b.textContent = 'Road alert'; const d = document.createElement('p'); d.textContent = String(label); el.append(b, d);
            popup!.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
          });
          map.on('mouseleave', layer, () => popup?.remove());
        }
        map.on('click', 'pins', (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => { const i = byId(e.features?.[0]?.properties?.id); if (i) latest.current.onSelect?.(i); });
        map.on('mousemove', 'sites', (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
          const f = e.features?.[0]; if (!f || !map) return; map.getCanvas().style.cursor = latest.current.onSiteSelect ? 'pointer' : '';
          const el = document.createElement('div'); el.className = 'map-alert'; const b = document.createElement('b'); b.textContent = String(f.properties?.full ?? '');
          const d = document.createElement('p'); d.className = 'muted'; d.textContent = String(f.properties?.noun ?? ''); el.append(b, d);
          popup!.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(el).addTo(map);
        });
        map.on('mouseleave', 'sites', () => { if (map) map.getCanvas().style.cursor = ''; popup?.remove(); });
        map.on('click', 'sites', (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => { const id = e.features?.[0]?.properties?.id; if (id != null) latest.current.onSiteSelect?.(String(id)); });
        // a click on empty map (e.g. placing a new site)
        map.on('click', (e: MapMouseEvent) => {
          if (!map) return;
          const { onMapClick, drawing, onZoneSelect } = latest.current;
          if (drawing) { if (!map.queryRenderedFeatures(e.point, { layers: ['draw-pts'] }).length) onMapClick?.([e.lngLat.lat, e.lngLat.lng]); return; }
          const hit = map.queryRenderedFeatures(e.point, { layers: ['pins', 'clusters', 'sites', 'sel-pin'].filter(l => map!.getLayer(l)) });
          if (hit.length) return;
          if (onMapClick) { onMapClick([e.lngLat.lat, e.lngLat.lng]); return; }
          const zone = map.queryRenderedFeatures(e.point, { layers: ['zone-fill'] })[0]?.properties?.id;
          if (zone != null) onZoneSelect?.(String(zone));
        });
        // drawing: double-click closes the ring (instead of zooming); vertices drag
        map.on('dblclick', (e: MapMouseEvent) => { const d = latest.current.drawing; if (!d) return; e.preventDefault(); if (d.points.length >= 3) d.onClose(); });
        map.on('mousedown', 'draw-pts', (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
          const n = Number(e.features?.[0]?.properties?.n); if (!map || !Number.isFinite(n)) return;
          e.preventDefault(); map.getCanvas().style.cursor = 'grabbing';
          const move = (ev: MapMouseEvent) => { const d = latest.current.drawing; if (d) d.onPoints(d.points.map((q, k) => (k === n ? [ev.lngLat.lat, ev.lngLat.lng] as LatLon : q))); };
          map.on('mousemove', move);
          map.once('mouseup', () => { map?.off('mousemove', move); if (map) map.getCanvas().style.cursor = ''; });
        });
        map.on('mouseenter', 'draw-pts', () => { if (map) map.getCanvas().style.cursor = 'grab'; });
        map.on('mouseleave', 'draw-pts', () => { if (map) map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'clusters', () => { if (map) map.getCanvas().style.cursor = 'zoom-in'; });
        map.on('mouseleave', 'clusters', () => { if (map) map.getCanvas().style.cursor = ''; });
        map.on('click', 'clusters', async (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
          const f = e.features?.[0]; if (!f || !map) return;
          const zoom = await (map.getSource('issues') as GeoJSONSource).getClusterExpansionZoom(f.properties?.cluster_id as number);
          map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: zoom + 0.3, duration: 500 });
        });
        ready.current = true; routeAnim.current.key = ''; pushAll(); fit(true);
      });
    })();
    return () => { disposed = true; ready.current = false; ro?.disconnect(); popup?.remove(); map?.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  // ---- data
  const setData = (id: string, data: FC) => (mapRef.current?.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  function pushIssues() {
    const { issues, emphasise, selectedId } = latest.current;
    setData('issues', fc(issues.filter(i => i.lat != null && i.lon != null && i.id !== selectedId).map(i => pt(i.lon!, i.lat!, { id: i.id, sev: i.severity, hz: i.severity === 5 ? 1 : 0, icon: `a-${i.category}-${i.severity}`, em: !emphasise || emphasise(i) ? 1 : 0, pinned: i.pinned ? 1 : 0 }))));
    const s = issues.find(i => i.id === selectedId);
    setData('sel', fc(s && s.lat != null && s.lon != null ? [pt(s.lon, s.lat, { id: s.id, icon: `a-${s.category}-${s.severity}`, label: `Selected · ${s.name?.trim() || ALERT_NOUN[s.category]} · S${s.severity}${s.pinned ? ' · Pinned' : ''}` })] : []));
  }
  function pushStatic() {
    const { track = [], depot, depots = [], roadAlerts = [], sites = [], selectedSiteId, zones = [], drawing } = latest.current;
    const closed = (r: LatLon[]) => { const c = r.map(q => [q[1], q[0]] as [number, number]); return c.length ? [...c, c[0]!] : c; };
    setData('zones', fc(zones.map(z => ({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: z.polygons.map(r => [closed(r)]) }, properties: { id: z.id, sel: z.selected ? 1 : 0, custom: z.kind === 'custom' ? 1 : 0, fill: Math.min(0.1, (z.count ?? 0) / 500) } }))));
    const chosen = zones.filter(z => z.selected);
    setData('zone-mask', fc(chosen.length ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...chosen.flatMap(z => z.polygons.map(closed))] }, properties: {} }] : []));
    setData('zone-labels', fc(zones.filter(z => z.count || z.selected).map(z => { const c = z.polygons.flat(); const lat = c.reduce((s, q) => s + q[0], 0) / Math.max(1, c.length), lon = c.reduce((s, q) => s + q[1], 0) / Math.max(1, c.length); return pt(lon, lat, { label: `${z.short ?? z.label}${z.count ? ` · ${z.count}` : ''}`, sel: z.selected ? 1 : 0 }); })));
    const dp = drawing?.points ?? [];
    setData('draw', fc(dp.length >= 3 ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [closed(dp)] }, properties: {} }] : dp.length >= 2 ? [ln(dp.map(q => [q[1], q[0]]))] : []));
    setData('draw-pts', fc(dp.map((q, n) => pt(q[1], q[0], { n }))));
    setData('track', fc(track.length > 1 ? [ln(track.map(p => [p[1], p[0]]))] : []));
    setData('depot', fc([...(depot ? [depot] : []), ...depots].map(d => pt(d.lon, d.lat, { label: d.label }))));
    setData('ralerts', fc(roadAlerts.map(a => (a.path && a.path.length > 1 ? ln(a.path.map(q => [q[1], q[0]]), { sev: a.severity, label: a.label }) : pt(a.lon, a.lat, { sev: a.severity, label: a.label })))));
    const p = palette();
    setData('sites', fc(sites.map(x => pt(x.lon, x.lat, { id: x.id, icon: `site-${x.kind}${x.id === selectedSiteId ? '-sel' : ''}`, sel: x.id === selectedSiteId ? 1 : 0, dim: x.dim ? 1 : 0, label: x.label.replace(/ \(.*\)$/, ''), full: x.label, noun: `${SITE_NOUN[x.kind]}${x.assumed ? ' · assumed location' : ''}`, color: p.site[x.kind] }))));
    setData('stops', fc((latest.current.routes ?? []).filter(r => !r.dim).flatMap(r => (r.stops ?? []).map(st => pt(st.at[1], st.at[0], { n: st.n, eta: st.eta, done: st.done ? 1 : 0, color: routeColor(r, p) })))));
  }
  function pushPlayhead() {
    const { track = [], travelled = 0, vehicle } = latest.current;
    setData('done', fc(track.length > 1 ? [ln(slice(track, travelled).line)] : []));
    setData('veh', fc(vehicle ? [pt(vehicle.at[1], vehicle.at[0], { heading: vehicle.heading })] : []));
  }
  function pushAll() { if (!ready.current) return; pushIssues(); pushStatic(); pushPlayhead(); kick(); }

  // ---- camera: fit whatever we're asked to focus on, only when that changes
  const lastFit = useRef('');
  function fit(force = false) {
    const map = mapRef.current; if (!map || !ready.current) return;
    const { focus, track, issues, minSpan = 500 } = latest.current;
    const pinsAt = issues.filter(i => i.lat != null).map(i => [i.lat!, i.lon!] as LatLon);
    const pts: LatLon[] = focus?.length ? focus : track?.length ? track : pinsAt.length ? pinsAt : (latest.current.sites ?? []).map(x => [x.lat, x.lon] as LatLon);
    const key = pts.length ? `${pts.length}:${pts[0]}:${pts[pts.length - 1]}` : 'none'; if (!force && key === lastFit.current) return; lastFit.current = key;
    if (!pts.length) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity; pts.forEach(([la, lo]) => { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); });
    const padDeg = (minSpan / 111320) / 2; if (n - s < padDeg * 2) { const c = (n + s) / 2; s = c - padDeg; n = c + padDeg; } if (e - w < padDeg * 2) { const c = (e + w) / 2; w = c - padDeg; e = c + padDeg; }
    // extra room at the top for the category chips that overlay the map, so no pin hides under them
    const pad = Math.min(48, Math.round(Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight) / 8));
    map.fitBounds([[w, s], [e, n]], { padding: { top: pad + 36, bottom: pad, left: pad, right: pad }, duration: force ? 0 : 650, maxZoom: 16.5, bearing: latest.current.bearing ?? 0 });
  }

  useEffect(() => { if (ready.current) { pushIssues(); kick(); } }); // cheap: one setData of pins per render
  useEffect(() => { if (ready.current) pushStatic(); }, [props.track, props.depot, props.depots, props.roadAlerts, props.routes, props.sites, props.selectedSiteId, props.zones, props.drawing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) pushPlayhead(); }, [props.travelled, props.vehicle, props.track]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fit(); }); // keyed internally

  // ---- animation: route draw-in, crew traversal, flowing dashes, hazard pulse
  const raf = useRef(0);
  function kick() { if (!raf.current) raf.current = requestAnimationFrame(frame); }
  function frame(now: number) {
    raf.current = 0; const map = mapRef.current; if (!map || !ready.current) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; const p = palette();
    const routes = latest.current.routes ?? []; const ra = routeAnim.current;
    const key = routes.map(r => `${r.id}:${r.path.length}`).join('|');
    if (key !== ra.key) { ra.key = key; ra.start = now; ra.cums = routes.map(r => measure(r.path)); }
    const grow = reduced ? 1 : Math.min(1, (now - ra.start) / 1100); const ease = 1 - (1 - grow) ** 3;
    setData('routes', fc(routes.map((r, k) => ln(slice(r.path, ease, ra.cums[k]).line, { color: routeColor(r, p), dim: r.dim ? 1 : 0 }))));
    const crews = routes.filter(r => !r.dim && r.path.length > 1).map((r) => { const k = routes.indexOf(r); if (r.at) return pt(r.at[1], r.at[0], { color: routeColor(r, p) }); const f = reduced ? 1 : grow < 1 ? ease : ((now / 9000) + k * 0.137) % 1; const at = slice(r.path, f, ra.cums[k]).at; return at ? pt(at[0], at[1], { color: routeColor(r, p) }) : null; }).filter(Boolean) as GeoJSON.Feature[];
    setData('crews', fc(crews));
    const hazards = latest.current.issues.some(i => i.severity === 5);
    if (!reduced) {
      if (routes.length) map.setPaintProperty('routes-flow', 'line-dasharray', DASHES[Math.floor(now / 70) % DASHES.length]!);
      if (hazards) { const ph = (now % 1600) / 1600; map.setPaintProperty('hz', 'circle-radius', 14 + ph * 14); map.setPaintProperty('hz', 'circle-opacity', 0.38 * (1 - ph)); }
    }
    const moving = !reduced && (routes.length > 0 || hazards) && document.visibilityState === 'visible';
    if (moving) raf.current = requestAnimationFrame(frame);
  }
  useEffect(() => { const onVis = () => { if (document.visibilityState === 'visible') kick(); }; document.addEventListener('visibilitychange', onVis); return () => { document.removeEventListener('visibilitychange', onVis); cancelAnimationFrame(raf.current); raf.current = 0; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} className="tilemap" role="region" aria-label={props.label} />;
}

