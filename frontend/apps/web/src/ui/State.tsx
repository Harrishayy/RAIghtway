// Empty, loading and error states. Every data view renders one of these instead of a blank area.
import type { ReactNode } from 'react';
import { Dash } from './Dash';
import { Icon } from './Icon';

export function Empty({ title, children, dash = 'idle' }: { title: string; children?: ReactNode; dash?: 'idle' | 'done' }) {
  return <div className="state"><Dash state={dash} size={40} /><b>{title}</b>{children ? <div className="muted">{children}</div> : null}</div>;
}
export function Failed({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className={`state state-bad${compact ? ' compact' : ''}`} role="alert">
      {compact ? <Icon name="alert" /> : <Dash state="fail" size={40} />}
      <b>Couldn’t load this</b><div className="muted">{msg}</div>
      {onRetry ? <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}><Icon name="refresh" />Retry</button> : null}
    </div>
  );
}
export function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <i key={i} style={{ width: `${88 - i * 14}%` }} />)}</div>;
}
