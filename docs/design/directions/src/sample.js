// Sample data that follows the backend's data contract (architecture §4): videos, canonical issues with
// work orders and sightings, a live clip to drop in, the report, and a route plan.
// Deterministic: same seed, same city. Replace with GET /api/* in the real app.
import { CATEGORIES, CATEGORY, CREW_FOR, CATEGORY_FOR_CREW, URGENCY_FOR, PRIZE_FOR, mulberry32, hashStr, fmtHours, plural } from './core.js';
import { gridLL, gridXY, placeName, haversineKm, STREETS } from './geo.js';
import { bboxFor } from './scene.js';

const STREET_FLAVOR = {
  'Queen St': { graffiti: 45, waste: 15, markings: 10, pavement: 15, signage: 10, work_zone: 5 },
  'King St': { pavement: 40, markings: 20, graffiti: 15, work_zone: 10, signage: 10, waste: 5 },
  'Dundas St': { waste: 30, graffiti: 30, pavement: 15, signage: 10, markings: 10, work_zone: 5 },
  'Front St': { work_zone: 35, pavement: 20, signage: 15, markings: 15, graffiti: 10, waste: 5 },
  'College St': { markings: 30, graffiti: 20, signage: 15, pavement: 15, waste: 15, work_zone: 5 },
  'Spadina Ave': { waste: 30, graffiti: 25, markings: 15, pavement: 15, signage: 10, work_zone: 5 },
  'University Ave': { signage: 25, markings: 25, pavement: 20, work_zone: 15, graffiti: 10, waste: 5 },
  'Bay St': { work_zone: 30, signage: 20, pavement: 20, markings: 15, graffiti: 10, waste: 5 },
  'Jarvis St': { signage: 30, pavement: 25, graffiti: 20, waste: 15, markings: 10 },
  'Parliament St': { graffiti: 30, waste: 25, pavement: 20, signage: 15, markings: 10 },
  'Bathurst St': { graffiti: 30, pavement: 25, waste: 20, markings: 15, signage: 10 },
  'Yonge St': { graffiti: 20, waste: 25, markings: 20, pavement: 20, signage: 15 },
};
const SEV_DIST = {
  graffiti: [30, 35, 25, 8, 2], pavement: [5, 20, 35, 25, 15], markings: [10, 30, 35, 20, 5],
  work_zone: [0, 15, 30, 30, 25], signage: [0, 20, 30, 30, 20], waste: [15, 35, 35, 15, 0],
};
const DESC = {
  graffiti: { 1: ['Small tag on a utility box', 'Sticker cluster and marker tag on a signal pole', 'Light tagging on a newspaper box'], 2: ['Tag on a roller shutter, about 1 m wide', 'Marker tags across a bus shelter panel', 'Tag on a brick wall beside a storefront'], 3: ['Throw-up across a roller shutter, about 2 m wide', 'Spray-painted tags across two storefronts', 'Tag over a heritage brick facade'], 4: ['Large piece across a shuttered storefront, 4 m wide', 'Tags covering a TTC shelter map'], 5: ['Paint over a pedestrian crossing sign'] },
  pavement: { 1: ['Hairline cracks in the curb lane'], 2: ['Crack along the streetcar rail', 'Worn patch over an old utility cut'], 3: ['Pothole forming in the curb lane, about 30 cm', 'Spalled asphalt along the streetcar rail'], 4: ['Pothole in a traffic lane, about 45 cm', 'Sunken utility cut in the right lane'], 5: ['Deep pothole in the curb lane, cyclists swerving', 'Raised manhole cover in a travel lane'] },
  markings: { 1: ['Lane arrows slightly faded'], 2: ['Lane dashes worn but visible', 'Bike lane symbol partly worn'], 3: ['Crosswalk bars faded to about 40%', 'Stop bar worn through on one lane'], 4: ['Crosswalk nearly invisible at the intersection', 'Streetcar stop line gone'], 5: ['School crossing markings worn away'] },
  work_zone: { 2: ['Barrels left on the sidewalk after works', 'Road-work sign left up after works ended'], 3: ['Cones drifting into the curb lane'], 4: ['Fencing blown into a live lane', 'Steel plate shifted over a trench'], 5: ['Open trench with no barrier or crew', 'Unguarded excavation at the curb'] },
  signage: { 2: ['Street name sign faded', 'Parking sign bent but readable'], 3: ['No-stopping sign hidden by branches', 'Sign face faded, hard to read at distance'], 4: ['Stop sign leaning about 20°', 'One-way sign turned the wrong way'], 5: ['Stop sign missing from its post', 'Stop sign knocked down at the intersection'] },
  waste: { 1: ['A few bags at the curb'], 2: ['Litter bin full', 'Cardboard piled beside a recycling bin'], 3: ['Overflowing litter bin, bags on the sidewalk', 'Dumped mattress on the sidewalk'], 4: ['Furniture blocking part of the sidewalk', 'Bags spilling into the bike lane'] },
};
const REPAIR = {
  graffiti: { 1: 'Remove tag with solvent wipe', 2: 'Remove tag with solvent wipe', 3: 'Pressure-wash, then apply anti-graffiti coating', 4: 'Paint-match and repaint the shutter', 5: 'Clean the sign face; replace if etched' },
  pavement: { 1: 'Seal cracks', 2: 'Seal crack along the rail', 3: 'Cold-patch the pothole', 4: 'Saw-cut and hot-patch', 5: 'Emergency patch, then cone until set' },
  markings: { 1: 'Repaint arrows', 2: 'Repaint lane dashes', 3: 'Repaint crosswalk bars in thermoplastic', 4: 'Repaint crosswalk and stop bar', 5: 'Repaint school crossing; add beads' },
  work_zone: { 2: 'Collect leftover barrels and signs', 3: 'Reset cones to the permit layout', 4: 'Re-anchor fencing; call the permit holder', 5: 'Barricade the trench; call the permit holder' },
  signage: { 2: 'Replace the sign face', 3: 'Prune branches to clear the sign', 4: 'Straighten and re-anchor the post', 5: 'Install a temporary Ra-1 stop sign' },
  waste: { 1: 'Collect bags', 2: 'Empty bin', 3: 'Empty bin, clear the sidewalk', 4: 'Bulk pickup' },
};
const EQUIP = {
  graffiti: ['Pressure washer', 'Solvent kit', 'Anti-graffiti coating', 'Paint-match kit'],
  pavement: ['Cold patch, 2 bags', 'Plate compactor', 'Cones ×6', 'Asphalt hot box', 'Saw cutter'],
  markings: ['Thermoplastic applicator', 'Line striper', 'Cones ×8', 'Glass beads'],
  work_zone: ['Barricades ×4', 'Cone trailer', 'Arrow board'],
  signage: ['Post driver', 'Ra-1 stop sign', 'Pruning saw', 'Ladder'],
  waste: ['Packer truck', 'Bulk item trailer', 'Litter picker'],
};

