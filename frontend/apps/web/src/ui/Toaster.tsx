'use client';
import { useToasts } from '@/state/toast';
import { Icon } from './Icon';

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast t-${t.tone}`}>
          <Icon name={t.tone === 'bad' ? 'alert' : 'check'} />
          <span className="toast-b"><b>{t.title}</b>{t.body ? <span> {t.body}</span> : null}</span>
          {t.action ? <button type="button" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button> : null}
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="x" /></button>
        </div>
      ))}
    </div>
  );
}
