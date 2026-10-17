'use client';
// Dispatch, map first. The map fills the screen; crews and routes live in a side panel. After a plan
// comes back, a shift clock (08:00–16:00) plays the day: crews move along their routes on the map,
// stops tick off, and each stop shows its ETA, drive time and time on site. Everything is derived from
// the backend's Plan (routes[].stops, eta_min, path) plus work-order minutes, so any solver plugs in.
// Each route starts and ends at its own base when the backend sends one (waste at the nearest transfer
// station, other crews at a works yard). The Roads tab plans closure-aware directions and lists road alerts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, CATEGORY, CATEGORY_FOR_CREW, SHIFT_MINUTES, clamp, enrichPlan, fmtHours, fmtShift, routeHome, summarizeIssues, type CategoryId, type CrewCounts, type CrewType, type Issue, type LatLon, type RouteView } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useDispatch, useHazards, useIssues, useReport } from '@/domain/queries';
import { toast } from '@/state/toast';
import { usePlayback } from '@/state/playback';
import { useCategories } from '@/state/ui';
import { MapView, type MapRoute } from '@/features/map/MapView';
import { IssueCard } from '@/features/issues/IssueCard';
import { Dash } from '@/ui/Dash';
import { Icon } from '@/ui/Icon';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { RoadsPanel, basesOf } from './RoadsPanel';

interface StopView { id: string; n: number; issue?: Issue; at: LatLon | null; arrive: number; depart: number; drive: number }
/** Stop timings for one route: arrive (ETA), depart (ETA + work), and the drive from the previous stop. */
function stopsOf(r: RouteView, byId: Map<string, Issue>): StopView[] {
  let prevDepart = 0;
  return r.stops.map((id, k) => {
    const issue = byId.get(id); const arrive = r.eta_min[k] ?? prevDepart; const depart = arrive + (issue?.work_order?.minutes ?? 30);
    const s = { id, n: k + 1, issue, at: issue && issue.lat != null && issue.lon != null ? [issue.lat, issue.lon] as LatLon : null, arrive, depart, drive: Math.max(0, arrive - prevDepart) };
    prevDepart = depart; return s;
  });
}
/** Where a crew is at minute m: on site during a job, else between the previous point and the next. */
function crewAt(stops: StopView[], end: number, depot: LatLon, m: number): LatLon {
  let from = depot, leave = 0;
  for (const s of stops) {
    if (!s.at) continue;
    if (m < s.arrive) { const f = s.arrive > leave ? (m - leave) / (s.arrive - leave) : 1; return lerp(from, s.at, clamp(f, 0, 1)); }
    if (m < s.depart) return s.at;
    from = s.at; leave = s.depart;
  }
  return m >= end ? depot : lerp(from, depot, clamp((m - leave) / Math.max(1, end - leave), 0, 1));
}
const lerp = (a: LatLon, b: LatLon, f: number): LatLon => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

