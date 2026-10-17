'use client';
// Which backend the console is talking to, whether it answers, and what it can do. Opens a small panel.
import { useEffect, useRef, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { useClient } from '@/domain/client';
import { useVideos } from '@/domain/queries';
import { clientConfig } from '@/config/backend';
import { env } from '@/config/env';
import { Icon } from '@/ui/Icon';

export function BackendStatus() {
  const c = useClient(); const videos = useVideos(); const fetching = useIsFetching(); const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; document.addEventListener('mousedown', off); document.addEventListener('keydown', esc); return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); }; }, [open]);
  const tone = videos.isError ? 'failed' : videos.isPending ? 'neutral' : 'done';
  const where = clientConfig.source === 'http' ? (env.apiBaseUrl || 'same origin → RAIGHTWAY_API_URL') : 'in-browser sample data';
  return (
    <div className="popover-host" ref={ref}>
      <button type="button" className={`chip s-${tone} chip-btn`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(o => !o)} title="Backend">
        {c.label}{fetching ? <span className="sr">, syncing</span> : null}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Backend">
          <div className="comp-h"><b><Icon name="plug" /> {c.label}</b><span className={`chip s-${tone}`}>{videos.isError ? 'Unreachable' : videos.isPending ? 'Connecting' : 'Connected'}</span></div>
          <dl className="kv left"><dt>Source</dt><dd className="mono">{clientConfig.source}</dd><dt>Endpoint</dt><dd className="mono">{where}</dd>
            <dt>Polling</dt><dd className="mono">{env.pollLiveMs / 1000} s live · {env.pollIdleMs / 1000} s idle</dd></dl>
          {videos.isError ? <p className="note bad">{(videos.error as Error).message}</p> : null}
          <div className="label">Capabilities</div>
          <ul className="caps">{Object.entries(c.capabilities).map(([k, v]) => <li key={k} className={v ? 'on' : 'off'}><Icon name={v ? 'check' : 'x'} />{k}</li>)}</ul>
          <p className="muted small">Configure in <code>.env.local</code> or <code>src/config/backend.ts</code>.</p>
        </div>
      )}
    </div>
  );
}
