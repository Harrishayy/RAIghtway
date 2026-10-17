'use client';
// Dispatch, map first. Plan: pick which severities to go for, how many days, and the trucks each site
// sends out per day (or let Nemotron + cuOpt recommend them). Triage: Nemotron (or the rules) decides
// today / later / wait. Routes: cuOpt round trips from each site, a colour per truck, day by day, with
// the full shift (leave, drive, work, lunch, back) and a shift clock that plays the day on the map. The
// header always says which solver answered and whether travel times came from streets. Directions plans
// closure-aware paths and lists road alerts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, CATEGORY_FOR_CREW, SHIFT_MINUTES, fmtShift, inZone, isOpen, routeHome, summarizeIssues, zoneCounts, type Zone, type CategoryId, type CrewType, type Facility, type LatLon, type Route, type Scenario, type ScheduleEntry, type ShiftTotals, type SiteTrucks } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useAddZone, useDispatch, useFacilities, useHazards, useIssues, useLatestPlan, useLatestRecommendation, useRecommend, useRemoveZone, useUpdateFacility, useZones } from '@/domain/queries';
import { toast } from '@/state/toast';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { MapView, type MapDrawing, type MapRoute, type MapSite, type MapZone } from '@/features/map/MapView';
import { IssueCard } from '@/features/issues/IssueCard';
import { Dash } from '@/ui/Dash';
import { Icon } from '@/ui/Icon';
import { CategoryLabel, Chip } from '@/ui/marks';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { PlanPanel, type PlanSettings } from './PlanPanel';
import { RecommendCard } from './RecommendCard';
import { RoadsPanel, basesOf } from './RoadsPanel';
import { RouteList } from './RouteList';
import { TriagePanel } from './TriagePanel';
import { ZonePicker, type DrawState } from './ZonePicker';
import { nameOf, timeline, totalsOf, truckAt } from './schedule';

export interface RouteRow { r: Route & { category: CategoryId }; tl: ScheduleEntry[]; totals: ShiftTotals; tone: number }
type Tab = 'plan' | 'triage' | 'routes' | 'roads';

