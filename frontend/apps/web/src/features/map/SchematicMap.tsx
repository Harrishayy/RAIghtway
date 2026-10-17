'use client';
// Offline fallback map: dependency-free SVG for any city. Projects lat/lon onto a local plane, fits the
// focus, and draws the optional Toronto schematic underneath. Same alerts, ETAs and animations as the
// tile map; labels that would collide or leave the frame are dropped.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { CATEGORY, boundsOf, centroid, fitBounds, makeProjector, torontoBasemap, type LatLon } from '@raightway/core';
import { env } from '@/config/env';
import { hit, useSize } from '@/lib/useSize';

import type { MapViewProps } from './MapView';
import { GLYPH } from './glyphs';

const pts = (a: Array<[number, number]>) => a.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
const path = (a: Array<[number, number]>) => a.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');

export default function SchematicMap({ issues, emphasise, selectedId, onSelect, track = [], travelled = 0, vehicle, routes = [], depot, depots = [], roadAlerts = [], focus, label, minSpan = 500 }: MapViewProps) {
  const box = useRef<HTMLDivElement>(null); const svg = useRef<SVGSVGElement>(null);
  const { width, height } = useSize(box);
  const base = env.basemap === 'none' ? null : torontoBasemap();
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
    const blocked = [...(box.current?.closest('.mapbox')?.querySelectorAll('.map-overlay > *, .map-legend') ?? [])].map(e => e.getBoundingClientRect());
    s.querySelectorAll<SVGTextElement>('.m-label').forEach(t => {
      t.style.display = ''; const r = t.getBoundingClientRect();
      const inside = r.left >= sr.left + 4 && r.right <= sr.right - 4 && r.top >= sr.top + 4 && r.bottom <= sr.bottom - 4;
      if (!inside || blocked.some(o => hit(o, r, 4))) { t.style.display = 'none'; return; }
      blocked.push(r);
    });
  });

  return (
    <div ref={box} className="schematic">
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
          {roadAlerts.map(a => a.path && a.path.length > 1
            ? <path key={`ra-${a.id}`} className={`m-ralert${a.severity >= 4 ? ' hard' : ''}`} d={path(a.path.map(P))}><title>{a.label}</title></path>
            : (() => { const [x, y] = P([a.lat, a.lon]); return <circle key={`ra-${a.id}`} className={`m-ralert-pt${a.severity >= 4 ? ' hard' : ''}`} cx={x} cy={y} r={pr * 1.1}><title>{a.label}</title></circle>; })())}
          {routes.map(r => <path key={`${r.id}:${r.path.length}`} className={`m-route${r.dim ? ' dim' : ''}`} data-cat={r.category} d={path(r.path.map(P))} pathLength={1} />)}
          {routes.filter(r => !r.dim).flatMap(r => (r.stops ?? []).map(st => { const [x, y] = P(st.at); return <g key={`${r.id}-${st.n}`} className={`m-stop${st.done ? ' done' : ''}`} data-cat={r.category} transform={`translate(${x} ${y})`}><circle r={pr * 1.6} /><text fontSize={pr * 1.9} textAnchor="middle" dy={pr * 0.65}>{st.n}</text><title>{`Stop ${st.n} · ETA ${st.eta}`}</title></g>; }))}
          {routes.filter(r => r.at && !r.dim).map(r => { const [x, y] = P(r.at!); return <circle key={`crew-${r.id}`} className="m-crew" data-cat={r.category} cx={x} cy={y} r={pr * 1.1} />; })}
          {trackXY.length > 1 && <><path className="m-track-dim" d={path(trackXY)} /><path className="m-track" d={path(trackXY.slice(0, cut))} /></>}
          {[...(depot ? [depot] : []), ...depots].map(d => { const [x, y] = P([d.lat, d.lon]); return <g key={`d-${d.label}`} className="m-depot" transform={`translate(${x} ${y})`}><rect x={-pr * 1.3} y={-pr * 1.3} width={pr * 2.6} height={pr * 2.6} /><title>{d.label}</title></g>; })}
          {located.map(i => {
            const [x, y] = P([i.lat!, i.lon!]); const em = emphasise ? emphasise(i) : true;
            return (
              <g key={i.id} className={`m-pin${em ? '' : ' dim'}${i.id === selectedId ? ' sel' : ''}${i.provisional ? ' prov' : ''}`} data-sev={i.severity}
                role={onSelect ? 'button' : undefined} tabIndex={onSelect && em ? 0 : -1} aria-label={`${CATEGORY[i.category].label}, severity ${i.severity}${i.place ? `, ${i.place}` : ''}`}
                onClick={onSelect ? () => onSelect(i) : undefined} onKeyDown={onSelect ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } } : undefined}>
                {i.severity === 5 && em ? <circle className="m-hz" cx={x} cy={y} r={pr * 2.2} /> : null}
                <circle cx={x} cy={y} r={(em ? pr : pr * 0.7) * 1.45} />
                {em ? <path className="m-glyph" d={GLYPH[i.category]} transform={`translate(${x - pr * 0.95} ${y - pr * 0.95}) scale(${(pr * 1.9) / 24})`} /> : null}
              </g>
            );
          })}
          {vehicle && (() => { const [x, y] = P(vehicle.at); const rot = vehicle.heading + proj.rotationDeg; return <g className="m-car" transform={`translate(${x} ${y}) rotate(${rot})`}><circle r={pr * 2.6} /><path d={`M0 ${-pr * 1.5}L${pr * 1.05} ${pr * 1.2}L0 ${pr * 0.55}L${-pr * 1.05} ${pr * 1.2}Z`} /></g>; })()}
        </svg>
      )}
    </div>
  );
}
