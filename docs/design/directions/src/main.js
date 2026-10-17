// Raightway design directions: one page, three looks, one component inventory.
// Vanilla DOM so the page is a single small bundle; the product itself is Next.js (see Build spec).
import { CATEGORIES, CATEGORY, CATEGORY_PRESETS, SEVERITY, STAGES, clamp, mulberry32, hashStr, fmtClock, fmtTimecode, fmtHours, fmtShift, fmtCoord } from './core.js';
import { gridLL, gridXY, project, STREETS, streetPoints, toPath, PARKS, lakePolygon, LABELS, VIEWS, viewBoxFor } from './geo.js';
import { buildSample, buildReport, planRoutes } from './sample.js';
import { drawScene } from './scene.js';
import { DIRS, DASH_STATES, TOPICS, STACK, LAYERS, EVENTS, CONTRACT, TOKEN_ROLES, CATALOGUE, TREE, WORK, RELIABILITY, STEPS, DEMO } from './content.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem('rw-dir:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('rw-dir:' + k, JSON.stringify(v)); } catch { /* private mode */ } } };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- icons (24px grid, stroked)
const P = {
  graffiti: '<rect x="7" y="9" width="9" height="12" rx="2"/><path d="M9 9V6h5v3M11.5 6V3.5M18.5 5h.01M20.5 3h.01M20.5 7.5h.01"/>',
  markings: '<path d="M5 3v18M19 3v18M12 4v3M12 10.5v3M12 17v3"/>',
  work_zone: '<path d="M9.8 4h4.4l4.3 15.5h-13z M7.9 10.5h8.2M6.6 15h10.8M3 20h18"/>',
  pavement: '<path d="M3 18h18"/><ellipse cx="12" cy="13" rx="7" ry="3"/><path d="M8.5 12.6l1.8 1 1.9-1.4 1.9 1.4 1.4-.8"/>',
  signage: '<path d="M8.6 2.5h6.8l3.1 3.1v4.8l-3.1 3.1H8.6l-3.1-3.1V5.6z"/><path d="M12 13.5V21"/>',
  waste: '<path d="M4.5 7h15M10 7V4h4v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5.5L9.5 12l8.5 6.5z"/><path d="M6 5v14"/>',
  next: '<path d="M6 5.5l8.5 6.5L6 18.5z"/><path d="M18 5v14"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M8 5v14M16 5v14"/>',
  report: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5z"/><path d="M9 12h6M9 15.5h6M9 8.5h3"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;

// ---------- Dash, the cone. Shapes stay put; props and faces change per state.
function dash(state = 'idle', size = 64) {
  const big = state === 'spot';
  const eyes = state === 'fail'
    ? '<path class="mouth" d="M26.5 18.5l3 3M29.5 18.5l-3 3M34.5 18.5l3 3M37.5 18.5l-3 3"/>'
    : `<g class="pupils"><circle class="eye" cx="28" cy="20" r="${big ? 2.8 : 2.2}"/><circle class="eye" cx="36" cy="20" r="${big ? 2.8 : 2.2}"/>${state === 'done' ? '' : '<circle cx="28.8" cy="19.2" r=".7" fill="#fff"/><circle cx="36.8" cy="19.2" r=".7" fill="#fff"/>'}</g>`;
  const mouth = { done: 'M28.5 24.5Q32 29 35.5 24.5', spot: 'M30.6 26a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0', fail: 'M29 26.5q1.5-1.6 3 0t3 0', plan: 'M30 25.5h4', check: 'M30 25.5h4', route: 'M29.5 25Q32 27 34.5 25' }[state] || 'M29.5 25Q32 27 34.5 25';
  const props = {
    scan: '<path class="prop-s" d="M48 14a8 8 0 0 1 0 12M52.5 10a14 14 0 0 1 0 20"/>',
    spot: '<path class="prop-s" d="M32-9v6" stroke-width="3"/><circle class="prop" cx="32" cy="1" r="1.8"/>',
    check: '<circle class="prop-s" cx="51" cy="20" r="5.5"/><path class="prop-s" d="M55 24l4.5 4.5" stroke-width="3"/>',
    plan: '<rect class="prop" x="47" y="15" width="13" height="16" rx="1.6"/><path class="prop-line" d="M50 20h7M50 23.5h7M50 27h4.5"/>',
    route: '<path class="prop-s" d="M0 74h64" stroke-dasharray="2 4"/><circle class="prop dot" cx="32" cy="74" r="2.6"/>',
    done: '<path class="prop twinkle" d="M51 3l1.3 3.2 3.2 1.3-3.2 1.3L51 12l-1.3-3.2-3.2-1.3 3.2-1.3z"/><path class="prop twinkle" style="animation-delay:.4s" d="M12 9l.9 2.1 2.1.9-2.1.9L12 15l-.9-2.1-2.1-.9 2.1-.9z"/>',
    fail: '<path class="prop-s" d="M50 52l4-4M54 56l5-1M46 50l-1-5"/>',
  }[state] || '';
  return `<svg class="dash st-${state}" width="${size}" height="${Math.round(size * 1.2)}" viewBox="-4 -12 72 92" role="img" aria-label="Dash: ${esc((DASH_STATES.find(d => d.id === state) || DASH_STATES[0]).label)}">
    <ellipse class="shadow" cx="32" cy="70" rx="26" ry="3.5"/>
    <g class="whole"><rect class="base" x="6" y="58" width="52" height="9" rx="3"/>
      <path class="body" d="M25.3 7.4Q32 1.6 38.7 7.4L52 58H12z"/>
      <path class="stripe" d="M18.7 30h26.6l2 8H16.7z"/><path class="stripe" d="M15.1 45h33.8l1.1 4.5H14z" opacity=".9"/>
      ${eyes}<circle class="cheek" cx="24.5" cy="24.5" r="2.2"/><circle class="cheek" cx="39.5" cy="24.5" r="2.2"/><path class="mouth" d="${mouth}"/></g>
    ${props}</svg>`;
}

// ---------- sample data
const S = buildSample();
const ISS = new Map(S.issues.map(i => [i.id, i]));
const VID = new Map(S.videos.map(v => [v.id, v]));
const legLen = l => Math.abs(l[3] - l[2]);

// Position along a drive at fraction f (0..1), in grid units, plus the grid point just ahead for heading.
function gridAt(video, f) {
  const total = video.legs.reduce((s, l) => s + legLen(l), 0); let d = clamp(f, 0, 1) * total;
  for (const l of video.legs) { const len = legLen(l); if (d <= len || l === video.legs[video.legs.length - 1]) { const [axis, at, a, b] = l; const p = a + Math.sign(b - a) * Math.min(d, len); return axis === 'row' ? [at, p] : [p, at]; } d -= len; }
  return [0, 0];
}
function trackPath(video, f0, f1, n = 80) { const pts = []; for (let i = 0; i <= n; i++) pts.push(gridXY(...gridAt(video, f0 + (f1 - f0) * (i / n)))); return toPath(pts); }

// Speed in km/h: cruising with drift, stopping at about half the lights.
const speedCache = new Map();
function speedSeries(video) {
  if (speedCache.has(video.id)) return speedCache.get(video.id);
  const rnd = mulberry32(hashStr(video.id)); const lights = new Map(); const N = 240; const out = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N; const [r, c] = gridAt(video, f);
    let v = 31 + 7 * Math.sin(f * 17 + rnd() * 0.3) + 3 * Math.sin(f * 53);
    for (const g of [r, c]) { const k = Math.round(g); const d = Math.abs(g - k); if (!lights.has(k + ':' + (g === r))) lights.set(k + ':' + (g === r), rnd() < 0.5); if (lights.get(k + ':' + (g === r)) && Number.isInteger(g) === false) v *= 1 - Math.exp(-((d / 0.05) ** 2)); }
    out.push(Math.max(0, v));
  }
  speedCache.set(video.id, out); return out;
}
const speedAt = (video, f) => { const s = speedSeries(video); return s[Math.round(clamp(f, 0, 1) * (s.length - 1))]; };

// ---------- state
const st = {
  dir: store.get('dir', 'survey'), preset: store.get('preset', 'all'), off: new Set(),
  video: 'v01', t: 0, playing: false, rate: 4, sel: null, order: store.get('order', ['footage', 'player', 'map']),
  wA: store.get('wA', 272), wC: store.get('wC', 380), mapView: 'drive', query: '', dashState: 'idle',
};
if (!DIRS[st.dir]) st.dir = 'survey';
if (!CATEGORY_PRESETS[st.preset]) st.preset = 'all';
const cats = () => CATEGORY_PRESETS[st.preset].ids.filter(c => !st.off.has(c));
const presetCats = () => CATEGORY_PRESETS[st.preset].ids;
const open = i => !i.duplicate_of;
const videoIssues = (vid = st.video) => (VID.get(vid)?.issue_ids || []).map(id => ISS.get(id)).filter(i => i && open(i) && cats().includes(i.category)).sort((a, b) => a.t - b.t);
const vNow = () => VID.get(st.video);
{ const a = S.issues.find(i => i.anchor && i.category === 'graffiti'); st.sel = a.id; st.t = Math.max(0, a.t - 0.4); }

