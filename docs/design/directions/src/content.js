// Words and tables for the directions page. Kept apart from the renderers so the copy can change without
// touching layout code, the same split the product uses (registries in core, components read them).

export const DIRS = {
  survey: {
    key: 'A', label: 'Survey', eyebrow: 'Direction A · The inspector’s clipboard',
    name: 'Survey', concept: 'A city inspector’s clipboard: graph paper, condensed headings, and survey-marking pink where the eye needs to land. Calm and legible, so a long day of review stays easy on the eyes.',
    principles: ['Light paper surfaces; colour is spent only on findings and severity.', 'Condensed caps for structure, monospace for every number a person might act on.', 'Hard 1 px rules and 4 px corners: it reads like a form, because it is one.', 'Findings get a spray-paint ring, the mark a real inspector leaves on site.'],
    mascot: 'Dash wears survey pink, standing in for the cone a field inspector drops beside a defect.',
    type: { d: 'Barlow Semi Condensed', b: 'Public Sans', m: 'IBM Plex Mono' },
    signature: 'Spray ring: the box sprays in at 1.25× and settles',
  },
  night: {
    key: 'B', label: 'Night Shift', eyebrow: 'Direction B · The depot before dawn',
    name: 'Night <b>Shift</b>', concept: 'The works depot at 5 a.m.: dark, dense, with sodium-lamp amber on whatever needs a decision. Built for a big screen in a dim room and for watching footage for hours.',
    principles: ['A dark room lets the dashcam footage carry the colour.', 'Monospace labels and tight rows: more video, more timeline, less chrome.', 'Amber only for the live and the selected; everything else steps back.', 'Live items glow like a hazard lamp; rows that arrive get a headlight sheen.'],
    mascot: 'Dash gets a reflective collar that catches the light, like a cone on a night closure.',
    type: { d: 'Chivo', b: 'Instrument Sans', m: 'Chivo Mono' },
    signature: 'Hazard glow: the box lights up amber with a soft bloom',
  },
  paint: {
    key: 'C', label: 'Fresh Paint', eyebrow: 'Direction C · New lines on the road',
    name: 'Fresh Paint', concept: 'Thermoplastic yellow, thick outlines and chunky rounded shapes: road-marking paint on clean asphalt. Bright and confident, made to read from the back of a room on a projector.',
    principles: ['Ink outlines and offset shadows make every control obvious from across a room.', 'Yellow is a fill, never text: an ink colour carries any label that sits on it.', 'Rounded 12 px shapes; buttons press down into their own shadow.', 'Lane dashes paint in when progress moves; the box is a fat yellow stroke.'],
    mascot: 'Dash gets an ink outline and a fresh yellow stripe, like a new cone.',
    type: { d: 'Familjen Grotesk', b: 'Hanken Grotesk', m: 'Red Hat Mono' },
    signature: 'Line paint: the box strokes on like a striping machine',
  },
};

export const DASH_STATES = [
  { id: 'idle', label: 'Idle', on: 'No job running', line: 'Watching the feed.' },
  { id: 'scan', label: 'Scanning', on: 'stage: segment · find', line: 'Checking pieces 3 of 6.' },
  { id: 'spot', label: 'Spotted', on: 'detection found', line: 'Graffiti, S3, on Queen St W.' },
  { id: 'check', label: 'Checking', on: 'stage: history', line: 'Seen this one before: merged.' },
  { id: 'plan', label: 'Planning', on: 'stage: plan · report', line: 'Writing 4 work orders.' },
  { id: 'route', label: 'Routing', on: 'cuOpt solve', line: 'Routing 5 crews.' },
  { id: 'fail', label: 'Tipped over', on: 'status: failed', line: 'Model timed out. Retrying.' },
  { id: 'done', label: 'Done', on: 'plan ready', line: 'Plan ready for tomorrow.' },
];

export const TOPICS = {
  all: 'anything blocking a lane',
  graffiti: 'tags on storefront shutters',
  roads: 'potholes in the curb lane',
  streetscape: 'overflowing bins on the sidewalk',
};

