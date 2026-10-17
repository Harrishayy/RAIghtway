// Downtown Toronto, drawn to "Toronto north": the street grid is rotated ~17° from true north,
// so the map turns with it and Queen, King and Dundas run flat across the band.
// Coordinates are approximate intersection positions; the real app swaps this layer for map tiles.

export const GRID_ROTATION = 17; // degrees clockwise applied to true-north projection
const LAT0 = 43.652, LON0 = -79.384;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;

// Rows (south → north) and columns (west → east) of the arterial grid.
export const ROWS = ['Front', 'King', 'Queen', 'Dundas', 'College'];
export const COLS = ['Bathurst St', 'Spadina Ave', 'University Ave', 'Bay St', 'Yonge St', 'Jarvis St', 'Parliament St'];
const LL = [ // [row][col] = [lat, lon]
  [[43.6411, -79.4015], [43.6431, -79.3937], [43.6449, -79.3838], [43.6460, -79.3795], [43.6467, -79.3770], [43.6482, -79.3712], [43.6505, -79.3617]],
  [[43.6435, -79.4025], [43.6455, -79.3947], [43.6476, -79.3848], [43.6482, -79.3804], [43.6489, -79.3779], [43.6504, -79.3721], [43.6529, -79.3628]],
  [[43.6467, -79.4040], [43.6487, -79.3963], [43.6508, -79.3868], [43.6517, -79.3818], [43.6524, -79.3793], [43.6540, -79.3733], [43.6565, -79.3640]],
  [[43.6508, -79.4058], [43.6528, -79.3980], [43.6548, -79.3884], [43.6554, -79.3827], [43.6561, -79.3802], [43.6577, -79.3744], [43.6602, -79.3652]],
  [[43.6558, -79.4081], [43.6578, -79.4003], [43.6600, -79.3904], [43.6606, -79.3854], [43.6613, -79.3829], [43.6629, -79.3768], [43.6640, -79.3672]],
];
const NR = ROWS.length, NC = COLS.length;

// Bilinear interpolation (and linear extrapolation) over the intersection table.
export function gridLL(r, c) {
  const r0 = Math.max(0, Math.min(NR - 2, Math.floor(r))), c0 = Math.max(0, Math.min(NC - 2, Math.floor(c)));
  const fr = r - r0, fc = c - c0;
  const a = LL[r0][c0], b = LL[r0][c0 + 1], d = LL[r0 + 1][c0], e = LL[r0 + 1][c0 + 1];
  const lat = a[0] * (1 - fr) * (1 - fc) + b[0] * (1 - fr) * fc + d[0] * fr * (1 - fc) + e[0] * fr * fc;
  const lon = a[1] * (1 - fr) * (1 - fc) + b[1] * (1 - fr) * fc + d[1] * fr * (1 - fc) + e[1] * fr * fc;
  return [lat, lon];
}

const TH = GRID_ROTATION * Math.PI / 180, COS = Math.cos(TH), SIN = Math.sin(TH);
// lat/lon → map metres (x east, y down), rotated to grid north.
export function project(lat, lon) {
  const x = (lon - LON0) * KX, y = -(lat - LAT0) * KY;
  return [x * COS - y * SIN, x * SIN + y * COS];
}
export const gridXY = (r, c) => project(...gridLL(r, c));

