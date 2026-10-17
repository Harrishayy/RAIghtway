// In-memory backend with the same contract as the real one, including a live upload that walks the
// pipeline stages in real time. The UI cannot tell it apart from the API, which is the point: every
// screen is built and tried against it offline, and switching to the API is configuration.
import type { Facility, Issue, LatLon, Plan, Recommendation, Zone, ReportIssue, ReportPayload, StageId, TopicHit, Video, WorkOrder } from '../types';
import { CATEGORY, CREW_FOR, STAGES } from '../registry';
import { fmtClock } from '../format';
import type { Capabilities, RaightwayClient } from '../client/types';
import { buildWorld, scriptedClip, type MockWorld } from './fixtures';
import { buildReport, planRoutes } from './planner';
import { MOCK_SITES, planRounds, recommendRules } from './rounds';
import wardsDoc from './wards.json';

export interface MockClientOptions {
  /** Simulated network latency in ms. */
  latencyMs?: number;
  /** 1 = the real ~14 s pipeline; 2 = twice as fast. */
  speed?: number;
  capabilities?: Partial<Capabilities>;
}

// Pipeline timeline for an upload, in ms at speed 1.
const T = { segment: 800, find: 2200, box: 8200, history: 10000, plan: 12000, done: 14000 };
const PIECE_MS = (T.box - T.find) / 6;

interface Upload { started: number; clip: ReturnType<typeof scriptedClip> }

/** Where the car was at video time t: the GPS samples when the video has them, else along its track. */
function locate(video: Video, t: number): LatLon | null {
  const gps = video.gps ?? [];
  if (gps.length) {
    const next = gps.findIndex(p => p.t >= t);
    if (next <= 0) return [gps[Math.max(0, next)]!.lat, gps[Math.max(0, next)]!.lon];
    const a = gps[next - 1]!, b = gps[next]!; const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
  }
  const track = video.track; if (!track.length) return null;
  const k = Math.min(track.length - 1, Math.max(0, Math.round((t / Math.max(1, video.duration_s)) * (track.length - 1))));
  return track[k]!;
}