export const STACK = [
  ['Framework', 'Next.js 16 (App Router)', 'Server components for the shell, client components for the desk. Rewrites proxy /api to FastAPI, so there is one origin and no CORS.'],
  ['Workspace', 'pnpm 10 workspaces', 'apps/web and packages/core. Strict engines, a single lockfile, and exact versions.'],
  ['Language', 'TypeScript 6, strict', 'The contracts are zod schemas; the types are inferred from them, so the backend and the UI can’t disagree in silence.'],
  ['Styling', 'Tailwind v4 + CSS variables', 'Each direction is one CSS file of tokens under [data-dir]. @theme inline maps them to bg-surface, text-ink-2 and the rest.'],
  ['Primitives', 'Radix UI', 'Dialog, Popover, Tooltip, Tabs, ToggleGroup, Slider: accessible behaviour, styled by our tokens.'],
  ['Variants', 'cva + tailwind-merge', 'One variant table per component: tone, size, density.'],
  ['Desk layout', 'dockview 8 (React)', 'Movable, dockable, floating panes; the layout serialises to JSON and is saved per user.'],
  ['Server state', 'TanStack Query 5', 'Polling at 1 s while a job runs and 10 s when idle; cached by resource key.'],
  ['Client state', 'zustand 5 (persist)', 'Direction, category preset, playhead, selection and the desk layout.'],
  ['Map', 'MapLibre GL + SVG fallback', 'Tiles when online; the schematic SVG map from this page when the venue Wi-Fi drops.'],
  ['Video', 'Native <video> + our transport', 'requestVideoFrameCallback for frame-accurate boxes; seeks driven by the timeline.'],
  ['Validation', 'zod 4', 'Every response is parsed at the boundary, and the fixtures are checked against the same schemas in CI.'],
  ['Feedback', 'sonner, cmdk', 'Toasts with Undo; a command palette on ⌘K for jump-to-issue and seek-to-time.'],
  ['Mocks', 'msw 2', 'The whole UI runs on fixtures until the backend is up, served from the same paths.'],
  ['Tests', 'vitest + Playwright', 'Unit tests for derive/format; one Playwright run of the full demo path with screenshots.'],
  ['Lint', 'eslint 10 + boundaries', 'Enforces the import direction below and bans raw hex outside the token files.'],
];

export const LAYERS = [
  ['Routes', 'app/(desk)/review, /issues, /report, /dispatch', 'Thin pages: read params, pick a feature, nothing else. app/api holds no logic; next.config rewrites /api to FastAPI.'],
  ['Features', 'features/review, issues, report, dispatch, upload', 'One folder per screen. Composes domain hooks and ui pieces. Features never import each other.'],
  ['Domain', 'domain/footage, issues, plan, live', 'Query hooks, selectors and view models: useVideo, useIssues, usePlaybackSync, usePlan. No JSX.'],
  ['UI', 'ui/Button, Chip, Pane, Timeline, FrameMark …', 'Presentational components with no data fetching. Imports tokens and other ui only.'],
  ['Tokens', 'tokens/base.css, survey.css, night.css, paint.css', 'Semantic CSS variables. Swapping the data-dir attribute swaps the whole look.'],
];

export const EVENTS = [
  ['POST /api/videos', 'Upload accepted', 'Row appears in Footage as queued; desk focuses it', 'idle → scan'],
  ['stage = segment', 'Video cut into 5 s pieces', 'Stage track fills; piece ticks appear on the timeline', 'scan'],
  ['stage = find', 'Cosmos3-Reason per piece', 'Each found issue drops a mark on its lane at its exact time', 'spot (per hit)'],
  ['stage = box', 'Boxes + Cosmos-Embed1 vectors', 'The box draws on the frame; the map pin lands', 'spot'],
  ['stage = history', 'VastDB vector search', 'Merged issues collapse into their original with a toast and Undo', 'check'],
  ['stage = plan', 'Nemotron work orders', 'Work orders fill in on the issue card', 'plan'],
  ['GET /api/report', 'updating = true', 'Report shows a shimmer on the paragraphs being rewritten', 'plan'],
  ['POST /api/plan', 'cuOpt solve', 'Routes draw on the map, crew lanes fill the schedule', 'route → done'],
  ['status = failed', 'Any stage errors', 'Row turns red with a Retry button; the rest of the desk keeps working', 'fail'],
];

