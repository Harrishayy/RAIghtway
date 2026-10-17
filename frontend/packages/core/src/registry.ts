// Registries. Everything the UI says about a category, severity level, pipeline stage or model comes
// from these tables: adding, renaming or removing one is a change here, not in components.
import type { CategoryId, CrewType, ModelId, Severity, StageId, Urgency } from './types';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  /** Short label for chips. */
  short: string;
  crew: CrewType;
  crewLabel: string;
  /** One-letter crew code used in crew ids (G1, R2…). */
  code: string;
  /** Typical minutes on site, S1 → S5. */
  minutes: [number, number];
}

// Order is the colour-validated order (adjacent hues stay distinguishable for CVD). Keep it for legends and stacked bars.
export const CATEGORIES: readonly CategoryDef[] = [
  { id: 'graffiti', label: 'Graffiti', short: 'Graffiti', crew: 'graffiti', crewLabel: 'Graffiti removal', code: 'G', minutes: [15, 45] },
  { id: 'markings', label: 'Road markings', short: 'Markings', crew: 'markings', crewLabel: 'Markings', code: 'M', minutes: [20, 60] },
  { id: 'work_zone', label: 'Work zone', short: 'Work zone', crew: 'inspection', crewLabel: 'Work-zone inspection', code: 'I', minutes: [10, 30] },
  { id: 'pavement', label: 'Pavement', short: 'Pavement', crew: 'roads', crewLabel: 'Roads', code: 'R', minutes: [30, 90] },
  { id: 'signage', label: 'Signage', short: 'Signage', crew: 'signage', crewLabel: 'Signage', code: 'S', minutes: [15, 45] },
  { id: 'waste', label: 'Waste', short: 'Waste', crew: 'sanitation', crewLabel: 'Sanitation', code: 'W', minutes: [10, 25] },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map(c => [c.id, c])) as Record<CategoryId, CategoryDef>;
export const CREW_FOR = Object.fromEntries(CATEGORIES.map(c => [c.id, c.crew])) as Record<CategoryId, CrewType>;
export const CATEGORY_FOR_CREW = Object.fromEntries(CATEGORIES.map(c => [c.crew, c.id])) as Record<CrewType, CategoryId>;

export type CategoryPresetId = 'all' | 'graffiti' | 'roads' | 'streetscape';
export const CATEGORY_PRESETS: Record<CategoryPresetId, { label: string; ids: CategoryId[] }> = {
  all: { label: 'All six categories', ids: CATEGORIES.map(c => c.id) },
  graffiti: { label: 'Graffiti only', ids: ['graffiti'] },
  roads: { label: 'Roads and markings', ids: ['pavement', 'markings', 'work_zone'] },
  streetscape: { label: 'Streetscape', ids: ['graffiti', 'waste', 'signage'] },
};

export interface SeverityDef { level: Severity; label: string; when: string; legend: string; urgency: Urgency; example: string; prize: number }
export const SEVERITY: readonly SeverityDef[] = [
  { level: 1, label: 'Cosmetic', when: 'Routine', legend: 'Cosmetic', urgency: 'routine', example: 'Light tagging, slightly faded paint', prize: 50 },
  { level: 2, label: 'Minor', when: 'Routine', legend: 'Minor', urgency: 'routine', example: 'Small crack, worn but visible markings', prize: 120 },
  { level: 3, label: 'Repair this month', when: 'This month', legend: 'This month', urgency: 'soon', example: 'Pothole forming, faded crosswalk, overflowing bin', prize: 300 },
  { level: 4, label: 'Repair this week', when: 'This week', legend: 'This week', urgency: 'soon', example: 'Pothole in a traffic lane, hard-to-read sign', prize: 600 },
  { level: 5, label: 'Safety hazard', when: 'Today', legend: 'Hazard, today', urgency: 'urgent', example: 'Deep pothole, missing stop sign, unguarded work zone', prize: 1000 },
];
export const severityDef = (s: Severity): SeverityDef => SEVERITY[s - 1]!;

export interface StageDef { id: StageId; label: string; verb: string }
/** The live pipeline, in the order the backend reports it (architecture §3.3). */
export const STAGES: readonly StageDef[] = [
  { id: 'segment', label: 'Segment', verb: 'Cutting into 5 s pieces' },
  { id: 'find', label: 'Find', verb: 'Checking pieces' },
  { id: 'box', label: 'Box & embed', verb: 'Boxing and embedding issues' },
  { id: 'history', label: 'History', verb: 'Checking history' },
  { id: 'plan', label: 'Repairs', verb: 'Planning repairs' },
];

export interface ModelDef { id: ModelId; name: string; vendor: string; role: string; p50: string }
export const MODELS: readonly ModelDef[] = [
  { id: 'cosmos-reason', name: 'Cosmos3-Reason', vendor: 'NVIDIA', role: 'Finds, grades and boxes issues', p50: '2.8 s' },
  { id: 'cosmos-embed', name: 'Cosmos-Embed1', vendor: 'NVIDIA', role: 'Issue embeddings for dedupe', p50: '0.4 s' },
  { id: 'nemotron', name: 'Nemotron 3.5 Lightning', vendor: 'NVIDIA via W&B', role: 'Work orders, explanations, report', p50: '3.1 s' },
  { id: 'cuopt', name: 'cuOpt', vendor: 'NVIDIA', role: 'Crew routing', p50: '3.0 s' },
];

/** Shift length used by dispatch (architecture §3.8). */
export const SHIFT_MINUTES = 480;
export const SHIFT_START_MINUTES = 8 * 60;