// ---------- header
function renderHeader() {
  $('#brandMascot').innerHTML = dash('idle', 40);
  $('#dirSeg').innerHTML = Object.entries(DIRS).map(([id, d]) => `<button type="button" data-dir="${id}" aria-pressed="${st.dir === id}"><span class="k">${d.key}</span>${d.label}</button>`).join('');
  $('#presetSeg').innerHTML = Object.entries(CATEGORY_PRESETS).map(([id, p]) => `<button type="button" data-preset="${id}" aria-pressed="${st.preset === id}">${id === 'all' ? 'All' : p.label.replace(' only', '')}</button>`).join('');
  $('#dirSeg').onclick = e => { const b = e.target.closest('[data-dir]'); if (b) setDir(b.dataset.dir); };
  $('#presetSeg').onclick = e => { const b = e.target.closest('[data-preset]'); if (b) setPreset(b.dataset.preset); };
}
function renderIntro() {
  const d = DIRS[st.dir];
  $('#dirEyebrow').textContent = d.eyebrow; $('#dirName').innerHTML = d.name; $('#dirConcept').textContent = d.concept;
  $('#dirPrinciples').innerHTML = d.principles.map(p => `<li>${ic('check')}<span>${esc(p)}</span></li>`).join('');
  $$('#dirSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.dir === st.dir));
}
function setDir(d) {
  st.dir = d; document.body.dataset.dir = d; store.set('dir', d); renderIntro(); renderFoundations(); renderMascot();
  // each direction has its own fonts and borders, so everything that measures text lays out again
  const relayout = () => { renderRuler(); renderMapSvg(); refs(); tick(); fitTag(R.mark); fitTag($('#markDemo .mark')); };
  relayout(); document.fonts?.ready.then(relayout);
  replayMark($('#shellCard .mark')); replayMark($('#markDemo .mark'));
}
function setPreset(p) {
  st.preset = p; st.off.clear(); store.set('preset', p);
  $$('#presetSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.preset === p));
  const vi = videoIssues(); if (!vi.find(i => i.id === st.sel)) {
    // keep the desk on a drive that has something to show for this preset
    if (!vi.length) { const v = S.videos.find(v => videoIssues(v.id).length); if (v) st.video = v.id; }
    const first = videoIssues()[0]; st.sel = first ? first.id : null; if (first) st.t = Math.max(0, first.t - 0.4);
  }
  renderShell(); renderComponents(); renderFoundations();
}

// ---------- the review desk
const R = {}; // live element refs, refreshed by renderShell
const PANES = {
  footage: { title: 'Footage', render: footagePane },
  player: { title: 'Player', render: playerPane },
  map: { title: 'Map', render: mapPane },
};

// Pane widths are preferences; what is applied is clamped to the room available, so a pane never
// gets squeezed below what its content needs, whatever the window size or the saved layout.
const mqTwo = matchMedia('(max-width:1120px)'), mqOne = matchMedia('(max-width:860px)');
const MIN_A = 200, MIN_C = 260, MIN_MID = 340;
function effWidths() {
  const p = $('#panes'); const total = p ? p.clientWidth : 1200;
  if (mqOne.matches) return { a: total, c: total };
  if (mqTwo.matches) return { a: clamp(st.wA, MIN_A, Math.max(MIN_A, total - MIN_MID)), c: st.wC };
  let a = Math.max(MIN_A, st.wA), c = Math.max(MIN_C, st.wC); let over = a + c + MIN_MID - total;
  if (over > 0) { const dc = Math.min(over, c - MIN_C); c -= dc; over -= dc; }
  if (over > 0) a = Math.max(MIN_A, a - over);
  return { a, c };
}
function applyWidths() {
  const p = $('#panes'); if (!p) return; const { a, c } = effWidths();
  p.style.setProperty('--pa', a + 'px'); p.style.setProperty('--pc', c + 'px');
  const A = $('[data-rz="A"]'), C = $('[data-rz="C"]');
  if (A) { A.style.left = a + 'px'; A.setAttribute('aria-valuenow', a); }
  if (C) { C.style.left = `calc(100% - ${c}px)`; C.setAttribute('aria-valuenow', c); }
}

function renderShell() {
  const allOpen = S.issues.filter(i => open(i) && cats().includes(i.category));
  const live = st.playing;
  $('#shellCard').innerHTML = `
    <nav class="nav" aria-label="Console">
      <div class="nav-brand"><span id="navDash">${dash(st.dashState, 22)}</span>Raightway</div>
      <div class="nav-tabs" role="list">
        <button class="nav-tab" aria-current="page">${ic('film')}Review</button>
        <button class="nav-tab">${ic('pin')}Issues <span class="count num">${allOpen.length}</span></button>
        <button class="nav-tab">${ic('report')}Report</button>
        <button class="nav-tab">${ic('route')}Dispatch</button>
      </div>
      <div class="nav-right">
        <label class="search">${ic('search')}<span class="sr">Search footage</span><input id="q" value="${esc(st.query)}" placeholder="Search footage"><span class="kbd">/</span></label>
        <span class="chip ${live ? 's-live' : 's-done'}" id="liveChip">${live ? 'Playing' : 'Ready'}</span>
        <span class="avatar" aria-label="Signed in as operator">OP</span>
      </div>
    </nav>
    <div class="panes" id="panes">
      ${st.order.map(k => `<section class="pane" data-pane="${k}" aria-label="${PANES[k].title}">
        <header class="pane-h"><button class="pane-grip" draggable="true" data-grip="${k}" aria-label="Move ${PANES[k].title} pane. Drag onto another pane, or use the arrow keys">${ic('grip', 'fill')}</button><h3>${PANES[k].title}</h3><span class="pane-act" data-act-slot="${k}"></span></header>
        <div class="pane-b" data-body="${k}"></div></section>`).join('')}
      <div class="resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize left pane" data-rz="A"></div>
      <div class="resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize right pane" data-rz="C"></div>
    </div>`;
  applyWidths();
  st.order.forEach(k => PANES[k].render($(`[data-body="${k}"]`), $(`[data-act-slot="${k}"]`)));
  bindShell(); refs(); observeShell(); drawFrame(true); tick();
}

// Every pane re-lays its own content when its width changes: while dragging a border, after a swap,
// or when the window resizes. Batched into one frame.
let ro = null; const lastW = {}; const pending = new Set(); let pendRaf = 0, frameT = 0;
function observeShell() {
  ro?.disconnect(); Object.keys(lastW).forEach(k => delete lastW[k]);
  ro = new ResizeObserver(entries => {
    for (const e of entries) { const k = e.target.dataset.body || e.target.id; const w = Math.round(e.contentRect.width); if (lastW[k] === w) continue; const first = lastW[k] === undefined; lastW[k] = w; if (!first) pending.add(k); }
    if (pending.size && !pendRaf) pendRaf = requestAnimationFrame(flushResize);
  });
  $$('#shellCard [data-body]').forEach(n => ro.observe(n)); ro.observe($('#panes'));
}
function flushResize() {
  pendRaf = 0; const p = new Set(pending); pending.clear();
  if (p.has('panes')) applyWidths();
  if (p.has('player')) { renderRuler(); fitTag(R.mark); clearTimeout(frameT); frameT = setTimeout(() => drawFrame(true, false), 120); }
  if (p.has('map')) renderMapSvg();
  refs(); tick();
}

function footagePane(body, act) {
  act.innerHTML = `<span class="count num">${S.videos.length}</span>`;
  const q = st.query.trim().toLowerCase();
  const vids = S.videos.filter(v => !q || (v.drive + ' ' + v.explanation[0].text).toLowerCase().includes(q));
  body.innerHTML = `<div class="filters" role="group" aria-label="Categories">${presetCats().map(c => `<button type="button" class="fchip" data-cat="${c}" data-toggle-cat="${c}" aria-pressed="${!st.off.has(c)}">${ic(c)}${CATEGORY[c].label}</button>`).join('')}</div>
    ${vids.map(v => {
      const vi = videoIssues(v.id); const hz = vi.filter(i => i.severity === 5).length;
      const where = v.explanation[0].text.split(',')[0].replace(/\.\s*$/, '');
      return `<button type="button" class="vrow" data-video="${v.id}" aria-current="${v.id === st.video}">
        <span class="vrow-top"><span class="vrow-id">${v.drive}</span>${hz ? `<span class="chip s-failed">${hz} hazard${hz > 1 ? 's' : ''}</span>` : `<span class="chip s-done">Done</span>`}</span>
        <span class="vrow-where">${esc(where)}</span>
        <span class="strip" aria-hidden="true">${vi.map(i => `<i data-sev="${i.severity}" style="left:${(i.t / v.duration_s) * 100}%"></i>`).join('')}${v.id === st.video ? '<b data-strip-head></b>' : ''}</span>
        <span class="vrow-meta"><span class="num">${fmtClock(v.duration_s)}</span><span>${vi.length} finding${vi.length === 1 ? '' : 's'}</span></span>
      </button>`;
    }).join('') || '<p class="muted" style="padding:16px">No drives match.</p>'}`;
}

function playerPane(body, act) {
  const v = vNow(); const vi = videoIssues(); const dur = v.duration_s;
  act.innerHTML = `<span class="fname mono muted">${v.filename}</span>`;
  const topic = topicHits(v);
  const sp = speedSeries(v); const spPath = sp.map((x, i) => `${i ? 'L' : 'M'}${((i / (sp.length - 1)) * 200).toFixed(1)} ${(20 - (x / 50) * 18).toFixed(1)}`).join('');
  body.innerHTML = `<div class="player">
    <div class="frame" id="frame"><canvas aria-hidden="true"></canvas>
      <div class="hud h-tl"><span class="rec"></span><span class="hud-cam">${v.camera_id} · </span>${v.drive}</div>
      <div class="hud h-bl" id="hudGps"></div><div class="hud h-br" id="hudTc"></div>
      <div class="mark" id="mark" hidden><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="ring" pathLength="400" d=""/></svg><span class="tag"></span></div>
    </div>
    <div class="transport">
      <span class="transport-keys">
        <button class="btn btn-ghost btn-sm btn-icon" data-act="prev" aria-label="Previous detection">${ic('prev')}</button>
        <button class="btn btn-primary btn-sm btn-icon" data-act="play" id="playBtn" aria-label="Play">${ic('play')}</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-act="next" aria-label="Next detection">${ic('next')}</button>
      </span>
      <span class="tc num" id="tc"></span>
      <span class="speed"><span class="speed-l">Speed</span><span class="seg" role="group" aria-label="Playback speed">${[1, 4, 16].map(r => `<button type="button" data-rate="${r}" aria-pressed="${st.rate === r}">${r}×</button>`).join('')}</span></span>
    </div>
    <div class="tl" id="tl">
      <div class="tl-ruler" aria-hidden="true"></div>
      <div class="tl-lanes" id="lanes">
        ${cats().map(c => { const list = vi.filter(i => i.category === c); return `<div class="lane" data-cat="${c}"><span class="lane-l" title="${CATEGORY[c].label}: ${list.length}">${ic(c)}<span class="ll">${CATEGORY[c].label}</span><b>${list.length}</b></span><span class="lane-t" data-seek>${list.map(i => `<button type="button" class="mk" data-sev="${i.severity}" data-issue="${i.id}" aria-pressed="${i.id === st.sel}" style="left:${(i.t / dur) * 100}%" aria-label="${CATEGORY[c].label}, S${i.severity}, at ${fmtClock(i.t)}" title="${fmtClock(i.t)} · ${esc(i.description)}"></button>`).join('')}</span></div>`; }).join('')}
        <div class="lane"><span class="lane-l" title="Topic search: “${esc(TOPICS[st.preset])}”">${ic('search')}<span class="ll">“${esc(TOPICS[st.preset])}”</span><b>${topic.length}</b></span><span class="lane-t" data-seek>${topic.map(h => `<span class="band" style="left:${(h.start / dur) * 100}%;width:${((h.end - h.start) / dur) * 100}%" title="${fmtClock(h.start)}–${fmtClock(h.end)} · ${esc(h.caption)} · ${h.score.toFixed(2)}"></span>`).join('')}</span></div>
        <div class="lane"><span class="lane-l" title="Speed, km/h">${ic('clock')}<span class="ll">Speed</span><b id="spd"></b></span><span class="lane-t" data-seek><svg class="spark" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true"><path d="${spPath}"/></svg></span></div>
        <div class="playhead" id="ph"></div>
      </div>
    </div>
    <table class="moments"><thead><tr><th>Time</th><th>Finding</th><th>Sev</th><th class="d">What</th><th class="seen-c">Seen</th></tr></thead><tbody>
      ${vi.map(i => `<tr data-issue="${i.id}" aria-selected="${i.id === st.sel}" tabindex="0"><td class="t">${fmtTimecode(i.t)}</td><td><span class="cat" data-cat="${i.category}" title="${CATEGORY[i.category].label}">${ic(i.category)}<span class="ct">${CATEGORY[i.category].label}</span></span></td><td><span class="sev-dot" data-sev="${i.severity}">${i.severity}</span></td><td class="d" title="${esc(i.description)}">${esc(i.description)}</td><td class="num seen-c">${i.sightings}×</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No findings in these categories on this drive.</td></tr>'}
    </tbody></table></div>`;
  renderRuler();
}

// The ruler picks the densest step whose labels still fit, so they never touch.
function renderRuler() {
  const el = $('#tl .tl-ruler'); if (!el) return; const dur = vNow().duration_s;
  const w = el.clientWidth || 400; const room = Math.max(2, Math.floor(w / 58));
  const step = [15, 30, 60, 120, 180, 300, 600].find(s => dur / s <= room) || 600; const out = [];
  for (let s = 0; s < dur - step * 0.4; s += step) out.push(`<span style="left:${(s / dur) * 100}%">${fmtClock(s)}</span>`);
  el.innerHTML = out.join('');
}

function topicHits(v) {
  const rnd = mulberry32(hashStr(v.id + st.preset));
  return videoIssues(v.id).filter(i => presetCats().includes(i.category) && rnd() < 0.55)
    .map(i => ({ start: Math.max(0, i.t - 3 - rnd() * 3), end: Math.min(v.duration_s, i.t + 2 + rnd() * 4), score: 0.62 + rnd() * 0.3, caption: i.description }));
}

function mapPane(body, act) {
  act.innerHTML = `<span class="seg" role="group" aria-label="Map extent">${['drive', 'city'].map(m => `<button type="button" data-mapview="${m}" aria-pressed="${st.mapView === m}">${m === 'drive' ? 'Drive' : 'City'}</button>`).join('')}</span>`;
  body.innerHTML = `<div class="mapbox"></div><div class="issue" id="issueCard"></div>`;
  renderMapSvg(); renderIssue();
}

// The map is drawn at the box's real aspect ratio, so 1 user unit maps to a known number of pixels:
// labels and pins keep a constant on-screen size, and labels that would collide are dropped.
function renderMapSvg() {
  const box = $('#shellCard .mapbox'); if (!box) return; const v = vNow();
  const bw = Math.max(160, box.clientWidth), bh = Math.max(120, box.clientHeight);
  let ext;
  if (st.mapView === 'city') ext = VIEWS.downtown;
  else {
    const rs = [], cs = []; v.legs.forEach(([axis, at, a, b]) => { if (axis === 'row') { rs.push(at); cs.push(a, b); } else { cs.push(at); rs.push(a, b); } });
    ext = { r0: Math.min(...rs) - 0.5, r1: Math.max(...rs) + 0.5, c0: Math.min(...cs) - 0.45, c1: Math.max(...cs) + 0.45 };
  }
  const vb = viewBoxFor(ext, bw / bh); const [x0, y0, w, h] = vb; const k = bw / w;
  const fs = 10.5 / k, pr = 5 / k;
  const pts = a => a.map(p => p.join(',')).join(' ');
  const pins = S.issues.filter(i => open(i) && cats().includes(i.category) && i.lat != null).map(i => {
    const [x, y] = project(i.lat, i.lon); if (x < x0 - pr || x > x0 + w + pr || y < y0 - pr || y > y0 + h + pr) return '';
    const mine = i.video_id === v.id;
    return `<g class="m-pin${mine ? '' : ' dim'}${i.id === st.sel ? ' sel' : ''}" data-sev="${i.severity}" data-issue="${i.id}" role="button" tabindex="-1" aria-label="${CATEGORY[i.category].label} S${i.severity}, ${esc(i.place)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(mine ? pr : pr * 0.7).toFixed(1)}"/></g>`;
  }).join('');
  const labels = LABELS.map(l => { const [x, y] = gridXY(l.r, l.c); if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return ''; return `<text class="m-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs.toFixed(2)}" text-anchor="middle" dy="${(-fs * 0.55).toFixed(2)}" ${l.v ? `transform="rotate(-90 ${x.toFixed(1)} ${y.toFixed(1)})"` : ''}>${esc(l.text)}</text>`; }).join('');
  box.innerHTML = `<svg viewBox="${vb.map(n => n.toFixed(1)).join(' ')}" preserveAspectRatio="xMidYMid meet" aria-label="Map of ${esc(v.drive)} with ${videoIssues().length} findings">
      <rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="var(--map-ground)"/>
      <polygon class="m-water" points="${pts(lakePolygon())}"/>
      ${PARKS.map(p => `<polygon class="m-park" points="${pts(p.q)}"/>`).join('')}
      ${STREETS.filter(s => s.kind === 'street').map(s => `<path class="m-st" d="${toPath(streetPoints(s))}" style="stroke-width:2.5"/>`).join('')}
      ${STREETS.filter(s => s.kind === 'arterial').map(s => `<path class="m-art-c" d="${toPath(streetPoints(s))}"/>`).join('')}
      ${STREETS.filter(s => s.kind === 'arterial').map(s => `<path class="m-art" d="${toPath(streetPoints(s))}"/>`).join('')}
      <g class="m-labels">${labels}</g>
      <path class="m-track-dim" d="${trackPath(v, 0, 1)}"/><path class="m-track" id="mTrack" d=""/>
      ${pins}
      <g class="m-car" id="mCar"><circle r="${(pr * 2.6).toFixed(1)}"/><path d="M0 -${(pr * 1.5).toFixed(1)} L${(pr * 1.05).toFixed(1)} ${(pr * 1.2).toFixed(1)} L0 ${(pr * 0.55).toFixed(1)} L-${(pr * 1.05).toFixed(1)} ${(pr * 1.2).toFixed(1)}Z"/></g>
    </svg><div class="mapchip"><span id="mapGps">00:00.0 · 00 km/h</span></div>`;
  layoutLabels(box);
}
const hit = (a, b, pad = 0) => a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
function layoutLabels(box) {
  const svg = $('svg', box); if (!svg) return; const sr = svg.getBoundingClientRect(); if (!sr.width) return;
  const placed = [$('.mapchip', box).getBoundingClientRect()];
  $$('.m-label', svg).forEach(t => {
    t.style.display = ''; const r = t.getBoundingClientRect();
    const inside = r.left >= sr.left + 4 && r.right <= sr.right - 4 && r.top >= sr.top + 4 && r.bottom <= sr.bottom - 4;
    if (!inside || placed.some(p => hit(p, r, 4))) { t.style.display = 'none'; return; }
    placed.push(r);
  });
}

function renderIssue() {
  const el = $('#issueCard'); if (!el) return; const i = ISS.get(st.sel);
  if (!i) { el.innerHTML = '<p class="muted">Select a finding on the timeline, the table or the map.</p>'; return; }
  const sv = SEVERITY[i.severity - 1]; const wo = i.work_order;
  el.innerHTML = `<div class="issue-tags"><span class="cat" data-cat="${i.category}">${ic(i.category)}${CATEGORY[i.category].label}</span><span class="sev" data-sev="${i.severity}"><span class="sev-dot" data-sev="${i.severity}">${i.severity}</span>${sv.label}</span><span class="chip ${i.severity === 5 ? 's-failed' : 's-neutral'}">${sv.when}</span></div>
    <div><h4>${esc(i.description)}</h4><p class="where">${esc(i.place)}</p></div>
    <dl class="kv"><dt>Seen</dt><dd>${i.sightings}× · first in ${i.video_id} @ ${fmtTimecode(i.t)}</dd><dt>Confidence</dt><dd>${Math.round(i.confidence * 100)}%</dd><dt>GPS</dt><dd>${fmtCoord(i.lat, i.lon)}</dd></dl>
    <div><div class="label" style="margin-bottom:6px">Sightings</div><div class="seen">${(i.sighting_refs || []).map(r => `<button type="button" data-seekvid="${r.video_id}" data-seekt="${r.t}">${r.video_id} · ${fmtClock(r.t)}</button>`).join('')}</div></div>
    ${wo ? `<div><div class="label" style="margin-bottom:6px">Work order</div><dl class="kv left"><dt>Repair</dt><dd>${esc(wo.repair)}</dd><dt>Crew</dt><dd>${CATEGORY[i.category].crewLabel}, ${wo.minutes} min</dd><dt>Kit</dt><dd>${wo.equipment.map(esc).join(' · ')}</dd></dl></div>` : ''}
    <div class="actions"><button class="btn btn-primary btn-sm">${ic('route')}Add to tomorrow</button><button class="btn btn-secondary btn-sm">Not an issue</button></div>`;
}

function refs() {
  Object.assign(R, { frame: $('#frame'), canvas: $('#frame canvas'), mark: $('#mark'), tc: $('#tc'), hudTc: $('#hudTc'), hudGps: $('#hudGps'), ph: $('#ph'), lanes: $('#lanes'), car: $('#mCar'), track: $('#mTrack'), mapGps: $('#mapGps'), spd: $('#spd'), head: $('[data-strip-head]'), play: $('#playBtn'), chip: $('#liveChip'), navDash: $('#navDash') });
}

// One loop writes the playhead into every view; DOM structure only changes on selection or layout.
let lastSceneKey = '';
function tick() {
  const v = vNow(); const f = st.t / v.duration_s;
  if (R.ph) R.ph.style.left = `calc(var(--tlw) + (100% - var(--tlw)) * ${f})`;
  if (R.head) R.head.style.left = `${f * 100}%`;
  if (R.tc) R.tc.innerHTML = `${fmtTimecode(st.t)}<small> / ${fmtClock(v.duration_s)}</small>`;
  const [r, c] = gridAt(v, f); const [lat, lon] = gridLL(r, c); const kmh = Math.round(speedAt(v, f));
  if (R.hudTc) R.hudTc.textContent = `${fmtTimecode(v.start_s + st.t)}`;
  if (R.hudGps) R.hudGps.innerHTML = `<span class="hud-gps">${fmtCoord(lat, lon)} · </span>${String(kmh).padStart(2, ' ')} km/h`;
  if (R.spd) R.spd.textContent = `${kmh}`;
  if (R.mapGps) R.mapGps.textContent = `${fmtTimecode(st.t)} · ${String(kmh).padStart(2, ' ')} km/h`;
  if (R.track) R.track.setAttribute('d', trackPath(v, 0, Math.max(0.0005, f), Math.max(4, Math.round(f * 80))));
  if (R.car) { const [x, y] = gridXY(r, c); const [x2, y2] = gridXY(...gridAt(v, Math.min(1, f + 0.003))); const [xb, yb] = gridXY(...gridAt(v, Math.max(0, f - 0.003))); const ang = Math.atan2(x2 - xb, -(y2 - yb)) * 180 / Math.PI; R.car.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${ang.toFixed(1)})`); }
  drawFrame(false);
}

