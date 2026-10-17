'use client';
// One row per truck for the chosen day: its colour on the map, its kind of work, jobs done, driving, back at
// base and road alerts. Clicking a row opens the truck's full shift in RouteDetail, a panel over the map.
import { fmtShift } from '@raightway/core';
import { Icon } from '@/ui/Icon';
import { CategoryLabel } from '@/ui/marks';
import type { RouteRow } from './DispatchView';
import { hm } from './schedule';

export function RouteList({ byTruck = false, rows, clock, open, onOpen }: {
  byTruck?: boolean; rows: RouteRow[]; clock: number; open: string | null; onOpen: (id: string | null) => void;
}) {
  return (
    <table className="moments route-tbl">
      <thead><tr><th>Truck</th><th>Type</th><th className="r">Jobs</th><th className="r">Driving</th><th className="r">Back</th></tr></thead>
      <tbody>
        {rows.map(({ r, tl, totals, tone }) => {
          const isOpen = open === r.crew_id; const jobs = tl.filter(e => e.kind === 'job');
          const doneN = jobs.filter(e => clock >= e.depart_min).length; const onWay = r.warnings?.filter(w => !w.avoided).length ?? 0;
          return (
            <tr key={r.crew_id} data-cat={r.category} data-tone={byTruck ? tone : undefined} aria-selected={isOpen} tabIndex={0}
              onClick={() => onOpen(isOpen ? null : r.crew_id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(isOpen ? null : r.crew_id); } }}>
              <td><span className="rt-truck"><span className="route-id"><i className="route-swatch" aria-hidden="true" />{r.vehicle_id ?? r.crew_id}</span>{onWay ? <span className="route-alerts small" title={r.warnings!.map(w => w.label).join('\n')}><Icon name="alert" />{onWay}</span> : null}</span></td>
              <td><CategoryLabel id={r.category} compact /></td>
              <td className="r num">{doneN}/{jobs.length}</td>
              <td className="r num">{hm(totals.drive_min)}</td>
              <td className="r num">{fmtShift(totals.back_min)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
