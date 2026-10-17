// REST adapter. Defaults match architecture §5 exactly; every path, header, timeout and field mapping
// can be overridden by config, so a different backend usually needs config rather than code.
import type { CrewCounts, Depot, Issue, StageId, Video } from '../types';
import { parse } from '../schema';
import { ApiError, type Capabilities, type RaightwayClient, type UploadOptions } from './types';

export interface Endpoints {
  videos: string; video: string; issues: string; similar: string; frame: string;
  report: string; regenerateReport: string; dispatch: string; upload: string; search: string;
  /** Optional: a playable file per video, e.g. "/api/videos/{id}/file". */
  videoFile: string | null;
}
export const DEFAULT_ENDPOINTS: Endpoints = {
  videos: '/api/videos', video: '/api/videos/{id}', issues: '/api/issues', similar: '/api/issues/{id}/similar',
  frame: '/api/frames/{id}', report: '/api/report', regenerateReport: '/api/report', dispatch: '/api/dispatch',
  upload: '/api/videos', search: '/api/search', videoFile: null,
};

type Raw = unknown;
export interface HttpClientConfig {
  /** Prepended to every endpoint. '' keeps requests same-origin (Next rewrites /api to the backend). */
  baseUrl?: string;
  endpoints?: Partial<Endpoints>;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  timeoutMs?: number;
  capabilities?: Partial<Capabilities>;
  depot?: Depot;
  /** Map a backend's free-text stage ("checking 3/6") onto a pipeline stage id. */
  stage?: (raw: unknown) => StageId | null;
  /** Reshape raw payloads before they are validated. Use for field renames or envelopes. */
  transform?: Partial<Record<'videos' | 'video' | 'issues' | 'report' | 'plan' | 'similar' | 'search', (raw: Raw) => Raw>>;
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
  const stage = config.stage ?? defaultStage;
  const tx = config.transform ?? {};
  const url = (tpl: string, id?: string) => base + tpl.replace('{id}', encodeURIComponent(id ?? ''));
  const headers = async () => (typeof config.headers === 'function' ? await config.headers() : config.headers ?? {});

  async function request(method: string, path: string, opts: { body?: BodyInit; json?: unknown; signal?: AbortSignal; allow404?: boolean } = {}): Promise<Raw> {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), timeout);
    opts.signal?.addEventListener('abort', () => ctrl.abort(opts.signal?.reason), { once: true });
    const h: Record<string, string> = { Accept: 'application/json', ...(await headers()) };
    let body = opts.body; if (opts.json !== undefined) { body = JSON.stringify(opts.json); h['Content-Type'] = 'application/json'; }
    let res: Response;
    try { res = await f(path, { method, headers: h, body, signal: ctrl.signal, credentials: config.credentials }); }
    catch (e) { throw new ApiError(e instanceof Error && e.name === 'TimeoutError' ? `Timed out after ${timeout / 1000} s` : 'Network error: the backend is unreachable', 0, path); }
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

  const caps: Capabilities = { upload: true, dispatch: true, regenerateReport: true, similar: true, topicSearch: false, frames: true, ...config.capabilities };
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
    async regenerateReport() { return parse.report((tx.report ?? (x => x))(await request('POST', url(ep.regenerateReport)))); },
    async dispatch(crews: CrewCounts) { return parse.plan((tx.plan ?? (x => x))(await request('POST', url(ep.dispatch), { json: { crews } }))); },
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
    frameUrl: (issue: Issue) => (caps.frames ? (issue.frame_url ? (/^https?:/.test(issue.frame_url) ? issue.frame_url : base + issue.frame_url) : url(ep.frame, issue.id)) : null),
    videoUrl: (video: Video) => video.video_url ?? null,
    depot: () => config.depot ?? { lat: 43.6505, lon: -79.3617, label: 'Depot' },
  };
}
