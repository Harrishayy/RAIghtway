// Registries and helpers. Everything the UI shows about a category, a severity level, a pipeline stage,
// a model or a module comes from these tables, so adding or removing one is a one-line change.

export const CATEGORIES = [
  // Order is the validated colour order (graffiti → waste); keep it for legends and stacked bars.
  { id: 'graffiti', label: 'Graffiti', crew: 'graffiti', crewLabel: 'Graffiti removal', code: 'G', minutes: [15, 45] },
  { id: 'markings', label: 'Road markings', crew: 'markings', crewLabel: 'Markings', code: 'M', minutes: [20, 60] },
  { id: 'work_zone', label: 'Work zone', crew: 'inspection', crewLabel: 'Work-zone inspection', code: 'I', minutes: [10, 30] },
  { id: 'pavement', label: 'Pavement', crew: 'roads', crewLabel: 'Roads', code: 'R', minutes: [30, 90] },
  { id: 'signage', label: 'Signage', crew: 'signage', crewLabel: 'Signage', code: 'S', minutes: [15, 45] },
  { id: 'waste', label: 'Waste', crew: 'sanitation', crewLabel: 'Sanitation', code: 'W', minutes: [10, 25] },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
export const CREW_FOR = Object.fromEntries(CATEGORIES.map(c => [c.id, c.crew]));
export const CATEGORY_FOR_CREW = Object.fromEntries(CATEGORIES.map(c => [c.crew, c.id]));

// Presets let a team narrow the product without touching components.
export const CATEGORY_PRESETS = {
  all: { label: 'All six categories', ids: CATEGORIES.map(c => c.id) },
  graffiti: { label: 'Graffiti only', ids: ['graffiti'] },
  roads: { label: 'Roads and markings', ids: ['pavement', 'markings', 'work_zone'] },
  streetscape: { label: 'Streetscape', ids: ['graffiti', 'waste', 'signage'] },
};

export const SEVERITY = [
  { level: 1, label: 'Cosmetic', urgency: 'routine', when: 'Routine', example: 'Light tagging, slightly faded paint' },
  { level: 2, label: 'Minor', urgency: 'routine', when: 'Routine', example: 'Small crack, worn but visible markings' },
  { level: 3, label: 'Repair this month', urgency: 'soon', when: 'This month', example: 'Pothole forming, faded crosswalk, overflowing bin' },
  { level: 4, label: 'Repair this week', urgency: 'soon', when: 'This week', example: 'Pothole in a traffic lane, hard-to-read sign' },
  { level: 5, label: 'Safety hazard', urgency: 'urgent', when: 'Today', example: 'Deep pothole, missing stop sign, unguarded work zone' },
];
export const URGENCY_FOR = { 1: 'routine', 2: 'routine', 3: 'soon', 4: 'soon', 5: 'urgent' };
export const PRIZE_FOR = { 1: 50, 2: 120, 3: 300, 4: 600, 5: 1000 };

// The live pipeline, in the order the backend reports it (architecture §3.3).
export const STAGES = [
  { id: 'segment', label: 'Segment', verb: 'Cutting into 5 s pieces' },
  { id: 'find', label: 'Find', verb: 'Checking pieces' },
  { id: 'box', label: 'Box & embed', verb: 'Boxing and embedding issues' },
  { id: 'history', label: 'History', verb: 'Checking history' },
  { id: 'plan', label: 'Repairs', verb: 'Planning repairs' },
];

export const MODELS = [
  { id: 'cosmos-reason', name: 'Cosmos3-Reason', vendor: 'NVIDIA', role: 'Finds, grades and boxes issues', p50: '2.8 s' },
  { id: 'cosmos-embed', name: 'Cosmos-Embed1', vendor: 'NVIDIA', role: 'Issue embeddings for dedupe', p50: '0.4 s' },
  { id: 'nemotron', name: 'Nemotron 3.5 Lightning', vendor: 'NVIDIA via W&B', role: 'Work orders, explanations, report', p50: '3.1 s' },
  { id: 'cuopt', name: 'cuOpt', vendor: 'NVIDIA', role: 'Crew routing', p50: '3.0 s' },
];

// Module manifest: which panel sits in which slot of which view. The console reads this; nothing is hard-wired.
export const DEFAULT_LAYOUT = {
  band: { map: true },
  overview: { kpis: true, intake: true, issues: true, plan: true, health: false },
  inspector: { sightings: true, similar: true, workOrder: true },
  footage: { drop: true },
  dispatch: { schedule: true, routes: true, unassigned: true },
};

export const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'footage', label: 'Footage' },
  { id: 'report', label: 'Report' },
  { id: 'dispatch', label: 'Dispatch' },
];

// ---------- helpers
export const cx = (...a) => a.filter(Boolean).join(' ');
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export const pad2 = n => String(Math.floor(n)).padStart(2, '0');
export const fmtClock = s => `${pad2(s / 60)}:${pad2(s % 60)}`;
export const fmtTimecode = s => `${pad2(s / 60)}:${pad2(Math.floor(s % 60))}.${Math.floor((s % 1) * 10)}`;
export const fmtDuration = s => s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? Math.round(s % 60) + ' s' : ''}`.trim() : `${Math.round(s)} s`;
export const fmtHours = m => { const h = m / 60; return (h < 10 ? h.toFixed(1) : Math.round(h)).toString().replace(/\.0$/, ''); };
export const fmtShift = (min, start = 8 * 60) => { const t = start + min; return `${pad2(t / 60)}:${pad2(t % 60)}`; };
export const fmtCoord = (lat, lon) => `${lat.toFixed(5)}, ${lon < 0 ? '−' : ''}${Math.abs(lon).toFixed(5)}`;
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