// Seven corpus drives (PIE dashcam, pie_cam-3). Legs: ['row', r, c0, c1] or ['col', c, r0, r1].
export const DRIVES = [
  { id: 'v01', drive: 'set01/video_0002', seed: 11, legs: [['row', 2, 0, 4], ['col', 4, 2, 1], ['row', 1, 4, 6]] },
  { id: 'v02', drive: 'set02/video_0004', seed: 23, legs: [['row', 1, 6, 0], ['col', 0, 1, 2], ['row', 2, 0, 0.9]] },
  { id: 'v03', drive: 'set03/video_0001', seed: 37, legs: [['col', 1, 0, 4], ['row', 4, 1, 4]] },
  { id: 'v04', drive: 'set03/video_0006', seed: 41, legs: [['row', 3, 0, 6]] },
  { id: 'v05', drive: 'set05/video_0003', seed: 53, legs: [['row', 0, 0, 6], ['col', 6, 0, 2.5]] },
  { id: 'v06', drive: 'set06/video_0006', seed: 67, legs: [['col', 2, 0, 4], ['row', 4, 2, 3], ['col', 3, 4, 0]] },
  { id: 'v07', drive: 'set02/video_0011', seed: 71, legs: [['col', 5, 0, 4], ['row', 4, 5, 6], ['col', 6, 4, 2.6]] },
];
const legLen = l => Math.abs(l[3] - l[2]);
const streetOf = (axis, at) => STREETS.find(s => s.axis === axis && Math.abs(s.at - at) < 0.02);
const dirWord = (axis, a, b) => axis === 'row' ? (b > a ? 'Eastbound' : 'Westbound') : (b > a ? 'Northbound' : 'Southbound');

