'use client';
// A dependency-free vector map for any city: projects lat/lon onto a local plane, fits whatever it is
// asked to focus on, and draws an optional offline basemap underneath. Pins and labels keep a constant
// on-screen size at any pane width; labels that would collide or leave the frame are dropped.
import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { CATEGORY, boundsOf, centroid, fitBounds, makeProjector, torontoBasemap, type CategoryId, type Issue, type LatLon } from '@raightway/core';
import { env } from '@/config/env';
import { hit, useSize } from '@/lib/useSize';

export interface MapRoute { id: string; category: CategoryId; path: LatLon[]; dim?: boolean }
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
  label: string;
  /** Smallest span to show, in metres, so a single pin isn't zoomed to street level. */
  minSpan?: number;
  overlay?: ReactNode;
  className?: string;
}

const pts = (a: Array<[number, number]>) => a.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
const path = (a: Array<[number, number]>) => a.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');

function MapViewImpl({ issues, emphasise, selectedId, onSelect, track = [], travelled = 0, vehicle, routes = [], depot, focus, label, minSpan = 500, overlay, className }: MapViewProps) {
  const box = useRef<HTMLDivElement>(null); const svg = useRef<SVGSVGElement>(null);
  const { width, height } = useSize(box);
  const base = env.basemap === 'toronto' ? torontoBasemap() : null;
  const located = useMemo(() => issues.filter(i => i.lat != null && i.lon != null), [issues]);
  const all = useMemo<LatLon[]>(() => [...track, ...located.map(i => [i.lat!, i.lon!] as LatLon), ...routes.flatMap(r => r.path)], [track, located, routes]);
  const proj = useMemo(() => { const c = all.length ? centroid(all) : [43.6532, -79.3832] as LatLon; return makeProjector(c[0], c[1], base?.rotationDeg ?? 0); }, [all, base]);

  const bw = Math.max(1, width), bh = Math.max(1, height);
  const target = focus?.length ? focus : track.length ? track : all;
  const b = boundsOf(target.map(p => proj(p[0], p[1])));
  const [x0, y0, w, h] = b ? fitBounds(b, bw / bh, 0.12, minSpan) : [-500, -350, 1000, 700];
  const k = bw / w; const fs = 10.5 / k, pr = 5 / k;
  const P = (p: LatLon) => proj(p[0], p[1]);
  const trackXY = track.map(P);
  const cut = Math.max(1, Math.round(travelled * (trackXY.length - 1)) + 1);

  // drop labels that collide with each other or the overlay, or leave the frame
  useLayoutEffect(() => {
    const s = svg.current; if (!s) return; const sr = s.getBoundingClientRect(); if (!sr.width) return;
    const blocked = [...(box.current?.querySelectorAll('.map-overlay > *') ?? [])].map(e => e.getBoundingClientRect());
    s.querySelectorAll<SVGTextElement>('.m-label').forEach(t => {
      t.style.display = ''; const r = t.getBoundingClientRect();
      const inside = r.left >= sr.left + 4 && r.right <= sr.right - 4 && r.top >= sr.top + 4 && r.bottom <= sr.bottom - 4;
      if (!inside || blocked.some(o => hit(o, r, 4))) { t.style.display = 'none'; return; }
      blocked.push(r);
    });
  });

  return (
    <div ref={box} className={`mapbox${className ? ` ${className}` : ''}`}>
      {width > 0 && (
        <svg ref={svg} viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label}>
          <rect x={x0} y={y0} width={w} height={h} className="m-ground" />
          {base && <>
            {base.water.map((poly, i) => <polygon key={`w${i}`} className="m-water" points={pts(poly.map(P))} />)}
            {base.parks.map((poly, i) => <polygon key={`p${i}`} className="m-park" points={pts(poly.map(P))} />)}
            {base.streets.filter(s => s.kind === 'street').map(s => <path key={s.name} className="m-st" d={path(s.line.map(P))} />)}
            {base.streets.filter(s => s.kind === 'arterial').map(s => <path key={`c${s.name}`} className="m-art-c" d={path(s.line.map(P))} />)}
            {base.streets.filter(s => s.kind === 'arterial').map(s => <path key={`a${s.name}`} className="m-art" d={path(s.line.map(P))} />)}
            <g>{base.labels.map((l, i) => { const [x, y] = P(l.at); return <text key={i} className="m-label" x={x} y={y} fontSize={fs} textAnchor="middle" dy={-fs * 0.55} transform={l.vertical ? `rotate(-90 ${x} ${y})` : undefined}>{l.text}</text>; })}</g>
          </>}
          {!base && <g className="m-grid">{Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${x0 + (w * i) / 8} ${y0}V${y0 + h}M${x0} ${y0 + (h * i) / 8}H${x0 + w}`} />)}</g>}
          {routes.map(r => <path key={r.id} className={`m-route${r.dim ? ' dim' : ''}`} data-cat={r.category} d={path(r.path.map(P))} />)}
          {trackXY.length > 1 && <><path className="m-track-dim" d={path(trackXY)} /><path className="m-track" d={path(trackXY.slice(0, cut))} /></>}
          {depot && (() => { const [x, y] = P([depot.lat, depot.lon]); return <g className="m-depot" transform={`translate(${x} ${y})`}><rect x={-pr * 1.3} y={-pr * 1.3} width={pr * 2.6} height={pr * 2.6} /><title>{depot.label}</title></g>; })()}
          {located.map(i => {
            const [x, y] = P([i.lat!, i.lon!]); const em = emphasise ? emphasise(i) : true;
            return (
              <g key={i.id} className={`m-pin${em ? '' : ' dim'}${i.id === selectedId ? ' sel' : ''}${i.provisional ? ' prov' : ''}`} data-sev={i.severity}
                role={onSelect ? 'button' : undefined} tabIndex={onSelect && em ? 0 : -1} aria-label={`${CATEGORY[i.category].label}, severity ${i.severity}${i.place ? `, ${i.place}` : ''}`}
                onClick={onSelect ? () => onSelect(i) : undefined} onKeyDown={onSelect ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } } : undefined}>
                <circle cx={x} cy={y} r={em ? pr : pr * 0.7} />
              </g>
            );
          })}
          {vehicle && (() => { const [x, y] = P(vehicle.at); const rot = vehicle.heading + proj.rotationDeg; return <g className="m-car" transform={`translate(${x} ${y}) rotate(${rot})`}><circle r={pr * 2.6} /><path d={`M0 ${-pr * 1.5}L${pr * 1.05} ${pr * 1.2}L0 ${pr * 0.55}L${-pr * 1.05} ${pr * 1.2}Z`} /></g>; })()}
        </svg>
      )}
      {overlay ? <div className="map-overlay">{overlay}</div> : null}
    </div>
  );
}
export const MapView = memo(MapViewImpl);
