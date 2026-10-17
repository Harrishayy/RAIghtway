// Runtime contracts. Every payload from a backend is parsed here before the UI sees it, so a backend
// that drifts (a missing field, a number sent as a string, an extra key) degrades to a sensible
// default instead of a blank screen. Unknown keys are kept, so adapters can read backend extras.
import { z } from 'zod';
import type { Issue, Plan, Report, ReportPayload, Similar, TopicHit, Video } from './types';

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
export const ReportSchema = z.looseObject({
  generated_at: str(), summary: str(), counts: countMap, crews: countMap, rationale: str(),
  rationale_by_crew: z.record(z.string(), z.string()).optional().catch(undefined), model: z.string().optional().catch(undefined),
});
export const RouteSchema = z.object({ crew_id: z.coerce.string(), crew: CrewType, stops: z.array(z.coerce.string()).catch([]), eta_min: z.array(z.coerce.number()).catch([]), path: z.array(latLon).catch([]) });
export const PlanSchema = z.looseObject({
  routes: z.array(RouteSchema).catch([]), unassigned: z.array(z.coerce.string()).catch([]),
  solver: z.enum(['cuopt', 'fallback']).catch('fallback'), solve_ms: num(0),
  unassigned_reasons: z.record(z.string(), z.string()).optional().catch(undefined),
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
  similar: (raw: unknown): Similar[] => (Array.isArray(raw) ? raw : []).flatMap((x: unknown) => {
    const o = x as Record<string, unknown>;
    const r = IssueSchema.safeParse(o && 'issue' in o ? o.issue : o);
    return r.success ? [{ issue: r.data as Issue, distance: Number(o?.distance ?? o?.score ?? 0) }] : [];
  }),
  topicHits: (raw: unknown): TopicHit[] => {
    const o = raw as Record<string, unknown> | unknown[];
    const arr = Array.isArray(o) ? o : (o?.hits ?? o?.chunk_results ?? []);
    return list(TopicHitSchema, arr, 'search hit');
  },
};
