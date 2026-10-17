// Alert glyphs as plain SVG path data (24-unit grid) so the same shapes draw in SVG and on a canvas
// (map icons). One per issue type: what a dispatcher should recognise at a glance.
import type { CategoryId } from '@raightway/core';

export const GLYPH: Record<CategoryId, string> = {
  graffiti: 'M9 9h5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM9.5 9V6h4v3M11.5 6V3.5M18.5 5h.01M20.5 3h.01M20.5 7.5h.01', // spray can
  markings: 'M5 3v18M19 3v18M12 4v3M12 10.5v3M12 17v3', // lane lines
  work_zone: 'M9.8 4h4.4l4.3 15.5h-13zM7.9 10.5h8.2M6.6 15h10.8M3 20h18', // cone / roadblock
  pavement: 'M3 18h18M5 13a7 3 0 1 0 14 0a7 3 0 1 0-14 0M8.5 12.6l1.8 1 1.9-1.4 1.9 1.4 1.4-.8', // pothole
  signage: 'M8.6 2.5h6.8l3.1 3.1v4.8l-3.1 3.1H8.6l-3.1-3.1V5.6zM12 13.5V21', // stop sign
  waste: 'M4.5 7h15M10 7V4h4v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5', // bin
};
export const ALERT_NOUN: Record<CategoryId, string> = { graffiti: 'Graffiti', markings: 'Worn markings', work_zone: 'Road block / work zone', pavement: 'Pothole / pavement', signage: 'Sign damage', waste: 'Garbage / dumping' };

/** Operating-site glyphs (same 24-unit grid), drawn in a square badge so a site never reads as an issue pin. */
export type SiteKind = 'transfer_station' | 'collection_yard' | 'road_yard' | 'cleaning_yard' | 'yard';
export const SITE_GLYPH: Record<SiteKind, string> = {
  transfer_station: 'M3 20V9l9-5 9 5v11M3 20h18M12 9v7M9 13l3 3 3-3', // shed with a drop-off arrow
  collection_yard: 'M2 16V8h11v8M13 11h4l3 3v2h-7M2 16h2M8 16h7M6 18.5a1.5 1.5 0 1 0 0-.01M17 18.5a1.5 1.5 0 1 0 0-.01', // collection truck
  road_yard: 'M3 18h18M5 18v-3a7 7 0 0 1 14 0v3M10 8V6h4v2M12 8v4', // hard hat
  cleaning_yard: 'M15 3l-4 8M7 11h7l2 3-2 7H6l-1-7zM8 14v7M11 14v7', // broom
  yard: 'M3 20V9l9-5 9 5v11M3 20h18M9 20v-6h6v6', // depot
};
export const SITE_NOUN: Record<SiteKind, string> = {
  transfer_station: 'Transfer station', collection_yard: 'Collection yard', road_yard: 'Road operations yard', cleaning_yard: 'Street-cleaning yard', yard: 'Works yard',
};
/** CSS token per site kind, e.g. var(--site-road). */
export const SITE_TOKEN: Record<SiteKind, string> = {
  transfer_station: '--site-transfer', collection_yard: '--site-collection', road_yard: '--site-road', cleaning_yard: '--site-cleaning', yard: '--site-road',
};
export const ROUTE_TONES = 8;
/** A stable truck colour token: --route-1 … --route-8. */
export const routeToken = (n: number) => `--route-${(((n % ROUTE_TONES) + ROUTE_TONES) % ROUTE_TONES) + 1}`;