// The frame shows the nearest finding while the playhead is within its window; otherwise plain road.
function sceneFor() {
  const vi = videoIssues(); let best = null, bd = 1e9;
  for (const i of vi) { const d = st.t - i.t; if (d > -1.2 && d < 7 && Math.abs(d) < bd) { bd = Math.abs(d); best = i; } }
  return best;
}
function drawFrame(force, animate = true) {
  if (!R.canvas) return; const iss = sceneFor();
  const key = iss ? iss.id : 'road' + Math.floor(st.t / 9);
  const block = iss ? (st.t - iss.t + 1.2) / 8.2 : (st.t % 9) / 9;
  R.canvas.style.transform = `scale(${(1 + block * 0.05).toFixed(4)})`;
  if (key !== lastSceneKey || force) {
    const rect = R.frame.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(320, Math.round(rect.width * dpr)), H = Math.round(W * 9 / 16);
    R.canvas.width = W; R.canvas.height = H; const ctx = R.canvas.getContext('2d');
    const seed = iss ? iss.frame_seed : hashStr(st.video + key);
    drawScene(ctx, W, H, iss ? { category: iss.category, seed, bbox: iss.bbox, light: lightFor(st.video) } : { category: 'graffiti', seed, bbox: null, light: lightFor(st.video) });
    const changed = key !== lastSceneKey; lastSceneKey = key; placeMark(iss, R.mark, animate && changed || animate && force);
  }
}
const lightFor = vid => ['day', 'overcast', 'day', 'dusk', 'day', 'overcast', 'day'][(hashStr(vid) % 7)];
const RING = { survey: 'M50 4C78 3 97 22 96 50S76 97 49 96 3 77 4 49 23 5 54 6', box: 'M10 4H90Q96 4 96 10V90Q96 96 90 96H10Q4 96 4 90V10Q4 4 10 4Z' };
function placeMark(iss, el = R.mark, animate = true) {
  if (!el) return;
  if (!iss || !iss.bbox) { el.hidden = true; $$('.hud', el.parentElement).forEach(h => { h.style.visibility = ''; }); return; }
  const b = iss.bbox; el.hidden = false;
  Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  el.querySelector('.tag').textContent = `${CATEGORY[iss.category].label} · S${iss.severity} · ${Math.round(iss.confidence * 100)}%`;
  el.querySelector('.ring').setAttribute('d', st.dir === 'survey' ? RING.survey : RING.box);
  fitTag(el);
  if (animate) replayMark(el);
}
// Keep the tag inside the frame (above the box, else below it, else inside it), and hide any HUD
// readout it would cover.
function fitTag(el) {
  if (!el || el.hidden) return; const frame = el.parentElement; const tag = $('.tag', el); const fr = frame.getBoundingClientRect(); if (!fr.width) return;
  tag.style.transform = ''; tag.style.maxWidth = Math.max(48, fr.width - 12) + 'px'; tag.classList.remove('below', 'inside');
  let r = tag.getBoundingClientRect();
  if (r.top < fr.top + 4) { tag.classList.add('below'); r = tag.getBoundingClientRect(); if (r.bottom > fr.bottom - 4) { tag.classList.replace('below', 'inside'); r = tag.getBoundingClientRect(); } }
  let dx = 0; if (r.right > fr.right - 6) dx = fr.right - 6 - r.right; if (r.left + dx < fr.left + 6) dx = fr.left + 6 - r.left;
  tag.style.transform = `translateX(${dx.toFixed(1)}px)`;
  const tr = { left: r.left + dx, right: r.right + dx, top: r.top, bottom: r.bottom };
  $$('.hud', frame).forEach(h => { h.style.visibility = ''; if (hit(tr, h.getBoundingClientRect(), 3)) h.style.visibility = 'hidden'; });
}
function replayMark(el) { if (!el || el.hidden) return; const ring = el.querySelector('.ring'); if (ring) ring.setAttribute('d', st.dir === 'survey' ? RING.survey : RING.box); el.classList.remove('draw'); void el.offsetWidth; el.classList.add('draw'); }

