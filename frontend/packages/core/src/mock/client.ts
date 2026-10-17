// In-memory backend with the same contract as the real one, including a live upload that walks the
// pipeline stages in real time. The UI cannot tell it apart from the API, which is the point: every
// screen is built and demoed against it, and switching to the API is configuration.
import type { Issue, ReportPayload, StageId, TopicHit, Video } from '../types';
import { CATEGORY, STAGES } from '../registry';
import type { Capabilities, RaightwayClient } from '../client/types';
import { buildWorld, scriptedClip, type MockWorld } from './fixtures';
import { buildReport, planRoutes } from './planner';

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

export function createMockClient(opts: MockClientOptions = {}): RaightwayClient {
  const latency = opts.latencyMs ?? 140; const speed = opts.speed ?? 1;
  const world: MockWorld = buildWorld();
  const uploads: Upload[] = [];
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
    return [...world.issues.map(i => (extra.has(i.id) ? { ...i, sightings: i.sightings + extra.get(i.id)!, sighting_refs: [...(i.sighting_refs ?? []), ...uploads.map(u => ({ video_id: u.clip.video.id, drive: u.clip.video.drive, t: 0 }))] } : i)), ...live.filter(i => !i.duplicate_of)];
  }

  const depot = { lat: 43.6502, lon: -79.3627, label: 'Assumed depot, Front St E at Parliament St' };
  const caps: Capabilities = { upload: true, run: true, dispatch: true, regenerateReport: true, similar: true, topicSearch: true, frames: false, directions: false, ...opts.capabilities };
  return {
    id: 'mock', label: 'Sample data', capabilities: caps,
    listVideos: signal => wait(allVideos(), signal),
    getVideo(id, signal) {
      const u = uploads.find(x => x.clip.video.id === id);
      if (u) { const s = snapshot(u); return wait({ video: s.video, issues: s.issues }, signal); }
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
      return wait({ ...report, updating: Date.now() < reportUntil }, signal);
    },
    async regenerateReport() { reportUntil = Date.now() + 2500; await new Promise(r => setTimeout(r, 2500)); report = { report: buildReport(canonical()), updating: false }; return structuredClone(report); },
    async dispatch(crews) { await new Promise(r => setTimeout(r, 900 + latency)); return planRoutes(canonical(), crews, depot); },
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
    frameUrl: () => null,
    videoUrl: () => null,
    depot: () => depot,
  };
}
