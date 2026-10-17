// REST adapter. Defaults match architecture §5 exactly; every path, header, timeout and field mapping
// can be overridden by config, so a different backend usually needs config rather than code.
import type { CrewCounts, Depot, DispatchOptions, FacilityInput, Issue, LatLon, RecommendOptions, StageId, Video } from '../types';
import { parse } from '../schema';
import { ApiError, type Capabilities, type RaightwayClient, type UploadOptions } from './types';

export interface Endpoints {
  videos: string; video: string; issues: string; similar: string; frame: string;
  report: string; regenerateReport: string; dispatch: string; upload: string; run: string; search: string;
  /** POST: ask about one drive. */
  ask: string;
  hazards: string; directions: string;
  /** POST: an operator-marked issue. */
  createIssue: string;
  /** PATCH: pin/unpin or operator severity. */
  updateIssue: string;
  /** Sites: GET/POST list, PUT/DELETE one, POST reset; address lookup; workforce recommendation. */
  facilities: string; facility: string; facilitiesReset: string; geocode: string; recommend: string; recommendProgress: string; zones: string; zone: string;
  /** Optional: a playable file per video, e.g. "/api/videos/{id}/file". */
  videoFile: string | null;
}
export const DEFAULT_ENDPOINTS: Endpoints = {
  videos: '/api/videos', video: '/api/videos/{id}', issues: '/api/issues', similar: '/api/issues/{id}/similar',
  frame: '/api/frames/{id}', report: '/api/report', regenerateReport: '/api/report', dispatch: '/api/dispatch', ask: '/api/videos/{id}/ask',
  upload: '/api/videos', run: '/api/run', search: '/api/search', hazards: '/api/hazards', directions: '/api/directions', videoFile: '/api/videos/{id}/file',
  createIssue: '/api/issues', updateIssue: '/api/issues/{id}',
  facilities: '/api/facilities', facility: '/api/facilities/{id}', facilitiesReset: '/api/facilities/reset', geocode: '/api/geocode',
  recommend: '/api/dispatch/recommend', recommendProgress: '/api/dispatch/recommend/progress', zones: '/api/zones', zone: '/api/zones/{id}',
};

/** Where the backend's dispatch starts and ends every route (backend/app/planning: DEPOT). */
export const DEFAULT_DEPOT: Depot = { lat: 43.6534, lon: -79.3841, label: 'Toronto City Hall (assumed depot)' };

type Raw = unknown;
export interface HttpClientConfig {
  /** Prepended to every endpoint. '' keeps requests same-origin (Next rewrites /api to the backend). */
  baseUrl?: string;
  endpoints?: Partial<Endpoints>;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  timeoutMs?: number;
  /** Timeout for calls that wait on a model or solver (POST /api/report, POST /api/dispatch). Default 120 s. */
  slowTimeoutMs?: number;
  capabilities?: Partial<Capabilities>;
  depot?: Depot;
  /** Map a backend's free-text stage ("checking 3/6") onto a pipeline stage id. */
  stage?: (raw: unknown) => StageId | null;
  /** Reshape raw payloads before they are validated. Use for field renames or envelopes. */
  transform?: Partial<Record<'videos' | 'video' | 'issue' | 'issues' | 'report' | 'plan' | 'similar' | 'search' | 'hazards' | 'directions', (raw: Raw) => Raw>>;
  fetch?: typeof fetch;
  label?: string;
}

// Most specific first: the backend sends "checking history", which must not read as "checking 3/6".
const STAGE_WORDS: Array<[RegExp, StageId]> = [[/history|dedupe|merge|similar/i, 'history'], [/plan|repair|work order|report/i, 'plan'], [/box|embed/i, 'box'], [/segment|cut|split/i, 'segment'], [/find|check|detect|scan|reason/i, 'find']];
export function defaultStage(raw: unknown): StageId | null {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  // terminal or waiting states are not pipeline stages: "queued", "done", "done (replayed)", "Analysis failed: …"
  if (/^(queued|done|failed)\b|failed|interrupted/i.test(s)) return null;
  if (['segment', 'find', 'box', 'history', 'plan'].includes(s)) return s as StageId;
  return STAGE_WORDS.find(([re]) => re.test(s))?.[1] ?? null;
}
/** "checking 3/6" → 0.5 within the stage, when a backend only reports text. */
const stageFraction = (raw: unknown): number | undefined => { const m = /(\d+)\s*\/\s*(\d+)/.exec(String(raw ?? '')); return m ? Number(m[1]) / Math.max(1, Number(m[2])) : undefined; };