export function DispatchView() {
  const client = useClient(); const issues = useIssues(); const cats = useCategories();
  const solve = useDispatch(); const latest = useLatestPlan(); const sitesQ = useFacilities(); const updateSite = useUpdateFacility();
  const recommend = useRecommend(); const latestRec = useLatestRecommendation();
  const { selectedIssue, select } = usePlayback();
  const [panel, setPanel] = useState(true); const [tab, setTab] = useState<Tab>('plan'); const [crew, setCrew] = useState<string | null>(null);
  const [settings, setSettings] = useState<PlanSettings>({ floor: 3, days: 1, triage: true }); const [dayPick, setDay] = useState(1);
  const roadsOn = client.capabilities.directions; const sitesOn = client.capabilities.sites;
  const [planned, setPlanned] = useState<{ path: LatLon[]; category: CategoryId } | null>(null); const [alertFocus, setAlertFocus] = useState<LatLon[] | null>(null);
  const sum = useMemo(() => summarizeIssues(issues.data ?? [], cats), [issues.data, cats]);
  const open = useMemo(() => (issues.data ?? []).filter(i => (isOpen(i) || i.pinned) && cats.includes(i.category)), [issues.data, cats]);
  const crewTypes = CATEGORIES.filter(c => cats.includes(c.id) && sum.jobs[c.crew]).map(c => c.crew);
  const sites = useMemo(() => sitesQ.data ?? [], [sitesQ.data]);
  // focus zones: wards and saved areas by id, plus an unsaved drawn area used for one plan
  const zonesQ = useZones(); const addZone = useAddZone(); const removeZone = useRemoveZone(); const zonesOn = client.capabilities.zones;
  const zones = useMemo(() => zonesQ.data ?? [], [zonesQ.data]);
  const [focusIds, setFocusIds] = useState<string[]>([]); const [draw, setDraw] = useState<DrawState | null>(null); const [inline, setInline] = useState<LatLon[] | null>(null);
  const zoneN = useMemo(() => zoneCounts(zones, open), [zones, open]);
  const focusZones: Array<Pick<Zone, 'polygons'>> = useMemo(() => [...zones.filter(z => focusIds.includes(z.id)), ...(inline ? [{ polygons: [inline] }] : [])], [zones, focusIds, inline]);
  const pinnedOutside = focusZones.length ? open.filter(i => i.pinned && i.lat != null && i.lon != null && !focusZones.some(z => inZone([i.lat!, i.lon!], z))).length : 0;
  const toggleZone = (id: string) => setFocusIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]));
  const crewKey = crewTypes.join();
  const trucks: SiteTrucks = useMemo(() => Object.fromEntries(sites.map(f => [f.id, { ...(f.vehicles ?? {}) }])), [sites]);
  const visibleTrucks: SiteTrucks = useMemo(() => Object.fromEntries(Object.entries(trucks).map(([id, t]) => [id, Object.fromEntries(Object.entries(t).filter(([c]) => crewTypes.includes(c as CrewType)))])), [trucks, crewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Object.values(visibleTrucks).reduce((s, t) => s + Object.values(t).reduce((a, b) => a + (b ?? 0), 0), 0);
  const depot = client.depot();
  const byId = useMemo(() => new Map((issues.data ?? []).map(i => [i.id, i])), [issues.data]);
  const plan = solve.data ?? latest.data ?? null;
  const rec = recommend.data ?? latestRec.data ?? null;
  const horizon = plan?.days?.length ? Math.max(...plan.days.map(d => d.day)) : 1;
  const day = dayPick > horizon ? 1 : dayPick;

  // a colour per truck, the same on every day of the plan
  const tones = useMemo(() => { const ids = [...new Set((plan?.routes ?? []).filter(r => r.stops.length).map(r => r.vehicle_id ?? r.crew_id))].sort(); return new Map(ids.map((id, k) => [id, k])); }, [plan]);
  const rows: RouteRow[] = useMemo(() => (plan?.routes ?? []).filter(r => r.stops.length && (r.day ?? 1) === day).map(r => {
    const tl = timeline(r, byId, routeHome(r, depot));
    return { r: { ...r, category: CATEGORY_FOR_CREW[r.crew] }, tl, totals: totalsOf(r, tl), tone: (tones.get(r.vehicle_id ?? r.crew_id) ?? 0) % 8 + 1 };
  }), [plan, day, byId, tones]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (extra: { scenario?: Scenario; floor?: number } = {}) => {
    const floor = extra.floor ?? settings.floor;
    const opts = sitesOn ? { sites: extra.scenario?.sites ?? visibleTrucks, days: settings.days, min_severity: floor, triage: settings.triage,
      ...(focusIds.length ? { zones: focusIds } : {}), ...(inline ? { polygon: inline } : {}),
      ...(extra.scenario && rec ? { scenario: { recommendation_id: rec.id, scenario_id: extra.scenario.id } } : {}) } : undefined;
    const crews = Object.fromEntries(crewTypes.map(t => [t, sum.baselineCrews[t] ?? 1]));
    solve.mutate({ crews, opts }, { onSuccess: () => { setTab('routes'); setDay(1); setClock(0); setPlaying(true); } });
  };
  const setTrucks = (f: Facility, crewType: CrewType, n: number) => updateSite.mutate({ id: f.id, patch: { vehicles: { ...(f.vehicles ?? {}), [crewType]: Math.max(0, Math.min(20, n)) } } });
  const apply = (s: Scenario) => {
    setSettings(v => ({ ...v, floor: s.min_severity }));
    for (const f of sites) {
      const want = Object.fromEntries(f.crews.map(c => [c, s.sites[f.id]?.[c] ?? 0])); const have = f.vehicles ?? {};
      if (f.crews.some(c => (have[c] ?? 0) !== want[c])) updateSite.mutate({ id: f.id, patch: { vehicles: want } });
    }
    toast({ tone: 'ok', title: `Applied: ${s.label}`, body: `Floor S${s.min_severity}+, trucks per site updated.` });
  };
  const runRecommend = () => recommend.mutate({ days: settings.days, min_severity: settings.floor, sites: visibleTrucks, ...(focusIds.length ? { zones: focusIds } : {}), ...(inline ? { polygon: inline } : {}) });

  // road alerts: the plan's (near its routes) once there is one, else the backend's list near all work
  const liveHazards = useHazards(roadsOn && !plan);
  const hazards = useMemo(() => plan?.hazards ?? liveHazards.data ?? [], [plan?.hazards, liveHazards.data]);
  const bases = useMemo(() => basesOf(plan?.facilities?.length ? plan.facilities : sites, depot), [plan?.facilities, sites, depot.lat, depot.lon, depot.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const roadAlerts = useMemo(() => (roadsOn ? hazards.map(h => ({ id: h.id, lat: h.lat, lon: h.lon, path: h.path, severity: h.severity, label: h.label })) : []), [hazards, roadsOn]);
  const copyBrief = async (text: string) => { try { await navigator.clipboard.writeText(text); toast({ tone: 'ok', title: 'Run sheet copied', body: 'Paste it into a text or chat to the crew.' }); } catch { toast({ tone: 'bad', title: 'Could not copy', body: 'The browser blocked clipboard access.' }); } };

  // shift clock: plays the chosen day once a plan exists
  const [clock, setClock] = useState(0); const [playing, setPlaying] = useState(false); const [speed, setSpeed] = useState(12);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return; let last = 0;
    const step = (ts: number) => { const dt = last ? (ts - last) / 1000 : 0; last = ts; setClock(c => { const n = c + dt * speed; if (n >= SHIFT_MINUTES) { setPlaying(false); return SHIFT_MINUTES; } return n; }); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step); return () => cancelAnimationFrame(raf.current);
  }, [playing, speed]);

  const routes: MapRoute[] = rows.map(({ r, tl, tone }) => ({
    id: r.crew_id, category: r.category, path: r.path, dim: Boolean(crew && crew !== r.crew_id), tone: tone - 1,
    // numbered stops + ETAs for the truck in focus (or every truck when only a few are out), so the overview stays readable
    stops: crew === r.crew_id || (!crew && rows.length <= 3) ? tl.filter(e => e.kind === 'job').map((e, k) => ({ at: [e.lat, e.lon] as LatLon, n: k + 1, eta: fmtShift(e.arrive_min), done: clock >= e.depart_min })) : undefined,
    at: truckAt(tl, clock),
  }));
  if (planned && tab === 'roads') routes.push({ id: 'directions', category: planned.category, path: planned.path });
  const focusRoute = tab === 'roads' && alertFocus ? alertFocus : crew ? rows.find(a => a.r.crew_id === crew)?.r.path
    : draw?.points.length ? undefined : focusZones.length && !rows.length ? focusZones.flatMap(z => z.polygons.flat()) : undefined;
  const routed = useMemo(() => new Set((plan?.routes ?? []).flatMap(r => r.stops)), [plan]);
  const routedToday = useMemo(() => new Set(rows.flatMap(a => a.r.stops)), [rows]);
  // once routed, a job is drawn as its truck's numbered stop; pins remain for what is still unrouted
  const mapIssues = useMemo(() => (issues.data ?? []).filter(i => !i.duplicate_of && cats.includes(i.category) && !(plan && routedToday.has(i.id) && i.id !== selectedIssue)), [issues.data, cats, plan, routedToday, selectedIssue]);
  const usedSites = useMemo(() => new Set(rows.map(a => a.r.facility_id)), [rows]);
  const mapSites: MapSite[] = useMemo(() => {
    const shown = sites.length ? sites.filter(f => Object.values(f.vehicles ?? {}).some(n => n) || usedSites.has(f.id)) : plan?.facilities ?? [];
    return shown.map(f => ({ id: f.id, lat: f.lat, lon: f.lon, label: f.label, kind: f.kind, assumed: f.assumed, dim: Boolean(plan && rows.length && !usedSites.has(f.id)) }));
  }, [sites, plan, rows.length, usedSites]);
  const pinnedDeferred = useMemo(() => (plan?.triage?.decisions ?? []).filter(d => d.pinned && d.decision === 'defer'), [plan]);
  // zones on the map: while planning (with job counts) or whenever a focus is set; outside the focus is dimmed
  const showZones = zonesOn && (tab === 'plan' || focusIds.length > 0 || Boolean(inline) || Boolean(draw));
  const mapZones: MapZone[] = useMemo(() => !showZones ? [] : [
    ...zones.filter(z => tab === 'plan' || focusIds.includes(z.id)).map(z => ({ id: z.id, label: z.label, short: z.kind === 'ward' ? `W${z.code ?? ''}` : z.label, kind: z.kind, polygons: z.polygons, selected: focusIds.includes(z.id), count: zoneN.get(z.id)?.n, worst: zoneN.get(z.id)?.worst })),
    ...(inline ? [{ id: 'drawn', label: 'Drawn area', kind: 'custom' as const, polygons: [inline], selected: true }] : []),
    ...(draw?.closed ? [{ id: '__draft', label: 'New area', kind: 'custom' as const, polygons: [draw.points], selected: true }] : []),
  ], [showZones, zones, tab, focusIds, zoneN, inline, draw]);
  const drawing: MapDrawing | null = draw && !draw.closed ? { points: draw.points, onPoints: points => setDraw({ points, closed: false }), onClose: () => setDraw(d => (d && d.points.length >= 3 ? { ...d, closed: true } : d)), onCancel: () => setDraw(null) } : null;
  const solverLabel = plan ? (plan.solver === 'cuopt' ? 'cuOpt' : 'Fallback routing') : '';

  if (!client.capabilities.dispatch) return <div className="page-pad"><Empty title="Dispatch is off for this backend">Set capabilities.dispatch to enable it.</Empty></div>;
  return (
    <div className={`dispatch${panel ? '' : ' no-panel'}`}>
      <MapView label="Crew routes, sites and open issues" issues={mapIssues} emphasise={i => !plan || !routed.has(i.id) || i.id === selectedIssue} selectedId={selectedIssue} onSelect={i => select(i.id)}
        routes={routes} depot={mapSites.length ? null : depot} sites={mapSites} roadAlerts={roadAlerts}
        zones={mapZones} onZoneSelect={tab === 'plan' ? id => { if (id !== 'drawn' && id !== '__draft') toggleZone(id); } : undefined} drawing={drawing}
        focus={focusRoute} minSpan={900} className="map-fill"
        overlay={plan ? <span className="mapchip num">{horizon > 1 ? `Day ${day} · ` : ''}{fmtShift(clock)} · {rows.length} trucks out</span> : null} />

      {plan && (
        <div className="shift" role="group" aria-label="Shift playback">
          <button type="button" className="btn btn-primary btn-sm btn-icon" onClick={() => { if (clock >= SHIFT_MINUTES) setClock(0); setPlaying(p => !p); }} aria-label={playing ? 'Pause shift' : 'Play shift'}><Icon name={playing ? 'pause' : 'play'} /></button>
          <span className="tc num">{fmtShift(clock)}</span>
          <input type="range" min={0} max={SHIFT_MINUTES} step={1} value={Math.round(clock)} onChange={e => { setPlaying(false); setClock(Number(e.target.value)); }} aria-label="Shift time" className="shift-range" />
          <span className="num muted small">{fmtShift(SHIFT_MINUTES)}</span>
          <Seg size="sm" label="Shift speed" value={speed} onChange={setSpeed} options={[{ value: 6, label: '1×' }, { value: 12, label: '2×' }, { value: 30, label: '5×' }]} />
        </div>
      )}

      <button type="button" className="panel-toggle btn btn-secondary btn-sm" onClick={() => setPanel(p => !p)} aria-expanded={panel} aria-controls="dispatch-panel">{panel ? 'Hide panel' : 'Plan & routes'}</button>

      <aside id="dispatch-panel" className="dispatch-panel card" aria-label="Plan and routes" hidden={!panel}>
        <div className="toolbar">
          <Seg size="sm" label="Panel" value={tab} onChange={setTab} options={[{ value: 'plan', label: 'Plan' }, { value: 'triage', label: 'Triage' }, { value: 'routes', label: plan ? `Routes · ${rows.length}` : 'Routes' }, ...(roadsOn ? [{ value: 'roads' as const, label: 'Roads' }] : [])]} />
          <button type="button" className="btn btn-primary btn-sm push" onClick={() => go()} disabled={solve.isPending || (sitesOn ? !total : !crewTypes.length)}><Icon name="route" />{solve.isPending ? 'Routing…' : plan ? 'Re-plan' : 'Plan routes'}</button>
        </div>
        <div className="scroll">
          {issues.isPending ? <Loading rows={6} /> : issues.isError ? <Failed error={issues.error} onRetry={() => void issues.refetch()} /> : tab === 'roads' ? (
            liveHazards.isError && !plan ? <Failed compact error={liveHazards.error} onRetry={() => void liveHazards.refetch()} />
              : <RoadsPanel bases={bases} hazards={hazards} issue={selectedIssue ? byId.get(selectedIssue) : undefined} onPath={setPlanned} onFocus={setAlertFocus} />
          ) : tab === 'plan' ? (<>
            {client.capabilities.recommend ? <div className="pad-s"><RecommendCard rec={rec} running={recommend.isPending} planning={solve.isPending} onRun={runRecommend} onApply={apply} onApplyPlan={s => { apply(s); go({ scenario: s, floor: s.min_severity }); }} /></div> : null}
            {zonesOn ? <div className="pad-s zone-pad"><ZonePicker zones={zones} counts={zoneN} selected={focusIds} onToggle={toggleZone} onClear={() => setFocusIds([])}
              draw={draw} onDraw={() => setDraw({ points: [], closed: false })} onUndo={() => setDraw(d => (d ? { ...d, points: d.points.slice(0, -1) } : d))}
              onClose={() => setDraw(d => (d && d.points.length >= 3 ? { ...d, closed: true } : d))} onCancel={() => setDraw(null)}
              onSave={label => { if (draw) addZone.mutate({ label, polygon: draw.points }, { onSuccess: z => { setFocusIds(ids => [...ids, z.id]); setDraw(null); } }); }}
              onUseOnce={() => { if (draw) { setInline(draw.points); setDraw(null); } }} inline={Boolean(inline)} onClearInline={() => setInline(null)}
              onRemove={z => { removeZone.mutate(z); setFocusIds(ids => ids.filter(x => x !== z.id)); }} pinnedOutside={pinnedOutside} /></div> : null}
            {sitesOn && sitesQ.isError ? <Failed compact error={sitesQ.error} onRetry={() => void sitesQ.refetch()} /> : sitesOn && sitesQ.isPending ? <Loading rows={4} /> : (
              <PlanPanel settings={settings} onSettings={setSettings} open={open} sites={sites} trucks={trucks} onTrucks={setTrucks} crewTypes={crewTypes} />
            )}
          </>) : tab === 'triage' ? (
            <TriagePanel triage={plan?.triage} byId={byId} onSelect={select} routed={routed} />
          ) : solve.isPending ? <div className="solving pad-s"><Dash state="route" size={44} /><span>{settings.triage ? 'Nemotron triaging, then ' : ''}cuOpt routing {total} trucks over {settings.days} day{settings.days > 1 ? 's' : ''}…</span></div>
            : solve.isError ? <Failed compact error={solve.error} onRetry={() => go()} />
            : !plan ? <Empty title="No plan yet">Set what to go for and the trucks per site, then Plan routes.</Empty> : (
              <div className="routes pad-s">
                <p className="label">{solverLabel} · {(plan.solve_ms / 1000).toFixed(1)} s{plan.matrix_source === 'road' ? ' · street times' : ' · straight-line times'} · triage {plan.triage ? (plan.triage.model === 'rules' ? 'by rules' : plan.triage.model_name ?? plan.triage.model) : 'off'}{plan.scenario_id ? ' · recommended scenario' : ''}</p>
                {horizon > 1 ? <Seg size="sm" label="Day" value={day} onChange={d => { setDay(d); setClock(0); setCrew(null); }} options={(plan.days ?? []).map(d => ({ value: d.day, label: `Day ${d.day} · ${d.jobs}` }))} /> : null}
                {(() => { const d = plan.days?.find(x => x.day === day); return d ? <p className="small muted num">{d.jobs} jobs · {d.trucks} trucks · {Math.round(d.drive_min / 6) / 10} h driving · {Math.round(d.work_min / 6) / 10} h on site{d.distance_km ? ` · ${d.distance_km} km` : ''} · last back {fmtShift(d.last_back_min)}{d.solver === 'fallback' ? ' · fallback router' : ''}</p> : null; })()}
                {plan.zone_labels?.length ? <p className="small muted">Focus: {plan.zone_labels.join(', ')}{plan.outside_zone ? ` · ${plan.outside_zone} open jobs outside left out` : ''}</p> : null}
                {pinnedDeferred.length ? <p className="small rec-caveat"><Icon name="alert" />{pinnedDeferred.length} pinned job{pinnedDeferred.length > 1 ? 's' : ''} not planned: {pinnedDeferred[0]!.reason}</p> : null}
                {!rows.length ? <Empty title="No trucks out this day">Nothing left to do, or no trucks for these jobs.</Empty> : null}
                <RouteList rows={rows} clock={clock} open={crew} onOpen={setCrew} selectedIssue={selectedIssue} onSelect={select} byId={byId} onCopy={t => void copyBrief(t)} />
                {plan.unassigned.length ? (<><div className="comp-h mt"><h3>Not reached</h3><Chip tone="hold">{plan.unassigned.length}</Chip></div>
                  <ul className="unassigned">{plan.unassigned.slice(0, 30).map(id => { const i = byId.get(id); return <li key={id}><button type="button" onClick={() => select(id)}>{i ? <CategoryLabel id={i.category} compact /> : null}<span>{nameOf(i) ?? id}</span><span className="muted">{plan.unassigned_reasons?.[id] ?? 'Shift full'}</span></button></li>; })}</ul></>) : null}
                {plan.deferred?.length ? <p className="small muted mt">{plan.deferred.length} jobs wait (below the floor or beyond capacity). See Triage for the reasons.</p> : null}
              </div>
            )}
          {selectedIssue && byId.get(selectedIssue) ? <div className="panel-issue"><IssueCard issue={byId.get(selectedIssue)} /></div> : null}
        </div>
      </aside>
    </div>
  );
}
