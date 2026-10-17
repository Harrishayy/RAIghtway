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
  /** `manual` = marked by an operator on footage (POST /api/issues), never a model finding. */
  source?: 'upload' | 'corpus' | 'manual';
  /** Demo rank from a manual review of the footage (1 shows first); absent for most issues. */
  featured?: number | null;
  /** Severity rating pass: one sentence on what the rater saw and why this grade. */
  severity_reason?: string | null;
  /** Who graded severity: `cosmos3-reason`, `nemotron-super-vl` (fallback). Absent = the find pass's grade. */
  severity_model?: string | null;
  /** `rejected` = the rater judged it not a real defect (kept on record, left out of report and dispatch). */
  verdict?: 'confirmed' | 'rejected' | null;
  /** The find pass's grade before re-grading. */
  find_severity?: number | null;
  /** Include in the next plan: triage treats a pinned issue as must-do. Defaults to false. */
  pinned?: boolean;
  /** The operator's name for this issue (≤ 80 chars). Display with `issueLabel(i)`: name, else description. */
  name?: string | null;
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
  /** Who wrote `explanation`: Nemotron, or the template stand-in when Nemotron failed (UI extra). */
  explanation_source?: 'nemotron' | 'template' | null;
  /** Run clips: footage never analysed (`new`), or a re-check of analysed footage. */
  run_kind?: 'new' | 'recheck' | null;
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
  /** Display name of the model that wrote the prose (absent or null: the application's template). */
  model?: string | null;
  /** Detail sections (optional; older reports lack them). Figures come from code, prose from Nemotron. */
  stats?: ReportStats | null;
  sections?: ReportSection[];
  priorities?: ReportIssue[];
  hotspots?: ReportHotspot[];
  provenance?: ReportProvenance | null;
  /** The latest stored dispatch plan, summarised; null/absent = no plan yet. */
  crew_plan?: ReportCrewPlan | null;
}
export interface ReportTriageItem { issue_id: string; crew: string; severity: number; decision: string; reason: string; by: string }
export interface ReportCrewPlan {
  solver: string; matrix_source: string; solve_ms: number; routes: number; trucks: number; jobs: number;
  days: { day: number; jobs: number; trucks: number; drive_h: number; work_h: number; km?: number | null; back_first?: string | null; back_last?: string | null; solver?: string | null }[];
  sites: { id: string; label: string; kind: string; crews: string[]; trucks: Record<string, number>; routes: number; jobs: number; assumed: boolean }[];
  /** `nemotron-…` or `rules`; absent when the plan had no triage. */
  triage_model?: string | null; triage_model_name?: string | null; triage_rationale?: string | null;
  today: number; later: number; deferred: number; triage: ReportTriageItem[];
  unassigned: ReportTriageItem[]; unassigned_total: number; note?: string | null;
}
export type Deadline = 'today' | 'this week' | 'this month' | 'routine';
/** One finding as the report lists it. */
export interface ReportIssue {
  id: string; category: CategoryId; severity: Severity; severity_reason?: string | null; description: string;
  /** The operator's name for the issue, when set. */
  name?: string | null;
  video_id: string; drive?: string | null; t: number; lat?: number | null; lon?: number | null;
  /** Nearest named street, when known. */
  place?: string | null;
  sightings: number; confidence: number; deadline: Deadline; crew: CrewType; repair?: string | null; minutes: number;
}
export interface ReportSection {
  category: CategoryId; crew: CrewType; open: number;
  /** "1".."5" → open issues at that severity. */
  by_severity: Record<string, number>;
  severe: number; rejected: number; work_minutes: number; crew_hours: number; crews: number;
  equipment: { label: string; count: number }[];
  top: ReportIssue[];
  /** Recommended repair approach (Nemotron, else the application's template). */
  approach?: string | null;
}
export interface ReportHotspot {
  id: string; label: string; lat: number; lon: number; radius_m: number; issues: number; severe: number;
  max_severity: number; score: number; categories: Record<string, number>; drives: string[]; issue_ids: string[];
  note?: string | null;
}
export interface ReportStats {
  open: number; today: number; this_week: number; this_month: number; routine: number;
  located: number; drives: number; crews: number; crew_hours: number; rejected: number;
}
/** Which models answered and how complete the data is. */
export interface ReportProvenance {
  report_model: string; find_model: string; rating_models: Record<string, number>; unrated: number; rejected: number;
  sightings_total: number; canonical: number; duplicates_merged: number; with_embedding: number; with_gps: number;
  with_box: number; work_orders: number; template_work_orders: number; caveats: string[];
}
export interface ReportPayload { report: Report; updating: boolean }

