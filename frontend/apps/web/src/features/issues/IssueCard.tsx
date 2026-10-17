'use client';
// The selected issue: what and where, how often it has been seen (each sighting seeks to it), the
// work order, and similar past issues. Handles merged, provisional and not-yet-planned states.
import { CATEGORY, fmtClock, fmtCoord, fmtTimecode, severityDef, type Issue } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useSimilar } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { Chip, CategoryLabel, SevDot, SevLabel } from '@/ui/marks';
import { Empty } from '@/ui/State';

export function IssueCard({ issue, onOpen }: { issue: Issue | null | undefined; onOpen?: (i: Issue) => void }) {
  const client = useClient(); const similar = useSimilar(issue && !issue.provisional ? issue.duplicate_of ?? issue.id : null);
  const { open, seek, videoId, select } = usePlayback();
  if (!issue) return <div className="issue"><Empty title="Nothing selected">Pick a finding on the timeline, the table or the map.</Empty></div>;
  const sv = severityDef(issue.severity); const wo = issue.work_order;
  const jump = (vid: string, t: number) => (vid === videoId ? seek(t) : open(vid, t, issue.id));
  return (
    <div className="issue">
      <div className="issue-tags">
        <CategoryLabel id={issue.category} /><SevLabel level={issue.severity} />
        <Chip tone={issue.severity === 5 ? 'failed' : 'neutral'}>{sv.when}</Chip>
        {issue.provisional ? <Chip tone="live">Checking</Chip> : issue.duplicate_of ? <Chip tone="info">Merged</Chip> : null}
      </div>
      <div><h4>{issue.description}</h4><p className="where">{issue.place ?? (issue.lat != null && issue.lon != null ? fmtCoord(issue.lat, issue.lon) : 'No location')}</p></div>
      <dl className="kv">
        <dt>Seen</dt><dd>{issue.sightings}× · first in {issue.video_id} @ {fmtTimecode(issue.t)}</dd>
        <dt>Confidence</dt><dd>{Math.round(issue.confidence * 100)}%</dd>
        {issue.lat != null && issue.lon != null ? <><dt>GPS</dt><dd>{fmtCoord(issue.lat, issue.lon)}</dd></> : null}
      </dl>
      {issue.duplicate_of ? <p className="note">A re-sighting of <button type="button" className="link" onClick={() => select(issue.duplicate_of)}>{issue.duplicate_of}</button>; its work order lives there.</p> : null}
      {issue.sighting_refs?.length ? (
        <div><div className="label">Sightings</div><div className="seen">{issue.sighting_refs.map((r, k) => <button key={k} type="button" onClick={() => jump(r.video_id, r.t)}>{r.video_id} · {fmtClock(r.t)}</button>)}</div></div>
      ) : null}
      {wo ? (
        <div><div className="label">Work order</div>
          <dl className="kv left"><dt>Repair</dt><dd>{wo.repair}</dd><dt>Crew</dt><dd>{CATEGORY[issue.category].crewLabel}, {wo.minutes} min</dd>{wo.equipment.length ? <><dt>Kit</dt><dd>{wo.equipment.join(' · ')}</dd></> : null}</dl>
        </div>
      ) : !issue.duplicate_of ? <p className="note">{issue.provisional ? 'Work order follows once history is checked.' : 'No work order yet.'}</p> : null}
      {client.capabilities.similar && similar.data?.length ? (
        <div><div className="label">Similar issues</div>
          <ul className="similar">{similar.data.map(s => <li key={s.issue.id}><button type="button" onClick={() => (onOpen ? onOpen(s.issue) : open(s.issue.video_id, Math.max(0, s.issue.t - 0.4), s.issue.id))}><SevDot level={s.issue.severity} /><span className="two"><span>{s.issue.description}</span><span className="muted small">{s.issue.place ?? s.issue.video_id}</span></span><span className="mono muted" title="Embedding distance">{s.distance.toFixed(2)}</span></button></li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
