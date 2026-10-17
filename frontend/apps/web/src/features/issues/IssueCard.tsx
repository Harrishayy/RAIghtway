'use client';
// The selected issue: what and where, how often it has been seen (each sighting seeks to it), the
// work order, and similar past issues. Handles merged, provisional and not-yet-planned states.
// `frame` adds the finding's frame with its box, for screens that have no player beside the card.
import { CATEGORY, CATEGORY_FOR_CREW, fmtClock, fmtCoord, fmtTimecode, issueLabel, raterDef, severityDef, type Issue, type Similar, type Urgency } from '@raightway/core';
import { useClient } from '@/domain/client';
import { useSimilar, useUpdateIssue, useVideos } from '@/domain/queries';
import { Icon } from '@/ui/Icon';
import { usePlayback } from '@/state/playback';
import { Chip, CategoryLabel, SevDot, SevLabel } from '@/ui/marks';
import { Empty } from '@/ui/State';
import { Frame } from '@/ui/Footage/Frame';
import { Thumb } from '@/ui/Thumb';
import { PhotoButton, photoOf } from '@/ui/Lightbox';

const URGENCY: Record<Urgency, ['failed' | 'hold' | 'neutral', string]> = { urgent: ['failed', 'Urgent'], soon: ['hold', 'Soon'], routine: ['neutral', 'Routine'] };

// Which index answered the similar-issues search, so the VastDB claim is visible rather than assumed.
const INDEX: Record<NonNullable<Similar['search']>, [string, string]> = {
  vastdb: ['VastDB vector search', 'Cosine search inside VastDB over Cosmos-Embed1 vectors'],
  local: ['local index', 'VastDB was unreachable, so the backend searched its in-memory copy'],
};

