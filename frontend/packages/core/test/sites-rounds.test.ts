// Sites, multi-day round trips, triage and the workforce recommendation: what backend/app/planning sends.
import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/client/http';
import { parse } from '../src/schema';
import { createMockClient } from '../src/mock/client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('sites and plans', () => {
  it('parses sites leniently: new kinds, truck counts, unknown crews dropped', () => {
    const [a, b] = parse.facilities([
      { id: 'ry-wellington', label: 'Wellington Yard', kind: 'road_yard', crews: ['roads', 'inspection', 'plumbing'], lat: '43.64', lon: -79.4, source: 'TS', source_url: 'https://x', vehicles: { roads: '2', plumbing: 3 } },
      { id: 'old', label: 'Old yard', kind: 'depot-of-the-future', crews: ['roads'], lat: 43.6, lon: -79.3, source: 's' },
      { id: 'bad', label: 'No place' },
    ]) as [ReturnType<typeof parse.facility>, ReturnType<typeof parse.facility>];
    expect(a).toMatchObject({ kind: 'road_yard', crews: ['roads', 'inspection'], lat: 43.64, vehicles: { roads: 2 } });
    expect(b.kind).toBe('yard');
  });

  it('parses round-trip routes, triage and a recommendation on the plan', () => {
    const plan = parse.plan({
      routes: [{ crew_id: 'roads-1/d2', crew: 'roads', stops: ['i1'], eta_min: [12], path: [], day: 2, vehicle_id: 'roads-1', solver: 'cuopt',
        schedule: [{ kind: 'depart', label: 'Leave', lat: 43.6, lon: -79.4, arrive_min: 0, depart_min: 0 }, { kind: 'job', issue_id: 'i1', label: 'Pothole', lat: 43.61, lon: -79.41, drive_min: 12, arrive_min: 12, work_min: 45, depart_min: 57, pinned: true },
          { kind: 'teleport', label: 'x', lat: 0, lon: 0 }, { kind: 'return', label: 'Back', lat: 43.6, lon: -79.4, drive_min: 12, arrive_min: 69, depart_min: 69 }],
        totals: { drive_min: 24, work_min: 45, break_min: 0, idle_min: 0, back_min: 69, jobs: 1, lunch: 'teatime' } }],
      unassigned: [], solver: 'cuopt', solve_ms: 900, min_severity: 3, horizon_days: 2,
      days: [{ day: 1, jobs: 0, trucks: 0 }, { day: 2, jobs: 1, trucks: 1, solver: 'cuopt' }],
      triage: { model: 'nemotron-ultra', model_name: 'Nemotron 3 Ultra', min_severity: 3, days: 2, rationale: 'r', clamped: 1,
        decisions: [{ issue_id: 'i1', crew: 'roads', severity: 4, decision: 'today', reason: 'Lane hazard', by: 'model' }, { issue_id: 'i2', crew: 'roads', decision: 'maybe' }] },
      recommendation: { id: 'r1', agent_model: 'rules', proposer: 'rules', picker: 'rules', recommended: 'baseline', rationale: 'x', matrix_source: 'road', days: 1,
        scenarios: [{ id: 'baseline', label: 'Current', source: 'baseline', min_severity: 3, sites: { 'ry-wellington': { roads: 2 } }, trucks: { roads: 2 }, metrics: { jobs_routed: 5, s5_total: 1, s5_covered: 1, solver: 'cuopt' } }] },
    });
    const r = plan.routes[0]!;
    expect(r).toMatchObject({ day: 2, vehicle_id: 'roads-1', solver: 'cuopt' });
    expect(r.schedule!.map(e => e.kind)).toEqual(['depart', 'job', 'return']);       // an unknown line is dropped, not fatal
    expect(r.totals!.lunch).toBe('none');
    expect(plan.triage!.decisions).toHaveLength(1);
    expect(plan.recommendation!.scenarios[0]!.metrics!.jobs_routed).toBe(5);
  });

  it('calls the site, dispatch and recommend endpoints', async () => {
    const seen: string[] = [];
    const site = { id: 's1', label: 'Yard', kind: 'road_yard', crews: ['roads'], lat: 43.65, lon: -79.38, source: 'x', vehicles: { roads: 1 } };
    const c = createHttpClient({
      fetch: async (u, init) => {
        const key = `${init?.method ?? 'GET'} ${String(u)}`; seen.push(key + (init?.body ? ` ${String(init.body)}` : ''));
        if (key.startsWith('GET /api/geocode')) return new Response('', { status: 404 });
        if (key === 'GET /api/dispatch/recommend/progress') return json({ running: true, stage: 'cuOpt solving scenarios', scenarios_done: 2, scenarios_total: 5, elapsed_s: 12.5 });
        if (key === 'POST /api/dispatch') return json({ routes: [], unassigned: [], solver: 'cuopt', solve_ms: 1 });
        if (key === 'DELETE /api/facilities/s1') return json({ removed: 's1' });
        return json(key.endsWith('/api/facilities') && key.startsWith('GET') ? [site] : key.includes('recommend') ? { id: 'r', recommended: 'baseline', scenarios: [] } : site);
      },
    });
    expect(await c.listFacilities()).toHaveLength(1);
    await c.updateFacility('s1', { vehicles: { roads: 3 } });
    await c.removeFacility('s1');
    expect(await c.geocode('nowhere')).toBeNull();
    await c.dispatch({}, { sites: { s1: { roads: 2 } }, days: 2, min_severity: 4, triage: false });
    expect((await c.recommendProgress()).scenarios_done).toBe(2);
    expect((await c.recommend({ days: 1 })).recommended).toBe('baseline');
    expect(seen).toContain('PUT /api/facilities/s1 {"vehicles":{"roads":3}}');
    expect(seen).toContain('POST /api/dispatch {"crews":{},"sites":{"s1":{"roads":2}},"days":2,"min_severity":4,"triage":false}');
  });
});

describe('mock round trips', () => {
  it('plans closed round trips from the sites, says it used the fallback router and the rules, and recommends', async () => {
    const c = createMockClient({ latencyMs: 0 });
    const sites = await c.listFacilities();
    expect(sites.length).toBeGreaterThan(3);
    const plan = await c.dispatch({}, { days: 2, min_severity: 2 });
    expect(plan.solver).toBe('fallback'); expect(plan.triage!.model).toBe('rules');
    const r = plan.routes.find(x => x.stops.length)!;
    expect(r.schedule![0]!.kind).toBe('depart'); expect(r.schedule!.at(-1)!.kind).toBe('return');
    expect(r.path[0]).toEqual(r.path.at(-1));
    expect(r.totals!.back_min).toBeLessThanOrEqual(480);
    const rec = await c.recommend({ days: 1, min_severity: 3 });
    expect(rec.agent_model).toBe('rules'); expect(rec.scenarios[0]!.id).toBe('baseline');
    expect(rec.scenarios.map(s => s.id)).toContain(rec.recommended);
    const applied = await c.dispatch({}, { scenario: { recommendation_id: rec.id, scenario_id: rec.recommended } });
    expect(applied.scenario_id).toBe(rec.recommended);
  }, 15_000);
});