/** Where a crew type is based: a City transfer station for sanitation, a works yard for the rest. */
export type FacilityKind = 'transfer_station' | 'collection_yard' | 'road_yard' | 'cleaning_yard' | 'yard';
/** A City operating site crews leave from and return to (Sites tab). */
export interface Facility {
  id: string; label: string; kind: FacilityKind; crews: CrewType[];
  lat: number; lon: number; address?: string | null; source: string;
  /** A stand-in location, not a confirmed site. */
  assumed?: boolean;
  /** The public page that names the site. */
  source_url?: string | null;
  note?: string | null;
  /** Added in the console rather than bundled. */
  custom?: boolean;
  /** Trucks the site sends out each day, per crew type. */
  vehicles?: Partial<Record<CrewType, number>>;
}
/** A planning area: an official City ward or one drawn in the console. Rings of [lat, lon]. */
export interface Zone {
  id: string; label: string; kind: 'ward' | 'custom'; polygons: LatLon[][]; source: string;
  source_url?: string | null; code?: number | null; custom?: boolean;
}
/** Fields for POST/PUT /api/facilities. */
export type FacilityInput = Partial<Pick<Facility, 'label' | 'kind' | 'crews' | 'lat' | 'lon' | 'address' | 'source' | 'source_url' | 'note' | 'vehicles'>>;
/** POST /api/geocode result. */
export interface GeocodeHit { lat: number; lon: number; label: string }
/** A road that is closed, restricted or busy: a City of Toronto restriction or a work zone seen on camera. */
export interface Hazard {
  id: string; source: 'city' | 'dashcam'; kind: string; label: string; lat: number; lon: number;
  /** The affected stretch, when known. */
  path?: LatLon[];
  /** 5 road closed both ways · 4 closed one way · 3 construction both ways · 2 one lane. */
  severity: number;
  detail?: string | null; until?: string | null;
}
export interface RouteWarning { hazard_id: string; label: string; source: 'city' | 'dashcam'; avoided: boolean }

export interface Route {
  crew_id: string;
  crew: CrewType;
  stops: string[];
  eta_min: number[];
  path: LatLon[];
  /** Backend extras: the route's own base (it starts and ends there), street geometry and what to send the crew. */
  facility_id?: string | null;
  depot?: LatLon | null;
  depot_label?: string | null;
  distance_km?: number | null;
  path_source?: 'road' | 'straight';
  warnings?: RouteWarning[];
  /** Google Maps driving directions, chained when a route has more stops than one link takes. */
  maps_urls?: string[];
  /** Plain-text run sheet to paste into a message to the crew. */
  brief?: string | null;
  /** Round trips: day of the plan (1-based), the truck, its full shift and totals, and who ordered the stops. */
  day?: number;
  vehicle_id?: string | null;
  schedule?: ScheduleEntry[];
  totals?: ShiftTotals | null;
  solver?: 'cuopt' | 'fallback' | null;
}
/** One line of a truck's shift, in minutes from 08:00. */
export interface ScheduleEntry {
  kind: 'depart' | 'job' | 'break' | 'return'; issue_id?: string | null; label: string; lat: number; lon: number;
  drive_min: number; arrive_min: number; work_min: number; depart_min: number; idle_min: number;
  severity?: number | null; pinned?: boolean;
}
export interface ShiftTotals {
  drive_min: number; work_min: number; break_min: number; idle_min: number; distance_km?: number | null;
  back_min: number; jobs: number;
  /** solver: cuOpt placed the lunch break; reserved: added after (fallback router); none: back before lunch. */
  lunch: 'solver' | 'reserved' | 'none';
}
export type TriageDecisionKind = 'today' | 'later' | 'defer';
export interface TriageDecision { issue_id: string; crew: CrewType; severity: number; decision: TriageDecisionKind; reason: string; by: 'rule' | 'model'; pinned?: boolean }
/** The day plan before routing: Nemotron, or the rules when no model answered (model "rules"). */
export interface Triage {
  model: string; model_name?: string | null; min_severity: number; days: number; rationale: string;
  by_crew: Partial<Record<CrewType, string>>; capacity_min: Partial<Record<CrewType, number>>; clamped: number;
  decisions: TriageDecision[];
  /** Who made the final decisions ("Nemotron decided N, rules M"), and why the rules decided when a model was asked. */
  model_decisions?: number; rule_decisions?: number; note?: string | null;
}
export interface PlanDay { day: number; jobs: number; trucks: number; by_severity: Record<string, number>; drive_min: number; work_min: number; distance_km: number; last_back_min: number; solver: 'cuopt' | 'fallback' }
export interface PlanSite { facility_id: string; label: string; kind: FacilityKind; trucks: Partial<Record<CrewType, number>>; jobs: number }
/** Trucks per site per crew type per day. */
export type SiteTrucks = Record<string, Partial<Record<CrewType, number>>>;
export interface ScenarioMetrics {
  jobs_selected: number; jobs_routed: number; s5_total: number; s5_covered: number; s4_total: number; s4_covered: number;
  pinned_total: number; pinned_covered: number; drive_hours: number; work_hours: number;
  /** Estimate: straight lines × 1.3 between the stops. */
  distance_km: number; trucks_used: number; trucks_available: number; deferred: number;
  unassigned_by_reason: Record<string, number>; solver: 'cuopt' | 'fallback'; triage: string; days: number; solve_ms: number;
}
export interface Scenario {
  id: string; label: string; intent: string; source: 'baseline' | 'model' | 'rules' | 'refined';
  min_severity: number; sites: SiteTrucks; trucks: Partial<Record<CrewType, number>>; clamped: string[];
  /** Focus zones for this scenario ([] = the request's focus, or the whole city). */
  zones?: string[];
  metrics?: ScenarioMetrics | null; error?: string | null;
}
/** Nemotron proposes scenarios, cuOpt solves each, Nemotron (or the rules) picks; code validates. */
export interface Recommendation {
  id: string; generated_at: string; agent_model: string; agent_model_name?: string | null;
  proposer: 'nemotron' | 'rules'; picker: 'nemotron' | 'rules'; recommended: string; rationale: string;
  tradeoffs: string[]; priorities: string[]; scenarios: Scenario[]; matrix_source: 'road' | 'straight'; days: number;
  refined: boolean; timings: Record<string, number>; caveats: string[];
  zones?: string[]; zone_labels?: string[];
}
export interface Plan {
  routes: Route[];
  unassigned: string[];
  solver: 'cuopt' | 'fallback';
  solve_ms: number;
  /** UI extra: why each unassigned job was dropped. */
  unassigned_reasons?: Record<string, string>;
  /** Backend extras: the bases in use, road alerts near the work, and whether travel times are road or straight-line. */
  facilities?: Facility[];
  hazards?: Hazard[];
  matrix_source?: 'road' | 'straight';
  /** Multi-day round trips after triage. */
  min_severity?: number | null;
  horizon_days?: number | null;
  sites?: PlanSite[];
  days?: PlanDay[];
  triage?: Triage | null;
  deferred?: string[];
  pinned?: string[];
  recommendation?: Recommendation | null;
  scenario_id?: string | null;
  /** Focus zones planned ([] = whole city), their names, and open jobs left out for being outside them. */
  zones?: string[];
  zone_labels?: string[];
  outside_zone?: number;
}
/** POST /api/dispatch options beyond the legacy crew counts. */
export interface DispatchOptions {
  sites?: SiteTrucks; days?: number; min_severity?: number; triage?: boolean;
  scenario?: { recommendation_id: string; scenario_id: string };
  /** Plan only jobs inside these zones (ids) and/or this drawn ring. */
  zones?: string[]; polygon?: LatLon[];
}
export interface RecommendOptions { days?: number; min_severity?: number; sites?: SiteTrucks; agent?: boolean; zones?: string[]; polygon?: LatLon[] }
/** GET /api/dispatch/recommend/progress, polled while a recommendation runs. */
export interface RecommendProgress { running: boolean; stage?: string; scenarios_done?: number; scenarios_total?: number; elapsed_s?: number }
/** Best road path between two points, steering around closures (POST /api/directions). */
export interface Directions {
  path: LatLon[]; minutes: number; distance_km: number; path_source: 'road' | 'straight';
  warnings: RouteWarning[]; alternatives: number; maps_url: string;
}

