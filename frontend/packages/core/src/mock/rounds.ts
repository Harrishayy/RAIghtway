// Sample-data stand-ins for the backend's sites, triage, round trips and workforce recommendation
// (backend/app/planning: facilities, triage, dispatch, recommend). Same output shapes, computed with simple
// rules and a nearest-neighbour router, and labelled as such: solver "fallback", triage and agent "rules".
import type { CrewType, Facility, Issue, LatLon, Zone, Plan, PlanDay, Recommendation, Route, Scenario, ScenarioMetrics, ScheduleEntry, SiteTrucks, Triage, TriageDecision } from '../types';
import { CREW_FOR } from '../registry';
import { haversineKm, travelMinutes } from '../format';
import { inZone } from '../geo/zones';

/** Real City of Toronto sites near the sample drives (the backend bundles the full list with sources). */
export const MOCK_SITES: Facility[] = [
  { id: 'ry-wellington', label: 'Wellington Yard (Transportation Services)', kind: 'road_yard', crews: ['roads', 'inspection'], lat: 43.6414, lon: -79.40706, address: '677 Wellington St W, Toronto', source: 'City of Toronto media advisory, 2025-02-11', source_url: 'https://www.toronto.ca/news/city-of-toronto-to-discuss-plans-and-operations-for-upcoming-winter-storms/', assumed: false, vehicles: { roads: 2, inspection: 1 } },
  { id: 'ry-leslie', label: 'Leslie Street Yard (Depot 6)', kind: 'road_yard', crews: ['roads', 'inspection'], lat: 43.6554, lon: -79.32491, address: '7 Leslie St, Toronto', source: 'City of Toronto media advisory, 2023-10-15', source_url: 'https://www.toronto.ca/news/city-of-toronto-to-provide-update-on-winter-weather-readiness-plan/', assumed: false, vehicles: { roads: 1, inspection: 1 } },
  { id: 'cl-eastern', label: '433 Eastern Yard (Transportation Services)', kind: 'cleaning_yard', crews: ['sanitation', 'graffiti', 'roads', 'inspection', 'signage'], lat: 43.65707, lon: -79.34362, address: '433 Eastern Ave, Toronto', source: 'Doors Open Toronto listing; TS telephone directory (2026-03-01)', source_url: 'https://www.doorsopenontario.on.ca/toronto/433-eastern-yard', assumed: false, vehicles: { sanitation: 1, graffiti: 1, signage: 1 } },
  { id: 'cl-yonge', label: 'Yonge Yard - Public Space Cleaning (SWMS)', kind: 'cleaning_yard', crews: ['graffiti', 'sanitation'], lat: 43.67581, lon: -79.39032, address: '1008 Yonge St, Toronto ON M4W 2K1', source: 'City of Toronto SWMS telephone directory (2026-03-01)', source_url: 'https://www.toronto.ca/wp-content/uploads/2017/12/95e3-solid_waste_management_services.pdf', assumed: false, vehicles: { sanitation: 1, graffiti: 1 } },
  { id: 'ts-commissioners', label: 'Commissioners Street Transfer Station', kind: 'transfer_station', crews: ['sanitation'], lat: 43.65197, lon: -79.3393, address: '400 Commissioners St, Toronto ON M4M 3K2', source: 'City of Toronto SWMS telephone directory (2026-03-01)', source_url: 'https://www.toronto.ca/wp-content/uploads/2017/12/95e3-solid_waste_management_services.pdf', assumed: false, vehicles: {} },
  { id: 'ry-toryork', label: 'Toryork Yard - Signs and Pavement Markings', kind: 'road_yard', crews: ['roads', 'inspection', 'markings', 'signage'], lat: 43.75475, lon: -79.54551, address: '40 Toryork Dr, Toronto ON M9L 1X6', source: 'City of Toronto Transportation Services telephone directory (2026-03-01)', source_url: 'https://www.toronto.ca/wp-content/uploads/2017/12/864c-transportation_services.pdf', assumed: false, vehicles: { markings: 2, signage: 1 } },
];

