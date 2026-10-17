// Runtime contracts. Every payload from a backend is parsed here before the UI sees it, so a backend
// that drifts (a missing field, a number sent as a string, an extra key) degrades to a sensible
// default instead of a blank screen. Unknown keys are kept, so adapters can read backend extras.
import { z } from 'zod';
import type { Directions, Hazard, Issue, Plan, Report, ReportPayload, Similar, TopicHit, Video } from './types';

const num = (d = 0) => z.coerce.number().catch(d);
const str = (d = '') => z.coerce.string().catch(d);
const nullableNum = z.union([z.coerce.number(), z.null()]).catch(null);
const latLon = z.tuple([z.coerce.number(), z.coerce.number()]);

export const CategoryId = z.enum(['graffiti', 'markings', 'work_zone', 'pavement', 'signage', 'waste']);
export const CrewType = z.enum(['graffiti', 'markings', 'inspection', 'roads', 'signage', 'sanitation']);
export const StageId = z.enum(['segment', 'find', 'box', 'history', 'plan']);

export const BBox = z.object({ x: num(), y: num(), w: num(), h: num() });
export const WorkOrder = z.object({
  repair: str(), crew: CrewType, minutes: num(30), equipment: z.array(z.coerce.string()).catch([]),
  urgency: z.enum(['routine', 'soon', 'urgent']).catch('routine'),
});
export const SightingRef = z.object({ video_id: str(), drive: z.string().nullable().optional(), t: num() });

export const IssueSchema = z.looseObject({
  id: z.coerce.string(), video_id: str(), t: num(),
  category: CategoryId, severity: z.coerce.number().int().min(1).max(5).catch(3),
  confidence: num(0), description: str(), frame_url: str(),
  bbox: BBox.nullable().catch(null), lat: nullableNum, lon: nullableNum,
  duplicate_of: z.string().nullable().catch(null).default(null), sightings: num(1),
  work_order: WorkOrder.nullable().catch(null).default(null),
  place: z.string().optional().catch(undefined), sighting_refs: z.array(SightingRef).optional().catch(undefined),
  frame_seed: z.number().optional().catch(undefined), provisional: z.boolean().optional().catch(undefined),
  source: z.enum(['upload', 'corpus']).optional().catch(undefined),
  featured: z.coerce.number().int().positive().nullable().optional().catch(undefined),
  severity_reason: z.string().nullable().optional().catch(undefined),
  severity_model: z.string().nullable().optional().catch(undefined),
  verdict: z.enum(['confirmed', 'rejected']).nullable().optional().catch(undefined),
  find_severity: z.coerce.number().int().min(1).max(5).nullable().optional().catch(undefined),
});

export const TrackPoint = z.object({ t: num(), lat: num(), lon: num(), heading: num(), speed_kmh: num() });
export const VideoSchema = z.looseObject({
  id: z.coerce.string(), filename: str(), source: z.enum(['upload', 'corpus']).catch('corpus'),
  status: z.enum(['queued', 'analysing', 'done', 'failed']).catch('done'), progress: num(0),
  // stage arrives as free text from some backends ("checking 3/6"); adapters map it before parsing
  stage: StageId.nullable().catch(null).default(null),
  drive: z.string().nullable().catch(null).default(null), start_s: num(0), duration_s: num(0),
  explanation: z.string().nullable().catch(null).default(null), issue_ids: z.array(z.coerce.string()).catch([]),
  track: z.array(latLon).catch([]),
  camera_id: z.string().optional().catch(undefined), video_url: z.string().nullable().optional().catch(undefined),
  gps: z.array(TrackPoint).optional().catch(undefined), recorded_at: z.string().nullable().optional().catch(undefined),
  stage_progress: z.number().optional().catch(undefined), stage_detail: z.string().optional().catch(undefined),
  eta_s: z.number().optional().catch(undefined),
  result: z.object({ found: num(), merged: num(), fresh: num() }).optional().catch(undefined),
});