/** One GPS sample at 1 Hz from the PIE vehicle logs (architecture §3.4). `t` is seconds into the video. */
export interface TrackPoint { t: number; lat: number; lon: number; heading: number; speed_kmh: number }

/** A semantic-search hit from VSS `POST /api/v1/search` (`chunk_results`), placed on a video's timeline. */
export interface TopicHit { video_id: string; start: number; end: number; score: number; caption: string; similarity?: number }
/** `POST /api/search`: VSS matches on the listed drives, VSS's own synthesis, and Nemotron's answer from the matches
 *  and the issues already logged inside them (`answer_source` null: no answer, show the synthesis). */
export interface TopicSearch { query: string; hits: TopicHit[]; search?: 'vss'; synthesis?: string; answer?: string; answer_source?: 'nemotron' | null; answer_pending?: boolean; logged?: number }
/** `POST /api/videos/{id}/ask`: an answer about one drive, from VSS captions (`evidence`) and its logged issues. */
export interface AskEvidence { start: number; end: number; caption: string; kind: 'segment' | 'search' }
export interface AskAnswer { question: string; answer: string; source: 'nemotron' | 'vss'; times: number[]; evidence: AskEvidence[]; issue_ids: string[] }
export interface Topic { id: string; query: string; hits: TopicHit[]; pending?: boolean }

export interface Depot { lat: number; lon: number; label: string }
export type CrewCounts = Partial<Record<CrewType, number>>;
/** A vector-search neighbour. `distance` is cosine distance (0 = identical), null when the backend omits it.
 * `search` says which index answered: `vastdb` (VastDB ADBC) or `local` (the backend's in-memory fallback). */
export interface Similar { issue: Issue; distance: number | null; search?: 'vastdb' | 'local' }
