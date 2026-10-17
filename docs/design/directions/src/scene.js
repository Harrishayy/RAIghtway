// Procedural dashcam frames. A stand-in for /api/frames/{id} so every view has a believable
// picture to put a bounding box on. Pinhole camera at 1.4 m; the issue is drawn inside its bbox.
import { mulberry32 } from './core.js';

const PAL = {
  brick: ['#7d4a3a', '#8a5444', '#6e4134', '#94604c'],
  stone: ['#a59d8f', '#9b9384', '#b3ab9c'],
  concrete: ['#8c9094', '#7d8287', '#9aa0a5'],
  glass: ['#4d5d68', '#56697a', '#41505b'],
  paint: ['#5d6b5a', '#6a5d72', '#7b6f52', '#4f6470'],
};
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `rgb(${r},${g},${b})`;
}

export function drawScene(ctx, W, H, opts = {}) {
  const { category = 'graffiti', seed = 1, bbox = null, light = 'day', tracks = true } = opts;
  const rnd = mulberry32(seed * 7919 + 13);
  const cx = W * (0.47 + rnd() * 0.06), cy = H * (0.42 + rnd() * 0.03);
  const F = H * 1.6, camH = 1.4;
  const P = (X, Y, Z) => [cx + (X * F) / Z, cy + ((camH - Y) * F) / Z];
  const poly = (pts, fill) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, cy);
  if (light === 'dusk') { sky.addColorStop(0, '#3e4a5e'); sky.addColorStop(1, '#c9a58a'); }
  else if (light === 'overcast') { sky.addColorStop(0, '#9aa6af'); sky.addColorStop(1, '#d3d9dc'); }
  else { sky.addColorStop(0, '#7f9bb3'); sky.addColorStop(1, '#d6e0e6'); }
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

  // distant skyline at the vanishing point
  ctx.fillStyle = light === 'dusk' ? '#4b4f5a' : '#8b959c';
  let x = cx - W * 0.12;
  while (x < cx + W * 0.12) { const w = W * (0.008 + rnd() * 0.02), h = H * (0.03 + rnd() * 0.12); ctx.fillRect(x, cy - h, w, h + 2); x += w; }
  // a tower or two
  ctx.fillStyle = light === 'dusk' ? '#3c404a' : '#7a858d';
  for (let i = 0; i < 2; i++) { const w = W * 0.012, h = H * (0.18 + rnd() * 0.12), tx = cx + (rnd() - 0.5) * W * 0.16; ctx.fillRect(tx, cy - h, w, h); }

  // road, sidewalks
  const ZN = 1.2, ZF = 600;
  poly([P(-7, 0, ZN), P(7, 0, ZN), P(7, 0, ZF), P(-7, 0, ZF)], '#3d4144');
  // asphalt variation bands
  for (let i = 0; i < 18; i++) { const z0 = 3 + rnd() * 60, z1 = z0 + 1 + rnd() * 4, xs = -7 + rnd() * 10, xe = xs + 1 + rnd() * 4; poly([P(xs, 0, z0), P(xe, 0, z0), P(xe, 0, z1), P(xs, 0, z1)], rnd() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)'); }
  poly([P(-10.5, 0.15, ZN), P(-7, 0.15, ZN), P(-7, 0.15, ZF), P(-10.5, 0.15, ZF)], '#9a9a95');
  poly([P(7, 0.15, ZN), P(10.5, 0.15, ZN), P(10.5, 0.15, ZF), P(7, 0.15, ZF)], '#9a9a95');
  ctx.strokeStyle = '#c9c7c0'; ctx.lineWidth = Math.max(1, H * 0.003);
  [[-7, 0.15], [7, 0.15]].forEach(([X, Y]) => { const a = P(X, Y, ZN), b = P(X, Y, ZF); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });

  // streetcar rails (King and Queen have them)
  if (tracks) {
    ctx.strokeStyle = 'rgba(160,165,168,0.55)';
    [-2.7, -1.3, 1.3, 2.7].forEach(X => { ctx.lineWidth = Math.max(1, H * 0.002); const a = P(X, 0, 2), b = P(X, 0, ZF); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });
  }
  // lane markings
  const dash = (X, col, faded = 1) => { for (let z = 3; z < 160; z += 9) { const a = P(X - 0.06, 0, z), b = P(X + 0.06, 0, z), c = P(X + 0.06, 0, z + 3), d = P(X - 0.06, 0, z + 3); poly([a, b, c, d], col.replace('A', String(faded))); } };
  const solid = (X, col) => poly([P(X - 0.06, 0, 2), P(X + 0.06, 0, 2), P(X + 0.06, 0, ZF), P(X - 0.06, 0, ZF)], col);
  solid(-0.15, 'rgba(226,182,40,0.85)'); solid(0.15, 'rgba(226,182,40,0.85)');
  dash(-3.5, 'rgba(235,235,230,A)', category === 'markings' ? 0.35 : 0.85); dash(3.5, 'rgba(235,235,230,A)', 0.85);

  // buildings on both sides, far to near
  for (const side of [-1, 1]) {
    const Xf = side * 10.5; let z = 6 + rnd() * 4; const blocks = [];
    while (z < 170) { const d = 7 + rnd() * 16, h = 6 + rnd() * (z > 60 ? 30 : 18); blocks.push({ z0: z, z1: z + d, h, kind: pick(rnd, ['brick', 'brick', 'stone', 'concrete', 'glass', 'paint']), shutter: rnd() < 0.35, awning: rnd() < 0.3 }); z += d; }
    blocks.reverse().forEach(b => {
      const base = pick(rnd, PAL[b.kind]);
      poly([P(Xf, 0, b.z0), P(Xf, 0, b.z1), P(Xf, b.h, b.z1), P(Xf, b.h, b.z0)], shade(base, side < 0 ? -0.05 : 0.04));
      // windows
      const rows = Math.floor((b.h - 4) / 3.2), cols = Math.max(1, Math.floor((b.z1 - b.z0) / 2.6));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const y0 = 4.4 + r * 3.2, y1 = y0 + 1.7, za = b.z0 + 0.6 + c * ((b.z1 - b.z0) / cols), zb = za + ((b.z1 - b.z0) / cols) * 0.55;
        const lit = light === 'dusk' && rnd() < 0.35;
        poly([P(Xf, y0, za), P(Xf, y0, zb), P(Xf, y1, zb), P(Xf, y1, za)], lit ? '#e9c98a' : (b.kind === 'glass' ? shade(base, 0.18) : shade(base, -0.38 + rnd() * 0.12)));
      }
      // ground floor: storefront or roller shutter
      const gf = b.shutter ? '#8d9196' : shade(base, -0.45);
      poly([P(Xf, 0.2, b.z0 + 0.4), P(Xf, 0.2, b.z1 - 0.4), P(Xf, 3.2, b.z1 - 0.4), P(Xf, 3.2, b.z0 + 0.4)], gf);
      if (b.shutter) { ctx.strokeStyle = 'rgba(60,64,68,0.35)'; ctx.lineWidth = 1; for (let y = 0.5; y < 3.2; y += 0.35) { const a = P(Xf, y, b.z0 + 0.4), c = P(Xf, y, b.z1 - 0.4); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke(); } }
      if (b.awning) poly([P(Xf, 3.3, b.z0 + 0.5), P(Xf, 3.3, b.z1 - 0.5), P(Xf - side * 1.2, 2.8, b.z1 - 0.5), P(Xf - side * 1.2, 2.8, b.z0 + 0.5)], pick(rnd, ['#4f6b5c', '#7a3b33', '#2f4b66', '#5b5248']));
    });
    // street lights and trees on the sidewalk
    for (let zz = 12 + rnd() * 6; zz < 110; zz += 22 + rnd() * 10) {
      const a = P(side * 7.6, 0.15, zz), b = P(side * 7.6, 7.5, zz), arm = P(side * 6.2, 7.5, zz);
      ctx.strokeStyle = '#3e4447'; ctx.lineWidth = Math.max(1, (F * 0.16) / zz);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(arm[0], arm[1]); ctx.stroke();
      if (rnd() < 0.55) { const t = P(side * 8.8, 4.2, zz + 5), r = (F * 2.1) / (zz + 5); ctx.fillStyle = rnd() < 0.5 ? '#4e6447' : '#5b7150'; ctx.beginPath(); ctx.arc(t[0], t[1], r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(30,40,28,0.25)'; ctx.beginPath(); ctx.arc(t[0] + r * 0.25, t[1] + r * 0.2, r * 0.7, 0, Math.PI * 2); ctx.fill(); const tr = P(side * 8.8, 0.15, zz + 5); ctx.strokeStyle = '#3d342c'; ctx.lineWidth = Math.max(1, (F * 0.25) / (zz + 5)); ctx.beginPath(); ctx.moveTo(tr[0], tr[1]); ctx.lineTo(t[0], t[1] + r * 0.6); ctx.stroke(); }
    }
  }

  // a parked car or a streetcar ahead for scale
  if (rnd() < 0.7) {
    const z = 30 + rnd() * 30, X = rnd() < 0.5 ? -5.2 : 5.2;
    const tl = P(X - 0.95, 1.5, z), br = P(X + 0.95, 0.1, z);
    ctx.fillStyle = pick(rnd, ['#2c3236', '#7d1f1f', '#d8d8d4', '#2d4157']); ctx.fillRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
    ctx.fillStyle = 'rgba(20,24,28,0.75)'; ctx.fillRect(tl[0] + (br[0] - tl[0]) * 0.12, tl[1] + (br[1] - tl[1]) * 0.08, (br[0] - tl[0]) * 0.76, (br[1] - tl[1]) * 0.32);
    ctx.fillStyle = '#c0392b'; ctx.fillRect(tl[0], br[1] - (br[1] - tl[1]) * 0.45, (br[0] - tl[0]) * 0.12, (br[1] - tl[1]) * 0.1); ctx.fillRect(br[0] - (br[0] - tl[0]) * 0.12, br[1] - (br[1] - tl[1]) * 0.45, (br[0] - tl[0]) * 0.12, (br[1] - tl[1]) * 0.1);
  }
  if (tracks && rnd() < 0.45) { // a red streetcar, receding
    const z = 55 + rnd() * 40, tl = P(-3.4, 3.4, z), br = P(-0.6, 0.2, z);
    ctx.fillStyle = '#c8322b'; ctx.fillRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
    ctx.fillStyle = '#26303a'; ctx.fillRect(tl[0] + 1, tl[1] + (br[1] - tl[1]) * 0.18, br[0] - tl[0] - 2, (br[1] - tl[1]) * 0.3);
    ctx.fillStyle = '#e8e6df'; ctx.fillRect(tl[0], br[1] - (br[1] - tl[1]) * 0.22, br[0] - tl[0], (br[1] - tl[1]) * 0.06);
  }

  if (bbox) drawIssue(ctx, W, H, category, bbox, rnd);

  // dash hood + vignette + grain
  ctx.fillStyle = '#15181a'; ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(0, H * 0.965); ctx.quadraticCurveTo(W * 0.5, H * 0.915, W, H * 0.965); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(W * 0.3, H * 0.937, W * 0.4, Math.max(1, H * 0.003));
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.42)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  const n = Math.min(2400, Math.floor((W * H) / 220));
  for (let i = 0; i < n; i++) { ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'; ctx.fillRect(rnd() * W, rnd() * H, 1, 1); }
}

function drawIssue(ctx, W, H, category, b, rnd) {
  const x = b.x * W, y = b.y * H, w = b.w * W, h = b.h * H;
  ctx.save();
  if (category === 'graffiti') {
    const left = b.x + b.w / 2 < 0.5;
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.translate(x, y); ctx.transform(1, (left ? 0.18 : -0.18), 0, 1, 0, left ? -w * 0.09 : w * 0.09);
    const cols = [['#d8336f', '#1d1d1f'], ['#29b0c2', '#f2f2f2'], ['#eac435', '#2b2b2b'], ['#9b5de5', '#f2f2f2'], ['#f2f2f2', '#d8336f']][Math.floor(rnd() * 5)];
    for (let k = 0; k < 2; k++) {
      ctx.strokeStyle = k ? cols[1] : cols[0]; ctx.lineWidth = Math.max(1.5, h * (k ? 0.035 : 0.09)); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); let px = w * 0.08, py = h * (0.45 + rnd() * 0.2); ctx.moveTo(px, py);
      const r2 = mulberry32(Math.floor(rnd() * 1e6) + k);
      for (let i = 0; i < 9; i++) { const nx = px + w * (0.06 + r2() * 0.1), ny = h * (0.18 + r2() * 0.62); ctx.bezierCurveTo(px + w * 0.05, py - h * 0.5, nx - w * 0.04, ny + h * 0.5, nx, ny); px = nx; py = ny; }
      ctx.stroke();
    }
    ctx.strokeStyle = cols[0]; ctx.lineWidth = Math.max(1, h * 0.012);
    for (let i = 0; i < 6; i++) { const dx = w * (0.1 + rnd() * 0.8), dy = h * (0.55 + rnd() * 0.15); ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx, dy + h * (0.08 + rnd() * 0.2)); ctx.stroke(); }
  } else if (category === 'pavement') {
    const ccx = x + w / 2, ccy = y + h * 0.55;
    ctx.fillStyle = '#26292b'; ctx.beginPath();
    for (let i = 0; i <= 14; i++) { const a = (i / 14) * Math.PI * 2, r = 0.78 + rnd() * 0.25; ctx.lineTo(ccx + Math.cos(a) * (w * 0.42) * r, ccy + Math.sin(a) * (h * 0.36) * r); }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.ellipse(ccx, ccy + h * 0.05, w * 0.3, h * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(150,150,145,0.65)'; ctx.lineWidth = Math.max(1, h * 0.03);
    ctx.beginPath(); ctx.ellipse(ccx, ccy - h * 0.02, w * 0.4, h * 0.33, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.strokeStyle = 'rgba(20,20,20,0.8)'; ctx.lineWidth = Math.max(1, h * 0.015);
    for (let i = 0; i < 5; i++) { ctx.beginPath(); let px = ccx + (rnd() - 0.5) * w * 0.6, py = ccy + (rnd() - 0.5) * h * 0.4; ctx.moveTo(px, py); for (let j = 0; j < 4; j++) { px += (rnd() - 0.5) * w * 0.35; py += (rnd() - 0.3) * h * 0.25; ctx.lineTo(px, py); } ctx.stroke(); }
  } else if (category === 'markings') {
    for (let i = 0; i < 7; i++) {
      const t0 = i / 7, t1 = t0 + 0.07; const yy0 = y + h * 0.15, yy1 = y + h * 0.85;
      const xa = x + w * t0, xb = x + w * t1, skew = (x + w * (t0 + 0.035) - W * 0.5) * 0.18;
      ctx.fillStyle = `rgba(232,232,226,${0.12 + rnd() * 0.22})`;
      ctx.beginPath(); ctx.moveTo(xa + skew, yy0); ctx.lineTo(xb + skew, yy0); ctx.lineTo(xb - skew * 0.6, yy1); ctx.lineTo(xa - skew * 0.6, yy1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#3d4144'; for (let k = 0; k < 3; k++) { const gy = yy0 + rnd() * (yy1 - yy0); ctx.fillRect(xa - 2, gy, xb - xa + 4, (yy1 - yy0) * 0.08); }
    }
  } else if (category === 'work_zone') {
    const n = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const s = 0.55 + (i / n) * 0.45, cw = w * 0.14 * s, ch = h * 0.55 * s, bx = x + w * (0.08 + (i / n) * 0.78), by = y + h * (0.4 + (i / n) * 0.45);
      ctx.fillStyle = '#e8622a'; ctx.beginPath(); ctx.moveTo(bx, by - ch); ctx.lineTo(bx + cw / 2, by); ctx.lineTo(bx - cw / 2, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f1f1ec'; ctx.fillRect(bx - cw * 0.3, by - ch * 0.55, cw * 0.6, ch * 0.13);
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(bx - cw * 0.62, by - 2, cw * 1.24, Math.max(2, ch * 0.07));
    }
    const bx = x + w * 0.62, by = y + h * 0.08, bw = w * 0.32, bh = h * 0.3;
    for (let i = 0; i < 5; i++) { ctx.fillStyle = i % 2 ? '#f1f1ec' : '#e8622a'; ctx.fillRect(bx + (bw / 5) * i, by, bw / 5, bh * 0.35); }
    ctx.fillStyle = '#4a4a4a'; ctx.fillRect(bx + bw * 0.1, by + bh * 0.35, Math.max(1, bw * 0.04), bh * 0.65); ctx.fillRect(bx + bw * 0.86, by + bh * 0.35, Math.max(1, bw * 0.04), bh * 0.65);
  } else if (category === 'signage') {
    const px = x + w * 0.45; ctx.strokeStyle = '#5a5f62'; ctx.lineWidth = Math.max(2, w * 0.06);
    ctx.beginPath(); ctx.moveTo(px, y + h); ctx.lineTo(px + w * 0.08, y + h * 0.35); ctx.stroke();
    ctx.save(); ctx.translate(px + w * 0.1, y + h * 0.25); ctx.rotate(0.28 + rnd() * 0.15);
    const r = Math.min(w, h) * 0.24; ctx.fillStyle = rnd() < 0.6 ? '#b71c1c' : '#f4f4ef'; ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#f4f4ef'; ctx.lineWidth = Math.max(1, r * 0.1); ctx.stroke(); ctx.restore();
    ctx.fillStyle = 'rgba(70,98,62,0.92)';
    for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(x + w * (0.05 + rnd() * 0.5), y + h * (0.05 + rnd() * 0.35), Math.min(w, h) * (0.12 + rnd() * 0.12), 0, Math.PI * 2); ctx.fill(); }
  } else if (category === 'waste') {
    const bx = x + w * 0.52, bw = w * 0.34, bh = h * 0.62, by = y + h - bh;
    ctx.fillStyle = '#2f4a3a'; ctx.fillRect(bx, by, bw, bh); ctx.fillStyle = '#243a2d'; ctx.fillRect(bx - bw * 0.05, by - bh * 0.08, bw * 1.1, bh * 0.1);
    for (let i = 0; i < 6; i++) { const r = Math.min(w, h) * (0.1 + rnd() * 0.1); ctx.fillStyle = rnd() < 0.7 ? '#1c1d1f' : '#e9e7df'; ctx.beginPath(); ctx.ellipse(x + w * (0.1 + rnd() * 0.75), y + h * (0.55 + rnd() * 0.38), r * 1.2, r, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#d9d2c3'; ctx.fillRect(x + w * 0.04, y + h * 0.3, w * 0.36, h * 0.12);
  }
  ctx.restore();
}

// Typical bbox placements per category, consistent with the camera above (normalised x, y, w, h).
export function bboxFor(category, rnd) {
  const r = () => rnd();
  switch (category) {
    case 'graffiti': { const left = r() < 0.6; const w = 0.12 + r() * 0.12; return { x: left ? 0.03 + r() * 0.12 : 0.97 - w - r() * 0.1, y: 0.27 + r() * 0.1, w, h: 0.14 + r() * 0.1 }; }
    case 'pavement': { const w = 0.12 + r() * 0.12; return { x: 0.38 + r() * 0.2, y: 0.66 + r() * 0.08, w, h: 0.1 + r() * 0.06 }; }
    case 'markings': { const w = 0.34 + r() * 0.16; return { x: 0.5 - w / 2 + (r() - 0.5) * 0.08, y: 0.6 + r() * 0.06, w, h: 0.12 + r() * 0.05 }; }
    case 'work_zone': { const w = 0.16 + r() * 0.1; return { x: 0.56 + r() * 0.12, y: 0.42 + r() * 0.08, w, h: 0.2 + r() * 0.08 }; }
    case 'signage': { const w = 0.07 + r() * 0.05; return { x: 0.74 + r() * 0.1, y: 0.2 + r() * 0.08, w, h: 0.22 + r() * 0.08 }; }
    case 'waste': { const left = r() < 0.5; const w = 0.11 + r() * 0.07; return { x: left ? 0.06 + r() * 0.08 : 0.94 - w - r() * 0.08, y: 0.5 + r() * 0.08, w, h: 0.14 + r() * 0.06 }; }
    default: return { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  }
}
