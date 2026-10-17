'use client';
// Ruler, one lane per category with each finding at its exact time, a VSS search lane, a speed lane
// and the playhead. Press and drag anywhere on a lane to scrub.
import { useMemo, useRef } from 'react';
import { CATEGORY, clamp, fmtClock, issueLabel, type CategoryId, type Issue, type TopicHit, type Video } from '@raightway/core';
import { usePlayback } from '@/state/playback';
import { useSize } from '@/lib/useSize';
import { Icon } from '@/ui/Icon';
import { useFootageSearch } from './FootageSearch';

export function Timeline({ video, issues, cats }: { video: Video; issues: Issue[]; cats: CategoryId[] }) {
  const dur = Math.max(1, video.duration_s);
  const { t, selectedIssue, seek, select, setPlaying } = usePlayback();
  const ruler = useRef<HTMLDivElement>(null); const { width } = useSize(ruler);
  // the query is typed in the footage list (FootageSearch); this lane shows its matches on the open drive
  const { topic: query, found: topic, hits: all } = useFootageSearch(); const hits: TopicHit[] = (all ?? []).filter(h => h.video_id === video.id);
  const room = Math.max(2, Math.floor((width || 400) / 58));
  const step = [5, 10, 15, 30, 60, 120, 180, 300, 600].find(s => dur / s <= room) ?? 600;
  const ticks: number[] = []; for (let s = 0; s < dur - step * 0.4; s += step) ticks.push(s);
  const speed = useMemo(() => {
    const g = video.gps; if (!g?.length) return null; const max = Math.max(40, ...g.map(p => p.speed_kmh));
    return { d: g.map((p, i) => `${i ? 'L' : 'M'}${((p.t / dur) * 200).toFixed(2)} ${(20 - (p.speed_kmh / max) * 18).toFixed(1)}`).join(''), now: g[Math.min(g.length - 1, Math.round(t))]?.speed_kmh };
  }, [video.gps, dur, t]);

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = (e.target as HTMLElement).closest<HTMLElement>('[data-seek]'); if (!track || (e.target as HTMLElement).closest('.mk, .band')) return;
    const r = track.getBoundingClientRect(); setPlaying(false); const lanes = e.currentTarget;
    const go = (x: number) => seek(clamp((x - r.left) / r.width, 0, 1) * dur);
    go(e.clientX); lanes.setPointerCapture(e.pointerId); lanes.onpointermove = ev => go(ev.clientX); lanes.onpointerup = () => { lanes.onpointermove = null; };
  };
  return (
    <div className="tl">
      <div className="tl-ruler" ref={ruler} aria-hidden="true">{ticks.map(s => <span key={s} style={{ left: `${(s / dur) * 100}%` }}>{fmtClock(s)}</span>)}</div>
      <div className="tl-lanes" onPointerDown={scrub}>
        {cats.map(c => {
          const list = issues.filter(i => i.category === c);
          return (
            <div key={c} className="lane" data-cat={c}>
              <span className="lane-l" title={`${CATEGORY[c].label}: ${list.length}`}><Icon name={c} /><span className="ll">{CATEGORY[c].label}</span><b>{list.length}</b></span>
              <span className="lane-t" data-seek>
                {list.map(i => <button key={i.id} type="button" className={`mk${i.duplicate_of ? ' merged' : ''}${i.provisional ? ' prov' : ''}${i.source === 'manual' ? ' manual' : ''}`} data-sev={i.severity} aria-pressed={i.id === selectedIssue} style={{ left: `${(i.t / dur) * 100}%` }}
                  aria-label={`${i.source === 'manual' ? 'Manual: ' : ''}${i.name?.trim() ? `${i.name.trim()}, ` : ''}${CATEGORY[c].label}, severity ${i.severity}, at ${fmtClock(i.t)}`} title={`${fmtClock(i.t)} · ${i.source === 'manual' ? 'Manual · ' : ''}${issueLabel(i)}`} onClick={() => { setPlaying(false); select(i.id); seek(Math.max(0, i.t - 0.4)); }} />)}
              </span>
            </div>
          );
        })}
        {query.length > 2 && (
          <div className="lane lane-vss">
            <span className="lane-l" title={topic.isError ? 'VSS search unavailable' : `VSS search “${query}”: ${hits.length} matches on this drive`}><Icon name={topic.isError ? 'alert' : 'search'} /><span className="ll">“{query}”</span><b>{topic.isError ? '!' : topic.isFetching && !all ? '…' : hits.length}</b></span>
            <span className="lane-t" data-seek>{hits.map((h, i) => <button key={i} type="button" className="band" style={{ left: `${(h.start / dur) * 100}%`, width: `${(Math.max(h.end - h.start, 1) / dur) * 100}%`, opacity: 0.45 + h.score * 0.55 }}
              aria-label={`VSS match ${fmtClock(h.start)} to ${fmtClock(h.end)}: ${h.caption}`} title={`${fmtClock(h.start)}–${fmtClock(h.end)} · ${h.caption}`} onClick={() => { setPlaying(false); seek(h.start); }} />)}</span>
          </div>
        )}
        {speed && (
          <div className="lane">
            <span className="lane-l" title="Speed, km/h"><Icon name="clock" /><span className="ll">Speed</span><b>{speed.now != null ? Math.round(speed.now) : '—'}</b></span>
            <span className="lane-t" data-seek><svg className="spark" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true"><path d={speed.d} /></svg></span>
          </div>
        )}
        <div className="playhead" style={{ left: `calc(var(--tlw) + (100% - var(--tlw)) * ${clamp(t / dur, 0, 1)})` }} />
      </div>
    </div>
  );
}