function select(id, { seek = false } = {}) {
  st.sel = id; const i = ISS.get(id);
  if (seek && i) { if (i.video_id !== st.video) { st.video = i.video_id; st.t = Math.max(0, i.t - 0.4); renderShell(); return; } st.t = Math.max(0, i.t - 0.4); }
  $$('#shellCard [data-issue]').forEach(n => { const on = n.dataset.issue === id; if (n.classList.contains('mk')) n.setAttribute('aria-pressed', on); else if (n.tagName === 'TR') n.setAttribute('aria-selected', on); else n.classList.toggle('sel', on); });
  renderIssue(); lastSceneKey = ''; tick();
}
function setDash(s) { if (st.dashState === s) return; st.dashState = s; if (R.navDash) R.navDash.innerHTML = dash(s, 22); }

// playback
let raf = 0, lastTs = 0, spotUntil = 0;
function loop(ts) {
  if (!st.playing) return; const v = vNow(); const dt = lastTs ? (ts - lastTs) / 1000 : 0; lastTs = ts;
  const t0 = st.t; st.t = Math.min(v.duration_s, st.t + dt * st.rate);
  const passed = videoIssues().find(i => i.t > t0 && i.t <= st.t);
  if (passed) { select(passed.id); spotUntil = ts + 1100; }
  setDash(ts < spotUntil ? 'spot' : 'scan');
  if (st.t >= v.duration_s) { pause(); setDash('done'); return; }
  tick(); raf = requestAnimationFrame(loop);
}
function play() { if (st.t >= vNow().duration_s - 0.1) st.t = 0; st.playing = true; lastTs = 0; R.play.innerHTML = ic('pause'); R.play.setAttribute('aria-label', 'Pause'); R.chip.className = 'chip s-live'; R.chip.textContent = 'Playing'; raf = requestAnimationFrame(loop); }
function pause() { st.playing = false; cancelAnimationFrame(raf); if (R.play) { R.play.innerHTML = ic('play'); R.play.setAttribute('aria-label', 'Play'); } if (R.chip) { R.chip.className = 'chip s-done'; R.chip.textContent = 'Ready'; } setDash('idle'); }
function stepDetection(dir) {
  const vi = videoIssues(); if (!vi.length) return;
  const cur = st.t + 0.41; const target = dir > 0 ? vi.find(i => i.t > cur + 0.05) : [...vi].reverse().find(i => i.t < cur - 0.6);
  if (target) select(target.id, { seek: true });
}