export function IssueCard({ issue, onOpen, frame }: { issue: Issue | null | undefined; onOpen?: (i: Issue) => void; frame?: boolean }) {
  const client = useClient(); const similar = useSimilar(issue && !issue.provisional ? issue.duplicate_of ?? issue.id : null);
  const { open, seek, videoId, select } = usePlayback(); const index = similar.data?.[0]?.search;
  // drive names, not video ids: Run clips have uuid ids
  const { data: videos } = useVideos(); const drive = (vid: string) => videos?.find(v => v.id === vid)?.drive ?? vid;
  if (!issue) return <div className="issue"><Empty title="Nothing selected">Pick a finding on the timeline, the table or the map.</Empty></div>;
  const sv = severityDef(issue.severity); const wo = issue.work_order;
  const jump = (vid: string, t: number) => (vid === videoId ? seek(t) : open(vid, t, issue.id));
  return (
    <div className="issue">
      {frame ? (
        <div className="photo-wrap">
          <Frame issue={issue} src={client.frameUrl(issue)} seed={issue.frame_seed ?? 0} placeholder={client.id === 'mock' ? 'scene' : 'blank'} className="issue-frame" />
          {!issue.provisional ? <PhotoButton src={client.frameUrl(issue)} photo={photoOf(issue)} className="photo-cover" /> : null}
        </div>
      ) : null}
      <div className="issue-tags">
        <CategoryLabel id={issue.category} /><SevLabel level={issue.severity} />
        <Chip tone={issue.severity === 5 ? 'failed' : 'neutral'}>{sv.when}</Chip>
        {issue.provisional ? <Chip tone="live">Checking</Chip> : issue.duplicate_of ? <Chip tone="info">Merged</Chip> : null}
        {issue.verdict === 'rejected' ? <Chip tone="neutral">Not a defect</Chip> : null}
        {issue.source === 'manual' ? <span title="Marked by an operator on the footage, not found by a model"><Chip tone="neutral">Manual</Chip></span> : null}
        {issue.pinned ? <span title="Pinned: triage treats it as must-do in the next plan"><Chip tone="info">Pinned</Chip></span> : null}
      </div>
      <PinToggle issue={issue} />
      <div><h4>{issueLabel(issue)}</h4>{issue.name?.trim() ? <p className="issue-desc">{issue.description}</p> : null}<p className="where">{issue.place ?? (issue.lat != null && issue.lon != null ? fmtCoord(issue.lat, issue.lon) : 'No location')}</p></div>
      {!frame && !issue.provisional && client.frameUrl(issue) ? <PhotoButton src={client.frameUrl(issue)} photo={photoOf(issue)} className="btn btn-ghost btn-sm issue-photo"><Icon name="zoom" />Full-size photo</PhotoButton> : null}
      <Grade issue={issue} />
      <dl className="kv">
        <dt>Seen</dt><dd>{issue.sightings}× · first in {drive(issue.video_id)} @ {fmtTimecode(issue.t)}</dd>
        {issue.source === 'manual' ? <><dt>Source</dt><dd>Operator-reported on footage</dd></> : <><dt>Confidence</dt><dd>{Math.round(issue.confidence * 100)}%</dd></>}
        {issue.lat != null && issue.lon != null ? <><dt>GPS</dt><dd>{fmtCoord(issue.lat, issue.lon)}</dd></> : null}
      </dl>
      {issue.duplicate_of ? <p className="note">A re-sighting of <button type="button" className="link" onClick={() => select(issue.duplicate_of)}>{issue.duplicate_of}</button>; its work order lives there.</p> : null}
      {issue.sighting_refs?.length ? (
        <div><div className="label">Sightings</div><div className="seen">{issue.sighting_refs.map((r, k) => <button key={k} type="button" onClick={() => jump(r.video_id, r.t)}>{r.drive ?? drive(r.video_id)} · {fmtClock(r.t)}</button>)}</div></div>
      ) : null}
      {wo ? (
        <div><div className="label">Work order</div>
          <dl className="kv left"><dt>Repair</dt><dd>{wo.repair}</dd><dt>Crew</dt><dd>{CATEGORY[CATEGORY_FOR_CREW[wo.crew] ?? issue.category].crewLabel}, {wo.minutes} min</dd><dt>Urgency</dt><dd><Chip tone={URGENCY[wo.urgency][0]} plain>{URGENCY[wo.urgency][1]}</Chip></dd>{wo.equipment.length ? <><dt>Kit</dt><dd>{wo.equipment.join(' · ')}</dd></> : null}</dl>
        </div>
      ) : !issue.duplicate_of ? <p className="note">{issue.provisional ? 'Work order follows once history is checked.' : 'No work order yet.'}</p> : null}
      {client.capabilities.similar && similar.data?.length ? (
        <div><div className="label">Similar issues{index ? <span className="muted" title={INDEX[index][1]}> · {INDEX[index][0]}</span> : null}</div>
          <ul className="similar">{similar.data.slice(0, 5).map(s => <li key={s.issue.id}><button type="button" title="Watch in Review" onClick={() => (onOpen ? onOpen(s.issue) : open(s.issue.video_id, Math.max(0, s.issue.t - 0.4), s.issue.id))}><Thumb src={client.frameUrl(s.issue)} category={s.issue.category} /><span className="two"><span>{issueLabel(s.issue)}</span><span className="muted small">{s.issue.place ?? drive(s.issue.video_id)}{s.issue.sightings > 1 ? ` · seen ${s.issue.sightings}×` : ''}</span></span><span className="sim-r"><SevDot level={s.issue.severity} />{s.distance != null ? <span className="mono muted small" title="Embedding distance">{s.distance.toFixed(2)}</span> : null}</span></button><PhotoButton src={client.frameUrl(s.issue)} photo={photoOf(s.issue)} className="thumb-cover" /></li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

/** Why the issue has its severity: the rater's one-sentence reason, who graded it (a fallback says so), and the
 * find pass's original grade when the rating changed it. Nothing when the issue was never re-graded. */
function Grade({ issue }: { issue: Issue }) {
  const rater = raterDef(issue.severity_model);
  if (!rater && !issue.severity_reason) return null;
  const rejected = issue.verdict === 'rejected';
  const changed = issue.find_severity != null && issue.find_severity !== issue.severity;
  return (
    <div className={`grade${rejected ? ' rejected' : ''}`} data-sev={issue.severity}>
      <div className="label">{rejected ? 'Judged not a defect' : 'Why this severity'}</div>
      {issue.severity_reason ? <p>{issue.severity_reason}</p> : null}
      <span className="muted">
        {rater ? <>Graded by {rater.name}{rater.fallback ? ' (fallback)' : ''}</> : 'Graded'}
        {changed ? (issue.source === 'manual' ? ` · marked as S${issue.find_severity}` : ` · find pass said S${issue.find_severity}`) : ''}
        {rejected ? ' · kept on record, left out of the report and routes' : ''}
      </span>
    </div>
  );
}

/** Include this issue in the next plan (a pin), or take it out. Re-sightings pin the issue they belong to. */
function PinToggle({ issue }: { issue: Issue }) {
  const client = useClient(); const update = useUpdateIssue();
  if (!client.capabilities.markIssues || issue.provisional || issue.verdict === 'rejected') return null;
  const id = issue.duplicate_of ?? issue.id; const pinned = Boolean(issue.pinned);
  return (
    <div className="pin-row">
      <button type="button" className={`btn btn-sm pin-toggle ${pinned ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={pinned} disabled={update.isPending}
        onClick={() => update.mutate({ id, patch: { pinned: !pinned } })} title={pinned ? 'Take it out of the next plan' : 'Triage treats a pinned issue as must-do today'}>
        <Icon name="pin" />{update.isPending ? 'Saving…' : pinned ? 'In next plan' : 'Include in plan'}
      </button>
    </div>
  );
}
