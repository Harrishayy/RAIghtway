// Small data marks: status chip, severity, category. Colour is never the only signal; each carries text.
import type { ReactNode } from 'react';
import { CATEGORY, severityDef, type CategoryId, type Severity, type VideoStatus } from '@raightway/core';
import { Icon } from './Icon';

export type Tone = 'done' | 'live' | 'neutral' | 'hold' | 'failed' | 'info';
export function Chip({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`chip s-${tone}${plain ? ' plain' : ''}`}>{children}</span>;
}
const STATUS: Record<VideoStatus, [Tone, string]> = { queued: ['neutral', 'Queued'], analysing: ['live', 'Analysing'], done: ['done', 'Done'], failed: ['failed', 'Failed'] };
export const StatusChip = ({ status }: { status: VideoStatus }) => { const [tone, label] = STATUS[status]; return <Chip tone={tone}>{label}</Chip>; };

export function SevDot({ level }: { level: Severity }) {
  return <span className="sev-dot" data-sev={level} title={`Severity ${level}: ${severityDef(level).label}`} aria-label={`Severity ${level} of 5, ${severityDef(level).label}`}>{level}</span>;
}
export function SevLabel({ level }: { level: Severity }) {
  return <span className="sev" data-sev={level}><SevDot level={level} />{severityDef(level).label}</span>;
}
export function CategoryLabel({ id, compact }: { id: CategoryId; compact?: boolean }) {
  return <span className="cat" data-cat={id} title={CATEGORY[id].label}><Icon name={id} /><span className={compact ? 'ct' : undefined}>{CATEGORY[id].label}</span></span>;
}
export const Kbd = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;