const SHIFT = 480, LUNCH: [number, number, number] = [210, 300, 30], TRUCK_MIN = Math.floor((SHIFT - LUNCH[2]) * 0.65);
const minutes = (i: Issue) => i.work_order?.minutes ?? 30;
const at = (i: Issue): LatLon => [i.lat!, i.lon!];
const rank = (a: Issue, b: Issue) => Number(!!b.pinned) - Number(!!a.pinned) || b.severity - a.severity || b.sightings - a.sightings || b.confidence - a.confidence;
const open = (issues: Issue[]) => issues.filter(i => !i.duplicate_of && !i.provisional && i.lat != null && i.lon != null && (i.verdict !== 'rejected' || i.pinned));

export const currentSites = (sites: Facility[]): SiteTrucks => Object.fromEntries(sites.map(f => [f.id, { ...(f.vehicles ?? {}) }]));

interface Truck { id: string; crew: CrewType; site: Facility }
function fleet(sites: Facility[], trucks: SiteTrucks): Truck[] {
  const out: Truck[] = []; const n: Partial<Record<CrewType, number>> = {};
  for (const f of [...sites].sort((a, b) => a.label.localeCompare(b.label))) {
    for (const [crew, k] of Object.entries(trucks[f.id] ?? {}) as Array<[CrewType, number]>) {
      if (!f.crews.includes(crew)) continue;
      for (let j = 0; j < Math.min(20, k); j++) { n[crew] = (n[crew] ?? 0) + 1; out.push({ id: `${crew}-${n[crew]}`, crew, site: f }); }
    }
  }
  return out;
}

export function triageRules(jobs: Issue[], floor: number, trucks: Partial<Record<CrewType, number>>, days: number): Triage {
  const cap: Partial<Record<CrewType, number>> = {}; (Object.keys(trucks) as CrewType[]).forEach(c => { if (trucks[c]) cap[c] = trucks[c]! * TRUCK_MIN; });
  const today: Partial<Record<CrewType, number>> = {}, total: Partial<Record<CrewType, number>> = {};
  const decisions: TriageDecision[] = [];
  for (const i of [...jobs].sort(rank)) {
    const crew = CREW_FOR[i.category]; const m = minutes(i); const c = cap[crew] ?? 0;
    const put = (decision: TriageDecision['decision'], reason: string) => decisions.push({ issue_id: i.id, crew, severity: i.severity, decision, reason, by: 'rule', pinned: !!i.pinned });
    if (!c) put('defer', `No ${crew} trucks at any site`);
    else if (i.pinned) { today[crew] = (today[crew] ?? 0) + m; total[crew] = (total[crew] ?? 0) + m; put('today', 'Pinned by operator: must-do today'); }
    else if (i.severity < floor) put('defer', `Below the S${floor}+ floor chosen for this plan`);
    else if (i.severity === 5) { today[crew] = (today[crew] ?? 0) + m; total[crew] = (total[crew] ?? 0) + m; put('today', 'Safety hazard: goes out today'); }
    else if (i.severity >= 3 && (today[crew] ?? 0) + m <= c) { today[crew] = (today[crew] ?? 0) + m; total[crew] = (total[crew] ?? 0) + m; put('today', `S${i.severity}, fits today's capacity`); }
    else if ((total[crew] ?? 0) + m <= c * days && (i.severity >= 3 || days > 1)) { total[crew] = (total[crew] ?? 0) + m; put('later', i.severity >= 3 ? `S${i.severity}, after today's worse jobs` : `Routine S${i.severity}: fill-in when a truck has room`); }
    else put('defer', i.severity <= 2 ? `Routine S${i.severity}: waits for a quieter day` : `Beyond ${days} day${days > 1 ? 's' : ''} of capacity`);
  }
  const n = (d: string) => decisions.filter(x => x.decision === d).length;
  return { model: 'rules', model_name: null, min_severity: floor, days, rationale: `Planning ${floor <= 1 ? 'all severities' : `S${floor} and worse`} over ${days} day${days > 1 ? 's' : ''}: ${n('today')} jobs today, ${n('later')} later, ${n('defer')} waiting. Safety hazards and pinned jobs go first.`, by_crew: {}, capacity_min: cap, clamped: 0, decisions };
}