export function DispatchView() {
  const client = useClient(); const issues = useIssues(); const report = useReport(); const cats = useCategories(); const solve = useDispatch();
  const { selectedIssue, select } = usePlayback();
  const [panel, setPanel] = useState(true); const [tab, setTab] = useState<'crews' | 'routes' | 'roads'>('crews'); const [crew, setCrew] = useState<string | null>(null);
  const roadsOn = client.capabilities.directions;
  const [planned, setPlanned] = useState<{ path: LatLon[]; category: CategoryId } | null>(null); const [alertFocus, setAlertFocus] = useState<LatLon[] | null>(null);
  const sum = useMemo(() => summarizeIssues(issues.data ?? [], cats), [issues.data, cats]);
  const types = CATEGORIES.filter(c => cats.includes(c.id) && sum.jobs[c.crew]).map(c => c.crew);
  const [overrides, setOverrides] = useState<CrewCounts>({});
  const crews: CrewCounts = Object.fromEntries(types.map(t => [t, overrides[t] ?? report.data?.report.crews[t] ?? sum.baselineCrews[t] ?? 1]));
  const total = Object.values(crews).reduce((a, b) => a + (b ?? 0), 0);
  const set = (t: CrewType, d: number) => setOverrides(o => ({ ...o, [t]: Math.max(0, Math.min(12, (crews[t] ?? 0) + d)) }));
  const depot = client.depot();
  const byId = useMemo(() => new Map((issues.data ?? []).map(i => [i.id, i])), [issues.data]);
  const plan = useMemo(() => (solve.data && issues.data ? enrichPlan(solve.data, issues.data, depot) : null), [solve.data, issues.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = useMemo(() => (plan?.routes ?? []).filter(r => r.stops.length).map(r => ({ r, stops: stopsOf(r, byId) })), [plan, byId]);
  const runPlan = () => solve.mutate(crews, { onSuccess: () => { setTab('routes'); setClock(0); setPlaying(true); } });
  // road alerts: the plan's (near its routes) once there is one, else the backend's list near all work
  const liveHazards = useHazards(roadsOn && !plan);
  const hazards = useMemo(() => plan?.hazards ?? liveHazards.data ?? [], [plan?.hazards, liveHazards.data]);
  const bases = useMemo(() => basesOf(plan?.facilities, depot), [plan?.facilities, depot.lat, depot.lon, depot.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const roadAlerts = useMemo(() => (roadsOn ? hazards.map(h => ({ id: h.id, lat: h.lat, lon: h.lon, path: h.path, severity: h.severity, label: h.label })) : []), [hazards, roadsOn]);
  const copyBrief = async (text: string) => { try { await navigator.clipboard.writeText(text); toast({ tone: 'ok', title: 'Crew brief copied', body: 'Paste it into a text or chat to the crew.' }); } catch { toast({ tone: 'bad', title: 'Could not copy', body: 'The browser blocked clipboard access.' }); } };

  // shift clock: plays the day once a plan exists
  const [clock, setClock] = useState(0); const [playing, setPlaying] = useState(false); const [speed, setSpeed] = useState(12);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return; let last = 0;
    const step = (ts: number) => { const dt = last ? (ts - last) / 1000 : 0; last = ts; setClock(c => { const n = c + dt * speed; if (n >= SHIFT_MINUTES) { setPlaying(false); return SHIFT_MINUTES; } return n; }); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step); return () => cancelAnimationFrame(raf.current);
  }, [playing, speed]);

  const routes: MapRoute[] = active.map(({ r, stops }) => ({
    id: r.crew_id, category: r.category, path: r.path, dim: Boolean(crew && crew !== r.crew_id),
    // numbered stops + ETAs for the crew in focus (or every crew when only a few are out), so the overview stays readable
    stops: crew === r.crew_id || (!crew && active.length <= 3) ? stops.filter(s => s.at).map(s => ({ at: s.at!, n: s.n, eta: fmtShift(s.arrive), done: clock >= s.depart })) : undefined,
    at: plan ? crewAt(stops, r.minutes, routeHome(r, depot), clock) : null,
  }));
  if (planned && tab === 'roads') routes.push({ id: 'directions', category: planned.category, path: planned.path });
  const focusRoute = tab === 'roads' && alertFocus ? alertFocus : crew ? active.find(a => a.r.crew_id === crew)?.r.path : undefined;
  const routed = useMemo(() => new Set(active.flatMap(a => a.r.stops)), [active]);
  // once routed, a job is drawn as its crew's numbered stop; pins remain for what is still unrouted
  const mapIssues = useMemo(() => (issues.data ?? []).filter(i => !i.duplicate_of && cats.includes(i.category) && !(plan && routed.has(i.id) && i.id !== selectedIssue)), [issues.data, cats, plan, routed, selectedIssue]);

  if (!client.capabilities.dispatch) return <div className="page-pad"><Empty title="Dispatch is off for this backend">Set capabilities.dispatch to enable it.</Empty></div>;
  return (
    <div className={`dispatch${panel ? '' : ' no-panel'}`}>
      <MapView label="Crew routes and open issues" issues={mapIssues} emphasise={i => !plan || !routed.has(i.id) || i.id === selectedIssue} selectedId={selectedIssue} onSelect={i => select(i.id)}
        routes={routes} depot={plan?.facilities?.length ? null : depot} depots={plan?.facilities?.map(f => ({ lat: f.lat, lon: f.lon, label: f.label }))} roadAlerts={roadAlerts}
        focus={focusRoute} minSpan={900} className="map-fill"
        overlay={plan ? <span className="mapchip num">{fmtShift(clock)} · {active.length} crews out</span> : null} />

      {plan && (
        <div className="shift" role="group" aria-label="Shift playback">
          <button type="button" className="btn btn-primary btn-sm btn-icon" onClick={() => { if (clock >= SHIFT_MINUTES) setClock(0); setPlaying(p => !p); }} aria-label={playing ? 'Pause shift' : 'Play shift'}><Icon name={playing ? 'pause' : 'play'} /></button>
          <span className="tc num">{fmtShift(clock)}</span>
          <input type="range" min={0} max={SHIFT_MINUTES} step={1} value={Math.round(clock)} onChange={e => { setPlaying(false); setClock(Number(e.target.value)); }} aria-label="Shift time" className="shift-range" />
          <span className="num muted small">{fmtShift(SHIFT_MINUTES)}</span>
          <Seg size="sm" label="Shift speed" value={speed} onChange={setSpeed} options={[{ value: 6, label: '1×' }, { value: 12, label: '2×' }, { value: 30, label: '5×' }]} />
        </div>
      )}

      <button type="button" className="panel-toggle btn btn-secondary btn-sm" onClick={() => setPanel(p => !p)} aria-expanded={panel} aria-controls="dispatch-panel">{panel ? 'Hide panel' : 'Crews & routes'}</button>

      <aside id="dispatch-panel" className="dispatch-panel card" aria-label="Crews and routes" hidden={!panel}>
        <div className="toolbar">
          <Seg size="sm" label="Panel" value={tab} onChange={setTab} options={[{ value: 'crews', label: `Crews · ${total}` }, { value: 'routes', label: plan ? `Routes · ${active.length}` : 'Routes' }, ...(roadsOn ? [{ value: 'roads' as const, label: 'Directions' }] : [])]} />
          <button type="button" className="btn btn-primary btn-sm push" onClick={runPlan} disabled={solve.isPending || !total}><Icon name="route" />{solve.isPending ? 'Routing…' : plan ? 'Re-plan' : 'Plan routes'}</button>
        </div>
        <div className="scroll">
          {issues.isPending ? <Loading rows={6} /> : issues.isError ? <Failed error={issues.error} onRetry={() => void issues.refetch()} /> : tab === 'roads' ? (
            liveHazards.isError && !plan ? <Failed compact error={liveHazards.error} onRetry={() => void liveHazards.refetch()} />
              : <RoadsPanel bases={bases} hazards={hazards} issue={selectedIssue ? byId.get(selectedIssue) : undefined} onPath={setPlanned} onFocus={setAlertFocus} />
          ) : tab === 'crews' ? (
            !types.length ? <Empty title="Nothing to dispatch" dash="done">No open jobs in these categories.</Empty> : (
              <div className="crew-list pad-s">{types.map(t => { const c = CATEGORY_FOR_CREW[t]; const base = sum.baselineCrews[t] ?? 0; const n = crews[t] ?? 0; return (
                <div key={t} className="crewrow" data-cat={c}>
                  <span className="g"><Icon name={c} /></span>
                  <div className="crewrow-b"><b>{CATEGORY[c].crewLabel}</b><span className="muted num">{sum.jobs[t]} jobs · {fmtHours(sum.workload[t] ?? 0)} h · baseline {base}</span></div>
                  <span className="stepper"><button type="button" aria-label={`Fewer ${CATEGORY[c].crewLabel} crews`} onClick={() => set(t, -1)}><Icon name="minus" /></button><b className={n < base ? 'under' : undefined} aria-live="polite">{n}</b><button type="button" aria-label={`More ${CATEGORY[c].crewLabel} crews`} onClick={() => set(t, 1)}><Icon name="plus" /></button></span>
                </div>); })}</div>
            )
          ) : solve.isPending ? <div className="solving pad-s"><Dash state="route" size={44} /><span>Routing {total} crews…</span></div>
            : solve.isError ? <Failed compact error={solve.error} onRetry={runPlan} />
            : !plan ? <Empty title="No plan yet">Set the crews, then Plan routes. Hazards go first.</Empty> : (
              <div className="routes pad-s">
                <p className="label">{plan.solver === 'cuopt' ? 'cuOpt' : 'Fallback routing'} · {(plan.solve_ms / 1000).toFixed(1)} s · {plan.jobs_routed} jobs · {plan.crews_needed} of {plan.crews_dispatched} crews needed{plan.matrix_source === 'road' ? ' · street times' : ''}</p>
                {active.map(({ r, stops }) => {
                  const open = crew === r.crew_id; const doneN = stops.filter(s => clock >= s.depart).length; const next = stops.find(s => clock < s.depart);
                  return (
                    <section key={r.crew_id} className={`route-card${open ? ' open' : ''}`} data-cat={r.category}>
                      <button type="button" className="route-h" aria-expanded={open} onClick={() => setCrew(open ? null : r.crew_id)}>
                        <span className="route-id">{r.crew_id}</span><CategoryLabel id={r.category} compact />
                        {r.depot_label ? <span className="route-base muted small">from {r.depot_label}{r.distance_km ? ` · ${r.distance_km.toFixed(1)} km` : ''}</span> : null}
                        {r.warnings?.length ? <span className="route-alerts small" title={r.warnings.map(w => w.label).join('\n')}><Icon name="alert" />{r.warnings.filter(w => w.avoided).length ? `${r.warnings.filter(w => w.avoided).length} avoided · ` : ''}{r.warnings.filter(w => !w.avoided).length} on the way</span> : null}
                        <span className="route-meta num">{doneN}/{stops.length} · back {fmtShift(r.minutes)}</span>
                        <span className="route-bar" aria-hidden="true"><i style={{ width: `${(doneN / Math.max(1, stops.length)) * 100}%` }} /></span>
                        {next ? <span className="route-next muted small">Next: stop {next.n} {clock < next.arrive ? `ETA ${fmtShift(next.arrive)}` : 'on site'}</span> : <span className="route-next muted small">Route complete</span>}
                      </button>
                      {open && (
                        <ol className="track" aria-label={`${r.crew_id} stops`}>
                          <li className="track-depot"><span className="track-dot" /><span>{r.depot_label ?? 'Depot'} · leave {fmtShift(0)}</span></li>
                          {stops.map(s => {
                            const state = clock >= s.depart ? 'done' : clock >= s.arrive ? 'on' : clock >= s.arrive - s.drive ? 'driving' : 'todo';
                            return (
                              <li key={s.id} className={`track-stop ${state}${s.id === selectedIssue ? ' sel' : ''}`}>
                                <span className="track-dot">{s.n}</span>
                                <button type="button" onClick={() => select(s.id)}>
                                  <span className="track-row"><b className="num">{fmtShift(s.arrive)}</b>{s.issue ? <SevDot level={s.issue.severity} /> : null}<span className="track-what">{s.issue?.description ?? s.id}</span></span>
                                  <span className="track-sub muted small num">{s.drive ? `${s.drive} min drive · ` : ''}{s.depart - s.arrive} min on site{s.issue?.place ? ` · ${s.issue.place}` : ''}</span>
                                </button>
                                {state === 'driving' || state === 'on' ? <span className="track-live" aria-hidden="true" /> : null}
                              </li>
                            );
                          })}
                          <li className="track-depot"><span className="track-dot" /><span>Back at {r.depot_label ?? 'depot'} · {fmtShift(r.minutes)}</span></li>
                        </ol>
                      )}
                      {open && (r.warnings?.length || r.maps_urls?.length || r.brief) ? (
                        <div className="route-send">
                          {r.warnings?.length ? <ul className="roads-warn">{r.warnings.map(w => <li key={w.hazard_id} className={w.avoided ? 'avoided' : undefined}><Icon name={w.avoided ? 'check' : 'alert'} /><span>{w.label}</span><span className="muted small">{w.avoided ? 'avoided' : w.source === 'dashcam' ? 'seen on camera' : 'on the way'}</span></li>)}</ul> : null}
                          <div className="route-actions">
                            {r.maps_urls?.map((u, k, all) => <a key={u} className="btn btn-secondary btn-sm" href={u} target="_blank" rel="noreferrer">{all.length > 1 ? `Google Maps ${k + 1}/${all.length}` : 'Open in Google Maps'}</a>)}
                            {r.brief ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyBrief(r.brief!)}>Copy crew brief</button> : null}
                          </div>
                        </div>
                      ) : null}
                    </section>
                  );
                })}
                {plan.unassigned.length ? (<><div className="comp-h mt"><h3>Not routed</h3><Chip tone="hold">{plan.unassigned.length}</Chip></div>
                  <ul className="unassigned">{plan.unassigned.slice(0, 30).map(id => { const i = byId.get(id); return <li key={id}><button type="button" onClick={() => select(id)}>{i ? <CategoryLabel id={i.category} compact /> : null}<span>{i?.description ?? id}</span><span className="muted">{plan.reasons[id]}</span></button></li>; })}</ul></>) : null}
              </div>
            )}
          {selectedIssue && byId.get(selectedIssue) ? <div className="panel-issue"><IssueCard issue={byId.get(selectedIssue)} /></div> : null}
        </div>
      </aside>
    </div>
  );
}