function weighted(rnd, table) { const tot = Object.values(table).reduce((a, b) => a + b, 0); let x = rnd() * tot; for (const [k, v] of Object.entries(table)) { if ((x -= v) <= 0) return k; } return Object.keys(table)[0]; }
function sevFor(rnd, cat) { const d = SEV_DIST[cat]; const tot = d.reduce((a, b) => a + b, 0); let x = rnd() * tot; for (let i = 0; i < 5; i++) { if ((x -= d[i]) <= 0) return i + 1; } return 3; }
const pickOf = (rnd, a) => a[Math.floor(rnd() * a.length)];

function makeWorkOrder(cat, sev, rnd) {
  const [lo, hi] = CATEGORY[cat].minutes; const base = lo + (hi - lo) * ((sev - 1) / 4);
  const minutes = Math.round((base * (0.85 + rnd() * 0.3)) / 5) * 5;
  const eq = EQUIP[cat]; const n = Math.min(eq.length, 1 + Math.floor(rnd() * 3));
  const equipment = [...eq].sort(() => rnd() - 0.5).slice(0, n);
  const rep = REPAIR[cat]; const repair = rep[sev] || rep[Object.keys(rep).find(k => +k >= sev) || Object.keys(rep).pop()];
  return { repair, crew: CREW_FOR[cat], minutes: Math.max(10, minutes), equipment, urgency: URGENCY_FOR[sev] };
}
function descFor(cat, sev, rnd) { const d = DESC[cat]; const lv = d[sev] ? sev : +Object.keys(d).reduce((a, k) => Math.abs(+k - sev) < Math.abs(+a - sev) ? k : a); return pickOf(rnd, d[lv]); }

function buildIssue({ id, video, t, axis, at, pos, cat, sev, rnd, seen = 1 }) {
  const off = (rnd() - 0.5) * 0.05;
  const r = axis === 'row' ? at + off : pos, c = axis === 'row' ? pos : at + off;
  const [lat, lon] = gridLL(r, c);
  const bbox = bboxFor(cat, rnd);
  return {
    id, video_id: video.id, t: Math.round(t * 10) / 10, category: cat, severity: sev,
    confidence: Math.round((0.62 + rnd() * 0.35) * 100) / 100,
    description: descFor(cat, sev, rnd), frame_url: `/api/frames/${id}`, frame_seed: hashStr(id),
    bbox, lat, lon, place: placeName(axis, at, pos), grid: { axis, at, pos, r, c },
    duplicate_of: null, sightings: seen, sighting_refs: [{ video_id: video.id, drive: video.drive, t: Math.round(t * 10) / 10 }],
    work_order: makeWorkOrder(cat, sev, rnd), source: 'corpus',
  };
}

function trackFor(legs) {
  const pts = [];
  for (const [axis, at, a, b] of legs) { const n = Math.max(2, Math.ceil(Math.abs(b - a) * 6)); for (let i = 0; i <= n; i++) { const p = a + ((b - a) * i) / n; pts.push(axis === 'row' ? gridLL(at, p) : gridLL(p, at)); } }
  return pts;
}

function explain(video, issues) {
  const legsTxt = video.legs.map(([axis, at, a, b], i) => {
    const s = streetOf(axis, at); const name = s && s.label ? s.label(axis === 'row' ? (a + b) / 2 : 0) : (s ? s.name : 'a side street');
    const to = placeName(axis, at, b).replace(/^.* (at|near) /, '');
    return i === 0 ? `${dirWord(axis, a, b)} on ${name} to ${to}` : `then ${name} to ${to}`;
  }).join(', ');
  const byCat = {}; issues.forEach(i => { (byCat[i.category] = byCat[i.category] || []).push(i); });
  const top = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)[0];
  const hazards = issues.filter(i => i.severity === 5);
  const parts = [{ text: legsTxt + '. ' }];
  if (top) {
    const [cat, list] = top; const places = [...new Set(list.map(i => i.place.replace(/ (near|at) .*/, '')))];
    const serious = list.filter(i => i.severity >= 3).length;
    parts.push({ text: 'Most findings are ' }, { text: `${CATEGORY[cat].label.toLowerCase()} (${list.length})`, strong: true }, { text: `, mostly on ${places[0]}${serious ? `; ${serious} ${serious === 1 ? 'is' : 'are'} S3 or worse` : ''}. ` });
  }
  if (hazards.length) {
    parts.push({ text: hazards.length === 1 ? 'One hazard to fix today: ' : `${hazards.length} hazards to fix today: ` }, { text: hazards.slice(0, 2).map(h => `${h.description.toLowerCase()} on ${h.place}`).join('; '), strong: true }, { text: '.' });
  } else parts.push({ text: 'No safety hazards on this drive.' });
  return parts;
}

