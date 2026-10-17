// Stand-ins for Nemotron's report and cuOpt's routes, computed the same way the backend counts them
// (architecture §3.7–3.8): numbers in code, words templated.
import type { CategoryId, CrewCounts, CrewType, Deadline, Depot, Issue, LatLon, Plan, Report, ReportHotspot, ReportIssue, ReportSection, Route } from '../types';
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
  return { generated_at: now.toISOString(), summary, counts, crews, rationale: Object.values(rationale_by_crew).join(' '), rationale_by_crew, model: 'Nemotron 3.5 Lightning (mock)', ...reportDetail(issues, crews) };
}

const DEADLINE: Record<number, Deadline> = { 5: 'today', 4: 'this week', 3: 'this month' };
const APPROACH: Record<CategoryId, string> = {
  pavement: 'Make the severity 4–5 potholes safe today with cold-patch and cones, then saw-cut and hot-mix the failed patches street by street.',
  markings: 'Repaint crosswalks and stop lines at intersections first, then lane lines, bundled by corridor in dry weather.',
  work_zone: 'Inspect each closure: reset knocked-over devices, check taper and signs, and escalate unguarded excavations to the permit holder.',
  signage: 'Replace downed and defaced stop signs first, then trim foliage and straighten bent posts.',
  graffiti: 'Paint out tags on signs this week; batch wall tagging by block for pressure-washing.',
  waste: 'Clear dumped items blocking sidewalks first, then empty overflowing bins along the route.',
};
const rank = (a: Issue, b: Issue) => b.severity - a.severity || b.sightings - a.sightings || b.confidence - a.confidence;

/** The report's computed detail, the same shape the backend sends (backend/app/planning/report.py). */
function reportDetail(issues: Issue[], crews: CrewCounts): Pick<Report, 'stats' | 'sections' | 'priorities' | 'hotspots' | 'provenance'> {
  const canonical = issues.filter(i => !i.duplicate_of && !i.provisional);
  const open = canonical.filter(i => i.verdict !== 'rejected'); const rejected = canonical.filter(i => i.verdict === 'rejected');
  const mins = (i: Issue) => i.work_order?.minutes ?? 30;
  const item = (i: Issue): ReportIssue => ({ id: i.id, category: i.category, severity: i.severity, severity_reason: i.severity_reason ?? null, description: i.description, name: i.name ?? null, video_id: i.video_id, drive: i.sighting_refs?.[0]?.drive ?? null, t: i.t, lat: i.lat, lon: i.lon, place: street(i) || null, sightings: i.sightings, confidence: i.confidence, deadline: DEADLINE[i.severity] ?? 'routine', crew: CREW_FOR[i.category], repair: i.work_order?.repair ?? null, minutes: mins(i) });
  const sections: ReportSection[] = CATEGORIES.flatMap(c => {
    const list = open.filter(i => i.category === c.id).sort(rank); const dropped = rejected.filter(i => i.category === c.id).length;
    if (!list.length && !dropped) return [];
    const by: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; list.forEach(i => { by[i.severity] = (by[i.severity] ?? 0) + 1; });
    const kit = new Map<string, number>(); list.forEach(i => new Set(i.work_order?.equipment ?? []).forEach(e => kit.set(e, (kit.get(e) ?? 0) + 1)));
    const work = list.reduce((a, i) => a + mins(i), 0);
    return [{ category: c.id, crew: c.crew, open: list.length, by_severity: by, severe: (by[4] ?? 0) + (by[5] ?? 0), rejected: dropped, work_minutes: work, crew_hours: Math.round(work * 1.3 / 6) / 10, crews: crews[c.crew] ?? 0, equipment: [...kit.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([label, count]) => ({ label, count })), top: list.slice(0, 5).map(item), approach: APPROACH[c.id] }];
  });
  const byStreet = new Map<string, Issue[]>(); open.forEach(i => { const k = street(i); if (k) byStreet.set(k, [...(byStreet.get(k) ?? []), i]); });
  const W = [0, 1, 2, 4, 8, 16];
  const hotspots: ReportHotspot[] = [...byStreet.entries()].filter(([, l]) => l.length > 1).map(([name, l]) => ({ name, l, score: l.reduce((a, i) => a + (W[i.severity] ?? 1), 0) })).sort((a, b) => b.score - a.score).slice(0, 6).map(({ name, l, score }, k) => {
    const cats: Record<string, number> = {}; l.forEach(i => { cats[i.category] = (cats[i.category] ?? 0) + 1; });
    return { id: `H${k + 1}`, label: `${name} area`, lat: l.reduce((a, i) => a + (i.lat ?? 0), 0) / l.length, lon: l.reduce((a, i) => a + (i.lon ?? 0), 0) / l.length, radius_m: 300, issues: l.length, severe: l.filter(i => i.severity >= 4).length, max_severity: Math.max(...l.map(i => i.severity)), score, categories: cats, drives: [...new Set(l.flatMap(i => i.sighting_refs?.map(r => r.drive ?? '') ?? []).filter(Boolean))], issue_ids: l.map(i => i.id), note: `${plural(l.length, 'open finding')} within a few blocks; send one mixed run.` };
  });
  const sev = (n: number) => open.filter(i => i.severity === n).length;
  const models: Record<string, number> = {}; issues.forEach(i => { if (i.severity_model) models[i.severity_model] = (models[i.severity_model] ?? 0) + 1; });
  const unrated = issues.filter(i => !i.severity_model).length; const fallback = models['nemotron-super-vl'] ?? 0;
  const caveats = [
    ...(unrated ? [`${plural(unrated, 'sighting')} still carry the find pass's severity (not re-graded).`] : []),
    ...(fallback ? [`${plural(fallback, 'sighting')} were graded by Nemotron Super-VL because Cosmos3-Reason did not answer.`] : []),
    ...(rejected.length ? [`${plural(rejected.length, 'finding')} judged not to be a defect are left out of the counts, crews and routes (kept on record, reversible).`] : []),
    'Sample data: every number here comes from the built-in mock city.',
  ];
  return {
    stats: { open: open.length, today: sev(5), this_week: sev(4), this_month: sev(3), routine: sev(1) + sev(2), located: open.filter(i => i.lat != null).length, drives: new Set(open.map(i => i.video_id)).size, crews: Object.values(crews).reduce((a, b) => a + (b ?? 0), 0), crew_hours: Math.round(open.reduce((a, i) => a + mins(i), 0) * 1.3 / 6) / 10, rejected: rejected.length },
    sections, priorities: open.filter(i => i.severity >= 4).sort(rank).slice(0, 40).map(item), hotspots,
    provenance: { report_model: 'nemotron-lightning', find_model: 'cosmos3-reason', rating_models: models, unrated, rejected: rejected.length, sightings_total: issues.length, canonical: canonical.length, duplicates_merged: issues.filter(i => i.duplicate_of).length, with_embedding: issues.length, with_gps: issues.filter(i => i.lat != null).length, with_box: issues.filter(i => i.bbox).length, work_orders: canonical.filter(i => i.work_order).length, template_work_orders: 0, caveats },
  };
}

/** Prize-aware nearest neighbour per crew type: a stand-in for cuOpt with the same output shape. */
export function planRoutes(issues: Issue[], crewsIn: CrewCounts, depot: Depot): Plan {
  const t0 = performance.now(); const home: LatLon = [depot.lat, depot.lon];
  const jobs = issues.filter(i => !i.duplicate_of && !i.provisional && i.verdict !== 'rejected' && i.work_order && i.lat != null && i.lon != null).sort((a, b) => b.severity - a.severity).slice(0, 120);
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
