// The one seam between the UI and a backend. Screens only ever call these methods, so pointing the
// console at a different service means writing (or configuring) one adapter, not touching components.
import type { CrewCounts, Depot, Directions, Hazard, Issue, LatLon, Plan, ReportPayload, Similar, TopicHit, Video } from '../types';

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
  /** Real JPEG frames at Issue.frame_url. Off: the UI draws a placeholder frame. */
  frames: boolean;
  /** Road alerts and closure-aware directions (GET /api/hazards, POST /api/directions). */
  directions: boolean;
}

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
  dispatch(crews: CrewCounts): Promise<Plan>;
  /** City road closures and dashcam work zones near the work, worst first. */
  hazards(signal?: AbortSignal): Promise<Hazard[]>;
  /** Best road path between two points around current closures. */
  directions(origin: LatLon, destination: LatLon): Promise<Directions>;
  upload(file: File, opts?: UploadOptions): Promise<Video>;
  /** Starts a live analysis of unseen footage from the VAST index; resolves with its Video (queued). */
  run(): Promise<Video>;
  searchTopic(query: string, signal?: AbortSignal): Promise<TopicHit[]>;
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
