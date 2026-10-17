// View models derived from the contract. Counts and arithmetic live in code, never in the LLM
// (architecture §3.7), and the UI and the mock source share these functions.
import type { CategoryId, CrewCounts, CrewType, Depot, Issue, Plan, Route, Severity } from './types';
import { CATEGORIES, CATEGORY_FOR_CREW, CREW_FOR, SHIFT_MINUTES } from './registry';
import { travelMinutes } from './format';

export interface IssueSummary {
  open: Issue[];
  total: number;
  /** category → counts for S1..S5 */
  matrix: Partial<Record<CategoryId, [number, number, number, number, number]>>;
  /** crew type → work-order minutes */
  workload: CrewCounts;
  /** crew type → job count */
  jobs: CrewCounts;
  /** crew type → ceil(workload × 1.3 ÷ 480) */
  baselineCrews: CrewCounts;
  hazards: Issue[];
  top: Issue[];
}

export const isCanonical = (i: Issue) => !i.duplicate_of && !i.provisional;

export function summarizeIssues(issues: Issue[], enabled: readonly CategoryId[] = CATEGORIES.map(c => c.id)): IssueSummary {
  const open = issues.filter(i => isCanonical(i) && enabled.includes(i.category));
  const matrix: IssueSummary['matrix'] = {};
  enabled.forEach(c => { matrix[c] = [0, 0, 0, 0, 0]; });
  const workload: CrewCounts = {}, jobs: CrewCounts = {};
  for (const i of open) {
    matrix[i.category]![i.severity - 1]!++;
    const crew = CREW_FOR[i.category];
    workload[crew] = (workload[crew] ?? 0) + (i.work_order?.minutes ?? 30);
    jobs[crew] = (jobs[crew] ?? 0) + 1;
  }
  const baselineCrews: CrewCounts = {};
  (Object.keys(workload) as CrewType[]).forEach(k => { baselineCrews[k] = Math.ceil(((workload[k] ?? 0) * 1.3) / SHIFT_MINUTES); });
  const hazards = open.filter(i => i.severity === 5);
  const top = [...open].sort((a, b) => b.severity - a.severity || b.confidence - a.confidence).slice(0, 8);
  return { open, total: open.length, matrix, workload, jobs, baselineCrews, hazards, top };
}

export interface PlanLeg { type: 'travel' | 'job'; start: number; end: number; issue?: string; severity?: Severity }
export interface RouteView extends Route { category: CategoryId; legs: PlanLeg[]; minutes: number }
export interface PlanView extends Omit<Plan, 'routes'> {
  routes: RouteView[];
  reasons: Record<string, string>;
  crews_needed: number;
  crews_dispatched: number;
  jobs_routed: number;
  depot: Depot;
}

/** Adds the timing legs the schedule draws, from stop ETAs and work-order minutes. */
export function enrichPlan(plan: Plan, issues: Issue[], depot: Depot): PlanView {
  const byId = new Map(issues.map(i => [i.id, i]));
  const home: [number, number] = [depot.lat, depot.lon];
  const routes: RouteView[] = plan.routes.map(r => {
    const legs: PlanLeg[] = []; let t = 0; let pos = home;
    r.stops.forEach((id, n) => {
      const iss = byId.get(id); const eta = r.eta_min[n] ?? t; const mins = iss?.work_order?.minutes ?? 30;
      if (eta > t) legs.push({ type: 'travel', start: t, end: eta });
      legs.push({ type: 'job', start: eta, end: eta + mins, issue: id, severity: iss?.severity ?? 3 });
      t = eta + mins; if (iss?.lat != null && iss.lon != null) pos = [iss.lat, iss.lon];
    });
    if (r.stops.length) { const back = travelMinutes(pos, home); legs.push({ type: 'travel', start: t, end: t + back }); t += back; }
    return { ...r, category: CATEGORY_FOR_CREW[r.crew], legs, minutes: Math.min(t, SHIFT_MINUTES + 60) };
  });
  return {
    ...plan, routes, depot,
    reasons: plan.unassigned_reasons ?? Object.fromEntries(plan.unassigned.map(id => [id, 'Shift full'])),
    crews_needed: routes.filter(r => r.stops.length).length,
    crews_dispatched: routes.length,
    jobs_routed: routes.reduce((s, r) => s + r.stops.length, 0),
  };
}

/** Where an issue sits in a plan: crew, stop number and ETA (minutes into the shift). */
export function routeFor(plan: PlanView | null, issueId: string): { crew_id: string; n: number; eta: number } | null {
  if (!plan) return null;
  for (const r of plan.routes) { const n = r.stops.indexOf(issueId); if (n >= 0) return { crew_id: r.crew_id, n: n + 1, eta: r.eta_min[n] ?? 0 }; }
  return null;
}
