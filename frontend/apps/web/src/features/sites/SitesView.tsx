'use client';
// Sites: the City operating sites crews leave from and return to (transfer stations, collection yards,
// road-operations yards, street-cleaning yards). Grouped by kind, each with its address, source and the
// trucks it sends out per day per crew type, which Dispatch plans from. Sites can be added (an address,
// or a click on the map), edited and removed; removing a bundled City site is remembered, and Reset
// brings the City list back. Everything persists on the backend (/api/facilities).
import { useMemo, useState } from 'react';
import { CATEGORY, CATEGORY_FOR_CREW, fmtCoord, type CrewType, type Facility, type FacilityKind, type LatLon } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useAddFacility, useFacilities, useGeocode, useRemoveFacility, useResetFacilities, useUpdateFacility } from '@/domain/queries';
import { MapView } from '@/features/map/MapView';
import { SITE_GLYPH, SITE_NOUN } from '@/features/map/glyphs';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/marks';
import { Empty, Failed, Loading } from '@/ui/State';

const KINDS: FacilityKind[] = ['transfer_station', 'collection_yard', 'road_yard', 'cleaning_yard', 'yard'];
const KIND_HOSTS: Record<FacilityKind, CrewType[]> = {
  transfer_station: ['sanitation'], collection_yard: ['sanitation'], road_yard: ['roads', 'inspection', 'markings', 'signage'],
  cleaning_yard: ['sanitation', 'graffiti'], yard: ['roads', 'inspection'],
};
const CREWS: CrewType[] = ['sanitation', 'roads', 'inspection', 'markings', 'signage', 'graffiti'];
const crewName = (c: CrewType) => CATEGORY[CATEGORY_FOR_CREW[c]].crewLabel;
const KIND_PLURAL: Record<FacilityKind, string> = { transfer_station: 'Transfer stations', collection_yard: 'Collection yards', road_yard: 'Road operations yards', cleaning_yard: 'Street-cleaning yards', yard: 'Works yards' };

export function SiteGlyph({ kind }: { kind: FacilityKind }) {
  return <span className="site-badge" data-kind={kind} aria-hidden="true"><svg viewBox="0 0 24 24"><path d={SITE_GLYPH[kind]} /></svg></span>;
}

