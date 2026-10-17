'use client';
import { fmtTimecode, issueLabel, type Issue } from '@raightway/core';
import { usePlayback } from '@/state/playback';
import { CategoryLabel, Chip, SevDot } from '@/ui/marks';

/** Every finding in this drive by time. Click or Enter to jump to it. */
export function Detections({ issues }: { issues: Issue[] }) {
  const { selectedIssue, select, seek, setPlaying } = usePlayback();
  const go = (i: Issue) => { setPlaying(false); select(i.id); seek(Math.max(0, i.t - 0.4)); };
  if (!issues.length) return <p className="muted pad-s">No findings in these categories on this drive.</p>;
  return (
    <table className="moments">
      <thead><tr><th>Time</th><th>Finding</th><th>Sev</th><th className="d">What</th><th className="seen-c">Seen</th></tr></thead>
      <tbody>
        {issues.map(i => (
          <tr key={i.id} aria-selected={i.id === selectedIssue} tabIndex={0} onClick={() => go(i)} onKeyDown={e => { if (e.key === 'Enter') go(i); }} className={i.duplicate_of ? 'merged' : i.provisional ? 'prov' : undefined}>
            <td className="t">{fmtTimecode(i.t)}</td><td><CategoryLabel id={i.category} compact /></td><td><SevDot level={i.severity} /></td>
            <td className="d" title={`${i.source === 'manual' ? 'Operator-reported: ' : ''}${i.name?.trim() ? `${i.name.trim()} · ` : ''}${i.description}${i.pinned ? ' (pinned for the next plan)' : ''}`}>{i.source === 'manual' ? <Chip tone="neutral" plain>Manual</Chip> : null}{i.pinned ? <Chip tone="info" plain>Pinned</Chip> : null}{i.duplicate_of ? 'Re-sighting: ' : ''}{issueLabel(i)}</td><td className="num seen-c">{i.sightings}×</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