const countMap = z.record(z.string(), z.coerce.number()).catch({});
const sev = z.coerce.number().int().min(1).max(5).catch(3);
const nstr = z.string().nullable().optional().catch(undefined);
/** Parses a list leniently: bad items are dropped, not the whole list (used for report sections). */
const lenientList = <T extends z.ZodTypeAny>(item: T) => z.array(z.unknown()).catch([]).transform(arr => arr.flatMap(x => { const r = item.safeParse(x); return r.success ? [r.data as z.infer<T>] : []; }));
export const ReportIssueSchema = z.object({
  id: z.coerce.string(), category: CategoryId, severity: sev, severity_reason: nstr, description: str(),
  video_id: str(), drive: nstr, t: num(0), lat: nullableNum.optional(), lon: nullableNum.optional(), place: nstr,
  sightings: num(1), confidence: num(0), deadline: z.enum(['today', 'this week', 'this month', 'routine']).catch('routine'),
  crew: CrewType, repair: nstr, minutes: num(0),
});
export const ReportSectionSchema = z.object({
  category: CategoryId, crew: CrewType, open: num(0), by_severity: countMap, severe: num(0), rejected: num(0),
  work_minutes: num(0), crew_hours: num(0), crews: num(0),
  equipment: z.array(z.object({ label: str(), count: num(0) })).catch([]),
  top: lenientList(ReportIssueSchema), approach: nstr,
});
export const ReportHotspotSchema = z.object({
  id: z.coerce.string(), label: str(), lat: z.coerce.number(), lon: z.coerce.number(), radius_m: num(300), issues: num(0),
  severe: num(0), max_severity: num(1), score: num(0), categories: countMap,
  drives: z.array(z.coerce.string()).catch([]), issue_ids: z.array(z.coerce.string()).catch([]), note: nstr,
});
export const ReportStatsSchema = z.object({
  open: num(0), today: num(0), this_week: num(0), this_month: num(0), routine: num(0), located: num(0), drives: num(0),
  crews: num(0), crew_hours: num(0), rejected: num(0),
});
export const ReportProvenanceSchema = z.object({
  report_model: str('template'), find_model: str('cosmos3-reason'), rating_models: countMap, unrated: num(0), rejected: num(0),
  sightings_total: num(0), canonical: num(0), duplicates_merged: num(0), with_embedding: num(0), with_gps: num(0),
  with_box: num(0), work_orders: num(0), template_work_orders: num(0), caveats: z.array(z.coerce.string()).catch([]),
});
const ReportTriageItemSchema = z.object({ issue_id: z.coerce.string(), crew: str(), severity: num(0), decision: str(), reason: str(), by: str() });
export const ReportCrewPlanSchema = z.object({
  solver: str('fallback'), matrix_source: str('straight'), solve_ms: num(0), routes: num(0), trucks: num(0), jobs: num(0),
  days: lenientList(z.object({ day: num(1), jobs: num(0), trucks: num(0), drive_h: num(0), work_h: num(0), km: nullableNum.optional(), back_first: nstr, back_last: nstr, solver: nstr })),
  sites: lenientList(z.object({ id: z.coerce.string(), label: str(), kind: str('yard'), crews: z.array(z.coerce.string()).catch([]), trucks: countMap, routes: num(0), jobs: num(0), assumed: z.boolean().catch(false) })),
  triage_model: nstr, triage_model_name: nstr, triage_rationale: nstr,
  today: num(0), later: num(0), deferred: num(0), triage: lenientList(ReportTriageItemSchema),
  unassigned: lenientList(ReportTriageItemSchema), unassigned_total: num(0), note: nstr,
});
export const ReportSchema = z.looseObject({
  generated_at: str(), summary: str(), counts: countMap, crews: countMap, rationale: str(),
  rationale_by_crew: z.record(z.string(), z.string()).optional().catch(undefined), model: z.string().nullable().optional().catch(undefined),
  stats: ReportStatsSchema.nullable().optional().catch(undefined),
  sections: lenientList(ReportSectionSchema).optional(),
  priorities: lenientList(ReportIssueSchema).optional(),
  hotspots: lenientList(ReportHotspotSchema).optional(),
  provenance: ReportProvenanceSchema.nullable().optional().catch(undefined),
  crew_plan: ReportCrewPlanSchema.nullable().optional().catch(undefined),
});
const optStr = z.string().nullable().optional().catch(undefined);
export const RouteWarningSchema = z.object({ hazard_id: z.coerce.string(), label: str(), source: z.enum(['city', 'dashcam']).catch('city'), avoided: z.boolean().catch(false) });
export const FacilitySchema = z.object({
  id: z.coerce.string(), label: str(), kind: z.enum(['transfer_station', 'yard']).catch('yard'), crews: z.array(CrewType).catch([]),
  lat: z.coerce.number(), lon: z.coerce.number(), address: optStr, source: str(), assumed: z.boolean().optional().catch(undefined),
});
export const HazardSchema = z.object({
  id: z.coerce.string(), source: z.enum(['city', 'dashcam']).catch('city'), kind: str(), label: str(),
  lat: z.coerce.number(), lon: z.coerce.number(), path: z.array(latLon).optional().catch(undefined),
  severity: num(3), detail: optStr, until: optStr,
});
const pathSource = z.enum(['road', 'straight']).optional().catch(undefined);
export const RouteSchema = z.object({
  crew_id: z.coerce.string(), crew: CrewType, stops: z.array(z.coerce.string()).catch([]), eta_min: z.array(z.coerce.number()).catch([]), path: z.array(latLon).catch([]),
  facility_id: optStr, depot: latLon.nullable().optional().catch(undefined), depot_label: optStr,
  distance_km: z.number().nullable().optional().catch(undefined), path_source: pathSource,
  warnings: z.array(RouteWarningSchema).optional().catch(undefined), maps_urls: z.array(z.string()).optional().catch(undefined), brief: optStr,
});
export const PlanSchema = z.looseObject({
  routes: z.array(RouteSchema).catch([]), unassigned: z.array(z.coerce.string()).catch([]),
  solver: z.enum(['cuopt', 'fallback']).catch('fallback'), solve_ms: num(0),
  unassigned_reasons: z.record(z.string(), z.string()).optional().catch(undefined),
  facilities: z.array(FacilitySchema).optional().catch(undefined), hazards: z.array(HazardSchema).optional().catch(undefined),
  matrix_source: pathSource,
});
export const DirectionsSchema = z.object({
  path: z.array(latLon).catch([]), minutes: num(0), distance_km: num(0), path_source: z.enum(['road', 'straight']).catch('straight'),
  warnings: z.array(RouteWarningSchema).catch([]), alternatives: num(1), maps_url: str(),
});
export const TopicHitSchema = z.object({ video_id: str(), start: num(), end: num(), score: num(), caption: str() });