export const CONTRACT = `<span class="c">// packages/core/src/schema/issue.ts — mirrors backend/app/models.py</span>
<span class="k">export const</span> BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }); <span class="c">// 0..1, top-left</span>

<span class="k">export const</span> WorkOrder = z.object({
  repair: z.string(), crew: CrewType, minutes: z.number().int(),
  equipment: z.array(z.string()), urgency: z.enum(['routine', 'soon', 'urgent']),
});

<span class="k">export const</span> Issue = z.object({
  id: z.string(), video_id: z.string(),
  t: z.number(),                         <span class="c">// seconds into the video: the timeline and the seek key</span>
  category: CategoryId, severity: z.number().int().min(1).max(5), confidence: z.number(),
  description: z.string(), frame_url: z.string(), bbox: BBox.nullable(),
  lat: z.number().nullable(), lon: z.number().nullable(),
  duplicate_of: z.string().nullable(), sightings: z.number().int(),
  work_order: WorkOrder.nullable(),
  place: z.string().optional(), sighting_refs: z.array(SightingRef).optional(),  <span class="c">// UI extras</span>
});

<span class="k">export const</span> TrackPoint = z.object({ t: z.number(), lat: z.number(), lon: z.number(), heading: z.number(), speed_kmh: z.number() });
<span class="k">export const</span> TopicHit = z.object({ video_id: z.string(), start: z.number(), end: z.number(), score: z.number(), caption: z.string() });

<span class="k">export const</span> Video = z.object({
  id: z.string(), filename: z.string(), source: z.enum(['upload', 'corpus']),
  status: z.enum(['queued', 'analysing', 'done', 'failed']), progress: z.number(),
  stage: StageId.nullable(), drive: z.string().nullable(), duration_s: z.number(),
  explanation: z.string().nullable(), issue_ids: z.array(z.string()),
  gps: z.array(TrackPoint).optional(),   <span class="c">// 1 Hz: the map car and the speed lane follow the playhead</span>
});
<span class="k">export type</span> Issue = z.infer&lt;<span class="k">typeof</span> Issue&gt;;`;

export const TOKEN_ROLES = [
  ['--bg', 'App background behind panes'], ['--surface', 'Pane and card fill'], ['--surface-2', 'Wells, tracks, hover'],
  ['--ink', 'Primary text'], ['--ink-2', 'Secondary text, icons'], ['--line', 'Hairlines and dividers'], ['--line-strong', 'Outlines that must be seen'],
  ['--accent', 'Live, selected, primary action'], ['--accent-ink', 'Text on accent'], ['--accent-text', 'Accent used as text or a playhead'], ['--focus', 'Focus ring'],
  ['--ok', 'Done, merged'], ['--hold', 'Waiting, needs review'], ['--info', 'Neutral information'], ['--bad', 'Failed, hazard'],
  ['--sev-1 … --sev-5', 'Severity ramp (data)'], ['--c-graffiti …', 'Category identity (data)'],
  ['--font-d / -b / -m', 'Display, body and data faces'], ['--r / --r-lg', 'Control and card radius'], ['--bw', 'Border width'], ['--shadow', 'Card elevation'],
];