interface TruckDay { truck: Truck; day: number; entries: ScheduleEntry[] }

/** One day for one truck: nearest-neighbour from its site, pinned/today first, lunch reserved after 11:30. */
function tour(truck: Truck, day: number, pool: Issue[], today: Set<string>): TruckDay | null {
  const base: LatLon = [truck.site.lat, truck.site.lon];
  let pos = base, clock = 0; const visits: Array<{ i: Issue; arrive: number; drive: number }> = [];
  for (;;) {
    const options = pool.filter(i => clock + travelMinutes(pos, at(i)) + minutes(i) + travelMinutes(at(i), base) <= SHIFT - LUNCH[2]);
    if (!options.length) break;
    const pick = options.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(today.has(b.id)) - Number(today.has(a.id)) || b.severity - a.severity || travelMinutes(pos, at(a)) - travelMinutes(pos, at(b)))[0]!;
    const drive = travelMinutes(pos, at(pick)); clock += drive; visits.push({ i: pick, arrive: clock, drive }); clock += minutes(pick); pos = at(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  if (!visits.length) return null;
  const entries: ScheduleEntry[] = [{ kind: 'depart', label: `Leave ${truck.site.label}`, lat: base[0], lon: base[1], drive_min: 0, arrive_min: 0, work_min: 0, depart_min: 0, idle_min: 0 }];
  let shift = 0; let lunch = false;
  for (const v of visits) {
    const arrive = v.arrive + shift, depart = arrive + minutes(v.i);
    entries.push({ kind: 'job', issue_id: v.i.id, label: v.i.description, lat: v.i.lat!, lon: v.i.lon!, drive_min: v.drive, arrive_min: arrive, work_min: minutes(v.i), depart_min: depart, idle_min: 0, severity: v.i.severity, pinned: !!v.i.pinned });
    if (!lunch && depart >= LUNCH[0]) { lunch = true; entries.push({ kind: 'break', label: 'Lunch break', lat: v.i.lat!, lon: v.i.lon!, drive_min: 0, arrive_min: depart, work_min: LUNCH[2], depart_min: depart + LUNCH[2], idle_min: 0 }); shift += LUNCH[2]; }
  }
  const last = entries[entries.length - 1]!; const back = travelMinutes(pos, base);
  if (!lunch && last.depart_min + back > LUNCH[0]) { lunch = true; entries.push({ kind: 'break', label: 'Lunch break', lat: pos[0], lon: pos[1], drive_min: 0, arrive_min: last.depart_min, work_min: LUNCH[2], depart_min: last.depart_min + LUNCH[2], idle_min: 0 }); }
  const end = entries[entries.length - 1]!.depart_min + back;
  entries.push({ kind: 'return', label: `Back at ${truck.site.label}`, lat: base[0], lon: base[1], drive_min: back, arrive_min: end, work_min: 0, depart_min: end, idle_min: 0 });
  return { truck, day, entries };
}

export interface RoundOptions { sites?: SiteTrucks; days?: number; min_severity?: number; focus?: Zone[] }

/** Multi-day round trips from each site (sample data): rules triage, nearest-neighbour tours. */
export function planRounds(issues: Issue[], allSites: Facility[], opts: RoundOptions = {}): Plan {
  const t0 = performance.now();
  const days = Math.max(1, Math.min(7, opts.days ?? 1)); const floor = Math.max(1, Math.min(5, opts.min_severity ?? 1));
  const trucks = fleet(allSites, opts.sites ?? currentSites(allSites));
  const all = open(issues); const focus = opts.focus?.length ? opts.focus : null;
  const inside = (i: Issue) => !focus || focus.some(z => inZone(at(i), z));
  const jobs = all.filter(inside); const pinnedOut = all.filter(i => !inside(i) && i.pinned);
  const perCrew: Partial<Record<CrewType, number>> = {}; trucks.forEach(t => { perCrew[t.crew] = (perCrew[t.crew] ?? 0) + 1; });
  const triage = triageRules(jobs, floor, perCrew, days);
  pinnedOut.forEach(i => triage.decisions.push({ issue_id: i.id, crew: CREW_FOR[i.category], severity: i.severity, decision: 'defer', reason: 'Pinned, outside focus zone', by: 'rule', pinned: true }));
  const decision = new Map(triage.decisions.map(d => [d.issue_id, d]));
  const today = new Set(triage.decisions.filter(d => d.decision === 'today').map(d => d.issue_id));
  const home = (i: Issue) => { const crew = CREW_FOR[i.category]; return trucks.filter(t => t.crew === crew).map(t => t.site).sort((a, b) => haversineKm([a.lat, a.lon], at(i)) - haversineKm([b.lat, b.lon], at(i)))[0]; };
  const selected = jobs.filter(i => decision.get(i.id)?.decision !== 'defer').sort(rank);
  const remaining = new Set(selected.map(i => i.id));
  const routes: Route[] = []; const planDays: PlanDay[] = [];
  for (let day = 1; day <= days && remaining.size; day++) {
    const done: TruckDay[] = [];
    for (const truck of trucks) {
      const pool = selected.filter(i => remaining.has(i.id) && CREW_FOR[i.category] === truck.crew && home(i)?.id === truck.site.id);
      const td = tour(truck, day, pool, today);
      if (td) { done.push(td); td.entries.forEach(e => { if (e.issue_id) remaining.delete(e.issue_id); }); }
    }
    for (const td of done) {
      const e = td.entries; const stops = e.filter(x => x.kind === 'job'); const base: LatLon = [td.truck.site.lat, td.truck.site.lon];
      const path: LatLon[] = [base, ...stops.map(s => [s.lat, s.lon] as LatLon), base];
      const km = path.slice(1).reduce((s, p, k) => s + haversineKm(path[k]!, p) * 1.3, 0);
      const sum = (f: (x: ScheduleEntry) => number) => e.reduce((s, x) => s + f(x), 0);
      const back = e[e.length - 1]!.arrive_min; const drive = sum(x => x.drive_min); const work = sum(x => (x.kind === 'job' ? x.work_min : 0)); const rest = sum(x => (x.kind === 'break' ? x.work_min : 0));
      routes.push({ crew_id: day === 1 ? td.truck.id : `${td.truck.id}/d${day}`, vehicle_id: td.truck.id, day, crew: td.truck.crew, stops: stops.map(s => s.issue_id!), eta_min: stops.map(s => s.arrive_min), path,
        facility_id: td.truck.site.id, depot: base, depot_label: td.truck.site.label, distance_km: Math.round(km * 10) / 10, path_source: 'straight', schedule: e, solver: 'fallback',
        totals: { drive_min: drive, work_min: work, break_min: rest, idle_min: Math.max(0, back - drive - work - rest), distance_km: Math.round(km * 10) / 10, back_min: back, jobs: stops.length, lunch: rest ? 'reserved' : 'none' } });
    }
    const jobsDone = done.flatMap(td => td.entries.filter(x => x.kind === 'job'));
    const bySev: Record<string, number> = {}; jobsDone.forEach(j => { bySev[String(j.severity)] = (bySev[String(j.severity)] ?? 0) + 1; });
    const rs = routes.filter(r => r.day === day);
    planDays.push({ day, jobs: jobsDone.length, trucks: done.length, by_severity: bySev, drive_min: rs.reduce((s, r) => s + (r.totals?.drive_min ?? 0), 0), work_min: rs.reduce((s, r) => s + (r.totals?.work_min ?? 0), 0), distance_km: Math.round(rs.reduce((s, r) => s + (r.distance_km ?? 0), 0) * 10) / 10, last_back_min: Math.max(0, ...rs.map(r => r.totals?.back_min ?? 0)), solver: 'fallback' });
  }
  const out = new Set(routes.filter(r => r.day === 1).map(r => r.vehicle_id));
  trucks.filter(t => !out.has(t.id)).forEach(t => routes.push({ crew_id: t.id, vehicle_id: t.id, day: 1, crew: t.crew, stops: [], eta_min: [], path: [], facility_id: t.site.id, depot: [t.site.lat, t.site.lon], depot_label: t.site.label }));
  const reasons: Record<string, string> = {}; remaining.forEach(id => { const i = jobs.find(j => j.id === id)!; reasons[id] = `Not reached in ${days} day${days > 1 ? 's' : ''}: shifts full at ${home(i)?.label ?? 'its site'}`; });
  const used = [...new Map(trucks.map(t => [t.site.id, t.site])).values()];
  return {
    routes, unassigned: [...remaining], unassigned_reasons: reasons, solver: 'fallback', solve_ms: Math.round(performance.now() - t0) + 1800,
    facilities: used, matrix_source: 'straight', min_severity: floor, horizon_days: days, days: planDays, triage,
    sites: used.map(f => { const tr: Partial<Record<CrewType, number>> = {}; trucks.filter(t => t.site.id === f.id).forEach(t => { tr[t.crew] = (tr[t.crew] ?? 0) + 1; }); return { facility_id: f.id, label: f.label, kind: f.kind, trucks: tr, jobs: routes.filter(r => r.facility_id === f.id).reduce((s, r) => s + r.stops.length, 0) }; }),
    deferred: triage.decisions.filter(d => d.decision === 'defer').map(d => d.issue_id), pinned: all.filter(i => i.pinned).map(i => i.id),
    zones: focus?.map(z => z.id) ?? [], zone_labels: focus?.map(z => z.label) ?? [], outside_zone: all.length - jobs.length,
  };
}

function metrics(plan: Plan, issues: Issue[], trucks: number): ScenarioMetrics {
  const jobs = open(issues); const routed = new Set(plan.routes.flatMap(r => r.stops)); const rs = plan.routes.filter(r => r.stops.length);
  const crews = new Set(plan.routes.map(r => r.crew)); const reach = jobs.filter(i => crews.has(CREW_FOR[i.category]));
  const cover = (f: (i: Issue) => boolean) => [reach.filter(f).length, reach.filter(i => f(i) && routed.has(i.id)).length] as const;
  const [s5t, s5c] = cover(i => i.severity === 5), [s4t, s4c] = cover(i => i.severity === 4), [pt, pc] = cover(i => !!i.pinned);
  const reasons: Record<string, number> = {}; Object.values(plan.unassigned_reasons ?? {}).forEach(r => { const k = r.split(':')[0]!; reasons[k] = (reasons[k] ?? 0) + 1; });
  return { jobs_selected: jobs.length - (plan.deferred?.length ?? 0), jobs_routed: routed.size, s5_total: s5t, s5_covered: s5c, s4_total: s4t, s4_covered: s4c, pinned_total: pt, pinned_covered: pc,
    drive_hours: Math.round(rs.reduce((s, r) => s + (r.totals?.drive_min ?? 0), 0) / 6) / 10, work_hours: Math.round(rs.reduce((s, r) => s + (r.totals?.work_min ?? 0), 0) / 6) / 10,
    distance_km: Math.round(rs.reduce((s, r) => s + (r.distance_km ?? 0), 0) * 10) / 10, trucks_used: new Set(rs.map(r => r.vehicle_id)).size, trucks_available: trucks,
    deferred: plan.deferred?.length ?? 0, unassigned_by_reason: reasons, solver: 'fallback', triage: 'rules', days: plan.horizon_days ?? 1, solve_ms: plan.solve_ms };
}
const score = (m: ScenarioMetrics) => [m.pinned_total - m.pinned_covered, m.s5_total - m.s5_covered, m.s4_total - m.s4_covered, m.drive_hours / Math.max(1, m.jobs_routed), -m.jobs_routed];
const better = (a: ScenarioMetrics, b: ScenarioMetrics) => { const x = score(a), y = score(b); for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k]! < y[k]!; return false; };
const totals = (s: SiteTrucks) => { const t: Partial<Record<CrewType, number>> = {}; Object.values(s).forEach(c => (Object.entries(c) as Array<[CrewType, number]>).forEach(([k, n]) => { if (n) t[k] = (t[k] ?? 0) + n; })); return t; };

