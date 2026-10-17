import { STAGES, type StageId, type VideoStatus } from '@raightway/core';

export function StageTrack({ stage, status }: { stage: StageId | null; status: VideoStatus }) {
  const cur = status === 'done' ? STAGES.length : stage ? STAGES.findIndex(s => s.id === stage) : -1;
  return (
    <ol className="stage-track" aria-label="Pipeline stages">
      {STAGES.map((s, i) => <li key={s.id} className={`stg${i < cur ? ' done' : i === cur ? ' on' : ''}${status === 'failed' && i === cur ? ' failed' : ''}`} aria-current={i === cur ? 'step' : undefined}><i /><span>{s.label}</span></li>)}
    </ol>
  );
}