let _cache = null;
export function buildSample() {
  if (_cache) return _cache;
  const rnd = mulberry32(20261019);
  const videos = [], issues = [];
  let n = 1;
  for (const d of DRIVES) {
    const total = d.legs.reduce((s, l) => s + legLen(l), 0);
    const duration = Math.round(420 + rnd() * 190);
    const video = { id: d.id, filename: `pie_${d.drive.replace('/', '_')}.mp4`, source: 'corpus', status: 'done', progress: 1, stage: null, drive: d.drive, start_s: 0, duration_s: duration, legs: d.legs, camera_id: 'pie_cam-3', issue_ids: [] };
    const vr = mulberry32(d.seed);
    let walked = 0;
    for (const leg of d.legs) {
      const [axis, at, a, b] = leg; const len = legLen(leg); const dir = Math.sign(b - a);
      const s = streetOf(axis, at); const flavor = STREET_FLAVOR[s ? s.name : 'Queen St'] || STREET_FLAVOR['Queen St'];
      let p = 0.08 + vr() * 0.15;
      while (p < len - 0.02) {
        const pos = a + dir * p; const cat = weighted(vr, flavor); const sev = sevFor(vr, cat);
        const t = ((walked + p) / total) * duration;
        const iss = buildIssue({ id: `iss_${String(n++).padStart(4, '0')}`, video, t, axis, at, pos, cat, sev, rnd: vr });
        issues.push(iss); video.issue_ids.push(iss.id);
        p += 0.2 + vr() * 0.42;
      }
      walked += len;
    }
    video.track = trackFor(d.legs);
    videos.push(video);
  }
  // Two issues set01 found on Queen St W just east of Spadina: the live clip re-sights them on stage.
  const v01 = videos.find(v => v.id === 'v01'); const ar = mulberry32(909);
  [{ pos: 1.13, cat: 'graffiti', sev: 3 }, { pos: 1.29, cat: 'markings', sev: 3 }].forEach(({ pos, cat, sev }) => {
    const iss = buildIssue({ id: `iss_${String(n++).padStart(4, '0')}`, video: v01, t: (pos / 6.6) * v01.duration_s, axis: 'row', at: 2, pos, cat, sev, rnd: ar });
    iss.anchor = true; issues.push(iss); v01.issue_ids.push(iss.id);
  });
  // Re-sightings: where drives overlap or a drive waits at lights, the same issue is seen again.
  const sr = mulberry32(77);
  issues.forEach(i => {
    if (sr() < 0.28) {
      const k = 1 + (sr() < 0.3 ? 2 : 1) - 1;
      for (let j = 0; j < k; j++) { const v = videos[Math.floor(sr() * videos.length)]; i.sighting_refs.push({ video_id: v.id, drive: v.drive, t: Math.round(sr() * v.duration_s * 10) / 10 }); }
      i.sightings = i.sighting_refs.length;
    }
  });
  videos.forEach(v => { v.explanation = explain(v, issues.filter(i => i.video_id === v.id)); });

  // The live clip: cut from set04/video_0008 at 05:10, covering Queen St W just east of Spadina,
  // a stretch set01/video_0002 already covered, so dedupe fires on stage.
  const live = buildLive(issues);
  _cache = { videos, issues, live, city: 'Toronto', area: 'Downtown', planDate: 'Sun 19 Oct', depot: { r: 0, c: 6.35, name: 'Assumed depot, Front St E at Parliament St' } };
  return _cache;
}

