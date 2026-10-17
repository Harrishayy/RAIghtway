'use client';
import { useClient } from '@/domain/client';
import { useRun } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { Icon } from '@/ui/Icon';

/** Runs a few clips live: the next footage in the VAST index nobody has analysed, then re-checks of reviewed
 *  stretches on other drives (the backend picks; it opens the first). Hidden when the backend can't. */
export function RunButton() {
  const c = useClient(); const run = useRun(); const open = usePlayback(s => s.open);
  if (!c.capabilities.run) return null;
  const go = async () => {
    try { const v = await run.mutateAsync(); open(v.id, 0, null); } catch { /* toast shown by the hook */ }
  };
  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => void go()} disabled={run.isPending}
      title="Fetch footage from the VAST index and run the full pipeline on it, live: new footage first, then re-checks of reviewed stretches on other drives">
      <Icon name="play" />{run.isPending ? 'Reading VAST index…' : 'Run'}
    </button>
  );
}
