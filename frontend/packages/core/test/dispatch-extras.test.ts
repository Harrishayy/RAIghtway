import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/client/http';
import { enrichPlan, routeHome } from '../src/derive';
import { parse } from '../src/schema';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const depot = { lat: 43.6534, lon: -79.3841, label: 'City Hall' };
const station: [number, number] = [43.65198, -79.3393];

// What backend/app/planning/dispatch.py sends: per-route bases, road alerts and crew links.
const plan = {
  routes: [
    { crew_id: 'sanitation-1', crew: 'sanitation', stops: ['w1'], eta_min: [12], path: [station, [43.66, -79.35], station],
      facility_id: 'ts-commissioners', depot: station, depot_label: 'Commissioners St. Transfer Station', distance_km: 4.2, path_source: 'road',
      warnings: [{ hazard_id: 'city:1', label: 'Shuter St closed', source: 'city', avoided: true }, { hazard_id: 'z1', label: 'Cones', source: 'dashcam', avoided: 'no' }],
      maps_urls: ['https://www.google.com/maps/dir/?api=1'], brief: 'SANITATION-1 …' },
    { crew_id: 'roads-1', crew: 'roads', stops: [], eta_min: [], path: [] },
  ],
  unassigned: [], solver: 'cuopt', solve_ms: 900, matrix_source: 'road',
  facilities: [{ id: 'ts-commissioners', label: 'Commissioners St. Transfer Station', kind: 'transfer_station', crews: ['sanitation'], lat: 43.65198, lon: -79.3393, source: 'City of Toronto Open Data' }],
  hazards: [{ id: 'city:1', source: 'city', kind: 'ROAD_CLOSED', label: 'Shuter St closed', lat: 43.65, lon: -79.37, path: [[43.65, -79.371], [43.65, -79.369]], severity: 5, until: '2027-01-01T00:00:00Z' }],
};
const issue = { id: 'w1', video_id: 'v', t: 1, category: 'waste', severity: 3, confidence: 1, description: 'bin', frame_url: '', bbox: null, lat: 43.66, lon: -79.35, work_order: { repair: 'empty', crew: 'sanitation', minutes: 20, equipment: [], urgency: 'soon' } };

describe('category dispatch extras', () => {
  it('parses per-route bases, alerts and crew links, repairing loose values', () => {
    const p = parse.plan(plan);
    expect(p.routes[0]).toMatchObject({ depot: station, depot_label: 'Commissioners St. Transfer Station', path_source: 'road', maps_urls: ['https://www.google.com/maps/dir/?api=1'] });
    expect(p.routes[0]!.warnings!.map(w => w.avoided)).toEqual([true, false]);
    expect(p.routes[1]!.depot).toBeUndefined();
    expect(p.facilities![0]!.kind).toBe('transfer_station');
    expect(p.hazards![0]!.path).toHaveLength(2);
    expect(p.matrix_source).toBe('road');
  });
  it('still parses a plan without any extras (older backends, the mock)', () => {
    const p = parse.plan({ routes: [{ crew_id: 'r', crew: 'roads', stops: [], eta_min: [], path: [] }], unassigned: [], solver: 'fallback', solve_ms: 0 });
    expect(p.routes[0]!.warnings).toBeUndefined(); expect(p.facilities).toBeUndefined();
  });
  it('returns each route to its own base', () => {
    const p = parse.plan(plan);
    expect(routeHome(p.routes[0]!, depot)).toEqual(station);
    expect(routeHome(p.routes[1]!, depot)).toEqual([depot.lat, depot.lon]);
    const view = enrichPlan(p, [parse.issue(issue)], depot);
    const back = view.routes[0]!.legs.at(-1)!;
    expect(back.type).toBe('travel');
    expect(back.end - back.start).toBeLessThan(15);   // a short hop back to the station, not across town to City Hall
  });
  it('calls the hazards and directions endpoints', async () => {
    const seen: string[] = [];
    const c = createHttpClient({ fetch: async (u, init) => {
      seen.push(`${init?.method} ${String(u)} ${init?.body ?? ''}`);
      return String(u).endsWith('/api/hazards') ? json([plan.hazards[0], { id: 'bad' }])
        : json({ path: [[1, 2], [3, 4]], minutes: '7', distance_km: 3.5, path_source: 'road', warnings: [], alternatives: 2, maps_url: 'https://maps' });
    } });
    expect((await c.hazards()).map(h => h.id)).toEqual(['city:1']);   // the item without coordinates is dropped
    const d = await c.directions([43.66, -79.34], [43.65, -79.38]);
    expect(d).toMatchObject({ minutes: 7, alternatives: 2, maps_url: 'https://maps' });
    expect(seen[1]).toBe('POST /api/directions {"origin":[43.66,-79.34],"destination":[43.65,-79.38]}');
  });
  it('skips road alerts when the backend has no directions', async () => {
    const c = createHttpClient({ capabilities: { directions: false }, fetch: async () => { throw new Error('should not be called'); } });
    expect(await c.hazards()).toEqual([]);
  });
});