function buildLive(issues) {
  const span = [1.0, 1.45];
  const nearby = issues.filter(i => i.anchor);
  const lr = mulberry32(4242);
  const video = { id: 'u01', filename: 'set04_video_0008_t0310.mp4', source: 'upload', status: 'queued', progress: 0, stage: null, drive: 'set04/video_0008', start_s: 310, duration_s: 27, camera_id: 'pie_cam-3', issue_ids: [], legs: [['row', 2, span[0], span[1]]] };
  video.track = trackFor(video.legs);
  const plan = [
    { piece: 0, cat: 'graffiti', sev: 3, pos: 1.06 }, { piece: 1, match: nearby[0] }, { piece: 2, cat: 'waste', sev: 3, pos: 1.2 },
    { piece: 3, match: nearby[1] }, { piece: 4, cat: 'pavement', sev: 5, pos: 1.33 }, { piece: 5, cat: 'graffiti', sev: 2, pos: 1.41 },
  ];
  let k = 1;
  const detections = plan.map((d, idx) => {
    if (d.match) {
      return { piece: d.piece, t: d.piece * 5 + 1.5 + lr() * 2, matches: d.match.id, issue: { ...d.match, id: `iss_u${String(k++).padStart(3, '0')}`, video_id: video.id, duplicate_of: d.match.id, source: 'upload', t: d.piece * 5 + 2, frame_seed: hashStr('u' + idx), work_order: null } };
    }
    const t = d.piece * 5 + 1 + lr() * 3;
    const iss = buildIssue({ id: `iss_u${String(k++).padStart(3, '0')}`, video, t, axis: 'row', at: 2, pos: d.pos, cat: d.cat, sev: d.sev, rnd: lr });
    iss.source = 'upload';
    if (d.cat === 'pavement') iss.description = 'Deep pothole in the curb lane, cyclists swerving';
    if (d.cat === 'graffiti' && d.sev === 3) iss.description = 'Throw-up across a roller shutter, about 2 m wide';
    return { piece: d.piece, t, matches: null, issue: iss };
  });
  video.explanation = [
    { text: 'Eastbound on Queen St W from Spadina Ave, 27 s. ' },
    { text: '6 detections: 4 new issues and 2 re-sightings', strong: true },
    { text: ' of issues set01/video_0002 found on the same stretch. ' },
    { text: 'One hazard to fix today: ' }, { text: 'a deep pothole in the curb lane near Peter St', strong: true }, { text: ', where cyclists are swerving into the streetcar rail.' },
  ];
  return { video, detections, pieces: 6 };
}