/** Parses a list, dropping (and reporting) items that can't be repaired rather than failing the whole list. */
function list<T>(schema: z.ZodType<T>, raw: unknown, what: string, onDrop?: (what: string, err: z.ZodError) => void): T[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: T[] = [];
  for (const item of arr) { const r = schema.safeParse(item); if (r.success) out.push(r.data); else onDrop?.(what, r.error); }
  return out;
}
// Warn once per distinct problem, not on every poll.
const warned = new Set<string>();
const warn = (what: string, err: z.ZodError) => {
  const key = `${what}:${err.issues.map(i => i.path.join('.') + i.code).join('|')}`;
  if (warned.has(key) || typeof console === 'undefined') return;
  warned.add(key); console.warn(`[raightway] dropped a ${what} that does not match the contract`, err.issues.slice(0, 3));
};

export const parse = {
  video: (raw: unknown): Video => VideoSchema.parse(raw) as Video,
  videos: (raw: unknown): Video[] => list(VideoSchema, raw, 'video', warn) as Video[],
  issue: (raw: unknown): Issue => IssueSchema.parse(raw) as Issue,
  issues: (raw: unknown): Issue[] => list(IssueSchema, raw, 'issue', warn) as Issue[],
  report: (raw: unknown): ReportPayload => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const inner = 'report' in o ? o.report : raw;
    return { report: ReportSchema.parse(inner) as Report, updating: Boolean(o.updating) };
  },
  plan: (raw: unknown): Plan => PlanSchema.parse(raw) as Plan,
  hazards: (raw: unknown): Hazard[] => list(HazardSchema, raw, 'road alert', warn) as Hazard[],
  directions: (raw: unknown): Directions => DirectionsSchema.parse(raw) as Directions,
  similar: (raw: unknown): Similar[] => (Array.isArray(raw) ? raw : []).flatMap((x: unknown) => {
    const o = x as Record<string, unknown>;
    const r = IssueSchema.safeParse(o && 'issue' in o ? o.issue : o);
    const d = Number(o?.distance ?? o?.score ?? NaN);
    const search = o?.search === 'vastdb' || o?.search === 'local' ? o.search : undefined;
    return r.success ? [{ issue: r.data as Issue, distance: Number.isFinite(d) ? d : null, ...(search ? { search } : {}) }] : [];
  }),
  topicHits: (raw: unknown): TopicHit[] => {
    const o = raw as Record<string, unknown> | unknown[];
    const arr = Array.isArray(o) ? o : (o?.hits ?? o?.chunk_results ?? []);
    return list(TopicHitSchema, arr, 'search hit');
  },
};
