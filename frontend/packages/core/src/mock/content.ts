// Words the mock source uses to make believable findings. Real data replaces all of this.
import type { CategoryId, Severity } from '../types';

type ByStreet = Record<string, Partial<Record<CategoryId, number>>>;
export const STREET_FLAVOR: ByStreet = {
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
export const SEV_DIST: Record<CategoryId, number[]> = {
  graffiti: [30, 35, 25, 8, 2], pavement: [5, 20, 35, 25, 15], markings: [10, 30, 35, 20, 5],
  work_zone: [0, 15, 30, 30, 25], signage: [0, 20, 30, 30, 20], waste: [15, 35, 35, 15, 0],
};
export const DESC: Record<CategoryId, Partial<Record<Severity, string[]>>> = {
  graffiti: { 1: ['Small tag on a utility box', 'Sticker cluster and marker tag on a signal pole', 'Light tagging on a newspaper box'], 2: ['Tag on a roller shutter, about 1 m wide', 'Marker tags across a bus shelter panel', 'Tag on a brick wall beside a storefront'], 3: ['Throw-up across a roller shutter, about 2 m wide', 'Spray-painted tags across two storefronts', 'Tag over a heritage brick facade'], 4: ['Large piece across a shuttered storefront, 4 m wide', 'Tags covering a TTC shelter map'], 5: ['Paint over a pedestrian crossing sign'] },
  pavement: { 1: ['Hairline cracks in the curb lane'], 2: ['Crack along the streetcar rail', 'Worn patch over an old utility cut'], 3: ['Pothole forming in the curb lane, about 30 cm', 'Spalled asphalt along the streetcar rail'], 4: ['Pothole in a traffic lane, about 45 cm', 'Sunken utility cut in the right lane'], 5: ['Deep pothole in the curb lane, cyclists swerving', 'Raised manhole cover in a travel lane'] },
  markings: { 1: ['Lane arrows slightly faded'], 2: ['Lane dashes worn but visible', 'Bike lane symbol partly worn'], 3: ['Crosswalk bars faded to about 40%', 'Stop bar worn through on one lane'], 4: ['Crosswalk nearly invisible at the intersection', 'Streetcar stop line gone'], 5: ['School crossing markings worn away'] },
  work_zone: { 2: ['Barrels left on the sidewalk after works', 'Road-work sign left up after works ended'], 3: ['Cones drifting into the curb lane'], 4: ['Fencing blown into a live lane', 'Steel plate shifted over a trench'], 5: ['Open trench with no barrier or crew', 'Unguarded excavation at the curb'] },
  signage: { 2: ['Street name sign faded', 'Parking sign bent but readable'], 3: ['No-stopping sign hidden by branches', 'Sign face faded, hard to read at distance'], 4: ['Stop sign leaning about 20°', 'One-way sign turned the wrong way'], 5: ['Stop sign missing from its post', 'Stop sign knocked down at the intersection'] },
  waste: { 1: ['A few bags at the curb'], 2: ['Litter bin full', 'Cardboard piled beside a recycling bin'], 3: ['Overflowing litter bin, bags on the sidewalk', 'Dumped mattress on the sidewalk'], 4: ['Furniture blocking part of the sidewalk', 'Bags spilling into the bike lane'] },
};
export const REPAIR: Record<CategoryId, Partial<Record<Severity, string>>> = {
  graffiti: { 1: 'Remove tag with solvent wipe', 2: 'Remove tag with solvent wipe', 3: 'Pressure-wash, then apply anti-graffiti coating', 4: 'Paint-match and repaint the shutter', 5: 'Clean the sign face; replace if etched' },
  pavement: { 1: 'Seal cracks', 2: 'Seal crack along the rail', 3: 'Cold-patch the pothole', 4: 'Saw-cut and hot-patch', 5: 'Emergency patch, then cone until set' },
  markings: { 1: 'Repaint arrows', 2: 'Repaint lane dashes', 3: 'Repaint crosswalk bars in thermoplastic', 4: 'Repaint crosswalk and stop bar', 5: 'Repaint school crossing; add beads' },
  work_zone: { 2: 'Collect leftover barrels and signs', 3: 'Reset cones to the permit layout', 4: 'Re-anchor fencing; call the permit holder', 5: 'Barricade the trench; call the permit holder' },
  signage: { 2: 'Replace the sign face', 3: 'Prune branches to clear the sign', 4: 'Straighten and re-anchor the post', 5: 'Install a temporary Ra-1 stop sign' },
  waste: { 1: 'Collect bags', 2: 'Empty bin', 3: 'Empty bin, clear the sidewalk', 4: 'Bulk pickup' },
};
export const EQUIP: Record<CategoryId, string[]> = {
  graffiti: ['Pressure washer', 'Solvent kit', 'Anti-graffiti coating', 'Paint-match kit'],
  pavement: ['Cold patch, 2 bags', 'Plate compactor', 'Cones ×6', 'Asphalt hot box', 'Saw cutter'],
  markings: ['Thermoplastic applicator', 'Line striper', 'Cones ×8', 'Glass beads'],
  work_zone: ['Barricades ×4', 'Cone trailer', 'Arrow board'],
  signage: ['Post driver', 'Ra-1 stop sign', 'Pruning saw', 'Ladder'],
  waste: ['Packer truck', 'Bulk item trailer', 'Litter picker'],
};
