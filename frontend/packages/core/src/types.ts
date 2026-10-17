// The data contract (architecture.md §4), as TypeScript. Field names match the FastAPI models so
// responses parse without mapping. Fields marked "UI extra" are optional: the mock source fills them,
// and the backend can add them later without breaking anything.

export type CategoryId = 'graffiti' | 'markings' | 'work_zone' | 'pavement' | 'signage' | 'waste';
export type CrewType = 'graffiti' | 'markings' | 'inspection' | 'roads' | 'signage' | 'sanitation';
export type Severity = 1 | 2 | 3 | 4 | 5;
export type Urgency = 'routine' | 'soon' | 'urgent';
export type StageId = 'segment' | 'find' | 'box' | 'history' | 'plan';
export type VideoStatus = 'queued' | 'analysing' | 'done' | 'failed';
export type ModelId = 'cosmos-reason' | 'cosmos-embed' | 'nemotron' | 'cuopt';
export type Health = 'ok' | 'degraded' | 'down';
export type LatLon = [lat: number, lon: number];

/** Normalised 0..1, top-left origin. */
export interface BBox { x: number; y: number; w: number; h: number }

export interface WorkOrder {
  repair: string;
  crew: CrewType;
  minutes: number;
  equipment: string[];
  urgency: Urgency;
}

export interface SightingRef { video_id: string; drive?: string | null; t: number }

export interface Issue {
  id: string;
  video_id: string;
  /** Seconds from the start of the video. */
  t: number;
  category: CategoryId;
  severity: Severity;
  confidence: number;
  description: string;
  frame_url: string;
  bbox: BBox | null;
  lat: number | null;
  lon: number | null;
  duplicate_of: string | null;
  /** Canonical issues: 1 + re-sightings. */
  sightings: number;
  work_order: WorkOrder | null;
  /** UI extra: human place name, e.g. "Queen St W near Portland St". */
  place?: string;
  /** UI extra: every sighting of this issue, newest last. */
  sighting_refs?: SightingRef[];
  /** UI extra: seeds the placeholder frame when no image is served. */
  frame_seed?: number;
  /** UI extra: true while a live analysis has found but not yet confirmed it. */
  provisional?: boolean;
  source?: 'upload' | 'corpus';
}

export interface AnalysisResult { found: number; merged: number; fresh: number }

export interface Video {
  id: string;
  filename: string;
  source: 'upload' | 'corpus';
  status: VideoStatus;
  /** 0..1 across the whole pipeline. */
  progress: number;
  /** Pipeline stage id. The API adapter maps backend strings ("checking 3/6") onto these. */
  stage: StageId | null;
  drive: string | null;
  start_s: number;
  duration_s: number;
  /** Nemotron's explanation. `**bold**` marks the phrases worth scanning for. */
  explanation: string | null;
  issue_ids: string[];
  track: LatLon[];
  /** UI extras */
  camera_id?: string;
  /** UI extra: a playable URL for the footage. Without it the player steps through issue frames. */
  video_url?: string | null;
  /** 1 Hz GPS with heading and speed, for the map's vehicle marker and the speed lane. */
  gps?: TrackPoint[];
  /** When the drive was recorded, if known. PIE logs have no wall clock, so the mock leaves it empty. */
  recorded_at?: string | null;
  stage_progress?: number;
  stage_detail?: string;
  eta_s?: number;
  result?: AnalysisResult;
}

export interface Report {
  generated_at: string;
  /** Nemotron's summary. `**bold**` marks the phrases worth scanning for. */
  summary: string;
  counts: Partial<Record<CategoryId, number>>;
  crews: Partial<Record<CrewType, number>>;
  rationale: string;
  /** UI extras */
  rationale_by_crew?: Partial<Record<CrewType, string>>;
  model?: string;
}
export interface ReportPayload { report: Report; updating: boolean }

export interface Route {
  crew_id: string;
  crew: CrewType;
  stops: string[];
  eta_min: number[];
  path: LatLon[];
}
export interface Plan {
  routes: Route[];
  unassigned: string[];
  solver: 'cuopt' | 'fallback';
  solve_ms: number;
  /** UI extra: why each unassigned job was dropped. */
  unassigned_reasons?: Record<string, string>;
}

/** One GPS sample at 1 Hz from the PIE vehicle logs (architecture §3.4). `t` is seconds into the video. */
export interface TrackPoint { t: number; lat: number; lon: number; heading: number; speed_kmh: number }

/** A semantic-search hit from VSS `POST /api/v1/search` (`chunk_results`), placed on a video's timeline. */
export interface TopicHit { video_id: string; start: number; end: number; score: number; caption: string }
export interface Topic { id: string; query: string; hits: TopicHit[]; pending?: boolean }

export interface Depot { lat: number; lon: number; label: string }
export type CrewCounts = Partial<Record<CrewType, number>>;
/** `distance` is null when the backend returns plain issues (the FastAPI backend does). */
export interface Similar { issue: Issue; distance: number | null }