// tier: ui | layout | feature | domain | core
export const CATALOGUE = [
  { name: 'Button', tier: 'ui', file: 'ui/Button', what: 'Primary, secondary, ghost and icon buttons.', props: 'tone, size, icon, loading, asChild', states: 'hover, active (press into shadow in C), disabled, loading', a11y: 'Real <button>; icon-only requires aria-label', motion: 'scale .97 on press, 120 ms' },
  { name: 'Chip', tier: 'ui', file: 'ui/Chip', what: 'Status chip: done, analysing, queued, failed, hold.', props: 'status, children, live', states: 'live pulses its dot', a11y: 'Text always present; colour never alone', motion: 'dot pulse 1.2 s on live' },
  { name: 'SeverityMark', tier: 'ui', file: 'ui/SeverityMark', what: 'S1–S5 as dot, pips or bar from the ordinal ramp.', props: 'level, variant: dot | pips | bar, showLabel', states: '—', a11y: 'aria-label “Severity 4 of 5, repair this week”', motion: 'none' },
  { name: 'CategoryLabel', tier: 'ui', file: 'ui/CategoryLabel', what: 'Glyph + label in the category colour.', props: 'id, compact', states: '—', a11y: 'Glyph is aria-hidden; label is text', motion: 'none' },
  { name: 'Pane', tier: 'layout', file: 'layout/Pane', what: 'Header with grip, title, actions; scrolling body.', props: 'title, actions, onClose, onMaximize', states: 'dragging, drop target, maximised, floating', a11y: 'Grip is a button: arrow keys move the pane', motion: 'drop target outline; 200 ms swap' },
  { name: 'Desk', tier: 'layout', file: 'layout/Desk', what: 'dockview host: panes are movable, resizable, can float.', props: 'panels registry, layout json, onLayoutChange', states: 'default, custom (saved), reset', a11y: 'Resizers are focusable separators with aria-valuenow', motion: 'none on resize (direct manipulation)' },
  { name: 'TopNav', tier: 'layout', file: 'layout/TopNav', what: 'Brand + Dash, view tabs with counts, search, live chip.', props: 'views, counts, liveJob', states: 'live job running', a11y: 'nav landmark; aria-current on the active view', motion: 'Dash state changes' },
  { name: 'CommandPalette', tier: 'layout', file: 'layout/CommandPalette', what: '⌘K: jump to issue, seek to “03:41”, switch direction.', props: 'commands', states: 'empty, results, no results', a11y: 'cmdk listbox semantics', motion: 'fade + 8 px rise, 200 ms' },
  { name: 'Player', tier: 'feature', file: 'features/review/Player', what: 'Video, HUD, frame mark, transport.', props: 'video, t, onSeek, marks', states: 'loading, playing, paused, no footage (frame fallback)', a11y: 'Space play, J/K/L shuttle, ←/→ ±1 s, [ ] previous/next detection', motion: 'mark draws in on arrival' },
  { name: 'FrameMark', tier: 'ui', file: 'ui/FrameMark', what: 'The bounding box and tag on footage; the direction’s signature.', props: 'bbox, category, severity, label', states: 'provisional (dashed), confirmed, merged', a11y: 'Mirrored as text in the detections table', motion: 'per direction: spray, glow, paint' },
  { name: 'Timeline', tier: 'feature', file: 'features/review/Timeline', what: 'Ruler, category lanes, topic lane, speed lane, playhead.', props: 'duration, lanes, topics, gps, t, onSeek', states: 'scrubbing, zoomed, live (marks streaming in)', a11y: 'slider role on the playhead; marks are buttons with time + label', motion: 'marks pop in when found live' },
  { name: 'TopicSearch', tier: 'feature', file: 'features/review/TopicSearch', what: 'Free-text search over the footage; hits become a lane.', props: 'query, onSubmit', states: 'idle, pending, hits, none', a11y: 'Results announced in a polite live region', motion: 'bands fade in left to right' },
  { name: 'DetectionsTable', tier: 'feature', file: 'features/review/Detections', what: 'Every finding in this video, by time. Click to seek.', props: 'issues, selected, onSelect', states: 'empty, selected, merged rows', a11y: 'Table with row selection; Enter seeks', motion: 'headline sheen on new rows (B)' },
  { name: 'FootageList', tier: 'feature', file: 'features/review/FootageList', what: 'Drives with severity strips and category filters.', props: 'videos, filters, current', states: 'queued, analysing, done, failed', a11y: 'List of buttons; aria-current on the open drive', motion: 'progress stripe while analysing' },
  { name: 'MapView', tier: 'feature', file: 'features/map/MapView', what: 'Track, travelled portion, car on the playhead, pins.', props: 'track, gps, t, issues, routes, view', states: 'drive, city, routes; tiles or schematic', a11y: 'Pins are buttons; a list view lists every pin', motion: 'car eases between 1 Hz fixes' },
  { name: 'IssueCard', tier: 'feature', file: 'features/issues/IssueCard', what: 'Selected issue: what, where, sightings, work order.', props: 'issue, onSeek, onPlan', states: 'canonical, merged, provisional, no work order yet', a11y: 'Heading order; sightings are seek buttons', motion: 'content cross-fades on change' },
  { name: 'WorkOrder', tier: 'ui', file: 'ui/WorkOrder', what: 'Repair, crew, minutes, equipment, urgency.', props: 'order', states: 'pending (shimmer), ready', a11y: 'Definition list', motion: 'shimmer while Nemotron writes' },
  { name: 'UploadCard', tier: 'feature', file: 'features/upload/UploadCard', what: 'Drop a clip; stage track and live counts.', props: 'video, onRetry', states: 'drop, uploading, each stage, done, failed', a11y: 'Progress role with stage text', motion: 'tape stripe on the active stage' },
  { name: 'StageTrack', tier: 'ui', file: 'ui/StageTrack', what: 'Five pipeline stages as segments.', props: 'stages, current, progress', states: 'done, active, waiting, failed', a11y: 'Ordered list; aria-current on the active stage', motion: 'stripe 0.7 s loop on active' },
  { name: 'CrewStepper', tier: 'feature', file: 'features/dispatch/CrewStepper', what: 'Crews per type, with workload hours and the baseline.', props: 'counts, baseline, onChange', states: 'below baseline (hold), at, above', a11y: 'Spinbutton semantics', motion: 'number roll 200 ms' },
  { name: 'Schedule', tier: 'feature', file: 'features/dispatch/Schedule', what: 'Crew lanes across the shift: travel and jobs.', props: 'plan, onSelect', states: 'solving, solved, fallback solver', a11y: 'Each job is a button; table view available', motion: 'lanes fill left to right on solve' },
  { name: 'ReportView', tier: 'feature', file: 'features/report/ReportView', what: 'Summary, severity matrix, crew rationale.', props: 'report', states: 'updating, ready', a11y: 'Matrix has a table fallback', motion: 'shimmer on the paragraphs being rewritten' },
  { name: 'Dash', tier: 'ui', file: 'ui/Dash', what: 'The mascot. Shows pipeline state.', props: 'state, size', states: 'idle, scan, spot, check, plan, route, fail, done', a11y: 'role=img with the state as label; still under reduced motion', motion: 'per state, ≤ 1.6 s loops' },
  { name: 'usePlayback', tier: 'domain', file: 'domain/footage/usePlayback', what: 'One playhead shared by player, timeline, map and table.', props: 'videoId → { t, playing, seek, play, pause, rate }', states: '—', a11y: '—', motion: '—' },
  { name: 'useIssues', tier: 'domain', file: 'domain/issues/useIssues', what: 'Polls /api/issues; filters by the active preset.', props: '{ videoId?, categories } → Issue[]', states: 'loading, error, stale', a11y: '—', motion: '—' },
  { name: 'useLiveJob', tier: 'domain', file: 'domain/live/useLiveJob', what: 'Polls the running video at 1 s; maps stages to Dash.', props: 'videoId → { stage, progress, dashState }', states: '—', a11y: '—', motion: '—' },
  { name: 'schema', tier: 'core', file: 'packages/core/schema', what: 'zod contracts for every API resource.', props: '—', states: '—', a11y: '—', motion: '—' },
  { name: 'registry', tier: 'core', file: 'packages/core/registry', what: 'Categories, presets, severity, stages, models.', props: '—', states: '—', a11y: '—', motion: '—' },
  { name: 'derive', tier: 'core', file: 'packages/core/derive', what: 'Counts, workload, baseline crews, plan legs.', props: '—', states: '—', a11y: '—', motion: '—' },
];

