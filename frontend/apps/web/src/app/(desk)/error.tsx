'use client';
import { Failed } from '@/ui/State';
export default function DeskError({ error, reset }: { error: Error; reset: () => void }) {
  return <div className="page-pad"><Failed error={error} onRetry={reset} /></div>;
}
