// The one seam between the UI and a backend. Screens only ever call these methods, so pointing the
// console at a different service means writing (or configuring) one adapter, not touching components.
import type { BBox, CategoryId, CrewCounts, Depot, Directions, DispatchOptions, Facility, FacilityInput, GeocodeHit, Hazard, Issue, LatLon, Plan, Recommendation, RecommendOptions, RecommendProgress, ReportPayload, Severity, Similar, TopicHit, Video, Zone } from '../types';
import type { AskAnswer, TopicSearch } from '../types';

/** What this backend can do. The UI hides controls for anything switched off. */
export interface Capabilities {
  upload: boolean;
  /** POST /api/run: analyse the next footage in the VAST index that hasn't been analysed yet. */
  run: boolean;
  dispatch: boolean;
  regenerateReport: boolean;
  similar: boolean;
  /** Free-text search over footage (VSS). Adds the topic lane to the timeline. */
  topicSearch: boolean;
  /** POST /api/videos/{id}/ask: ask what happened on a drive (VSS evidence, Nemotron answer). */
  ask: boolean;
  /** Real JPEG frames at Issue.frame_url. Off: the UI draws a placeholder frame. */
  frames: boolean;
  /** Road alerts and closure-aware directions (GET /api/hazards, POST /api/directions). */
  directions: boolean;
  /** Operator input: mark an issue on footage (POST /api/issues) and pin issues into the plan (PATCH). */
  markIssues: boolean;
  /** Sites tab: list, add, edit and remove operating sites (/api/facilities). */
  sites: boolean;
  /** Workforce recommendation: Nemotron proposes, cuOpt evaluates (POST /api/dispatch/recommend). */
  recommend: boolean;
  /** Planning zones: wards and drawn areas (/api/zones), and focus on Dispatch. */
  zones: boolean;
}

/** An issue an operator marks on footage. No bbox: the whole frame. */
export interface ManualIssueInput {
  video_id: string; t: number; category: CategoryId; severity: Severity; description: string;
  bbox?: BBox | null; pinned: boolean;
  /** The operator's name for the issue (trimmed to 80 chars by the backend). */
  name?: string;
}

/** Operator changes to any issue: pin it into the next plan, name it ("" clears), or set (and undo) its severity. */
export interface IssuePatch { pinned?: boolean; severity?: Severity; revert_severity?: boolean; name?: string }

export interface UploadOptions { onProgress?: (fraction: number) => void; signal?: AbortSignal }

export interface RaightwayClient {
  readonly id: string;
  readonly label: string;
  readonly capabilities: Capabilities;
  listVideos(signal?: AbortSignal): Promise<Video[]>;
  getVideo(id: string, signal?: AbortSignal): Promise<{ video: Video; issues: Issue[] }>;
  listIssues(signal?: AbortSignal): Promise<Issue[]>;
  similar(issueId: string, signal?: AbortSignal): Promise<Similar[]>;
  /** null when no report has been generated yet. */
  getReport(signal?: AbortSignal): Promise<ReportPayload | null>;
  regenerateReport(): Promise<ReportPayload>;
  /** Plans routes. `crews` is the legacy trucks-per-crew-type; `opts` carries sites, days, floor, triage, scenario. */
  dispatch(crews: CrewCounts, opts?: DispatchOptions): Promise<Plan>;
  /** Operating sites with their crews and trucks per day. */
  listFacilities(signal?: AbortSignal): Promise<Facility[]>;
  addFacility(input: FacilityInput): Promise<Facility>;
  updateFacility(id: string, patch: FacilityInput): Promise<Facility>;
  removeFacility(id: string): Promise<void>;
  /** Forgets every site edit: the bundled City list again. */
  resetFacilities(): Promise<Facility[]>;
  /** An address in Toronto → a point, or null when nothing matches. */
  geocode(query: string): Promise<GeocodeHit | null>;
  /** Planning zones: the City's wards and areas drawn in the console. */
  listZones(signal?: AbortSignal): Promise<Zone[]>;
  addZone(label: string, polygon: LatLon[]): Promise<Zone>;
  updateZone(id: string, patch: { label?: string; polygon?: LatLon[] }): Promise<Zone>;
  removeZone(id: string): Promise<void>;
  /** Nemotron + cuOpt workforce scenarios and a pick. */
  recommend(opts: RecommendOptions): Promise<Recommendation>;
  /** The latest recommendation, or null. */
  latestRecommendation(signal?: AbortSignal): Promise<Recommendation | null>;
  /** What a running recommendation is doing (stage, scenarios solved, seconds). */
  recommendProgress(signal?: AbortSignal): Promise<RecommendProgress>;
  /** City road closures and dashcam work zones near the work, worst first. */
  hazards(signal?: AbortSignal): Promise<Hazard[]>;
  /** Best road path between two points around current closures. */
  directions(origin: LatLon, destination: LatLon): Promise<Directions>;
  upload(file: File, opts?: UploadOptions): Promise<Video>;
  /** Starts a live analysis of unseen footage from the VAST index; resolves with its Video (queued). */
  run(): Promise<Video>;
  searchTopic(query: string, signal?: AbortSignal): Promise<TopicHit[]>;
  /** The full footage search (POST /api/search): hits plus VSS's synthesis and Nemotron's answer. */
  searchFootage(query: string, signal?: AbortSignal): Promise<TopicSearch>;
  /** Ask about one drive; `t` is the playhead (seconds), omitted to ask about the whole drive. */
  ask(videoId: string, question: string, t?: number | null, signal?: AbortSignal): Promise<AskAnswer>;
  /** Saves an operator-reported issue (source "manual"); resolves with it once frame, GPS and work order are in. */
  createIssue(input: ManualIssueInput): Promise<Issue>;
  /** Pin/unpin an issue or override its severity; resolves with the updated issue. */
  updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
  /** An <img> src for an issue's frame, or null to draw a placeholder. */
  frameUrl(issue: Issue): string | null;
  /** A <video> src, or null to step through issue frames. */
  videoUrl(video: Video): string | null;
  /** Where crews start and end their shift. */
  depot(): Depot;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly url: string, readonly body?: unknown) { super(message); this.name = 'ApiError'; }
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500; }
}