export const TREE = `raightway/
├─ backend/                 <span class="c">Python · agents 1–7</span>
├─ apps/web/                <span class="c">Next.js · agent 8</span>
│  ├─ src/app/(desk)/       <span class="c">review · issues · report · dispatch</span>
│  ├─ src/features/         <span class="c">one folder per screen</span>
│  ├─ src/domain/           <span class="c">hooks, selectors, view models</span>
│  ├─ src/ui/               <span class="c">presentational components</span>
│  ├─ src/layout/           <span class="c">Desk, Pane, TopNav, CommandPalette</span>
│  ├─ src/tokens/           <span class="c">base · survey · night · paint</span>
│  ├─ src/state/            <span class="c">zustand stores</span>
│  ├─ src/mocks/            <span class="c">msw handlers + fixtures</span>
│  └─ src/lib/              <span class="c">cn, format, api client</span>
├─ packages/core/           <span class="c">schema · registry · derive</span>
├─ docs/design/             <span class="c">this page</span>
└─ docs/plan/               <span class="c">00–10 build notes</span>`;

export const WORK = [
  ['1', 'Backend core & API', 'backend/app/main.py, models.py', 'The contract the zod schemas mirror'],
  ['2', 'VAST data layer', 'backend/app/vast/', 'Similar issues, history merges'],
  ['3', 'Model clients', 'backend/app/ai/', 'Detections, boxes, work orders'],
  ['4', 'GPS & demo clips', 'backend/app/geo/, data/', 'gps[] for the map car and speed lane'],
  ['5', 'Live pipeline', 'backend/app/pipeline/', 'Stage events that drive Dash'],
  ['6', 'Corpus pre-compute', 'pipeline/precompute.py', 'The populated desk at demo start; topic hits'],
  ['7', 'Report & dispatch', 'report + plan endpoints', 'Report view, schedule, routes'],
  ['8', 'Frontend', 'apps/web, packages/core', 'Everything on this page'],
];