export function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Streets. kind: 'arterial' | 'street'. A row street runs along r from c0 to c1; a col street along c from r0 to r1.
const W = (name, east) => (c) => c < 4 ? `${name} W` : (east || `${name} E`);
export const STREETS = [
  { name: 'Front St', at: 0, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Front St') },
  { name: 'King St', at: 1, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('King St') },
  { name: 'Queen St', at: 2, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Queen St') },
  { name: 'Dundas St', at: 3, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Dundas St') },
  { name: 'College St', at: 4, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: (c) => c < 4 ? 'College St' : 'Carlton St' },
  { name: 'Wellington St', at: 0.5, from: -0.2, to: 5.2, axis: 'row', kind: 'street', label: W('Wellington St') },
  { name: 'Adelaide St', at: 1.34, from: -3.5, to: 10, axis: 'row', kind: 'street', label: W('Adelaide St') },
  { name: 'Richmond St', at: 1.67, from: -3.5, to: 10, axis: 'row', kind: 'street', label: W('Richmond St') },
  { name: 'Shuter St', at: 2.45, from: 4, to: 6.6, axis: 'row', kind: 'street', label: () => 'Shuter St' },
  { name: 'Baldwin St', at: 3.45, from: 0.6, to: 2, axis: 'row', kind: 'street', label: () => 'Baldwin St' },
  { name: 'Gerrard St', at: 3.5, from: 2, to: 6.6, axis: 'row', kind: 'street', label: W('Gerrard St') },
  { name: 'Queens Quay', at: -0.95, from: -0.4, to: 5.6, axis: 'row', kind: 'street', label: W('Queens Quay') },
  { name: 'Bathurst St', at: 0, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Spadina Ave', at: 1, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'University Ave', at: 2, from: 0, to: 4.1, axis: 'col', kind: 'arterial' },
  { name: 'Bay St', at: 3, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Yonge St', at: 4, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Jarvis St', at: 5, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Parliament St', at: 6, from: -0.5, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Bloor St', at: 5.9, from: -3.5, to: 10, axis: 'row', kind: 'arterial', label: W('Bloor St') },
  { name: 'Ossington Ave', at: -2, from: -1.1, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Dovercourt Rd', at: -1.2, from: -0.6, to: 6.5, axis: 'col', kind: 'street' },
  { name: 'Strachan Ave', at: -1.6, from: -1.1, to: 2, axis: 'col', kind: 'street' },
  { name: 'River St', at: 7.6, from: 1, to: 6.5, axis: 'col', kind: 'street' },
  { name: 'Broadview Ave', at: 8.6, from: 1.6, to: 6.5, axis: 'col', kind: 'arterial' },
  { name: 'Sumach St', at: 7.1, from: 0.4, to: 4.6, axis: 'col', kind: 'street' },
  { name: 'Eastern Ave', at: 0.4, from: 6.2, to: 10, axis: 'row', kind: 'street', label: () => 'Eastern Ave' },
  { name: 'Harbord St', at: 4.9, from: -2, to: 2, axis: 'row', kind: 'street', label: () => 'Harbord St' },
  { name: 'Wellesley St', at: 5.0, from: 3, to: 7, axis: 'row', kind: 'street', label: () => 'Wellesley St' },
  { name: 'Portland St', at: 0.5, from: -0.3, to: 2, axis: 'col', kind: 'street' },
  { name: 'Augusta Ave', at: 0.62, from: 2, to: 4, axis: 'col', kind: 'street' },
  { name: 'Peter St', at: 1.3, from: 1, to: 2, axis: 'col', kind: 'street' },
  { name: 'John St', at: 1.55, from: 0, to: 2, axis: 'col', kind: 'street' },
  { name: 'Beverley St', at: 1.45, from: 2, to: 4, axis: 'col', kind: 'street' },
  { name: 'McCaul St', at: 1.72, from: 2, to: 4, axis: 'col', kind: 'street' },
  { name: 'Simcoe St', at: 1.85, from: -0.3, to: 2, axis: 'col', kind: 'street' },
  { name: 'York St', at: 2.5, from: -0.6, to: 2, axis: 'col', kind: 'street' },
  { name: 'Church St', at: 4.5, from: -0.6, to: 4.6, axis: 'col', kind: 'street' },
  { name: 'Sherbourne St', at: 5.45, from: -0.6, to: 4.6, axis: 'col', kind: 'street' },
];
export const STREET = Object.fromEntries(STREETS.map(s => [s.name, s]));

export function streetPoints(s, step = 0.25) {
  const pts = [];
  for (let t = s.from; t <= s.to + 1e-9; t += step) pts.push(s.axis === 'row' ? gridXY(s.at, Math.min(t, s.to)) : gridXY(Math.min(t, s.to), s.at));
  const last = s.axis === 'row' ? gridXY(s.at, s.to) : gridXY(s.to, s.at);
  if (pts.length && (pts[pts.length - 1][0] !== last[0])) pts.push(last);
  return pts;
}
export const toPath = pts => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');

function quad(r0, r1, c0, c1) { return [gridXY(r0, c0), gridXY(r0, c1), gridXY(r1, c1), gridXY(r1, c0)]; }
export const PARKS = [
  { name: 'Grange Park', q: quad(2.3, 2.75, 1.5, 1.7) },
  { name: 'Nathan Phillips Sq', q: quad(2.08, 2.45, 2.42, 2.82) },
  { name: 'Moss Park', q: quad(2.1, 2.55, 5.5, 5.85) },
  { name: 'St James Park', q: quad(1.05, 1.3, 4.6, 4.85) },
  { name: 'Clarence Sq', q: quad(0.58, 0.85, 1.05, 1.22) },
  { name: 'Victoria Memorial Sq', q: quad(0.55, 0.8, 0.12, 0.35) },
  { name: 'Allan Gardens', q: quad(3.55, 4.0, 5.55, 5.95) },
  { name: 'Queen’s Park', q: quad(4.08, 4.6, 1.85, 2.2) },
];
// Shoreline: south of Queens Quay, with ferry slips cut in.
export function lakePolygon() {
  const top = [];
  for (let c = -4; c <= 11; c += 0.2) {
    const slip = (c > 1.8 && c < 2.0) || (c > 3.2 && c < 3.4) || (c > 4.6 && c < 4.8);
    top.push(gridXY(slip ? -1.18 : -1.3, c));
  }
  const bottom = [gridXY(-4, 11), gridXY(-4, -4)];
  return [...top, ...bottom];
}
export function landPolygon() { return [gridXY(-1.3, -4), gridXY(-1.3, 11), gridXY(7, 11), gridXY(7, -4)]; }
export const RAIL = { from: -4, to: 11, at: -0.42 };

// Labels placed between intersections so they never sit on a crossing.
export const LABELS = [
  { text: 'Queen St W', r: 2, c: 0.27 }, { text: 'Queen St W', r: 2, c: 2.72 }, { text: 'Queen St E', r: 2, c: 5.25 },
  { text: 'King St W', r: 1, c: 0.27 }, { text: 'King St W', r: 1, c: 2.72 }, { text: 'King St E', r: 1, c: 5.25 },
  { text: 'Dundas St W', r: 3, c: 0.27 }, { text: 'Dundas St W', r: 3, c: 2.25 }, { text: 'Dundas St E', r: 3, c: 5.25 },
  { text: 'College St', r: 4, c: 0.27 }, { text: 'Carlton St', r: 4, c: 5.25 },
  { text: 'Front St W', r: 0, c: 0.27 }, { text: 'Front St E', r: 0, c: 5.25 },
  { text: 'Bathurst', r: 2.55, c: 0, v: true }, { text: 'Spadina', r: 2.55, c: 1, v: true }, { text: 'University', r: 1.5, c: 2, v: true },
  { text: 'Bay', r: 3.5, c: 3, v: true }, { text: 'Yonge', r: 1.5, c: 4, v: true }, { text: 'Jarvis', r: 2.55, c: 5, v: true }, { text: 'Parliament', r: 3.5, c: 6, v: true },
];

// Sensible viewports, in grid units (rows south→north, cols west→east).
export const VIEWS = {
  downtown: { r0: -0.55, r1: 4.25, c0: -0.25, c1: 6.45 },
  queenWest: { r0: 1.2, r1: 2.9, c0: -0.1, c1: 2.9 },
};
export function viewBoxFor({ r0, r1, c0, c1 }, aspect) {
  const corners = [gridXY(r0, c0), gridXY(r0, c1), gridXY(r1, c0), gridXY(r1, c1)];
  let x0 = Math.min(...corners.map(p => p[0])), x1 = Math.max(...corners.map(p => p[0]));
  let y0 = Math.min(...corners.map(p => p[1])), y1 = Math.max(...corners.map(p => p[1]));
  let w = x1 - x0, h = y1 - y0;
  if (aspect) {
    if (w / h < aspect) { const nw = h * aspect; x0 -= (nw - w) / 2; w = nw; }
    else { const nh = w / aspect; y0 -= (nh - h) / 2; h = nh; }
  }
  return [x0, y0, w, h];
}

// Name a point that sits on a street: "Queen St W near Portland St".
export function placeName(axis, at, t) {
  const cross = STREETS.filter(s => s.axis !== axis && at >= s.from && at <= s.to);
  let best = null, bd = 9;
  for (const s of cross) { const d = Math.abs(s.at - t); if (d < bd) { bd = d; best = s; } }
  const self = STREETS.find(s => s.axis === axis && Math.abs(s.at - at) < 0.02);
  const selfName = self ? (self.label ? self.label(axis === 'row' ? t : 0) : self.name) : 'Unnamed street';
  if (!best) return selfName;
  const crossName = best.label ? best.label(axis === 'row' ? 0 : at) : best.name;
  return bd < 0.06 ? `${selfName} at ${crossName}` : `${selfName} near ${crossName}`;
}