export function SitesView() {
  const client = useClient(); const sites = useFacilities();
  const update = useUpdateFacility(); const remove = useRemoveFacility(); const reset = useResetFacilities();
  const [selected, setSelected] = useState<string | null>(null); const [confirm, setConfirm] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); const [placing, setPlacing] = useState(false); const [draft, setDraft] = useState<LatLon | null>(null);
  const [panel, setPanel] = useState(true);
  const list = useMemo(() => sites.data ?? [], [sites.data]);
  const groups = useMemo(() => KINDS.map(k => ({ kind: k, items: list.filter(f => f.kind === k).sort((a, b) => a.label.localeCompare(b.label)) })).filter(g => g.items.length), [list]);
  const totals = useMemo(() => { const t: Partial<Record<CrewType, number>> = {}; list.forEach(f => Object.entries(f.vehicles ?? {}).forEach(([c, n]) => { t[c as CrewType] = (t[c as CrewType] ?? 0) + (n ?? 0); })); return t; }, [list]);
  const mapSites = useMemo(() => [...list.map(f => ({ id: f.id, lat: f.lat, lon: f.lon, label: f.label, kind: f.kind, assumed: f.assumed, dim: Boolean(selected && selected !== f.id) })),
    ...(draft ? [{ id: '__draft', lat: draft[0], lon: draft[1], label: 'New site', kind: 'yard' as const }] : [])], [list, selected, draft]);
  const focus = useMemo<LatLon[] | undefined>(() => { const f = list.find(x => x.id === selected); return f ? [[f.lat, f.lon]] : draft ? [draft] : undefined; }, [list, selected, draft]);
  const setTrucks = (f: Facility, crew: CrewType, d: number) => update.mutate({ id: f.id, patch: { vehicles: { ...(f.vehicles ?? {}), [crew]: Math.max(0, Math.min(20, (f.vehicles?.[crew] ?? 0) + d)) } } });

  if (!client.capabilities.sites) return <div className="page-pad"><Empty title="Sites are off for this backend">Set capabilities.sites to enable them.</Empty></div>;
  return (
    <div className={`dispatch sites-desk${panel ? '' : ' no-panel'}${placing ? ' placing' : ''}`}>
      <MapView label="City operating sites" issues={[]} sites={mapSites} selectedSiteId={selected} onSiteSelect={id => { if (id !== '__draft') setSelected(s => (s === id ? null : id)); }}
        onMapClick={placing ? at => { setDraft(at); setPlacing(false); } : undefined} focus={focus} minSpan={focus ? 1500 : 4000} className="map-fill" quiet
        overlay={placing ? <span className="mapchip">Click the map to place the site</span> : <span className="mapchip num">{list.length} sites</span>} />
      <button type="button" className="panel-toggle btn btn-secondary btn-sm" onClick={() => setPanel(p => !p)} aria-expanded={panel} aria-controls="sites-panel">{panel ? 'Hide panel' : 'Sites'}</button>

      <aside id="sites-panel" className="dispatch-panel card" aria-label="Sites" hidden={!panel}>
        <div className="toolbar">
          <span className="label">Sites · {list.length}</span>
          <button type="button" className="btn btn-secondary btn-sm push" onClick={() => { if (window.confirm('Forget every site change and restore the City list?')) reset.mutate(); }} disabled={reset.isPending}><Icon name="refresh" />Reset</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(a => !a)} aria-expanded={adding}><Icon name={adding ? 'x' : 'plus'} />{adding ? 'Close' : 'Add site'}</button>
        </div>
        <div className="scroll">
          {adding ? <AddSite at={draft} placing={placing} onPlace={() => setPlacing(p => !p)} onAt={setDraft} onDone={() => { setAdding(false); setDraft(null); }} /> : null}
          <p className="site-totals small muted pad-s">Trucks per day: {CREWS.filter(c => totals[c]).map(c => `${crewName(c)} ${totals[c]}`).join(' · ') || 'none yet'}. Dispatch plans round trips from these.</p>
          {sites.isPending ? <Loading rows={6} /> : sites.isError ? <Failed error={sites.error} onRetry={() => void sites.refetch()} /> : !list.length ? <Empty title="No sites">Add a site, or Reset to restore the City list.</Empty> : (
            groups.map(g => (
              <section key={g.kind} className="site-group" aria-label={KIND_PLURAL[g.kind]}>
                <h3 className="label site-group-h"><SiteGlyph kind={g.kind} />{KIND_PLURAL[g.kind]} · {g.items.length}</h3>
                <ul className="site-list">
                  {g.items.map(f => {
                    const open = selected === f.id;
                    return (
                      <li key={f.id} className={`site-row${open ? ' open' : ''}`} data-kind={f.kind}>
                        <button type="button" className="site-head" aria-expanded={open} onClick={() => setSelected(open ? null : f.id)}>
                          <span className="site-name">{f.label}</span>
                          <span className="site-sub muted small">{f.address ?? fmtCoord(f.lat, f.lon)}</span>
                          <span className="site-tags">
                            {f.crews.map(c => <span key={c} className="site-crew small" data-cat={CATEGORY_FOR_CREW[c]}>{crewName(c)}{f.vehicles?.[c] ? ` ×${f.vehicles[c]}` : ''}</span>)}
                            {f.assumed ? <Chip tone="hold">Assumed location</Chip> : null}{f.custom ? <Chip tone="info">Added here</Chip> : null}
                          </span>
                        </button>
                        {open && (
                          <div className="site-body">
                            <p className="small muted">{SITE_NOUN[f.kind]} · {fmtCoord(f.lat, f.lon)}</p>
                            <p className="small">Source: {f.source_url ? <a href={f.source_url} target="_blank" rel="noreferrer">{f.source}</a> : f.source}</p>
                            {f.note ? <p className="small muted">{f.note}</p> : null}
                            <p className="label mt">Trucks per day</p>
                            <div className="site-trucks">
                              {f.crews.map(c => { const n = f.vehicles?.[c] ?? 0; return (
                                <div key={c} className="crewrow" data-cat={CATEGORY_FOR_CREW[c]}>
                                  <span className="g"><Icon name={CATEGORY_FOR_CREW[c]} /></span>
                                  <div className="crewrow-b"><b>{crewName(c)}</b></div>
                                  <span className="stepper"><button type="button" aria-label={`Fewer ${crewName(c)} trucks at ${f.label}`} onClick={() => setTrucks(f, c, -1)} disabled={!n}><Icon name="minus" /></button><b aria-live="polite">{n}</b><button type="button" aria-label={`More ${crewName(c)} trucks at ${f.label}`} onClick={() => setTrucks(f, c, 1)} disabled={n >= 20}><Icon name="plus" /></button></span>
                                </div>); })}
                            </div>
                            <div className="route-actions">
                              {confirm === f.id ? (<>
                                <span className="small">Remove {f.label}?</span>
                                <button type="button" className="btn btn-sm btn-danger" onClick={() => { remove.mutate(f); setConfirm(null); setSelected(null); }}>Remove</button>
                                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
                              </>) : <button type="button" className="btn btn-sm btn-secondary" onClick={() => setConfirm(f.id)}><Icon name="x" />Remove site</button>}
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function AddSite({ at, placing, onPlace, onAt, onDone }: { at: LatLon | null; placing: boolean; onPlace: () => void; onAt: (p: LatLon | null) => void; onDone: () => void }) {
  const add = useAddFacility(); const geo = useGeocode(); const client = useClient();
  const [label, setLabel] = useState(''); const [kind, setKind] = useState<FacilityKind>('road_yard'); const [crews, setCrews] = useState<CrewType[]>(KIND_HOSTS.road_yard);
  const [address, setAddress] = useState(''); const [source, setSource] = useState('');
  const [lat, setLat] = useState(''); const [lon, setLon] = useState('');
  const point: LatLon | null = lat && lon && Number.isFinite(+lat) && Number.isFinite(+lon) ? [+lat, +lon] : at;
  // a click on the map fills the coordinates
  const shown = at && !lat && !lon ? at : null;
  const lookup = () => geo.mutate(address, { onSuccess: hit => { if (hit) { setLat(String(hit.lat)); setLon(String(hit.lon)); onAt([hit.lat, hit.lon]); } } });
  const ok = label.trim() && crews.length && point;
  const submit = () => {
    if (!ok || !point) return;
    add.mutate({ label: label.trim(), kind, crews, lat: point[0], lon: point[1], address: address.trim() || null, source: source.trim() || 'Added in the console', vehicles: Object.fromEntries(crews.map(c => [c, 1])) },
      { onSuccess: onDone });
  };
  return (
    <form className="site-add pad-s" onSubmit={e => { e.preventDefault(); submit(); }} aria-label="Add a site">
      <label className="roads-field"><span className="label">Name</span><input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Booth Yard" required /></label>
      <label className="roads-field"><span className="label">Kind</span>
        <select value={kind} onChange={e => { const k = e.target.value as FacilityKind; setKind(k); setCrews(KIND_HOSTS[k]); }}>
          {KINDS.map(k => <option key={k} value={k}>{SITE_NOUN[k]}</option>)}
        </select>
      </label>
      <fieldset className="site-crews"><legend className="label">Crews based here</legend>
        {CREWS.map(c => <label key={c} className="site-check"><input type="checkbox" checked={crews.includes(c)} onChange={e => setCrews(cs => (e.target.checked ? [...cs, c] : cs.filter(x => x !== c)))} />{crewName(c)}</label>)}
      </fieldset>
      <label className="roads-field"><span className="label">Address</span>
        <span className="site-addr"><input value={address} onChange={e => setAddress(e.target.value)} placeholder="Street address in Toronto" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={lookup} disabled={!address.trim() || geo.isPending || client.id === 'mock'} title={client.id === 'mock' ? 'Address lookup needs the live backend' : undefined}>{geo.isPending ? 'Finding…' : 'Find'}</button></span>
      </label>
      {geo.isSuccess && geo.data === null ? <p className="small muted">No match in Toronto. Place it on the map instead.</p> : null}
      <div className="site-coords">
        <label className="roads-field"><span className="label">Lat</span><input inputMode="decimal" value={lat || (shown ? shown[0].toFixed(5) : '')} onChange={e => setLat(e.target.value)} /></label>
        <label className="roads-field"><span className="label">Lon</span><input inputMode="decimal" value={lon || (shown ? shown[1].toFixed(5) : '')} onChange={e => setLon(e.target.value)} /></label>
        <button type="button" className={`btn btn-sm ${placing ? 'btn-primary' : 'btn-secondary'}`} onClick={onPlace} aria-pressed={placing}><Icon name="pin" />{placing ? 'Click the map…' : 'Place on map'}</button>
      </div>
      <label className="roads-field"><span className="label">Source (optional)</span><input value={source} onChange={e => setSource(e.target.value)} placeholder="Where this site is published" /></label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={!ok || add.isPending}><Icon name="check" />{add.isPending ? 'Saving…' : 'Save site'}</button>
    </form>
  );
}