/** The rules version of the recommendation loop (sample data): baseline, S4+ focus, +1 truck where work per truck is highest. */
export function recommendRules(issues: Issue[], sites: Facility[], opts: { days?: number; min_severity?: number; sites?: SiteTrucks; focus?: Zone[] }): Recommendation {
  const t0 = performance.now(); const days = opts.days ?? 1; const floor = opts.min_severity ?? 3; const now = opts.sites ?? currentSites(sites);
  const jobs = open(issues);
  const load = new Map<string, number>();
  for (const i of jobs.filter(j => j.severity >= floor)) { const crew = CREW_FOR[i.category]; const f = sites.filter(s => s.crews.includes(crew)).sort((a, b) => haversineKm([a.lat, a.lon], at(i)) - haversineKm([b.lat, b.lon], at(i)))[0]; if (f) load.set(`${f.id}|${crew}`, (load.get(`${f.id}|${crew}`) ?? 0) + minutes(i)); }
  const busiest = [...load.entries()].sort((a, b) => b[1] / ((now[a[0].split('|')[0]!]?.[a[0].split('|')[1] as CrewType] ?? 0) + 1) - a[1] / ((now[b[0].split('|')[0]!]?.[b[0].split('|')[1] as CrewType] ?? 0) + 1))[0];
  const plus: SiteTrucks = structuredClone(now);
  if (busiest) { const [fid, crew] = busiest[0].split('|') as [string, CrewType]; plus[fid] = { ...(plus[fid] ?? {}), [crew]: (plus[fid]?.[crew] ?? 0) + 1 }; }
  const site = busiest ? sites.find(f => f.id === busiest[0].split('|')[0]) : undefined;
  const raw: Array<Omit<Scenario, 'trucks' | 'clamped' | 'metrics'>> = [
    { id: 'baseline', label: 'Current settings', intent: 'The trucks and floor set now', source: 'baseline', min_severity: floor, sites: now },
    { id: 'rules-1', label: floor < 4 ? 'S4+ focus' : 'Widen to S3+', intent: floor < 4 ? 'Same trucks, only this-week work and hazards' : 'Same trucks, take on this-month work too', source: 'rules', min_severity: floor < 4 ? 4 : 3, sites: now },
    ...(busiest && site ? [{ id: 'rules-2', label: `+1 ${busiest[0].split('|')[1]} truck at ${site.label.split(' (')[0]}`, intent: 'One more truck where the work per truck is highest', source: 'rules' as const, min_severity: floor, sites: plus }] : []),
  ];
  const scenarios: Scenario[] = raw.map(s => { const plan = planRounds(issues, sites, { sites: s.sites, days, min_severity: s.min_severity, focus: opts.focus }); return { ...s, trucks: totals(s.sites), clamped: [], metrics: metrics(plan, issues, Object.values(totals(s.sites)).reduce((a, b) => a + (b ?? 0), 0)) }; });
  const pick = scenarios.reduce((a, b) => (better(b.metrics!, a.metrics!) ? b : a));
  const m = pick.metrics!;
  return {
    id: `mock-${Date.now().toString(36)}`, generated_at: new Date().toISOString(), agent_model: 'rules', agent_model_name: null, proposer: 'rules', picker: 'rules', recommended: pick.id,
    rationale: `${pick.label} routes ${m.jobs_routed} jobs, covering ${m.s5_covered}/${m.s5_total} S5 and ${m.s4_covered}/${m.s4_total} S4 jobs with ${m.drive_hours} h of driving. Picked by the code rule: pinned and S5 coverage first, then S4, then drive hours per job.`,
    tradeoffs: scenarios.filter(s => s.id !== pick.id).map(s => `${s.label}: ${s.metrics!.jobs_routed} jobs, S4 ${s.metrics!.s4_covered}/${s.metrics!.s4_total}, ${s.metrics!.drive_hours} h driving`),
    priorities: [], scenarios, matrix_source: 'straight', days, refined: false, timings: { total: Math.round(performance.now() - t0) / 1000 },
    caveats: ['Sample data: the rules proposed and picked, and a nearest-neighbour router evaluated each scenario.'],
    zones: opts.focus?.map(z => z.id) ?? [], zone_labels: opts.focus?.map(z => z.label) ?? [],
  };
}