export const RELIABILITY = [
  ['First paint', '< 1 s on the demo laptop. The desk renders from cached fixtures, then hydrates from the API.'],
  ['Playhead', 'One requestAnimationFrame loop writes CSS variables; React re-renders only when the selected issue changes.'],
  ['Timeline', 'Marks are absolutely positioned buttons; 600 marks per video stay under 2 ms a frame.'],
  ['Map', 'Pins in one SVG layer (or one MapLibre source); the car moves by transform only.'],
  ['Polling', '1 s while a job runs, 10 s idle, paused when the tab is hidden. Stale data is shown dimmed, never blank.'],
  ['Network loss', 'Map falls back to the schematic; frames fall back to cached JPEGs; the live job resumes by polling.'],
  ['Model slow', 'Each stage has a timeout; the row shows Retry and Dash tips over. Other panes keep working.'],
  ['Demo safety', 'A “replay last run” switch plays the recorded event log through the same code path.'],
  ['Reduced motion', 'Every animation has a still state; the mark appears without drawing.'],
];

export const STEPS = [
  ['Pick a direction', 'Choose A, B or C on this page. The others stay as token files you can switch to later.'],
  ['Contracts first', 'packages/core: zod schemas, registry and derive, with fixtures that pass the schemas.'],
  ['Tokens and ui/', 'Base + direction CSS, the Tailwind @theme mapping, then the ui components in catalogue order.'],
  ['The desk', 'Desk + Pane with the three default panes; the shared playhead; the map and the timeline.'],
  ['Screens', 'Issues, Report and Dispatch as features over the same domain hooks.'],
  ['Wire the API', 'Swap msw for the rewrites to FastAPI; keep msw for tests and for a demo fallback.'],
  ['Rehearse', 'Run the Playwright demo path; time it; record a fallback video.'],
];

export const DEMO = [
  ['0:00', 'The desk, full of last week’s drives. Dash idle.', '“Seven drives of the city’s own dashcam footage, every issue found, graded and placed.”'],
  ['0:08', 'Drop set04 clip. Stage track runs; Dash scans.', '“A new drive comes in. Cosmos reads it in 5-second pieces.”'],
  ['0:18', 'Marks land on the timeline; the box sprays onto the frame.', '“Every finding has an exact timestamp, a box and a place on the map.”'],
  ['0:28', 'Two merge with a toast; Dash checks.', '“These two we’d already seen on Queen St W. VAST’s vector search merges them.”'],
  ['0:38', 'Report view: summary paragraph and matrix.', '“Nemotron writes the report; the numbers come from code.”'],
  ['0:48', 'Dispatch: crews, schedule, routes on the map. Dash done.', '“cuOpt plans tomorrow: five crews, hazards first.”'],
];