export function createMockClient(opts: MockClientOptions = {}): RaightwayClient {
  const latency = opts.latencyMs ?? 140; const speed = opts.speed ?? 1;
  const world: MockWorld = buildWorld();
  const uploads: Upload[] = [];
  // Operator input: pins and severity overrides layered on any issue, like the backend's overlay rows.
  const pins = new Map<string, boolean>();
  const names = new Map<string, string | null>();
  const cleanName = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || null;
  const grades = new Map<string, { severity: Issue['severity']; was: Pick<Issue, 'severity' | 'severity_model' | 'severity_reason' | 'verdict'> }>();
  let manualSeq = 0;
  const overlay = (i: Issue): Issue => {
    const g = grades.get(i.id);
    const pinned = pins.get(i.id) ?? i.pinned ?? false;
    const name = names.has(i.id) ? names.get(i.id) ?? null : i.name ?? null;
    return g ? { ...i, pinned, name, severity: g.severity, severity_model: 'operator', severity_reason: 'Set by an operator.', verdict: 'confirmed', find_severity: i.find_severity ?? g.was.severity } : { ...i, pinned, name };
  };
  let report: ReportPayload | null = null; let reportUntil = 0;
  const wait = <T,>(v: T, signal?: AbortSignal): Promise<T> => new Promise((res, rej) => {
    const t = setTimeout(() => res(structuredClone(v)), latency * (0.6 + Math.random() * 0.8));
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  // Materialise an upload at the current moment: stage, progress and the issues found so far.
  function snapshot(u: Upload, now = Date.now()) {
    const ms = (now - u.started) * speed; const v: Video = { ...u.clip.video };
    const stageAt: Array<[StageId, number, number]> = [['segment', T.segment, T.find], ['find', T.find, T.box], ['box', T.box, T.history], ['history', T.history, T.plan], ['plan', T.plan, T.done]];
    const cur = stageAt.find(([, a, b]) => ms >= a && ms < b);
    if (ms < T.segment) Object.assign(v, { status: 'queued', progress: 0, stage: null });
    else if (cur) {
      const [id, a, b] = cur; const frac = (ms - a) / (b - a); const idx = STAGES.findIndex(s => s.id === id);
      const pieces = Math.min(6, Math.floor((ms - T.find) / PIECE_MS) + 1);
      Object.assign(v, { status: 'analysing', stage: id, stage_progress: frac, progress: (idx + frac) / STAGES.length, eta_s: Math.ceil((T.done - ms) / 1000 / speed), stage_detail: id === 'find' ? `Checking pieces ${pieces} of 6` : STAGES[idx]!.verb });
    } else Object.assign(v, { status: 'done', progress: 1, stage: null, explanation: u.clip.explanation });
    const found = ms < T.find ? [] : u.clip.detections.filter(d => ms >= T.find + (d.piece + 1) * PIECE_MS);
    const merged = ms >= T.history + 900; const planned = ms >= T.plan + 1000;
    const issues: Issue[] = found.map(d => {
      const i: Issue = { ...d.issue };
      if (d.matches) { if (merged) i.duplicate_of = d.matches; else i.provisional = true; i.work_order = null; }
      else { if (!merged) i.provisional = true; if (!planned) i.work_order = null; }
      if (ms < T.history) i.bbox = ms >= T.box + 600 ? i.bbox : null;
      return i;
    });
    v.issue_ids = issues.map(i => i.id);
    v.track = ms >= T.segment ? u.clip.video.track : [];
    if (v.status === 'done') v.result = { found: issues.length, merged: issues.filter(i => i.duplicate_of).length, fresh: issues.filter(i => !i.duplicate_of).length };
    return { video: v, issues, merged };
  }
  const allVideos = () => [...uploads.map(u => snapshot(u).video).reverse(), ...world.videos];
  function canonical(): Issue[] {
    const extra = new Map<string, number>(); const live: Issue[] = [];
    for (const u of uploads) { const s = snapshot(u); s.issues.forEach(i => { if (i.duplicate_of) extra.set(i.duplicate_of, (extra.get(i.duplicate_of) ?? 0) + 1); else live.push(i); }); }
    return [...world.issues.map(i => (extra.has(i.id) ? { ...i, sightings: i.sightings + extra.get(i.id)!, sighting_refs: [...(i.sighting_refs ?? []), ...uploads.map(u => ({ video_id: u.clip.video.id, drive: u.clip.video.drive, t: 0 }))] } : i)), ...live.filter(i => !i.duplicate_of)].map(overlay);
  }

  const depot = { lat: 43.6502, lon: -79.3627, label: 'Assumed depot, Front St E at Parliament St' };
  const caps: Capabilities = { upload: true, run: true, dispatch: true, regenerateReport: true, similar: true, topicSearch: true, ask: true, frames: false, directions: false, markIssues: true, sites: true, recommend: true, zones: true, ...opts.capabilities };
  let sites: Facility[] = structuredClone(MOCK_SITES);
  // the City's 25 wards (the backend's bundled file), plus areas drawn in this session
  const wards: Zone[] = wardsDoc.zones.map(z => ({ id: z.id, label: z.label, kind: 'ward' as const, code: z.code, polygons: z.polygons as LatLon[][], source: wardsDoc.source, source_url: wardsDoc.source_url }));
  let drawn: Zone[] = [];
  const focusOf = (ids?: string[], polygon?: LatLon[]): Zone[] => [...[...wards, ...drawn].filter(z => ids?.includes(z.id)), ...(polygon && polygon.length >= 3 ? [{ id: 'drawn', label: 'Drawn area', kind: 'custom' as const, polygons: [polygon], source: 'Drawn in the console' }] : [])];
  let recommendation: Recommendation | null = null; let lastPlan: Plan | null = null; let recommendStarted = 0;
  const inToronto = (f: { lat: number; lon: number }) => f.lat >= 43.55 && f.lat <= 43.88 && f.lon >= -79.7 && f.lon <= -79.08;
  const checkSite = (f: Facility) => {
    if (!f.label.trim()) throw new Error('The site needs a name');
    if (!f.crews.length) throw new Error('Pick at least one crew type for the site');
    if (!inToronto(f)) throw new Error('The site is outside the City of Toronto');
    f.vehicles = Object.fromEntries(Object.entries(f.vehicles ?? {}).filter(([c, n]) => f.crews.includes(c as never) && n != null).map(([c, n]) => [c, Math.max(0, Math.min(20, n!))]));
    return f;
  };
  return {
    id: 'mock', label: 'Sample data', capabilities: caps,
    listVideos: signal => wait(allVideos(), signal),
    getVideo(id, signal) {
      const u = uploads.find(x => x.clip.video.id === id);
      if (u) {
        const s = snapshot(u); const marked = world.issues.filter(i => i.video_id === id && i.source === 'manual');
        return wait({ video: { ...s.video, issue_ids: [...s.video.issue_ids, ...marked.map(i => i.id)] }, issues: [...s.issues, ...marked].map(overlay) }, signal);
      }
      const video = world.videos.find(v => v.id === id); if (!video) return Promise.reject(new Error(`No video ${id}`));
      const byId = new Map(canonical().map(i => [i.id, i]));
      return wait({ video, issues: video.issue_ids.map(i => byId.get(i)).filter((i): i is Issue => Boolean(i)) }, signal);
    },
    listIssues: signal => wait(canonical(), signal),
    similar(issueId, signal) {
      const all = canonical(); const me = all.find(i => i.id === issueId); if (!me) return wait([], signal);
      const h = (s: string) => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return (x % 1000) / 1000; };
      return wait(all.filter(i => i.id !== me.id && i.category === me.category).map(i => ({ issue: i, distance: Math.round((0.08 + Math.abs(h(i.description) - h(me.description)) * 0.35 + Math.abs(i.severity - me.severity) * 0.04) * 100) / 100 })).sort((a, b) => a.distance - b.distance).slice(0, 4), signal);
    },
    getReport(signal) {
      if (!report) report = { report: buildReport(canonical()), updating: false };
      // Names are an operator overlay that can change after the report was written: show the current ones.
      const named = (r: ReportIssue): ReportIssue => (names.has(r.id) ? { ...r, name: names.get(r.id) ?? null } : r);
      const current = report.report && { ...report.report, priorities: report.report.priorities?.map(named), sections: report.report.sections?.map(s => ({ ...s, top: s.top?.map(named) })) };
      return wait({ ...report, report: current, updating: Date.now() < reportUntil }, signal);
    },
    async regenerateReport() { reportUntil = Date.now() + 2500; await new Promise(r => setTimeout(r, 2500)); report = { report: buildReport(canonical()), updating: false }; return structuredClone(report); },
    async dispatch(crews, o = {}) {
      await new Promise(r => setTimeout(r, 900 + latency));
      // Legacy crew counts keep the old planner; anything per site plans round trips from the sites.
      if (!o.sites && !o.days && !o.min_severity && !o.scenario && !o.zones && !o.polygon && Object.keys(crews).length) return (lastPlan = planRoutes(canonical(), crews, depot));
      const pick = o.scenario && recommendation?.id === o.scenario.recommendation_id ? recommendation.scenarios.find(x => x.id === o.scenario!.scenario_id) : undefined;
      const focus = focusOf(pick?.zones?.length ? pick.zones : o.zones, o.polygon);
      const plan = planRounds(canonical(), sites, pick ? { sites: pick.sites, days: o.days, min_severity: pick.min_severity, focus } : { ...o, focus });
      return (lastPlan = { ...plan, recommendation, scenario_id: pick?.id ?? null });
    },
    latestPlan: () => wait(lastPlan),
    listFacilities: signal => wait(sites, signal),
    listZones: signal => wait([...wards, ...drawn], signal),
    async addZone(label, polygon) {
      if (polygon.length < 3) throw new Error('A zone needs at least three points');
      const z: Zone = { id: `zone-${Date.now().toString(36)}`, label: label.trim() || 'Drawn area', kind: 'custom', polygons: [polygon], source: 'Drawn in the console', custom: true };
      drawn = [...drawn, z]; return wait(z);
    },
    async updateZone(id, patch) {
      const cur = drawn.find(z => z.id === id); if (!cur) throw new Error('No such drawn zone (wards are read-only)');
      const z: Zone = { ...cur, label: patch.label?.trim() || cur.label, polygons: patch.polygon ? [patch.polygon] : cur.polygons };
      drawn = drawn.map(x => (x.id === id ? z : x)); return wait(z);
    },
    async removeZone(id) { if (!drawn.some(z => z.id === id)) throw new Error('No such drawn zone (wards are read-only)'); drawn = drawn.filter(z => z.id !== id); await wait(null); },
    async addFacility(input) {
      await new Promise(r => setTimeout(r, latency));
      const id = `site-${(input.label ?? 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}-${Date.now().toString(36).slice(-4)}`;
      const f = checkSite({ id, label: input.label ?? '', kind: input.kind ?? 'yard', crews: input.crews ?? [], lat: Number(input.lat), lon: Number(input.lon), address: input.address ?? null, source: input.source ?? 'Added in the console', source_url: input.source_url ?? null, note: input.note ?? null, custom: true, assumed: false, vehicles: input.vehicles ?? {} });
      sites = [...sites, f]; return structuredClone(f);
    },
    async updateFacility(id, patch) {
      await new Promise(r => setTimeout(r, latency));
      const cur = sites.find(f => f.id === id); if (!cur) throw new Error('No such site');
      const f = checkSite({ ...structuredClone(cur), ...structuredClone(patch) } as Facility);
      sites = sites.map(x => (x.id === id ? f : x)); return structuredClone(f);
    },
    async removeFacility(id) { await new Promise(r => setTimeout(r, latency)); if (!sites.some(f => f.id === id)) throw new Error('No such site'); sites = sites.filter(f => f.id !== id); },
    async resetFacilities() { sites = structuredClone(MOCK_SITES); return wait(sites); },
    async geocode() { return null; },
    async recommend(o) {
      recommendStarted = Date.now();
      try { await new Promise(r => setTimeout(r, 1600 + latency)); recommendation = recommendRules(canonical(), sites, { ...o, focus: focusOf(o.zones, o.polygon) }); return structuredClone(recommendation); }
      finally { recommendStarted = 0; }
    },
    latestRecommendation: signal => wait(recommendation, signal),
    recommendProgress: signal => wait(recommendStarted ? { running: true, stage: Date.now() - recommendStarted < 800 ? 'Rules proposing scenarios' : 'Fallback router solving scenarios', elapsed_s: Math.round((Date.now() - recommendStarted) / 100) / 10 } : { running: false }, signal),
    hazards: signal => wait([], signal),
    directions: () => Promise.reject(new Error('Directions need the live backend')),
    async upload(file, o = {}) {
      for (let p = 0.2; p <= 1; p += 0.2) { if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError'); o.onProgress?.(p); await new Promise(r => setTimeout(r, 120)); }
      const u: Upload = { started: Date.now(), clip: scriptedClip(world, uploads.length + 1, file.name || 'clip.mp4') }; uploads.push(u);
      return structuredClone(snapshot(u).video);
    },
    async run() {
      await new Promise(r => setTimeout(r, 900 + latency));
      const u: Upload = { started: Date.now(), clip: scriptedClip(world, uploads.length + 1, `run_${uploads.length + 1}.mp4`) }; uploads.push(u);
      return structuredClone(snapshot(u).video);
    },
    searchTopic(query, signal) {
      const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
      const hits: TopicHit[] = [];
      if (words.length) for (const v of allVideos()) {
        const issues = v.source === 'upload' ? [] : world.issues.filter(i => i.video_id === v.id);
        for (const i of issues) {
          const hay = `${i.description} ${CATEGORY[i.category].label} ${i.place ?? ''}`.toLowerCase(); const m = words.filter(w => hay.includes(w) || hay.includes(w.replace(/s$/, ''))).length;
          if (m) hits.push({ video_id: v.id, start: Math.max(0, i.t - 3), end: Math.min(v.duration_s, i.t + 3), score: Math.round((0.55 + 0.4 * (m / words.length)) * 100) / 100, caption: i.description });
        }
      }
      return wait(hits.sort((a, b) => b.score - a.score).slice(0, 200), signal);
    },
    async searchFootage(query, signal) {
      const hits = await this.searchTopic(query, signal);   // method call on the client object: `this` is the client
      const drives = new Set(hits.map(h => h.video_id)).size;
      return { query, hits, search: 'vss', logged: hits.length, synthesis: hits.length ? `Sample footage shows ${hits[0]!.caption.toLowerCase()}.` : `Nothing matching “${query}” is visible in the sample footage.`,
        answer: hits.length ? `“${query}” appears at ${hits.length} moments on ${drives} sample drive${drives === 1 ? '' : 's'}. All of them are already logged as issues.` : '', answer_source: hits.length ? 'nemotron' : null };
    },
    async ask(videoId, { question, t }, signal) {
      const v = allVideos().find(x => x.id === videoId); if (!v) throw new Error('Video not found');
      const near = world.issues.filter(i => i.video_id === videoId).sort((a, b) => Math.abs(a.t - (t ?? 0)) - Math.abs(b.t - (t ?? 0))).slice(0, 3);
      const first = near[0];
      return wait({ question, source: 'nemotron' as const, model: 'Nemotron 3.5 Lightning (sample)', times: near.map(i => Math.round(i.t)), issue_ids: near.map(i => i.id),
        evidence: near.map(i => ({ start: Math.max(0, i.t - 2.5), end: i.t + 2.5, caption: `Sample caption: ${i.description}.`, kind: 'segment' as const })),
        answer: first ? `Sample answer: near ${fmtClock(first.t)} the footage shows ${first.description.toLowerCase()}${near[1] ? `, and at ${fmtClock(near[1].t)} ${near[1].description.toLowerCase()}` : ''}.` : 'Sample answer: nothing is logged on this drive.' }, signal);
    },
    async createIssue(input) {
      await new Promise(r => setTimeout(r, 700 + latency));        // the backend grabs a frame and asks Nemotron
      const video = world.videos.find(v => v.id === input.video_id) ?? uploads.map(u => u.clip.video).find(v => v.id === input.video_id);
      if (!video) throw new Error(`No video ${input.video_id}`);
      const id = `m-mock${String(++manualSeq).padStart(4, '0')}`;
      const where = locate(video, input.t);
      const order: WorkOrder = { repair: `Inspect and repair the reported ${CATEGORY[input.category].label.toLowerCase()} issue.`, crew: CREW_FOR[input.category], minutes: 45, equipment: ['safety cones'], urgency: input.severity >= 5 ? 'urgent' : input.severity >= 3 ? 'soon' : 'routine' };
      const issue: Issue = {
        id, video_id: video.id, t: Math.round(input.t * 100) / 100, category: input.category, severity: input.severity, confidence: 1,
        description: input.description.trim() || `Operator-reported ${CATEGORY[input.category].label.toLowerCase()} issue`, frame_url: '',
        bbox: input.bbox ?? null, lat: where?.[0] ?? null, lon: where?.[1] ?? null, duplicate_of: null, sightings: 1, work_order: order,
        source: 'manual', pinned: input.pinned, severity_model: 'operator', severity_reason: 'Graded by the operator who marked it on the footage.',
        verdict: 'confirmed', frame_seed: video.id.length * 7 + manualSeq, place: undefined,
      };
      world.issues.push(issue);
      if (!video.issue_ids.includes(id)) video.issue_ids.push(id);
      if (input.pinned) pins.set(id, true);
      if (cleanName(input.name)) names.set(id, cleanName(input.name));
      return structuredClone(overlay(issue));
    },
    async updateIssue(id, patch) {
      await new Promise(r => setTimeout(r, latency));
      const all = [...canonical(), ...uploads.flatMap(u => snapshot(u).issues)];
      const me = all.find(i => i.id === id); if (!me) throw new Error(`No issue ${id}`);
      if (patch.pinned !== undefined) pins.set(id, patch.pinned);
      if (patch.name !== undefined) names.set(id, cleanName(patch.name));
      if (patch.severity) grades.set(id, { severity: patch.severity, was: grades.get(id)?.was ?? { severity: me.severity, severity_model: me.severity_model, severity_reason: me.severity_reason, verdict: me.verdict } });
      else if (patch.revert_severity) grades.delete(id);
      return structuredClone(overlay(world.issues.find(i => i.id === id) ?? me));
    },
    frameUrl: () => null,
    videoUrl: () => null,
    depot: () => depot,
  };
}
