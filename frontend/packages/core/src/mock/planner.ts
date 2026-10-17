// Stand-ins for Nemotron's report and cuOpt's routes, computed the same way the backend counts them
// (architecture §3.7–3.8): numbers in code, words templated.
import type { CategoryId, CrewCounts, CrewType, Depot, Issue, LatLon, Plan, Report, Route } from '../types';
import { CATEGORIES, CATEGORY, CATEGORY_FOR_CREW, CREW_FOR, SHIFT_MINUTES, severityDef } from '../registry';
import { fmtHours, plural, travelMinutes } from '../format';
import { summarizeIssues } from '../derive';
import { gridLL } from '../geo/toronto';
import { GRID } from './fixtures';

const mode = (a: string[]) => { const m = new Map<string, number>(); a.forEach(x => m.set(x, (m.get(x) ?? 0) + 1)); return [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''; };
const street = (i: Issue) => (i.place ?? '').replace(/ (near|at) .*/, '');

export function buildReport(issues: Issue[], now = new Date()): Report {
  const s = summarizeIssues(issues);
  const crews: CrewCounts = s.baselineCrews; const total = Object.values(crews).reduce((a, b) => a + (b ?? 0), 0);
  const counts: Partial<Record<CategoryId, number>> = {}; CATEGORIES.forEach(c => { counts[c.id] = s.open.filter(i => i.category === c.id).length; });
  const words: Record<CategoryId, [string, string]> = { pavement: ['deep pothole', 'deep potholes'], work_zone: ['unguarded work zone', 'unguarded work zones'], signage: ['missing or downed stop sign', 'missing or downed stop signs'], markings: ['worn school crossing', 'worn school crossings'], graffiti: ['painted-over crossing sign', 'painted-over crossing signs'], waste: ['blocked sidewalk', 'blocked sidewalks'] };
  const hzBy = new Map<CategoryId, number>(); s.hazards.forEach(h => hzBy.set(h.category, (hzBy.get(h.category) ?? 0) + 1));
  const hzText = [...hzBy.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${words[c][n === 1 ? 0 : 1]}`).join(', ');
  const biggest = (Object.entries(s.workload) as Array<[CrewType, number]>).sort((a, b) => b[1] - a[1])[0];
  let summary = `**${s.total} open issues** across the downtown streets the fleet drove. `;
  summary += s.hazards.length ? `**${plural(s.hazards.length, 'safety hazard')} to fix today**: ${hzText}. ` : 'No safety hazards today. ';
  if (biggest) { const cat = CATEGORY_FOR_CREW[biggest[0]]; summary += `${CATEGORY[cat].label} is the largest workload (${fmtHours(biggest[1])} crew-hours), concentrated on ${mode(s.open.filter(i => i.category === cat).map(street))}. `; }
  summary += `Recommended for tomorrow: **${plural(total, 'crew')}**.`;
  const rationale_by_crew: Partial<Record<CrewType, string>> = {};
  (Object.keys(crews) as CrewType[]).forEach(crew => {
    const cat = CATEGORY_FOR_CREW[crew]; const list = s.open.filter(i => i.category === cat); const serious = list.filter(i => i.severity >= 3);
    rationale_by_crew[crew] = `${plural(list.length, 'job')}, ${fmtHours(s.workload[crew] ?? 0)} h of work. ${serious.length ? `${serious.length} are S3 or worse, most on ${mode(serious.map(street))}.` : `All routine, mostly on ${mode(list.map(street))}.`} ${(crews[crew] ?? 0) > 1 ? `${crews[crew]} crews clear the S3+ work first and fit the rest into one shift.` : 'One crew covers it in a shift.'}`;
  });
  return { generated_at: now.toISOString(), summary, counts, crews, rationale: Object.values(rationale_by_crew).join(' '), rationale_by_crew, model: 'Nemotron 3.5 Lightning (mock)' };
}

/** Prize-aware nearest neighbour per crew type: a stand-in for cuOpt with the same output shape. */
export function planRoutes(issues: Issue[], crewsIn: CrewCounts, depot: Depot): Plan {
  const t0 = performance.now(); const home: LatLon = [depot.lat, depot.lon];
  const jobs = issues.filter(i => !i.duplicate_of && !i.provisional && i.work_order && i.lat != null && i.lon != null).sort((a, b) => b.severity - a.severity).slice(0, 120);
  const routes: Route[] = []; const unassigned: string[] = []; const reasons: Record<string, string> = {};
  for (const c of CATEGORIES) {
    const crew = c.crew; const n = crewsIn[crew] ?? 0; const J = jobs.filter(i => CREW_FOR[i.category] === crew); if (!J.length) continue;
    if (!n) { J.forEach(j => { unassigned.push(j.id); reasons[j.id] = 'No crew of this type dispatched'; }); continue; }
    const ang = (j: Issue) => Math.atan2(j.lat! - home[0], j.lon! - home[1]); J.sort((a, b) => ang(a) - ang(b));
    const totalMin = J.reduce((s, j) => s + j.work_order!.minutes, 0); const groups: Issue[][] = Array.from({ length: n }, () => []); let acc = 0;
    J.forEach(j => { groups[Math.min(n - 1, Math.floor((acc / totalMin) * n))]!.push(j); acc += j.work_order!.minutes; });
    groups.forEach((G, gi) => {
      let pos = home, time = 0; const stops: string[] = [], eta: number[] = []; const left = [...G];
      while (left.length) {
        let best = -1, score = -Infinity;
        left.forEach((j, k) => { const p: LatLon = [j.lat!, j.lon!]; const tr = travelMinutes(pos, p); if (time + tr + j.work_order!.minutes + travelMinutes(p, home) > SHIFT_MINUTES) return; const sc = severityDef(j.severity).prize / (tr + j.work_order!.minutes); if (sc > score) { score = sc; best = k; } });
        if (best < 0) break;
        const j = left.splice(best, 1)[0]!; const p: LatLon = [j.lat!, j.lon!]; time += travelMinutes(pos, p); eta.push(time); stops.push(j.id); time += j.work_order!.minutes; pos = p;
      }
      left.forEach(j => { unassigned.push(j.id); reasons[j.id] = 'Shift full'; });
      routes.push({ crew_id: `${c.code}${gi + 1}`, crew, stops, eta_min: eta, path: streetPath(home, stops.map(id => issues.find(i => i.id === id)!)) });
    });
  }
  return { routes, unassigned, solver: 'cuopt', solve_ms: Math.round(performance.now() - t0) + 2400, unassigned_reasons: reasons };
}

// Route geometry that follows the grid: along the street, turn at a crossing, along the next.
function streetPath(home: LatLon, stops: Issue[]): LatLon[] {
  const pts: LatLon[] = [home]; let prev = GRID.get('__depot') ?? { axis: 'row' as const, line: 0, pos: 6.35 };
  for (const s of [...stops, null]) {
    const g = s ? GRID.get(s.id) : { axis: 'row' as const, line: 0, pos: 6.35 }; const target: LatLon = s ? [s.lat!, s.lon!] : home;
    if (g) {
      if (prev.axis === 'row' && g.axis === 'row' && Math.abs(prev.line - g.line) > 0.01) { const cx = Math.max(0, Math.min(6, Math.round((prev.pos + g.pos) / 2))); pts.push(gridLL(prev.line, cx), gridLL(g.line, cx)); }
      else if (prev.axis === 'col' && g.axis === 'col' && Math.abs(prev.line - g.line) > 0.01) { const rx = Math.max(0, Math.min(4, Math.round((prev.pos + g.pos) / 2))); pts.push(gridLL(rx, prev.line), gridLL(rx, g.line)); }
      else if (prev.axis !== g.axis) pts.push(prev.axis === 'row' ? gridLL(prev.line, g.line) : gridLL(g.line, prev.line));
      prev = g;
    }
    pts.push(target);
  }
  return pts;
}