export function createHttpClient(config: HttpClientConfig = {}): RaightwayClient {
  const ep: Endpoints = { ...DEFAULT_ENDPOINTS, ...config.endpoints };
  const base = (config.baseUrl ?? '').replace(/\/$/, '');
  const f = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeout = config.timeoutMs ?? 15000;
  // Nemotron (report) and cuOpt (dispatch) answer in seconds to tens of seconds; the default would cut them off.
  const slowTimeout = Math.max(timeout, config.slowTimeoutMs ?? 120_000);
  const stage = config.stage ?? defaultStage;
  const tx = config.transform ?? {};
  const url = (tpl: string, id?: string) => base + tpl.replace('{id}', encodeURIComponent(id ?? ''));
  const headers = async () => (typeof config.headers === 'function' ? await config.headers() : config.headers ?? {});

  async function request(method: string, path: string, opts: { body?: BodyInit; json?: unknown; signal?: AbortSignal; allow404?: boolean; timeoutMs?: number } = {}): Promise<Raw> {
    const limit = opts.timeoutMs ?? timeout;
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), limit);
    opts.signal?.addEventListener('abort', () => ctrl.abort(opts.signal?.reason), { once: true });
    const h: Record<string, string> = { Accept: 'application/json', ...(await headers()) };
    let body = opts.body; if (opts.json !== undefined) { body = JSON.stringify(opts.json); h['Content-Type'] = 'application/json'; }
    let res: Response;
    try { res = await f(path, { method, headers: h, body, signal: ctrl.signal, credentials: config.credentials }); }
    catch (e) { throw new ApiError(e instanceof Error && e.name === 'TimeoutError' ? `Timed out after ${limit / 1000} s` : 'Network error: the backend is unreachable', 0, path); }
    finally { clearTimeout(timer); }
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text(); let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) { const detail = (data as { detail?: unknown })?.detail; throw new ApiError(typeof detail === 'string' ? detail : `${method} ${path} failed (${res.status})`, res.status, path, data); }
    return data;
  }
  const normVideo = (raw: Raw): Raw => {
    if (!raw || typeof raw !== 'object') return raw;
    const o = raw as Record<string, unknown>;
    return { ...o, stage: stage(o.stage), stage_detail: o.stage_detail ?? (typeof o.stage === 'string' ? o.stage : undefined), stage_progress: o.stage_progress ?? stageFraction(o.stage) };
  };
  const withVideoUrl = (v: Video): Video => (ep.videoFile && !v.video_url ? { ...v, video_url: url(ep.videoFile, v.id) } : v);

  const caps: Capabilities = { upload: true, run: true, dispatch: true, regenerateReport: true, similar: true, topicSearch: true, ask: true, frames: true, directions: true, markIssues: true, sites: true, recommend: true, zones: true, ...config.capabilities };
  return {
    id: 'http', label: config.label ?? 'API', capabilities: caps,
    async listVideos(signal) { const raw = (tx.videos ?? (x => x))(await request('GET', url(ep.videos), { signal })); return parse.videos((Array.isArray(raw) ? raw : []).map(normVideo)).map(withVideoUrl); },
    async getVideo(id, signal) {
      const raw = (tx.video ?? (x => x))(await request('GET', url(ep.video, id), { signal })) as Record<string, unknown>;
      const v = raw && 'video' in raw ? raw.video : raw;
      return { video: withVideoUrl(parse.video(normVideo(v))), issues: parse.issues(raw?.issues ?? []) };
    },
    async listIssues(signal) { return parse.issues((tx.issues ?? (x => x))(await request('GET', url(ep.issues), { signal }))); },
    async similar(id, signal) { return parse.similar((tx.similar ?? (x => x))(await request('GET', url(ep.similar, id), { signal, allow404: true }))); },
    async getReport(signal) { const raw = await request('GET', url(ep.report), { signal, allow404: true }); return raw == null ? null : parse.report((tx.report ?? (x => x))(raw)); },
    async regenerateReport() { return parse.report((tx.report ?? (x => x))(await request('POST', url(ep.regenerateReport), { timeoutMs: slowTimeout }))); },
    // The backend re-reads the VAST index before it answers, so this can take tens of seconds.
    async run() { return withVideoUrl(parse.video(normVideo((tx.video ?? (x => x))(await request('POST', url(ep.run), { timeoutMs: slowTimeout }))))); },
    async dispatch(crews: CrewCounts, opts: DispatchOptions = {}) { return parse.plan((tx.plan ?? (x => x))(await request('POST', url(ep.dispatch), { json: { crews, ...opts }, timeoutMs: slowTimeout }))); },
    async listFacilities(signal) { return caps.sites ? parse.facilities(await request('GET', url(ep.facilities), { signal })) : []; },
    async addFacility(input: FacilityInput) { return parse.facility(await request('POST', url(ep.facilities), { json: input })); },
    async updateFacility(id: string, patch: FacilityInput) { return parse.facility(await request('PUT', url(ep.facility, id), { json: patch })); },
    async removeFacility(id: string) { await request('DELETE', url(ep.facility, id)); },
    async resetFacilities() { return parse.facilities(await request('POST', url(ep.facilitiesReset))); },
    async geocode(query: string) { const raw = await request('GET', `${url(ep.geocode)}?q=${encodeURIComponent(query)}`, { allow404: true, timeoutMs: 20_000 }); return raw == null ? null : parse.geocode(raw); },
    // Nemotron proposes and picks, cuOpt solves every scenario: up to a minute or two.
    async recommend(opts: RecommendOptions) { return parse.recommendation(await request('POST', url(ep.recommend), { json: opts, timeoutMs: slowTimeout + 60_000 })); },
    async listZones(signal) { return caps.zones ? parse.zones(await request('GET', url(ep.zones), { signal, allow404: true }) ?? []) : []; },
    async addZone(label: string, polygon: LatLon[]) { return parse.zone(await request('POST', url(ep.zones), { json: { label, polygon } })); },
    async updateZone(id: string, patch: { label?: string; polygon?: LatLon[] }) { return parse.zone(await request('PUT', url(ep.zone, id), { json: patch })); },
    async removeZone(id: string) { await request('DELETE', url(ep.zone, id)); },
    async recommendProgress(signal) {
      const o = ((await request('GET', url(ep.recommendProgress), { signal, allow404: true })) ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      return { running: Boolean(o.running), stage: typeof o.stage === 'string' ? o.stage : undefined, scenarios_done: n(o.scenarios_done), scenarios_total: n(o.scenarios_total), elapsed_s: n(o.elapsed_s) };
    },
    async latestRecommendation(signal) { const raw = caps.recommend ? await request('GET', url(ep.recommend), { signal, allow404: true }) : null; return raw == null ? null : parse.recommendation(raw); },
    async hazards(signal) { return caps.directions ? parse.hazards((tx.hazards ?? (x => x))(await request('GET', url(ep.hazards), { signal, allow404: true }))) : []; },
    async directions(origin: LatLon, destination: LatLon) { return parse.directions((tx.directions ?? (x => x))(await request('POST', url(ep.directions), { json: { origin, destination }, timeoutMs: 45_000 }))); },
    upload(file: File, opts: UploadOptions = {}) {
      // XHR for upload progress; fetch has no upload progress events.
      return new Promise(async (resolve, reject) => {
        const xhr = new XMLHttpRequest(); const target = url(ep.upload);
        xhr.open('POST', target); xhr.timeout = Math.max(timeout, 10 * 60_000);
        if (config.credentials === 'include') xhr.withCredentials = true;
        Object.entries(await headers()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
        xhr.upload.onprogress = e => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total); };
        xhr.onload = () => {
          let data: unknown = null; try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
          if (xhr.status >= 200 && xhr.status < 300) { try { resolve(withVideoUrl(parse.video(normVideo((tx.video ?? (x => x))(data))))); } catch (e) { reject(e); } }
          else reject(new ApiError((data as { detail?: string })?.detail ?? `Upload failed (${xhr.status})`, xhr.status, target, data));
        };
        xhr.onerror = () => reject(new ApiError('Network error during upload', 0, target));
        xhr.ontimeout = () => reject(new ApiError('Upload timed out', 0, target));
        opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        const fd = new FormData(); fd.append('file', file); xhr.send(fd);
      });
    },
    async searchTopic(query, signal) {
      if (!caps.topicSearch) return [];
      return parse.topicHits((tx.search ?? (x => x))(await request('POST', url(ep.search), { json: { query }, signal })));
    },
    // VSS (serialised, cached) then Nemotron's answer: allow more than the default timeout on a cold query.
    async searchFootage(query, signal) {
      if (!caps.topicSearch) return { query, hits: [] };
      return parse.topicSearch((tx.search ?? (x => x))(await request('POST', url(ep.search), { json: { query }, signal, timeoutMs: Math.max(timeout, 30_000) })), query);
    },
    async ask(videoId, question, t, signal) {
      return parse.askAnswer(await request('POST', url(ep.ask, videoId), { json: { question, t: t ?? null }, signal, timeoutMs: Math.max(timeout, 45_000) }));
    },
    // Waits on ffmpeg, GPS, Nemotron and Cosmos-Embed1 on the backend (each best effort), so allow the slow timeout.
    async createIssue(input) { return parse.issue((tx.issue ?? (x => x))(await request('POST', url(ep.createIssue), { json: input, timeoutMs: slowTimeout }))); },
    async updateIssue(id, patch) { return parse.issue((tx.issue ?? (x => x))(await request('PATCH', url(ep.updateIssue, id), { json: patch }))); },
    frameUrl: (issue: Issue) => (caps.frames ? (issue.frame_url ? (/^https?:/.test(issue.frame_url) ? issue.frame_url : base + issue.frame_url) : url(ep.frame, issue.id)) : null),
    videoUrl: (video: Video) => video.video_url ?? null,
    depot: () => config.depot ?? DEFAULT_DEPOT,
  };
}