// ---------- report (architecture §3.7): counts in code, words from Nemotron (templated here)
export function buildReport(issues, enabled = CATEGORIES.map(c => c.id)) {
  const open = issues.filter(i => !i.duplicate_of && enabled.includes(i.category));
  const matrix = Object.fromEntries(enabled.map(c => [c, [0, 0, 0, 0, 0]]));
  const workload = {}, jobs = {};
  open.forEach(i => { matrix[i.category][i.severity - 1]++; const crew = CREW_FOR[i.category]; workload[crew] = (workload[crew] || 0) + (i.work_order ? i.work_order.minutes : 30); jobs[crew] = (jobs[crew] || 0) + 1; });
  const crews = {}; Object.entries(workload).forEach(([k, m]) => { crews[k] = Math.ceil((m * 1.3) / 480); });
  const hazards = open.filter(i => i.severity === 5);
  const top = [...open].sort((a, b) => b.severity - a.severity || b.confidence - a.confidence).slice(0, 8);
  const totalCrews = Object.values(crews).reduce((a, b) => a + b, 0);
  const km = 23;
  const biggest = Object.entries(workload).sort((a, b) => b[1] - a[1])[0];
  const bigCat = biggest ? CATEGORY_FOR_CREW[biggest[0]] : null;
  const bigStreet = bigCat ? mode(open.filter(i => i.category === bigCat).map(i => i.place.replace(/ (near|at) .*/, ''))) : '';
  const summary = [
    { text: `${open.length} open issues`, strong: true }, { text: ` across ${km} km of downtown streets from 7 drives. ` },
    hazards.length ? { text: `${plural(hazards.length, 'safety hazard')} to fix today`, strong: true } : { text: 'No safety hazards today' },
    { text: hazards.length ? `: ${summarizeHazards(hazards)}. ` : '. ' },
  ];
  if (biggest) summary.push({ text: `${CATEGORY[bigCat].label} is the largest workload (${fmtHours(biggest[1])} crew-hours), concentrated on ${bigStreet}. ` });
  summary.push({ text: 'Recommended for tomorrow: ' }, { text: plural(totalCrews, 'crew'), strong: true }, { text: '.' });
  const rationale = {};
  Object.keys(crews).forEach(crew => {
    const cat = CATEGORY_FOR_CREW[crew]; const list = open.filter(i => i.category === cat); const serious = list.filter(i => i.severity >= 3);
    const where = mode(list.map(i => i.place.replace(/ (near|at) .*/, '')));
    rationale[crew] = `${plural(list.length, 'job')}, ${fmtHours(workload[crew])} h of work. ${serious.length ? `${serious.length} are S3 or worse, most on ${where}.` : `All routine, mostly on ${where}.`} ${crews[crew] > 1 ? `${crews[crew]} crews clear the S3+ work first and fit the rest into one shift.` : 'One crew covers it in a shift.'}`;
  });
  return { generated_at: '2026-10-18T14:02:00-04:00', generated_label: 'Today 14:02', model: 'Nemotron 3.5 Lightning', summary, counts: Object.fromEntries(enabled.map(c => [c, matrix[c].reduce((a, b) => a + b, 0)])), matrix, crews, workload, jobs, rationale, hazards, top, total: open.length };
}
function mode(arr) { const m = {}; arr.forEach(x => { m[x] = (m[x] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; }
function summarizeHazards(h) {
  const byCat = {}; h.forEach(i => { byCat[i.category] = (byCat[i.category] || 0) + 1; });
  const words = { pavement: ['deep pothole', 'deep potholes'], work_zone: ['unguarded work zone', 'unguarded work zones'], signage: ['missing or downed stop sign', 'missing or downed stop signs'], markings: ['worn school crossing', 'worn school crossings'], graffiti: ['painted-over crossing sign', 'painted-over crossing signs'], waste: ['blocked sidewalk', 'blocked sidewalks'] };
  return Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${words[c][n === 1 ? 0 : 1]}`).join(', ');
}

// ---------- dispatch (architecture §3.8). A prize-aware nearest-neighbour stand-in for cuOpt.
const SHIFT = 480;
const travelMin = (a, b) => Math.max(1, Math.round((haversineKm(a, b) * 1.3 / 25) * 60));
export function planRoutes(issues, crewsIn, { depot, enabled = CATEGORIES.map(c => c.id), solver = 'cuopt' } = {}) {
  const dep = { r: depot.r, c: depot.c, ll: gridLL(depot.r, depot.c), axis: 'row', at: depot.r, pos: depot.c };
  const jobsAll = issues.filter(i => !i.duplicate_of && i.work_order && enabled.includes(i.category)).sort((a, b) => b.severity - a.severity).slice(0, 100);
  const routes = [], unassigned = [];
  for (const cat of enabled) {
    const crew = CREW_FOR[cat]; const n = crewsIn[crew] || 0;
    const J = jobsAll.filter(i => i.category === cat).map(i => ({ ...i, ll: [i.lat, i.lon] }));
    if (!J.length) continue;
    if (!n) { J.forEach(j => unassigned.push({ id: j.id, reason: 'No crew of this type dispatched' })); continue; }
    const ang = j => Math.atan2(j.lat - dep.ll[0], j.lon - dep.ll[1]);
    J.sort((a, b) => ang(a) - ang(b));
    const totalMin = J.reduce((s, j) => s + j.work_order.minutes, 0); const groups = Array.from({ length: n }, () => []); let acc = 0;
    J.forEach(j => { const g = Math.min(n - 1, Math.floor((acc / totalMin) * n)); groups[g].push(j); acc += j.work_order.minutes; });
    const crewRoutes = groups.map((G, gi) => {
      let pos = dep, time = 0; const legs = [], stops = [], eta = []; const left = [...G];
      while (left.length) {
        let best = -1, score = -Infinity;
        left.forEach((j, k) => { const tr = travelMin(pos.ll, j.ll), back = travelMin(j.ll, dep.ll); if (time + tr + j.work_order.minutes + back > SHIFT) return; const s = PRIZE_FOR[j.severity] / (tr + j.work_order.minutes); if (s > score) { score = s; best = k; } });
        if (best < 0) break;
        const j = left.splice(best, 1)[0]; const tr = travelMin(pos.ll, j.ll);
        legs.push({ type: 'travel', start: time, end: time + tr }); time += tr;
        legs.push({ type: 'job', start: time, end: time + j.work_order.minutes, issue: j.id, severity: j.severity }); eta.push(time); stops.push(j.id); time += j.work_order.minutes;
        pos = { ...j.grid, ll: j.ll, r: j.grid.r, c: j.grid.c };
      }
      if (stops.length) { const back = travelMin(pos.ll, dep.ll); legs.push({ type: 'travel', start: time, end: time + back }); time += back; }
      return { crew_id: `${CATEGORY[cat].code}${gi + 1}`, crew, category: cat, stops, eta_min: eta, legs, minutes: time, left };
    });
    crewRoutes.forEach(r => r.left.forEach(j => { // try another crew of the same type before dropping
      const other = crewRoutes.find(o => o !== r && o.minutes + j.work_order.minutes + 20 <= SHIFT && o.stops.length);
      if (other) { const t = other.minutes - 10; other.legs.splice(other.legs.length - 1, 0, { type: 'travel', start: t, end: t + 10 }, { type: 'job', start: t + 10, end: t + 10 + j.work_order.minutes, issue: j.id, severity: j.severity }); other.stops.push(j.id); other.eta_min.push(t + 10); other.minutes += j.work_order.minutes + 10; other.legs[other.legs.length - 1] = { type: 'travel', start: other.minutes - 10, end: other.minutes }; }
      else unassigned.push({ id: j.id, reason: 'Shift full' });
    }));
    crewRoutes.forEach(r => { delete r.left; r.path = routePath(dep, r.stops.map(id => jobsAll.find(j => j.id === id))); routes.push(r); });
  }
  const used = routes.filter(r => r.stops.length).length;
  return { routes, unassigned, solver, solve_ms: solver === 'cuopt' ? 3012 : 41, crews_needed: used, crews_dispatched: routes.length, jobs_routed: routes.reduce((s, r) => s + r.stops.length, 0), depot: dep };
}

// Grid-following legs: along the current street, turn at a crossing street, along the next.
function corner(a, b) {
  const A = a.grid || a, B = b.grid || b;
  if (A.axis === 'row' && B.axis === 'row') { if (Math.abs(A.at - B.at) < 0.01) return []; const cx = Math.max(0, Math.min(6, Math.round((A.pos + B.pos) / 2))); return [[A.at, cx], [B.at, cx]]; }
  if (A.axis === 'col' && B.axis === 'col') { if (Math.abs(A.at - B.at) < 0.01) return []; const rx = Math.max(0, Math.min(4, Math.round((A.pos + B.pos) / 2))); return [[rx, A.at], [rx, B.at]]; }
  if (A.axis === 'row') return [[A.at, B.at]];
  return [[B.at, A.at]];
}
function routePath(dep, stops) {
  const nodes = [dep, ...stops, dep]; const pts = [];
  nodes.forEach((nd, i) => {
    const g = nd.grid || nd; pts.push(gridXY(g.r ?? (g.axis === 'row' ? g.at : g.pos), g.c ?? (g.axis === 'row' ? g.pos : g.at)));
    if (i < nodes.length - 1) corner(nd, nodes[i + 1]).forEach(([r, c]) => pts.push(gridXY(r, c)));
  });
  return pts;
}

// Similar issues (VastDB vector search in the real app): same category, nearest by a stable hash.
export function similarTo(issue, issues, k = 4) {
  return issues.filter(i => i.id !== issue.id && !i.duplicate_of && i.category === issue.category)
    .map(i => ({ i, d: Math.abs((hashStr(i.description + i.severity) % 1000) - (hashStr(issue.description + issue.severity) % 1000)) / 1000 + Math.abs(i.severity - issue.severity) * 0.05 }))
    .sort((a, b) => a.d - b.d).slice(0, k).map(({ i, d }) => ({ issue: i, distance: Math.round((0.08 + d * 0.35) * 100) / 100 }));
}