function bindShell() {
  const card = $('#shellCard');
  card.onclick = e => {
    const t = e.target;
    const a = t.closest('[data-act]'); if (a) { const k = a.dataset.act; if (k === 'play') st.playing ? pause() : play(); if (k === 'prev') stepDetection(-1); if (k === 'next') stepDetection(1); return; }
    const r = t.closest('[data-rate]'); if (r) { st.rate = +r.dataset.rate; $$('[data-rate]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.rate === st.rate)); return; }
    const vrow = t.closest('[data-video]'); if (vrow) { if (vrow.dataset.video !== st.video) { pause(); st.video = vrow.dataset.video; const f = videoIssues()[0]; st.sel = f ? f.id : null; st.t = f ? Math.max(0, f.t - 0.4) : 0; renderShell(); } return; }
    const tc = t.closest('[data-toggle-cat]'); if (tc) { const c = tc.dataset.toggleCat; st.off.has(c) ? st.off.delete(c) : (cats().length > 1 && st.off.add(c)); renderShell(); return; }
    const mv = t.closest('[data-mapview]'); if (mv) { st.mapView = mv.dataset.mapview; $$('[data-mapview]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mapview === st.mapView)); renderMapSvg(); refs(); tick(); return; }
    const sv = t.closest('[data-seekvid]'); if (sv) { pause(); const vid = sv.dataset.seekvid; const tt = +sv.dataset.seekt; if (vid !== st.video) { st.video = vid; st.t = tt; renderShell(); } else { st.t = tt; lastSceneKey = ''; tick(); } return; }
    const is = t.closest('[data-issue]'); if (is) { pause(); select(is.dataset.issue, { seek: true }); }
  };
  card.onkeydown = e => {
    const row = e.target.closest('tr[data-issue]'); if (row && e.key === 'Enter') { select(row.dataset.issue, { seek: true }); return; }
    if (e.target.matches('input')) return;
    if (e.key === '[') stepDetection(-1); if (e.key === ']') stepDetection(1);
    if (e.key === 'k' || e.key === 'K') { st.playing ? pause() : play(); }
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  };
  $('#q').oninput = e => { st.query = e.target.value; const k = 'footage'; PANES[k].render($(`[data-body="${k}"]`), $(`[data-act-slot="${k}"]`)); refs(); tick(); };

  // scrub: press anywhere on a lane track and drag
  const lanes = $('#lanes');
  if (lanes) lanes.onpointerdown = e => {
    if (e.target.closest('.mk') || !e.target.closest('[data-seek]')) return;
    const track = e.target.closest('[data-seek]').getBoundingClientRect(); pause();
    const seek = ev => { st.t = clamp((ev.clientX - track.left) / track.width, 0, 1) * vNow().duration_s; tick(); };
    seek(e); lanes.setPointerCapture(e.pointerId);
    lanes.onpointermove = seek; lanes.onpointerup = () => { lanes.onpointermove = null; };
  };

  // resize: borders follow the pointer or the arrow keys; panes re-lay themselves via the ResizeObserver
  $$('.resizer', card).forEach(rz => {
    const which = rz.dataset.rz; const panes = $('#panes');
    const set = (px) => {
      const total = panes.clientWidth; const eff = effWidths();
      if (which === 'A') st.wA = clamp(Math.round(px), MIN_A, Math.max(MIN_A, total - (mqTwo.matches ? 0 : eff.c) - MIN_MID));
      else st.wC = clamp(Math.round(px), MIN_C, Math.max(MIN_C, total - eff.a - MIN_MID));
      applyWidths();
    };
    const save = () => { store.set('wA', st.wA); store.set('wC', st.wC); };
    rz.onpointerdown = e => { e.preventDefault(); rz.classList.add('on'); rz.setPointerCapture(e.pointerId); const box = panes.getBoundingClientRect(); rz.onpointermove = ev => set(which === 'A' ? ev.clientX - box.left : box.right - ev.clientX); rz.onpointerup = () => { rz.classList.remove('on'); rz.onpointermove = null; save(); }; };
    rz.onkeydown = e => { const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0; if (!d) return; e.preventDefault(); const eff = effWidths(); set(which === 'A' ? eff.a + d : eff.c - d); save(); };
  });

  // swap panes by dragging a grip onto another pane, or with arrow keys on the grip
  let dragging = null;
  $$('.pane-grip', card).forEach(g => {
    g.ondragstart = e => { dragging = g.dataset.grip; e.dataTransfer.setData('text/plain', dragging); e.dataTransfer.effectAllowed = 'move'; g.closest('.pane').classList.add('dragging'); };
    g.ondragend = () => { $$('.pane', card).forEach(p => p.classList.remove('dragging', 'drop-target')); dragging = null; };
    g.onkeydown = e => { const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0; if (!d) return; e.preventDefault(); const k = g.dataset.grip; const i = st.order.indexOf(k); const j = clamp(i + d, 0, 2); if (i === j) return; swap(k, st.order[j]); $(`[data-grip="${k}"]`).focus(); };
  });
  $$('.pane', card).forEach(p => {
    p.ondragover = e => { if (!dragging || dragging === p.dataset.pane) return; e.preventDefault(); p.classList.add('drop-target'); };
    p.ondragleave = () => p.classList.remove('drop-target');
    p.ondrop = e => { e.preventDefault(); const from = dragging || e.dataTransfer.getData('text/plain'); if (from && from !== p.dataset.pane) swap(from, p.dataset.pane); };
  });
}
function swap(a, b) { const o = [...st.order]; const i = o.indexOf(a), j = o.indexOf(b); [o[i], o[j]] = [o[j], o[i]]; st.order = o; store.set('order', o); const wasPlaying = st.playing; pause(); renderShell(); if (wasPlaying) play(); }

// ---------- mascot section
let mascotState = 'scan';
function renderMascot() {
  $('#mascotStage').innerHTML = dash(mascotState, 170);
  const d = DASH_STATES.find(x => x.id === mascotState);
  $('#mascotLine').innerHTML = `${esc(DIRS[st.dir].mascot)} <br><span class="mono" style="font-size:12.5px">${esc(d.label)}: “${esc(d.line)}”</span>`;
  $('#mascotStates').innerHTML = DASH_STATES.map(s => `<button type="button" class="mstate" data-mstate="${s.id}" aria-pressed="${s.id === mascotState}">${dash(s.id, 56)}<b>${s.label}</b><span>${esc(s.line)}</span><code>${esc(s.on)}</code></button>`).join('');
  $('#mascotStates').onclick = e => { const b = e.target.closest('[data-mstate]'); if (b) { mascotState = b.dataset.mstate; renderMascot(); } };
}

// ---------- foundations
const PALETTE = [['--bg', 'Background'], ['--surface', 'Surface'], ['--surface-2', 'Surface 2'], ['--ink', 'Ink'], ['--ink-2', 'Ink 2'], ['--line', 'Line'], ['--accent', 'Accent'], ['--accent-soft', 'Accent soft'], ['--ok', 'OK'], ['--hold', 'Hold'], ['--info', 'Info'], ['--bad', 'Bad']];
const CATVAR = { graffiti: '--c-graffiti', markings: '--c-markings', work_zone: '--c-workzone', pavement: '--c-pavement', signage: '--c-signage', waste: '--c-waste' };
const cssVal = (n) => getComputedStyle(document.body).getPropertyValue(n).trim().toUpperCase();
function renderFoundations() {
  const d = DIRS[st.dir];
  $('#palNote').textContent = `${d.label} tokens`;
  $('#swatches').innerHTML = PALETTE.map(([n, l]) => `<div class="sw"><i style="--x:var(${n})"></i><div><b>${l}</b><span>${cssVal(n)}</span></div></div>`).join('');
  $('#ramp').innerHTML = SEVERITY.map(s => `<i data-sev="${s.level}" title="${s.label}">S${s.level}</i>`).join('') + SEVERITY.map(s => `<span style="font-size:11.5px;color:var(--ink-2);line-height:1.25">${s.label}</span>`).join('');
  $('#catSwatches').innerHTML = CATEGORIES.map(c => `<div class="sw" data-cat="${c.id}" style="${presetCats().includes(c.id) ? '' : 'opacity:.4'}"><i style="--x:var(${CATVAR[c.id]});display:grid;place-items:center;color:#fff">${ic(c.id)}</i><div><b>${c.label}</b><span>${cssVal(CATVAR[c.id])}</span></div></div>`).join('');
  const rows = [
    ['Display', `var(--font-d)`, d.type.d, '<span style="font-size:34px;font-weight:700;letter-spacing:-.02em">Queen St W, 14 jobs</span>'],
    ['Title', 'var(--font-d)', d.type.d, '<span style="font-size:20px;font-weight:650">Deep pothole in the curb lane</span>'],
    ['Body', 'var(--font-b)', d.type.b, '<span style="font-size:15px">Cyclists are swerving into the streetcar rail to avoid it. Fix today.</span>'],
    ['Data', 'var(--font-m)', d.type.m, '<span style="font-size:13px">iss_0412 · 03:41.2 · 43.65086, −79.39630 · 31 km/h</span>'],
    ['Label', 'var(--font-m)', d.type.m, '<span class="label">Work order · Crew R2</span>'],
  ];
  $('#typeSpec').innerHTML = rows.map(([n, f, name, ex]) => `<div class="type-row"><div><b style="font-size:13px">${n}</b><div class="mono muted" style="font-size:11.5px">${name}</div></div><div style="font-family:${f};min-width:0;overflow-wrap:anywhere">${ex}</div></div>`).join('');
  $('#motion').innerHTML = [['Press', '120ms', 'var(--ease)', 'Buttons, chips'], ['UI', '200ms', 'var(--ease)', 'Hover, toggles, tabs'], ['Panel', '350ms', 'var(--out)', 'Cards, toasts, marks'], ['Drawer', '420ms', 'var(--drawer)', 'Sheets, palette']].map(([n, dur, e, use]) => `<div class="mrow"><span><b>${n}</b> <span class="mono muted" style="font-size:11.5px">${dur}</span></span><span class="mtrack" style="--d:${dur};--e:${e}"><i></i></span><span class="muted" style="font-size:12px">${use}</span></div>`).join('') + `<p class="muted" style="font-size:13px;margin-top:4px">Signature: ${esc(d.signature)}.</p>`;
}

// ---------- components gallery
const LIVE = S.live;
function renderComponents() {
  const rep = buildReport(S.issues, presetCats());
  const plan = planRoutes(S.issues, rep.crews, { depot: S.depot, enabled: presetCats() });
  const hazard = LIVE.detections.find(d => d.issue.category === 'pavement')?.issue || S.issues.find(i => i.severity === 5);
  const routes = plan.routes.filter(r => r.stops.length).slice(0, 4);
  const crewCats = presetCats().filter(c => rep.crews[CATEGORY[c].crew]);
  $('#compGrid').innerHTML = `
    <div class="card pad"><div class="comp-h"><h4>Actions and status</h4><span class="label">ui/Button · ui/Chip</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px"><button class="btn btn-primary">${ic('upload')}Drop footage</button><button class="btn btn-secondary">Open report</button><button class="btn btn-ghost">Skip</button><button class="btn btn-secondary btn-icon" aria-label="Expand">${ic('expand')}</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:16px"><span class="chip s-done">Done</span><span class="chip s-live">Analysing</span><span class="chip s-neutral">Queued</span><span class="chip s-hold">Needs review</span><span class="chip s-failed">Failed</span><span class="chip s-info">Merged</span></div>
      <p class="muted" style="font-size:12.5px;margin-top:16px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="kbd">/</span> search <span class="kbd">[</span><span class="kbd">]</span> detections <span class="kbd">K</span> play <span class="kbd">⌘K</span> commands</p></div>

    <div class="card pad"><div class="comp-h"><h4>Severity and category</h4><span class="label">ui/SeverityMark</span></div>
      <div style="display:grid;gap:8px">${SEVERITY.map(s => `<div style="display:flex;align-items:center;gap:10px;font-size:13px"><span class="sev-dot" data-sev="${s.level}">${s.level}</span><span class="sev-pips" data-sev="${s.level}">${[1, 2, 3, 4, 5].map(n => `<i style="${n <= s.level ? 'background:var(--sv)' : ''}"></i>`).join('')}</span><b style="font-weight:600">${s.label}</b><span class="muted" style="margin-left:auto">${s.when}</span></div>`).join('')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:16px">${presetCats().map(c => `<span class="cat" data-cat="${c}">${ic(c)}${CATEGORY[c].label}</span>`).join('')}</div></div>

    <div class="card pad upl" id="uplCard"><div class="comp-h" style="margin:0"><h4>Live upload</h4><button class="btn btn-secondary btn-sm" id="runBtn">Run</button></div>
      <div class="upl-top"><span id="uplDash">${dash('idle', 44)}</span><div style="min-width:0"><div class="mono" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis">${LIVE.video.filename}</div><div class="muted" style="font-size:12.5px" id="uplText">Queued · 27 s clip</div></div><span class="chip s-neutral" id="uplChip">Queued</span></div>
      <ol class="stage-track" style="list-style:none;margin:0;padding:0" id="stageTrack">${STAGES.map(s => `<li class="stg"><i></i><span>${s.label}</span></li>`).join('')}</ol>
      <div style="display:flex;gap:16px;font-size:13px" class="num"><span><b id="uplFound">0</b> found</span><span><b id="uplMerged">0</b> merged</span><span><b id="uplNew">0</b> new</span></div></div>

    <div class="card pad" id="markDemo"><div class="comp-h"><h4>Frame mark</h4><button class="btn btn-secondary btn-sm" id="markBtn">Replay</button></div>
      <div class="frame" style="border-radius:var(--r)"><canvas aria-hidden="true"></canvas><div class="hud h-tl"><span class="rec"></span>pie_cam-3 · set04/video_0008</div><div class="hud h-br">05:14.6</div><div class="mark"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="ring" pathLength="400" d=""/></svg><span class="tag"></span></div></div>
      <p class="muted" style="font-size:12.5px;margin-top:10px" id="markNote"></p></div>

    <div class="card pad wo"><div class="comp-h" style="margin:0"><h4>Work order</h4><span class="sev" data-sev="${hazard.severity}"><span class="sev-dot" data-sev="${hazard.severity}">${hazard.severity}</span>${SEVERITY[hazard.severity - 1].when}</span></div>
      <p style="font-family:var(--font-d);font-size:18px;font-weight:650;line-height:1.25">${esc(hazard.description)}</p>
      <p class="muted" style="font-size:13px">${esc(hazard.place)}</p>
      <dl class="kv"><dt>Repair</dt><dd style="font-family:var(--font-b);font-size:13px">${esc(hazard.work_order.repair)}</dd><dt>Crew</dt><dd>${CATEGORY[hazard.category].crewLabel} · ${hazard.work_order.minutes} min</dd><dt>Kit</dt><dd class="equip">${hazard.work_order.equipment.map(e => `<span>${esc(e)}</span>`).join('')}</dd><dt>Model</dt><dd>Nemotron 3.5 Lightning</dd></dl></div>

    <div class="card pad"><div class="comp-h"><h4>Crews for tomorrow</h4><span class="label num" id="crewTotal"></span></div>
      <div id="crewRows">${crewCats.map(c => { const crew = CATEGORY[c].crew; return `<div class="crewrow" data-cat="${c}"><span class="g">${ic(c)}</span><div style="min-width:0"><b style="font-size:14px;font-weight:600">${CATEGORY[c].crewLabel}</b><div class="muted" style="font-size:12.5px">${rep.jobs[crew]} jobs · ${fmtHours(rep.workload[crew])} h · baseline ${rep.crews[crew]}</div></div><span class="stepper"><button type="button" aria-label="Fewer ${CATEGORY[c].crewLabel} crews" data-step="-1" data-crew="${crew}">${ic('minus')}</button><b data-count="${crew}">${rep.crews[crew]}</b><button type="button" aria-label="More ${CATEGORY[c].crewLabel} crews" data-step="1" data-crew="${crew}">${ic('plus')}</button></span></div>`; }).join('')}</div></div>

    <div class="card pad"><div class="comp-h"><h4>Schedule</h4><span class="label">cuOpt · ${(plan.solve_ms / 1000).toFixed(1)} s</span></div>
      <div class="gantt">${routes.map(r => `<div class="grow" data-cat="${r.category}"><b>${r.crew_id}</b><span class="glane">${r.legs.filter(l => l.type === 'job').map(l => `<i data-sev="${l.severity}" style="left:${(l.start / 480) * 100}%;width:${Math.max(0.8, ((l.end - l.start) / 480) * 100)}%" title="${fmtShift(l.start)} · S${l.severity}"></i>`).join('')}</span></div>`).join('')}
      <div class="gaxis">${[0, 120, 240, 360, 480].map(m => `<span>${fmtShift(m)}</span>`).join('')}</div></div>
      <p class="muted" style="font-size:12.5px;margin-top:10px">Bars are jobs in the crew’s category colour; the cap is severity.</p></div>

    <div class="card pad"><div class="comp-h"><h4>Toasts</h4><button class="btn btn-secondary btn-sm" id="toastBtn">Merge one</button></div>
      <div class="toasts" id="toasts"><div class="toast">${ic('check')}<span><b>Merged</b> with iss_0129, now seen 3×</span><button type="button">Undo</button></div><div class="toast">${ic('route')}<span><b>Plan ready</b>, ${plan.jobs_routed} jobs on ${plan.crews_needed} crews</span><button type="button">View</button></div></div></div>

    <div class="card pad"><div class="comp-h"><h4>Map marks</h4><span class="label">features/map</span></div>
      <div class="pins">${SEVERITY.map(s => `<span class="pin-demo"><svg width="26" height="26" viewBox="-13 -13 26 26" class="m-pin" data-sev="${s.level}" aria-hidden="true"><circle r="8"/></svg>S${s.level}</span>`).join('')}
        <span class="pin-demo"><svg width="26" height="26" viewBox="-13 -13 26 26" class="m-pin sel" data-sev="4" aria-hidden="true"><circle r="8"/></svg>Selected</span>
        <span class="pin-demo"><svg width="30" height="30" viewBox="-15 -15 30 30" class="m-car" aria-hidden="true"><circle r="14"/><path d="M0 -9L6.5 7.5 0 3.5-6.5 7.5Z"/></svg>Vehicle</span>
        <span class="pin-demo"><svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true"><path class="m-track" d="M3 20 C 12 20 14 6 24 6 L 37 6"/></svg>Track</span></div>
      <p class="muted" style="font-size:12.5px;margin-top:14px">Pins use the severity ramp with a ground-coloured ring so overlaps stay readable; other drives’ pins are dimmed.</p></div>`;
  bindComponents(rep);
  drawMarkDemo();
}
function drawMarkDemo() {
  const box = $('#markDemo .frame'); if (!box) return; const cv = $('canvas', box);
  const iss = LIVE.detections[0].issue; const rect = box.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.max(320, Math.round(rect.width * dpr)); cv.height = Math.round(cv.width * 9 / 16);
  drawScene(cv.getContext('2d'), cv.width, cv.height, { category: iss.category, seed: iss.frame_seed, bbox: iss.bbox, light: 'day' });
  placeMark(iss, $('.mark', box));
  $('#markNote').textContent = DIRS[st.dir].signature + '. The same component in every direction; only tokens and one stroke rule change.';
}
let runTimer = 0;
function bindComponents(rep) {
  $('#markBtn').onclick = () => drawMarkDemo();
  $('#toastBtn').onclick = () => { const box = $('#toasts'); const n = document.createElement('div'); n.className = 'toast'; n.innerHTML = `${ic('check')}<span><b>Merged</b> with iss_0${100 + Math.floor(Math.random() * 60)}, seen again on Queen St W</span><button type="button">Undo</button>`; box.prepend(n); while (box.children.length > 3) box.lastChild.remove(); };
  const total = () => $$('[data-count]').reduce((s, b) => s + +b.textContent, 0);
  const upd = () => { $('#crewTotal').textContent = `${total()} crews`; };
  $('#crewRows').onclick = e => { const b = e.target.closest('[data-step]'); if (!b) return; const out = $(`[data-count="${b.dataset.crew}"]`); out.textContent = clamp(+out.textContent + +b.dataset.step, 0, 9); const base = rep.crews[b.dataset.crew]; out.closest('.crewrow').style.setProperty('--note', ''); out.style.color = +out.textContent < base ? 'var(--hold)' : ''; upd(); };
  upd();
  $('#runBtn').onclick = () => runUpload();
}
function runUpload() {
  clearInterval(runTimer); const stg = $$('#stageTrack .stg'); let k = 0, found = 0, merged = 0;
  const setStage = (i) => stg.forEach((s, j) => { s.className = 'stg' + (j < i ? ' done' : j === i ? ' on' : ''); });
  const dashFor = ['scan', 'scan', 'spot', 'check', 'plan'];
  const steps = [];
  STAGES.forEach((s, i) => { const n = i === 1 ? 6 : 1; for (let j = 0; j < n; j++) steps.push({ i, j, n, s }); });
  $('#uplChip').className = 'chip s-live'; $('#uplChip').textContent = 'Analysing';
  runTimer = setInterval(() => {
    if (k >= steps.length) { clearInterval(runTimer); setStage(5); $('#uplDash').innerHTML = dash('done', 44); $('#uplText').textContent = 'Done · 4 new issues, 2 merged'; $('#uplChip').className = 'chip s-done'; $('#uplChip').textContent = 'Done'; return; }
    const { i, j, n, s } = steps[k++]; setStage(i);
    $('#uplDash').innerHTML = dash(dashFor[i], 44);
    $('#uplText').textContent = n > 1 ? `${s.verb} ${j + 1} of ${n}` : s.verb;
    if (i === 1) { found++; $('#uplFound').textContent = found; }
    if (i === 3) { merged = 2; $('#uplMerged').textContent = merged; $('#uplNew').textContent = found - merged; }
  }, reduced ? 120 : 520);
}

// ---------- build spec
function renderSpec() {
  $('#stackTbl').innerHTML = `<thead><tr><th>Layer</th><th>Choice</th><th>Why</th></tr></thead><tbody>${STACK.map(([a, b, c]) => `<tr><td>${a}</td><td><b>${esc(b)}</b></td><td class="muted">${esc(c)}</td></tr>`).join('')}</tbody>`;
  $('#layers').innerHTML = LAYERS.map(([n, f, d], i) => `${i ? '<div class="arrow" aria-hidden="true">imports ↓</div>' : ''}<div class="layer"><div><b>${n}</b><div><code>${esc(f)}</code></div></div><p>${esc(d)}</p></div>`).join('');
  $('#eventTbl').innerHTML = `<thead><tr><th>Backend</th><th>Meaning</th><th>What the UI does</th><th>Dash</th></tr></thead><tbody>${EVENTS.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="muted">${esc(r[2])}</td><td><span class="mono" style="font-size:12px">${esc(r[3])}</span></td></tr>`).join('')}</tbody>`;
  $('#contractCode').innerHTML = CONTRACT;
  $('#tree').innerHTML = TREE;
  $('#workTbl').innerHTML = `<thead><tr><th>#</th><th>Workstream</th><th>Owns</th><th>Feeds the UI</th></tr></thead><tbody>${WORK.map(r => `<tr><td>${r[0]}</td><td><b>${esc(r[1])}</b></td><td><code>${esc(r[2])}</code></td><td class="muted">${esc(r[3])}</td></tr>`).join('')}</tbody>`;
  $('#relTbl').innerHTML = `<thead><tr><th>Concern</th><th>Budget or guard</th></tr></thead><tbody>${RELIABILITY.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</tbody>`;
  $('#steps').innerHTML = STEPS.map(([a, b]) => `<li><div><b>${esc(a)}</b><span>${esc(b)}</span></div></li>`).join('');
  $('#demoScript').innerHTML = DEMO.map(([t, a, b]) => `<div class="ds"><b>${t}</b><span>${esc(a)}</span><em>${esc(b)}</em></div>`).join('');
  renderTokens(); renderCatalogue();
}
function renderTokens() {
  // read each direction's real values by switching the attribute synchronously, then restore
  const cur = document.body.dataset.dir; const vals = {};
  for (const d of Object.keys(DIRS)) { document.body.dataset.dir = d; const cs = getComputedStyle(document.body); vals[d] = n => cs.getPropertyValue(n).trim(); vals[d] = Object.fromEntries(TOKEN_ROLES.map(([n]) => [n, n.includes(' ') || n.includes('…') ? '' : cs.getPropertyValue(n).trim()])); }
  document.body.dataset.dir = cur;
  const cell = v => v ? (v.startsWith('#') || v.startsWith('rgba') ? `<span style="display:inline-flex;gap:6px;align-items:center"><i style="width:12px;height:12px;border-radius:3px;background:${v};box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)"></i>${esc(v)}</span>` : esc(v.length > 26 ? v.slice(0, 26) + '…' : v)) : '<span class="muted">see Foundations</span>';
  $('#tokenTbl').innerHTML = `<thead><tr><th>Token</th><th>Role</th>${Object.values(DIRS).map(d => `<th>${d.key} · ${d.label}</th>`).join('')}</tr></thead><tbody>${TOKEN_ROLES.map(([n, role]) => `<tr><td>${esc(n)}</td><td class="muted" style="font-family:var(--font-b)">${esc(role)}</td>${Object.keys(DIRS).map(d => `<td class="mono" style="font-size:12px;white-space:nowrap">${cell(vals[d][n])}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
let catTier = 'all';
function renderCatalogue() {
  const tiers = ['all', 'ui', 'layout', 'feature', 'domain', 'core'];
  $('#catTiers').innerHTML = tiers.map(t => `<button type="button" data-tier="${t}" aria-pressed="${t === catTier}">${t === 'all' ? 'All' : t} <span class="k">${t === 'all' ? CATALOGUE.length : CATALOGUE.filter(c => c.tier === t).length}</span></button>`).join('');
  const q = ($('#catSearch').value || '').toLowerCase();
  const list = CATALOGUE.filter(c => (catTier === 'all' || c.tier === catTier) && (!q || (c.name + c.file + c.what).toLowerCase().includes(q)));
  $('#catList').innerHTML = list.map(c => `<details class="cat-item"><summary><b>${c.name}</b><span>${esc(c.what)}</span><code>${c.file}</code></summary>
    <div class="cat-body"><div><h5>Props</h5>${esc(c.props)}</div><div><h5>States</h5>${esc(c.states)}</div><div><h5>Accessibility</h5>${esc(c.a11y)}</div><div><h5>Motion</h5>${esc(c.motion)}</div>
    <div class="full"><button class="btn btn-secondary btn-sm" data-brief="${c.name}">${ic('copy')}Copy brief</button><span class="label">tier · ${c.tier}</span></div></div></details>`).join('') || '<p class="muted">Nothing matches.</p>';
}
function brief(c) {
  const path = c.tier === 'core' ? c.file : `apps/web/src/${c.file}`;
  return `Build \`${c.name}\` for Raightway at ${path} (export from its index.ts).

What: ${c.what}
Props / API: ${c.props}
States: ${c.states}
Accessibility: ${c.a11y}
Motion: ${c.motion} (respect prefers-reduced-motion)

Rules:
- Semantic tokens only (bg-surface, text-ink-2, border-line, rounded-ui …). No raw hex; it must look right in all three directions (survey, night, paint).
- Import only from lower layers: routes → features → domain → ui → tokens. Features never import each other.
- Types come from packages/core/schema (zod). Use the fixtures in src/mocks for every state listed.
- Add a vitest test for logic, and a fixture page under /dev/${c.name.toLowerCase()} that shows every state.`;
}
function bindCatalogue() {
  $('#catTiers').onclick = e => { const b = e.target.closest('[data-tier]'); if (b) { catTier = b.dataset.tier; renderCatalogue(); } };
  $('#catSearch').oninput = () => renderCatalogue();
  $('#catList').onclick = async e => {
    const b = e.target.closest('[data-brief]'); if (!b) return; const c = CATALOGUE.find(x => x.name === b.dataset.brief);
    try { await navigator.clipboard.writeText(brief(c)); b.innerHTML = `${ic('check')}Copied`; } catch { b.innerHTML = 'Copy blocked: select the text'; const pre = document.createElement('pre'); pre.className = 'code'; pre.style.gridColumn = '1/-1'; pre.textContent = brief(c); b.closest('.cat-body').append(pre); }
    setTimeout(() => { b.innerHTML = `${ic('copy')}Copy brief`; }, 1600);
  };
}

// ---------- motion demo
function bindMotion() { $('#motionBtn').onclick = () => { $$('.mtrack').forEach(t => t.classList.toggle('go')); }; }

// ---------- boot
document.body.dataset.dir = st.dir;
renderHeader(); renderIntro(); renderShell(); renderMascot(); renderFoundations(); renderComponents(); renderSpec(); bindCatalogue(); bindMotion();
addEventListener('keydown', e => { if (e.key === '/' && !e.target.matches('input,textarea')) { const q = $('#q'); if (q && q.getBoundingClientRect().top < innerHeight && q.getBoundingClientRect().bottom > 0) { e.preventDefault(); q.focus(); } } });
let rzT = 0; addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { drawMarkDemo(); }, 150); });
document.fonts?.ready.then(() => { renderFoundations(); renderRuler(); renderMapSvg(); refs(); tick(); fitTag(R.mark); fitTag($('#markDemo .mark')); });
